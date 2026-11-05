import { randomUUID } from "node:crypto";

import { BlobAccessError, BlobNotFoundError, BlobServiceNotAvailable, type HeadBlobResult, type PutBlobResult } from "@vercel/blob";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nobgUploadPrefix, originalUploadPathname, originalUploadPrefix, UPLOAD_LIMITS } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";

import { createFakeBlobStorage, FAKE_BLOB_ORIGIN } from "../../../test/fakes/blob";
import {
  assertRegisteredBlob,
  blobFailure,
  createBlobStorage,
  IMMUTABLE_CACHE_SECONDS,
  type BlobSdk,
} from "./blob";

const TOKEN = "vercel_blob_rw_fakestore_notarealsecret";

function headResult(pathname: string): HeadBlobResult {
  const url = `${FAKE_BLOB_ORIGIN}/${pathname}`;
  return {
    url,
    downloadUrl: `${url}?download=1`,
    pathname,
    size: 1234,
    contentType: "image/jpeg",
    contentDisposition: "inline",
    cacheControl: "public, max-age=31536000",
    uploadedAt: new Date(0),
    etag: "etag",
  };
}

function recordingSdk() {
  const put = vi.fn<BlobSdk["put"]>(async (pathname) => {
    const url = `${FAKE_BLOB_ORIGIN}/${pathname}`;
    const result: PutBlobResult = {
      url,
      downloadUrl: `${url}?download=1`,
      pathname,
      contentType: "image/webp",
      contentDisposition: "inline",
      etag: "etag",
    };
    return result;
  });
  const del = vi.fn<BlobSdk["del"]>(async () => undefined);
  const head = vi.fn<BlobSdk["head"]>(async (url) => headResult(new URL(url).pathname.slice(1)));
  return { put, del, head };
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createBlobStorage", () => {
  it("passes the token to every put, del and head", async () => {
    const sdk = recordingSdk();
    const storage = createBlobStorage(TOKEN, sdk);

    await storage.put("items/x/processed.webp", Buffer.from("webp"), { contentType: "image/webp" });
    await storage.del(["https://a.example/1", "https://a.example/2"]);
    await storage.del("https://a.example/3");
    await storage.head(`${FAKE_BLOB_ORIGIN}/items/x/original.jpg`);

    const calls = [...sdk.put.mock.calls, ...sdk.del.mock.calls, ...sdk.head.mock.calls];
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.at(-1)).toMatchObject({ token: TOKEN });
  });

  it("puts public, random-suffixed, long-cached blobs with an explicit content type", async () => {
    const sdk = recordingSdk();
    const stored = await createBlobStorage(TOKEN, sdk).put("items/x/thumb.webp", Buffer.from("webp"), {
      contentType: "image/webp",
    });

    expect(sdk.put).toHaveBeenCalledWith("items/x/thumb.webp", Buffer.from("webp"), {
      access: "public",
      addRandomSuffix: true,
      contentType: "image/webp",
      cacheControlMaxAge: IMMUTABLE_CACHE_SECONDS,
      token: TOKEN,
    });
    expect(stored).toEqual({
      url: `${FAKE_BLOB_ORIGIN}/items/x/thumb.webp`,
      pathname: "items/x/thumb.webp",
      contentType: "image/webp",
    });
    expect(IMMUTABLE_CACHE_SECONDS).toBeGreaterThanOrEqual(365 * 24 * 60 * 60);
  });

  it("makes no delete call for an empty list", async () => {
    const sdk = recordingSdk();
    await createBlobStorage(TOKEN, sdk).del([]);
    expect(sdk.del).not.toHaveBeenCalled();
  });

  it("treats a blob the store does not have as deleted", async () => {
    const sdk = recordingSdk();
    sdk.del.mockRejectedValue(new BlobNotFoundError());
    await expect(createBlobStorage(TOKEN, sdk).del("https://a.example/gone")).resolves.toBeUndefined();
    expect(sdk.del.mock.calls).toEqual([["https://a.example/gone", { token: TOKEN }]]);
  });

  it("deletes each URL on its own when a list holds a missing blob, and still fails on other errors", async () => {
    const urls = ["https://a.example/1", "https://a.example/gone", "https://a.example/3"];
    const sdk = recordingSdk();
    sdk.del.mockImplementation(async (target) => {
      if (Array.isArray(target) || target === "https://a.example/gone") throw new BlobNotFoundError();
    });

    await expect(createBlobStorage(TOKEN, sdk).del(urls)).resolves.toBeUndefined();
    expect(sdk.del.mock.calls).toEqual([
      [urls, { token: TOKEN }],
      ["https://a.example/1", { token: TOKEN }],
      ["https://a.example/gone", { token: TOKEN }],
      ["https://a.example/3", { token: TOKEN }],
    ]);

    const failing = recordingSdk();
    failing.del.mockImplementation(async (target) => {
      if (Array.isArray(target)) throw new BlobNotFoundError();
      if (target === "https://a.example/3") throw new BlobServiceNotAvailable();
    });
    expect(await thrownBy(createBlobStorage(TOKEN, failing).del(urls))).toMatchObject({ code: "UPSTREAM" });
  });

  it("gives up on a delete the store never answers after timeoutMs, aborting the SDK call with an AbortError", async () => {
    const urls = ["https://a.example/1", "https://a.example/2"];
    const sdk = recordingSdk();
    sdk.del.mockImplementation(() => new Promise<never>(() => undefined));
    const started = Date.now();

    const error = await thrownBy(createBlobStorage(TOKEN, sdk).del(urls, { timeoutMs: 50 }));

    expect(Date.now() - started).toBeLessThan(1_000);
    if (!(error instanceof AppError)) throw new Error("expected an AppError");
    expect(error).toMatchObject({ code: "UPSTREAM", message: "The photo store is not responding. Try again in a moment." });
    expect(error.cause).toEqual(new Error("Vercel Blob did not answer within 50 ms"));
    expect(sdk.del.mock.calls).toEqual([[urls, { token: TOKEN, abortSignal: expect.any(AbortSignal) }]]);
    const signal = sdk.del.mock.calls[0]?.[1]?.abortSignal;
    expect(signal?.aborted).toBe(true);
    // The SDK stops retrying only for a DOMException named AbortError; the
    // TimeoutError of AbortSignal.timeout() would be retried for minutes.
    expect(signal?.reason).toBeInstanceOf(DOMException);
    expect(signal?.reason).toMatchObject({ name: "AbortError" });
  });

  it("gives one deadline to the whole delete, the one-by-one deletes after a not-found included", async () => {
    const urls = ["https://a.example/1", "https://a.example/gone"];
    const sdk = recordingSdk();
    sdk.del.mockImplementation((target) =>
      Array.isArray(target) ? Promise.reject(new BlobNotFoundError()) : new Promise<never>(() => undefined),
    );

    expect(await thrownBy(createBlobStorage(TOKEN, sdk).del(urls, { timeoutMs: 50 }))).toMatchObject({
      code: "UPSTREAM",
    });

    // The list, then the first URL on its own, which never answered.
    expect(sdk.del.mock.calls.map((call) => call[0])).toEqual([urls, "https://a.example/1"]);
    const signals = sdk.del.mock.calls.map((call) => call[1]?.abortSignal);
    expect(new Set(signals).size).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("answers as before when the store answers within timeoutMs, and aborts nothing afterwards", async () => {
    const sdk = recordingSdk();

    await expect(createBlobStorage(TOKEN, sdk).del("https://a.example/1", { timeoutMs: 20 })).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sdk.del.mock.calls[0]?.[1]?.abortSignal?.aborted).toBe(false);
  });

  it("answers null from head for a blob the store does not have", async () => {
    const sdk = recordingSdk();
    sdk.head.mockRejectedValue(new BlobNotFoundError());
    expect(await createBlobStorage(TOKEN, sdk).head(`${FAKE_BLOB_ORIGIN}/nope.jpg`)).toBeNull();
  });

  it("turns token problems into CONFIG and outages into UPSTREAM", async () => {
    const refused = recordingSdk();
    refused.put.mockRejectedValue(new BlobAccessError());
    const config = await thrownBy(
      createBlobStorage(TOKEN, refused).put("a.webp", Buffer.from("x"), { contentType: "image/webp" }),
    );
    expect(config).toMatchObject({ code: "CONFIG" });
    expect((config as AppError).cause).toBeInstanceOf(BlobAccessError);

    const down = recordingSdk();
    down.head.mockRejectedValue(new BlobServiceNotAvailable());
    expect(await thrownBy(createBlobStorage(TOKEN, down).head(`${FAKE_BLOB_ORIGIN}/a.jpg`))).toMatchObject({
      code: "UPSTREAM",
    });
  });

  it("leaves an AppError untouched", () => {
    const original = new AppError("VALIDATION", "no");
    expect(blobFailure(original, "x")).toBe(original);
  });
});

describe("assertRegisteredBlob", () => {
  const itemId = randomUUID();

  function uploadedOriginal() {
    const fake = createFakeBlobStorage();
    const blob = fake.upload(originalUploadPathname(itemId), Buffer.from("jpeg bytes"), "image/jpeg");
    return { fake, blob };
  }

  async function expectRejected(promise: Promise<unknown>, reason: string) {
    const error = await thrownBy(promise);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "VALIDATION", details: { reason } });
  }

  it("returns the store's metadata for this item's original", async () => {
    const { fake, blob } = uploadedOriginal();
    const meta = await assertRegisteredBlob(fake, blob.url, originalUploadPrefix(itemId), {
      pathname: blob.pathname,
      contentTypes: UPLOAD_LIMITS.originalContentTypes,
      maxBytes: UPLOAD_LIMITS.originalMaxBytes,
    });
    expect(meta).toEqual({ url: blob.url, pathname: blob.pathname, size: 10, contentType: "image/jpeg" });
  });

  it("rejects http and URLs with a query or fragment without asking the store", async () => {
    const { fake, blob } = uploadedOriginal();
    const prefix = originalUploadPrefix(itemId);
    await expectRejected(assertRegisteredBlob(fake, blob.url.replace("https:", "http:"), prefix), "not_a_blob_url");
    await expectRejected(assertRegisteredBlob(fake, `${blob.url}?download=1`, prefix), "not_a_blob_url");
    await expectRejected(assertRegisteredBlob(fake, `${blob.url}#x`, prefix), "not_a_blob_url");
    await expectRejected(assertRegisteredBlob(fake, "not a url", prefix), "malformed_url");
    expect(fake.calls).toEqual([]);
  });

  it("rejects a blob outside the store (head finds nothing)", async () => {
    const { fake } = uploadedOriginal();
    const foreign = `https://other-store.public.blob.vercel-storage.com/${originalUploadPathname(itemId)}`;
    await expectRejected(assertRegisteredBlob(fake, foreign, originalUploadPrefix(itemId)), "not_in_store");
  });

  it("rejects a URL the store resolves to a different URL", async () => {
    const { blob } = uploadedOriginal();
    const lookAlike = `https://evil.example/${blob.pathname}`;
    const sdk = recordingSdk();
    // The store knows the blob by its path and reports its own URL.
    sdk.head.mockResolvedValue(headResult(blob.pathname));
    const storage = createBlobStorage(TOKEN, sdk);
    await expectRejected(assertRegisteredBlob(storage, lookAlike, originalUploadPrefix(itemId)), "url_mismatch");
  });

  it("rejects another item's upload and the other kind of upload", async () => {
    const { fake, blob } = uploadedOriginal();
    await expectRejected(assertRegisteredBlob(fake, blob.url, originalUploadPrefix(randomUUID())), "wrong_pathname");
    await expectRejected(assertRegisteredBlob(fake, blob.url, nobgUploadPrefix(itemId)), "wrong_pathname");
  });

  it("checks the reported pathname, content type and size when asked", async () => {
    const { fake, blob } = uploadedOriginal();
    const prefix = originalUploadPrefix(itemId);
    await expectRejected(
      assertRegisteredBlob(fake, blob.url, prefix, { pathname: originalUploadPathname(itemId) }),
      "pathname_mismatch",
    );
    await expectRejected(
      assertRegisteredBlob(fake, blob.url, prefix, { contentTypes: UPLOAD_LIMITS.nobgContentTypes }),
      "content_type",
    );
    await expectRejected(assertRegisteredBlob(fake, blob.url, prefix, { maxBytes: 5 }), "too_large");
  });
});
