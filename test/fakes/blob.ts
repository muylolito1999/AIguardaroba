import { randomBytes } from "node:crypto";

import type { BlobMeta, BlobStorage, StoredBlob } from "@/lib/images/blob";

// In-memory stand-in for Vercel Blob (D-046): the BlobStorage the services
// take, a simulated browser upload, and a fetch that serves stored blobs, so
// tests never touch the network.

export const FAKE_BLOB_ORIGIN = "https://fakestore.public.blob.vercel-storage.com";

export type FakeBlob = StoredBlob & { body: Buffer };

type Method = "put" | "del" | "head";

export type FakeBlobStorage = BlobStorage & {
  /** Every stored blob by URL. */
  readonly blobs: Map<string, FakeBlob>;
  /** Every call in order: put records the requested pathname, del the URLs, head the URL. */
  readonly calls: Array<{ method: Method; target: string | string[] }>;
  /** URLs requested through `fetch`. */
  readonly fetched: string[];
  /** Stores a blob as a client upload with a token would (random suffix included). */
  upload(pathname: string, body: Buffer, contentType: string): FakeBlob;
  /** Makes the next call of `method` throw `error`. */
  failNext(method: Method, error: unknown): void;
  /** Serves stored blobs by URL with Content-Type and Content-Length, 404 otherwise. */
  fetch: typeof fetch;
  /** URLs of stored blobs whose pathname starts with `prefix`. */
  urlsUnder(prefix: string): string[];
};

function withRandomSuffix(pathname: string): string {
  const suffix = randomBytes(15).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 20) || "x";
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  return dot > slash ? `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}` : `${pathname}-${suffix}`;
}

export function createFakeBlobStorage(): FakeBlobStorage {
  const blobs = new Map<string, FakeBlob>();
  const calls: FakeBlobStorage["calls"] = [];
  const fetched: string[] = [];
  const failures = new Map<Method, unknown[]>();

  function takeFailure(method: Method): void {
    const queue = failures.get(method);
    if (queue !== undefined && queue.length > 0) throw queue.shift();
  }

  function store(pathname: string, body: Buffer, contentType: string): FakeBlob {
    const stored = withRandomSuffix(pathname);
    const blob: FakeBlob = { url: `${FAKE_BLOB_ORIGIN}/${stored}`, pathname: stored, contentType, body };
    blobs.set(blob.url, blob);
    return blob;
  }

  return {
    blobs,
    calls,
    fetched,

    async put(pathname, body, { contentType }) {
      calls.push({ method: "put", target: pathname });
      takeFailure("put");
      const { url, pathname: storedPath } = store(pathname, body, contentType);
      return { url, pathname: storedPath, contentType };
    },

    async del(urls) {
      const list = typeof urls === "string" ? [urls] : [...urls];
      calls.push({ method: "del", target: list });
      takeFailure("del");
      for (const url of list) blobs.delete(url);
    },

    async head(url): Promise<BlobMeta | null> {
      calls.push({ method: "head", target: url });
      takeFailure("head");
      const blob = blobs.get(url);
      if (blob === undefined) return null;
      return { url: blob.url, pathname: blob.pathname, size: blob.body.length, contentType: blob.contentType };
    },

    upload: store,

    failNext(method, error) {
      failures.set(method, [...(failures.get(method) ?? []), error]);
    },

    async fetch(input) {
      const url = input instanceof Request ? input.url : String(input);
      fetched.push(url);
      const blob = blobs.get(url);
      if (blob === undefined) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(blob.body), {
        status: 200,
        headers: { "content-type": blob.contentType, "content-length": String(blob.body.length) },
      });
    },

    urlsUnder(prefix) {
      return [...blobs.values()].filter((blob) => blob.pathname.startsWith(prefix)).map((blob) => blob.url);
    },
  };
}
