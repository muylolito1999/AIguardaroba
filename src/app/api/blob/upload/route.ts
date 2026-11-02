import { handleUpload } from "@vercel/blob/client";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { blobEnv } from "@/env";
import { requireSession } from "@/lib/auth/dal";
import { getDb, type Db } from "@/lib/db";
import { items } from "@/lib/db/schema";
import { IMMUTABLE_CACHE_SECONDS } from "@/lib/images/blob";
import {
  BlobClientPayloadSchema,
  nobgUploadPathname,
  originalUploadPathname,
  UPLOAD_LIMITS,
  type BlobClientPayload,
} from "@/lib/items/contracts";
import { AppError } from "@/lib/result";
import { authedRoute } from "@/server/http";
import { checkHashes } from "@/server/services/check-hashes";

// Issues the short-lived client token that lets the browser upload one photo
// straight to Vercel Blob (D-031). The proxy skips this path, so authedRoute's
// Origin and session checks are the gate. Only the token request is accepted:
// no onUploadCompleted is registered, because Blob's completion callback never
// reaches localhost and carries no session; /api/items/register does that work.
//
// Success answers with handleUpload's own JSON ({ type, clientToken }), which
// is what upload() from @vercel/blob/client reads. Failures answer with the
// app's Result JSON and status; upload() itself reports any failure only as
// "Failed to retrieve the client token".

const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

const GenerateClientTokenEventSchema = z.object({
  type: z.literal("blob.generate-client-token"),
  payload: z.object({
    pathname: z.string().min(1).max(300),
    clientPayload: z.string().max(2000).nullable(),
    multipart: z.boolean(),
  }),
});

const INVALID_REQUEST = "This upload request is not valid. Reload the page and try again.";

function parseClientPayload(raw: string | null): BlobClientPayload {
  if (raw === null) throw new AppError("VALIDATION", INVALID_REQUEST, { reason: "missing_payload" });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError("VALIDATION", INVALID_REQUEST, { reason: "payload_not_json" });
  }
  const parsed = BlobClientPayloadSchema.safeParse(json);
  if (!parsed.success) throw new AppError("VALIDATION", INVALID_REQUEST, { reason: "payload_invalid" });
  return parsed.data;
}

function assertPathname(pathname: string, expected: string): void {
  // Exactly the contract's pathname; Blob adds the random suffix itself.
  if (pathname !== expected) throw new AppError("VALIDATION", INVALID_REQUEST, { reason: "pathname" });
}

async function authorizeUpload(db: Db, pathname: string, clientPayload: string | null) {
  await requireSession();
  const payload = parseClientPayload(clientPayload);
  const common = {
    addRandomSuffix: true,
    allowOverwrite: false,
    cacheControlMaxAge: IMMUTABLE_CACHE_SECONDS,
    validUntil: Date.now() + TOKEN_LIFETIME_MS,
  };

  if (payload.kind === "original") {
    assertPathname(pathname, originalUploadPathname(payload.itemId));
    // check-hashes already filtered the batch; this closes the gap for two
    // tabs or a retry, before a Blob operation is spent.
    const { known } = await checkHashes(db, [payload.sourceHash]);
    const existingItemId = known[payload.sourceHash];
    if (existingItemId !== undefined) {
      throw new AppError("DUPLICATE", "This photo is already in your wardrobe.", { existingItemId });
    }
    return {
      ...common,
      allowedContentTypes: [...UPLOAD_LIMITS.originalContentTypes],
      maximumSizeInBytes: UPLOAD_LIMITS.originalMaxBytes,
    };
  }

  assertPathname(pathname, nobgUploadPathname(payload.itemId));
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, payload.itemId)).limit(1);
  if (item === undefined) {
    throw new AppError("NOT_FOUND", "That item no longer exists.", { itemId: payload.itemId });
  }
  return {
    ...common,
    allowedContentTypes: [...UPLOAD_LIMITS.nobgContentTypes],
    maximumSizeInBytes: UPLOAD_LIMITS.nobgMaxBytes,
  };
}

export const POST = authedRoute(GenerateClientTokenEventSchema, async (event, { request }) => {
  // Explicit token (AGENTS.md); a missing one is a CONFIG error, logged and hidden (D-053).
  const token = blobEnv().BLOB_READ_WRITE_TOKEN;
  const db = getDb();
  const result = await handleUpload({
    body: event,
    request,
    token,
    onBeforeGenerateToken: (pathname, clientPayload) => authorizeUpload(db, pathname, clientPayload),
  });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
});
