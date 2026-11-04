import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { BlobRequestAbortedError, del, head, put } from "@vercel/blob";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "@/lib/result";

import { createBlobStorage, type BlobSdk } from "./blob";

// The deadline of BlobStorage.del against the real @vercel/blob SDK (D-237).
// A fake SDK cannot show what matters here: that the SDK, which retries a 5xx
// or a network error ten times with doubling waits, really stops once the
// signal is aborted. The SDK talks to a stub of the Blob API on 127.0.0.1
// through its own VERCEL_BLOB_API_URL override, so nothing leaves the machine.

const TOKEN = "vercel_blob_rw_sdkteststore_notarealsecret";
const URLS = ["https://sdkteststore.public.blob.vercel-storage.com/items/a/thumb.webp"];

type Mode = "unavailable" | "silent";

let server: Server;
let mode: Mode = "unavailable";
let requests = 0;
const saved = { apiUrl: process.env.VERCEL_BLOB_API_URL, retries: process.env.VERCEL_BLOB_RETRIES };

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      // A store that accepts the connection and never answers.
      if (mode === "silent") return;
      // A store outage: a code the SDK retries.
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "service_unavailable", message: "stub outage" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${port}`;
  // The SDK's default of ten retries, whatever the shell says.
  delete process.env.VERCEL_BLOB_RETRIES;
});

beforeEach(() => {
  requests = 0;
});

afterAll(async () => {
  if (saved.apiUrl === undefined) delete process.env.VERCEL_BLOB_API_URL;
  else process.env.VERCEL_BLOB_API_URL = saved.apiUrl;
  if (saved.retries !== undefined) process.env.VERCEL_BLOB_RETRIES = saved.retries;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The real SDK, with each del() call's own promise kept, so a test can see when the SDK itself stops. */
function realSdk(): { sdk: BlobSdk; calls: Array<Promise<void>> } {
  const calls: Array<Promise<void>> = [];
  const sdk: BlobSdk = {
    put,
    head,
    del: (target, options) => {
      const call = del(target, options);
      // Settled after the storage has given up; observed by the test below.
      call.catch(() => undefined);
      calls.push(call);
      return call;
    },
  };
  return { sdk, calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("BlobStorage.del with timeoutMs and the real SDK", () => {
  it.each<[string, Mode]>([
    ["a store that answers 503 service_unavailable", "unavailable"],
    ["a store that never answers", "silent"],
  ])("gives up at the deadline on %s, and the SDK stops retrying", async (_label, stubMode) => {
    mode = stubMode;
    const { sdk, calls } = realSdk();
    const started = Date.now();

    const error = await rejection(createBlobStorage(TOKEN, sdk).del(URLS, { timeoutMs: 1_500 }));

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(3_000);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "UPSTREAM" });
    expect(requests).toBeGreaterThanOrEqual(1);

    // The SDK's own call ends with its "aborted" error at its next attempt
    // (after the wait it was in), instead of retrying for many minutes.
    const [call] = calls;
    if (call === undefined) throw new Error("the SDK was not called");
    expect(await rejection(call)).toBeInstanceOf(BlobRequestAbortedError);
    expect(Date.now() - started).toBeLessThan(10_000);
    const requestsAtEnd = requests;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(requests).toBe(requestsAtEnd);
  }, 20_000);
});
