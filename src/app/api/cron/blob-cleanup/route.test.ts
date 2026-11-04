import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { blobCleanup, type BlobCleanup } from "@/lib/db/schema";
import type { BlobStorage } from "@/lib/images/blob";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";
import { CLEANUP_CALL_TIMEOUT_MS } from "@/server/services/blob-cleanup";

import { makeTestDb, type TestDb } from "../../../../../test/db";
import { createFakeBlobStorage, type FakeBlobStorage } from "../../../../../test/fakes/blob";

// The route with the real cleanup over PGlite and the fake store: only the
// environment, the database handle and the storage getter are replaced.

const SECRET = "fake-cron-secret-0123456789";

const mocks = vi.hoisted(() => ({
  cronEnv: vi.fn(),
  getBlobStorage: vi.fn(),
  db: { current: undefined as unknown },
}));
vi.mock("@/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/env")>()),
  cronEnv: mocks.cronEnv,
}));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));
vi.mock("@/lib/images/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/images/blob")>()),
  getBlobStorage: mocks.getBlobStorage,
}));

const route = await import("./route");

let testDb: TestDb;
let storage: FakeBlobStorage;

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  storage = createFakeBlobStorage();
  mocks.cronEnv.mockReset();
  mocks.cronEnv.mockReturnValue({ CRON_SECRET: SECRET });
  mocks.getBlobStorage.mockReset();
  mocks.getBlobStorage.mockReturnValue(storage);
});

afterAll(async () => {
  await testDb.close();
});

function call(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return route.GET(new Request("http://localhost:3000/api/cron/blob-cleanup", { headers }));
}

/** Two files of a deleted item, in the store and in the queue. */
async function queueDeletedItem(): Promise<string[]> {
  const itemId = randomUUID();
  const urls = ["original", "thumb"].map(
    (kind) => storage.upload(`items/${itemId}/${kind}.webp`, Buffer.from(kind), "image/webp").url,
  );
  await testDb.db.insert(blobCleanup).values(urls.map((url) => ({ url, itemId, reason: "item_deleted" })));
  return urls;
}

async function queued(): Promise<BlobCleanup[]> {
  return testDb.db.select().from(blobCleanup);
}

describe("GET /api/cron/blob-cleanup", () => {
  it("allows the Hobby maximum of 300 s", () => {
    expect(route.maxDuration).toBe(300);
  });

  it.each([
    ["no Authorization header", undefined],
    ["a wrong secret", "Bearer not-the-secret-at-all"],
    ["the secret without the Bearer scheme", SECRET],
    ["a secret with a prefix of the right one", `Bearer ${SECRET.slice(0, -1)}`],
  ])("answers 401 for %s without touching the queue or Blob", async (_label, header) => {
    const urls = await queueDeletedItem();

    const response = await call(header);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Missing or wrong cron secret." },
    });
    expect(mocks.getBlobStorage).not.toHaveBeenCalled();
    expect(storage.calls).toEqual([]);
    expect((await queued()).map((row) => row.attempts)).toEqual(urls.map(() => 0));
  });

  it("deletes the queued files with the right secret and returns the counts", async () => {
    const first = await queueDeletedItem();
    const second = await queueDeletedItem();

    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { deleted: 4, pending: 0, error: null } });
    for (const url of [...first, ...second]) expect(storage.blobs.has(url)).toBe(false);
    expect(await queued()).toEqual([]);
  });

  it("ends its Blob calls 30 s before maxDuration, so a slow store still gets an answer", async () => {
    for (let index = 0; index < 4; index += 1) await queueDeletedItem();
    const timeouts: Array<number | undefined> = [];
    // Each call takes 90 s of the clock: 270, 180 and 90 s are left before
    // the three calls, then none. Without the margin, a fourth would start
    // with 30 s left.
    const slow: BlobStorage = {
      ...storage,
      async del(target, options) {
        timeouts.push(options?.timeoutMs);
        vi.setSystemTime(Date.now() + 90_000);
        return storage.del(target);
      },
    };
    mocks.getBlobStorage.mockReturnValue(slow);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T05:00:00Z"));
    let response: Response;
    try {
      response = await call(`Bearer ${SECRET}`);
    } finally {
      vi.useRealTimers();
    }

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { deleted: 6, pending: 2, error: null } });
    expect(timeouts).toEqual([CLEANUP_CALL_TIMEOUT_MS, CLEANUP_CALL_TIMEOUT_MS, CLEANUP_CALL_TIMEOUT_MS]);
  });

  it("answers with the Blob failure's status, keeps the counts and leaves the files queued", async () => {
    await queueDeletedItem();
    storage.failNext("del", new Error("socket hang up"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await call(`Bearer ${SECRET}`);

    consoleError.mockRestore();
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const error = { code: "UPSTREAM", message: "The photo store is not responding. Try again in a moment." };
    expect(await response.json()).toEqual({ ok: false, error, data: { deleted: 0, pending: 2, error } });
    expect((await queued()).map((row) => row.attempts)).toEqual([1, 1]);
  });

  it("answers 500 without detail and leaves the queue alone when BLOB_READ_WRITE_TOKEN is missing", async () => {
    await queueDeletedItem();
    mocks.getBlobStorage.mockImplementation(() => {
      throw new AppError("CONFIG", "Invalid server configuration (blob): BLOB_READ_WRITE_TOKEN is required.");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    expect(storage.calls).toEqual([]);
    expect((await queued()).map((row) => ({ attempts: row.attempts, lastAttemptAt: row.lastAttemptAt }))).toEqual([
      { attempts: 0, lastAttemptAt: null },
      { attempts: 0, lastAttemptAt: null },
    ]);
  });

  it("answers 500 without detail when CRON_SECRET is not configured", async () => {
    await queueDeletedItem();
    mocks.cronEnv.mockImplementation(() => {
      throw new AppError("CONFIG", "Invalid server configuration (cron): CRON_SECRET is required.", {
        variables: ["CRON_SECRET"],
      });
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } });
    consoleError.mockRestore();
    expect(mocks.getBlobStorage).not.toHaveBeenCalled();
    expect(storage.calls).toEqual([]);
  });
});
