import "server-only";

import {
  BlobAccessError,
  BlobNotFoundError,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  del as sdkDel,
  head as sdkHead,
  put as sdkPut,
} from "@vercel/blob";

import { blobEnv } from "@/env";
import { AppError } from "@/lib/result";

// The app's only door to Vercel Blob on the server. Every call passes the
// read-write token explicitly (AGENTS.md, D-031), so there is one
// deterministic credential path instead of an implicit OIDC lookup.

/** Stored images never change: every pathname gets a random suffix, so a new image is a new URL. */
export const IMMUTABLE_CACHE_SECONDS = 365 * 24 * 60 * 60;

export type StoredBlob = { url: string; pathname: string; contentType: string };
export type BlobMeta = { url: string; pathname: string; size: number; contentType: string };

export type BlobStorage = {
  /** Public, random-suffixed, immutable upload of a server-made file. */
  put(pathname: string, body: Buffer, options: { contentType: string }): Promise<StoredBlob>;
  /** Deletes blobs by URL; an empty list makes no call. */
  del(urls: string | readonly string[]): Promise<void>;
  /** The blob's metadata, or null when this store has no blob at that URL. */
  head(url: string): Promise<BlobMeta | null>;
};

/** The SDK functions the storage wraps; tests pass recording fakes. */
export type BlobSdk = { put: typeof sdkPut; del: typeof sdkDel; head: typeof sdkHead };

const DEFAULT_SDK: BlobSdk = { put: sdkPut, del: sdkDel, head: sdkHead };

/**
 * A wrong or revoked token surfaces as one of these; that is a deployment
 * problem, not something the user can fix, so it becomes CONFIG (logged and
 * hidden from the client, D-053).
 */
function isConfigFailure(error: unknown): boolean {
  return (
    error instanceof BlobAccessError ||
    error instanceof BlobStoreNotFoundError ||
    error instanceof BlobStoreSuspendedError
  );
}

/** Converts an SDK failure into an AppError; the original stays as the cause for the server log. */
export function blobFailure(error: unknown, action: string): AppError {
  if (error instanceof AppError) return error;
  if (isConfigFailure(error)) {
    return new AppError("CONFIG", `Vercel Blob refused to ${action}: check BLOB_READ_WRITE_TOKEN.`, undefined, {
      cause: error,
    });
  }
  return new AppError("UPSTREAM", "The photo store is not responding. Try again in a moment.", undefined, {
    cause: error,
  });
}

export function createBlobStorage(token: string, sdk: BlobSdk = DEFAULT_SDK): BlobStorage {
  return {
    async put(pathname, body, { contentType }) {
      try {
        const result = await sdk.put(pathname, body, {
          access: "public",
          addRandomSuffix: true,
          contentType,
          cacheControlMaxAge: IMMUTABLE_CACHE_SECONDS,
          token,
        });
        return { url: result.url, pathname: result.pathname, contentType: result.contentType };
      } catch (error) {
        throw blobFailure(error, "store an image");
      }
    },

    async del(urls) {
      const list = typeof urls === "string" ? [urls] : [...urls];
      if (list.length === 0) return;
      try {
        await sdk.del(list, { token });
      } catch (error) {
        throw blobFailure(error, "delete an image");
      }
    },

    async head(url) {
      try {
        const meta = await sdk.head(url, { token });
        return { url: meta.url, pathname: meta.pathname, size: meta.size, contentType: meta.contentType };
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw blobFailure(error, "read an image's details");
      }
    },
  };
}

let instance: BlobStorage | undefined;

/** The app's storage, created on first use so builds and tests never need the token. */
export function getBlobStorage(): BlobStorage {
  instance ??= createBlobStorage(blobEnv().BLOB_READ_WRITE_TOKEN);
  return instance;
}

/**
 * Deletes blobs without letting a failure mask the error or result the caller
 * is already returning; a leftover blob is logged for manual cleanup.
 */
export async function deleteBlobsQuietly(storage: BlobStorage, urls: readonly string[], why: string): Promise<void> {
  if (urls.length === 0) return;
  try {
    await storage.del(urls);
  } catch (error) {
    console.error(`[blob] could not delete ${urls.length} blob(s) after ${why}:`, urls, error);
  }
}

export type RegisteredBlobExpectations = {
  /** The pathname the client reported; must equal the stored one. */
  pathname?: string;
  contentTypes?: readonly string[];
  maxBytes?: number;
};

const UNKNOWN_UPLOAD = "That upload was not found in the photo store. Upload the photo again.";

/**
 * Confirms that a client-reported URL is a blob in this app's store under
 * `expectedPrefix` (for example `items/<itemId>/original`), using the
 * documented head() rather than any assumption about the store's host name or
 * token format (D-031). Returns the store's own metadata; callers must use
 * `meta.url` from here on, never the client's string.
 */
export async function assertRegisteredBlob(
  storage: BlobStorage,
  url: string,
  expectedPrefix: string,
  expectations: RegisteredBlobExpectations = {},
): Promise<BlobMeta> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError("VALIDATION", UNKNOWN_UPLOAD, { reason: "malformed_url" });
  }
  // Blob URLs are always https and carry no query or fragment; anything else
  // cannot be an upload of ours, so it never reaches the store or fetch().
  if (parsed.protocol !== "https:" || parsed.search !== "" || parsed.hash !== "") {
    throw new AppError("VALIDATION", UNKNOWN_UPLOAD, { reason: "not_a_blob_url" });
  }

  const meta = await storage.head(parsed.href);
  if (meta === null) throw new AppError("VALIDATION", UNKNOWN_UPLOAD, { reason: "not_in_store" });

  // head() resolves a URL to a blob of this store; insisting that the store's
  // URL is the one we were given means a look-alike on another host can never
  // be fetched later.
  if (new URL(meta.url).href !== parsed.href) {
    throw new AppError("VALIDATION", UNKNOWN_UPLOAD, { reason: "url_mismatch" });
  }
  if (!meta.pathname.startsWith(expectedPrefix)) {
    throw new AppError("VALIDATION", "That upload belongs to a different photo.", { reason: "wrong_pathname" });
  }
  if (expectations.pathname !== undefined && expectations.pathname !== meta.pathname) {
    throw new AppError("VALIDATION", "That upload belongs to a different photo.", { reason: "pathname_mismatch" });
  }
  if (expectations.contentTypes !== undefined && !expectations.contentTypes.includes(meta.contentType)) {
    throw new AppError("VALIDATION", "That file type is not supported.", { reason: "content_type" });
  }
  if (expectations.maxBytes !== undefined && meta.size > expectations.maxBytes) {
    throw new AppError("VALIDATION", "That photo is too large.", { reason: "too_large" });
  }
  return meta;
}
