import "server-only";

import { and, eq } from "drizzle-orm";
import sharp, { type Metadata } from "sharp";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { itemImages, items } from "@/lib/db/schema";
import {
  assertRegisteredBlob,
  deleteBlobsQuietly,
  type BlobMeta,
  type BlobStorage,
  type StoredBlob,
} from "@/lib/images/blob";
import {
  encodeWebp,
  PROCESSED_LONG_EDGE,
  PROCESSED_WEBP_QUALITY,
  type EncodedImage,
} from "@/lib/images/server-pipeline";
import {
  isUuid,
  matchesUploadPathname,
  nobgUploadPathname,
  nobgUploadPrefix,
  UPLOAD_LIMITS,
  type NobgBody,
  type NobgData,
} from "@/lib/items/contracts";
import { AppError } from "@/lib/result";
import { loadItemCard } from "@/server/items/dto";

// Attaches a background-removed cut-out to an item (D-034). The browser runs
// the model and uploads a PNG with real alpha to items/<id>/nobg.png; this
// validates that upload, re-encodes it as a WebP that keeps the alpha channel,
// stores it and points the item's single "nobg" image row at it. The uploaded
// PNG is only an input: once it is known to be this item's upload it is
// deleted whatever happens, so a failed attempt never leaves it behind. A retry
// is a new run of the button, which uploads a new PNG.

export type AttachNobgDeps = {
  db: Db;
  storage: BlobStorage;
  /** Reads the uploaded PNG from Blob; tests pass the fake storage's fetch. */
  fetch: typeof fetch;
  /** Defaults to NOBG_FETCH_TIMEOUT_MS. */
  fetchTimeoutMs?: number;
};

/** Leaves room for sharp, one put and the upsert within the route's 60 s. */
export const NOBG_FETCH_TIMEOUT_MS = 20_000;

/** The cut-out matches the processed photo it was made from. */
export const NOBG_LONG_EDGE = PROCESSED_LONG_EDGE;
export const NOBG_WEBP_QUALITY = PROCESSED_WEBP_QUALITY;

/** Where the stored WebP goes; Blob adds a random suffix, so a new cut-out is a new URL. */
export function nobgPathname(itemId: string): string {
  return `items/${itemId}/nobg.webp`;
}

function notFound(itemId: string): AppError {
  return new AppError("NOT_FOUND", "That item no longer exists.", { itemId });
}

function readFailed(cause?: unknown, details?: Record<string, unknown>): AppError {
  return new AppError("UPSTREAM", "The cut-out could not be read from the photo store. Try again.", details, {
    cause,
  });
}

function notACutout(cause: unknown): AppError {
  return new AppError("VALIDATION", "That cut-out is not a PNG image we can read.", { reason: "unreadable" }, { cause });
}

async function itemExists(db: Db, itemId: string): Promise<boolean> {
  const [row] = await db.select({ id: items.id }).from(items).where(eq(items.id, itemId)).limit(1);
  return row !== undefined;
}

/**
 * Reads exactly the bytes head() reported. More is refused as soon as it
 * arrives, and less (a dropped connection) is an error rather than a
 * truncated image.
 */
async function fetchUpload(deps: AttachNobgDeps, upload: BlobMeta): Promise<Buffer> {
  let response: Response;
  try {
    // Only the URL the store itself reported, with no redirects to anywhere else.
    response = await deps.fetch(upload.url, {
      redirect: "error",
      signal: AbortSignal.timeout(deps.fetchTimeoutMs ?? NOBG_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw readFailed(error);
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw readFailed(undefined, { status: response.status });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      total += chunk.value.byteLength;
      if (total > upload.size) {
        await reader.cancel();
        throw readFailed(undefined, { reason: "too_long", expectedBytes: upload.size });
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    throw error instanceof AppError ? error : readFailed(error);
  }
  if (total !== upload.size) {
    throw readFailed(undefined, { reason: "incomplete", bytes: total, expectedBytes: upload.size });
  }
  return Buffer.concat(chunks, total);
}

/** A PNG with an alpha channel becomes a WebP that keeps it; anything else is refused. */
async function encodeCutout(png: Buffer): Promise<EncodedImage> {
  let metadata: Metadata;
  try {
    // Header only; encodeWebp enforces the pixel limit when it decodes.
    metadata = await sharp(png, { limitInputPixels: false }).metadata();
  } catch (error) {
    throw notACutout(error);
  }
  if (metadata.format !== "png") throw notACutout(new Error(`Unexpected format: ${metadata.format}`));
  if (!metadata.hasAlpha) {
    throw new AppError("VALIDATION", "That image has no transparent background.", { reason: "no_alpha" });
  }
  try {
    return await encodeWebp(png, { longEdge: NOBG_LONG_EDGE, quality: NOBG_WEBP_QUALITY });
  } catch (error) {
    throw notACutout(error);
  }
}

/**
 * Points the item's nobg row at the new blob and returns the URL it pointed at
 * before, if any. The item row is locked first, so two saves for one item run
 * one after the other and each sees the other's blob as the one to delete;
 * without the lock both could find no previous row and one blob would leak.
 */
async function upsertNobgRow(
  db: Db,
  itemId: string,
  stored: StoredBlob,
  cutout: EncodedImage,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select({ id: items.id }).from(items).where(eq(items.id, itemId)).for("update");
    if (item === undefined) throw notFound(itemId);

    const [previous] = await tx
      .select({ url: itemImages.blobUrl })
      .from(itemImages)
      .where(and(eq(itemImages.itemId, itemId), eq(itemImages.kind, "nobg")));

    const image = {
      blobUrl: stored.url,
      blobPathname: stored.pathname,
      contentType: stored.contentType,
      width: cutout.width,
      height: cutout.height,
      bytes: cutout.bytes,
    };
    await tx
      .insert(itemImages)
      .values({ itemId, kind: "nobg", ...image })
      .onConflictDoUpdate({
        target: [itemImages.itemId, itemImages.kind],
        // created_at dates the blob write the usage page counts, so a replacement is a new write.
        set: { ...image, createdAt: new Date() },
      });
    return previous?.url ?? null;
  });
}

async function attachValidated(deps: AttachNobgDeps, itemId: string, upload: BlobMeta): Promise<NobgData> {
  const { db, storage } = deps;
  // Checked before the work below; the transaction checks again under a lock.
  if (!(await itemExists(db, itemId))) throw notFound(itemId);

  const cutout = await encodeCutout(await fetchUpload(deps, upload));
  const stored = await storage.put(nobgPathname(itemId), cutout.buffer, { contentType: cutout.contentType });

  let previousUrl: string | null;
  try {
    previousUrl = await upsertNobgRow(db, itemId, stored, cutout);
  } catch (error) {
    await deleteBlobsQuietly(storage, [stored.url], "a failed cut-out save");
    throw error;
  }
  if (previousUrl !== null && previousUrl !== stored.url) {
    await deleteBlobsQuietly(storage, [previousUrl], "replacing a cut-out");
  }
  return { item: await loadItemCard(db, itemId) };
}

/**
 * Stores a browser-made cut-out as the item's nobg image and returns the
 * updated card. Throws NOT_FOUND for an unknown item, and VALIDATION when the
 * URL is not this item's uploaded PNG in our store or the file is not a PNG
 * with transparency.
 */
export async function attachNobgImage(deps: AttachNobgDeps, itemId: string, input: NobgBody): Promise<NobgData> {
  await requireSession();
  const { storage } = deps;
  // A malformed id cannot name an item, and it must not reach SQL or a pathname.
  if (!isUuid(itemId)) throw notFound(itemId);

  // Before anything is fetched or deleted, the URL must be this item's
  // uploaded PNG in our store. The prefix alone would also match the stored
  // items/<id>/nobg-<suffix>.webp, so the exact upload name is required too;
  // otherwise a crafted request could make the server delete the current cut-out.
  const upload = await assertRegisteredBlob(storage, input.url, nobgUploadPrefix(itemId), {
    pathname: input.pathname,
    contentTypes: UPLOAD_LIMITS.nobgContentTypes,
    maxBytes: UPLOAD_LIMITS.nobgMaxBytes,
  });
  if (!matchesUploadPathname(upload.pathname, nobgUploadPathname(itemId))) {
    throw new AppError("VALIDATION", "That upload belongs to a different photo.", { reason: "wrong_pathname" });
  }

  try {
    return await attachValidated(deps, itemId, upload);
  } finally {
    await deleteBlobsQuietly(storage, [upload.url], "processing an uploaded cut-out");
  }
}
