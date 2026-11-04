import "server-only";

import { eq, or, type SQL } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { appSettings, deletedItems, itemImages, items, type NewItemImage } from "@/lib/db/schema";
import {
  assertRegisteredBlob,
  deleteBlobsQuietly,
  type BlobMeta,
  type BlobStorage,
  type StoredBlob,
} from "@/lib/images/blob";
import { processImage, type ProcessImageResult } from "@/lib/images/server-pipeline";
import {
  matchesUploadPathname,
  originalUploadPathname,
  originalUploadPrefix,
  UPLOAD_LIMITS,
  type RegisterBody,
  type RegisterData,
} from "@/lib/items/contracts";
import { AppError } from "@/lib/result";
import { loadItemCard } from "@/server/items/dto";

// Turns a browser upload into an item (D-031, D-033): validate the blob,
// process it once, store the derived images, then create the item and its three
// image rows in one transaction. Safe to call again with the same item id, and
// safe against a concurrent duplicate: the unique constraints decide the race.
// An id whose item was deleted is refused, so a retry cannot bring it back
// (D-238).

export type RegisterUploadDeps = {
  db: Db;
  storage: BlobStorage;
  /** Reads the original from Blob; tests pass the fake storage's fetch. */
  fetch: typeof fetch;
  /** Defaults to ORIGINAL_FETCH_TIMEOUT_MS. */
  fetchTimeoutMs?: number;
};

/** Leaves room for processing, two puts and the insert within the route's 60 s. */
export const ORIGINAL_FETCH_TIMEOUT_MS = 20_000;

export function processedPathname(itemId: string): string {
  return `items/${itemId}/processed.webp`;
}

export function thumbPathname(itemId: string): string {
  return `items/${itemId}/thumb.webp`;
}

// Postgres names inline UNIQUE constraints <table>_<column>_key.
const ITEM_UNIQUE_CONSTRAINTS = new Set(["items_pkey", "items_image_hash_key", "items_source_hash_key"]);

/**
 * The constraint behind a unique violation (SQLSTATE 23505), or null. Drizzle
 * wraps driver errors in DrizzleQueryError with the pg or PGlite error as its
 * cause; both carry `code` and `constraint`.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && current.code === "23505") {
      return "constraint" in current && typeof current.constraint === "string" ? current.constraint : "";
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return null;
}

async function findItemId(db: Db, where: SQL | undefined): Promise<string | null> {
  const [row] = await db.select({ id: items.id }).from(items).where(where).limit(1);
  return row?.id ?? null;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Refuses an item id that was deleted (D-238). Its photos, this upload's
 * original among them, are queued in blob_cleanup, so an item registered
 * again on them would lose its original to the next cleanup run.
 */
async function assertNotDeleted(db: Db | Tx, itemId: string): Promise<void> {
  const [row] = await db
    .select({ itemId: deletedItems.itemId })
    .from(deletedItems)
    .where(eq(deletedItems.itemId, itemId));
  if (row !== undefined) {
    throw new AppError("VALIDATION", "That item was deleted. Upload the photo again.", { reason: "item_deleted" });
  }
}

async function registered(db: Db, itemId: string): Promise<RegisterData> {
  return { duplicate: false, item: await loadItemCard(db, itemId) };
}

/**
 * Another request got there first. With the same item id it was this upload
 * (a retried or concurrent register), so the item is returned as is and its
 * original stays. Otherwise the photo is a duplicate of another item, and the
 * new original is deleted.
 */
async function settleExisting(
  deps: RegisterUploadDeps,
  itemId: string,
  existingItemId: string,
  original: BlobMeta,
): Promise<RegisterData> {
  if (existingItemId === itemId) return registered(deps.db, itemId);
  await deleteBlobsQuietly(deps.storage, [original.url], "a duplicate upload");
  return { duplicate: true, existingItemId };
}

function readFailed(cause?: unknown, details?: Record<string, unknown>): AppError {
  return new AppError("UPSTREAM", "The uploaded photo could not be read. Try again.", details, { cause });
}

function tooLarge(): AppError {
  return new AppError("VALIDATION", "That photo is too large.", { reason: "too_large" });
}

/** Collects a body stream, stopping as soon as it passes `maxBytes`. */
async function collect(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, total);
}

/** Reads the body up to `maxBytes`, refusing more, and insists on the size head() reported. */
async function readCapped(response: Response, maxBytes: number, expectedBytes: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  let buffer: Buffer = Buffer.alloc(0);
  try {
    if (response.body !== null) buffer = await collect(response.body, maxBytes);
  } catch (error) {
    throw error instanceof AppError ? error : readFailed(error);
  }
  // A short read (a dropped connection, a CDN hiccup) must not reach sharp:
  // its "unreadable" verdict would delete a good original.
  if (buffer.length !== expectedBytes) {
    throw readFailed(undefined, { reason: "incomplete", bytes: buffer.length, expectedBytes });
  }
  return buffer;
}

async function fetchOriginal(deps: RegisterUploadDeps, original: BlobMeta): Promise<Buffer> {
  let response: Response;
  try {
    // Only the URL the store itself reported, with no redirects to anywhere else.
    response = await deps.fetch(original.url, {
      redirect: "error",
      signal: AbortSignal.timeout(deps.fetchTimeoutMs ?? ORIGINAL_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw readFailed(error);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw readFailed(undefined, { status: response.status });
  }
  return readCapped(response, UPLOAD_LIMITS.originalMaxBytes, original.size);
}

async function processOrDiscard(
  deps: RegisterUploadDeps,
  original: BlobMeta,
  buffer: Buffer,
): Promise<ProcessImageResult> {
  try {
    return await processImage(buffer);
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION") {
      // A file sharp refuses can never become an item; keeping it only uses storage.
      await deleteBlobsQuietly(deps.storage, [original.url], "an unreadable upload");
    }
    throw error;
  }
}

/** Stores the processed image and the thumbnail; if either fails, removes the other and rethrows. */
async function putDerivatives(
  storage: BlobStorage,
  itemId: string,
  result: ProcessImageResult,
): Promise<{ processed: StoredBlob; thumb: StoredBlob }> {
  const [processed, thumb] = await Promise.allSettled([
    storage.put(processedPathname(itemId), result.processed.buffer, { contentType: result.processed.contentType }),
    storage.put(thumbPathname(itemId), result.thumb.buffer, { contentType: result.thumb.contentType }),
  ]);
  if (processed.status === "fulfilled" && thumb.status === "fulfilled") {
    return { processed: processed.value, thumb: thumb.value };
  }
  const written = [processed, thumb].flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value.url] : []));
  const reasons = [processed, thumb].flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []));
  await deleteBlobsQuietly(storage, written, "a failed image upload");
  throw reasons[0];
}

async function insertItem(
  db: Db,
  input: RegisterBody,
  result: ProcessImageResult,
  original: BlobMeta,
  stored: { processed: StoredBlob; thumb: StoredBlob },
): Promise<void> {
  const { itemId } = input;
  const images: NewItemImage[] = [
    {
      itemId,
      kind: "original",
      blobUrl: original.url,
      blobPathname: original.pathname,
      contentType: original.contentType,
      width: result.source.width,
      height: result.source.height,
      bytes: original.size,
    },
    {
      itemId,
      kind: "processed",
      blobUrl: stored.processed.url,
      blobPathname: stored.processed.pathname,
      contentType: stored.processed.contentType,
      width: result.processed.width,
      height: result.processed.height,
      bytes: result.processed.bytes,
    },
    {
      itemId,
      kind: "thumb",
      blobUrl: stored.thumb.url,
      blobPathname: stored.thumb.pathname,
      contentType: stored.thumb.contentType,
      width: result.thumb.width,
      height: result.thumb.height,
      bytes: result.thumb.bytes,
    },
  ];

  await db.transaction(async (tx) => {
    const [settings] = await tx
      .select({ location: appSettings.defaultItemLocation })
      .from(appSettings)
      .where(eq(appSettings.id, 1));
    if (settings === undefined) {
      throw new AppError("CONFIG", "The app_settings row is missing. Run `pnpm db:seed` against this database.");
    }
    await tx.insert(items).values({
      id: itemId,
      status: "pending_tagging",
      location: settings.location,
      sourceHash: input.sourceHash,
      imageHash: result.imageHash,
    });
    // After the insert, not before (D-238): an insert of an id whose delete
    // has not committed yet waits on the primary key until it has, and only
    // a read after that wait sees the delete's deleted_items row. Refused
    // here, the transaction rolls back and registerUpload deletes the
    // derived images it stored.
    await assertNotDeleted(tx, itemId);
    await tx.insert(itemImages).values(images);
  });
}

/**
 * Registers a client upload as a pending_tagging item. Returns the new (or
 * already registered) item, or `{ duplicate: true, existingItemId }` when the
 * photo matches another item by source hash or processed-image hash, in which
 * case the new original is deleted. Throws VALIDATION (reason item_deleted)
 * for the id of a deleted item and leaves the upload alone: the delete queued
 * that item's photos, the original among them, for the cleanup.
 */
export async function registerUpload(deps: RegisterUploadDeps, input: RegisterBody): Promise<RegisterData> {
  await requireSession();
  const { db, storage } = deps;
  const { itemId } = input;

  // A retry after a lost response: the item exists, nothing is redone.
  if ((await findItemId(db, eq(items.id, itemId))) !== null) return registered(db, itemId);
  // A retry after the item was deleted meanwhile: refused before anything is
  // read, processed or stored. insertItem checks again for a delete that
  // commits while this register runs.
  await assertNotDeleted(db, itemId);

  // Before anything is fetched or deleted, the URL must be this item's
  // original in our store; otherwise a crafted request could make the server
  // delete or read another blob.
  const original = await assertRegisteredBlob(storage, input.url, originalUploadPrefix(itemId), {
    pathname: input.pathname,
    contentTypes: UPLOAD_LIMITS.originalContentTypes,
    maxBytes: UPLOAD_LIMITS.originalMaxBytes,
  });
  if (!matchesUploadPathname(original.pathname, originalUploadPathname(itemId))) {
    throw new AppError("VALIDATION", "That upload belongs to a different photo.", { reason: "wrong_pathname" });
  }

  const bySource = await findItemId(db, eq(items.sourceHash, input.sourceHash));
  if (bySource !== null) return settleExisting(deps, itemId, bySource, original);

  const result = await processOrDiscard(deps, original, await fetchOriginal(deps, original));

  const byImage = await findItemId(db, eq(items.imageHash, result.imageHash));
  if (byImage !== null) return settleExisting(deps, itemId, byImage, original);

  const stored = await putDerivatives(storage, itemId, result);
  try {
    await insertItem(db, input, result, original, stored);
  } catch (error) {
    await deleteBlobsQuietly(storage, [stored.processed.url, stored.thumb.url], "a failed registration");
    const constraint = uniqueViolationConstraint(error);
    if (constraint === null || !ITEM_UNIQUE_CONSTRAINTS.has(constraint)) throw error;
    // Lost a race. Which constraint Postgres reports first is not defined when
    // several match, so the item id is checked before the hashes.
    const winner =
      (await findItemId(db, eq(items.id, itemId))) ??
      (await findItemId(db, or(eq(items.sourceHash, input.sourceHash), eq(items.imageHash, result.imageHash))));
    if (winner === null) throw error;
    return settleExisting(deps, itemId, winner, original);
  }
  return registered(db, itemId);
}
