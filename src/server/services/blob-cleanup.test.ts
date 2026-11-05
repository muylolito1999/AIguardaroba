import { randomUUID } from "node:crypto";

import { BlobNotFoundError } from "@vercel/blob";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { blobCleanup, type BlobCleanup } from "@/lib/db/schema";
import { createBlobStorage, type BlobSdk, type BlobStorage } from "@/lib/images/blob";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { createFakeBlobStorage, type FakeBlobStorage } from "../../../test/fakes/blob";
import { CLEANUP_CALL_TIMEOUT_MS, deleteOrQueue, MIN_CALL_MS, runBlobCleanup } from "./blob-cleanup";

// The queue worker on its own; deleteItem's use of it is tested in
// item-lifecycle.test.ts and the cron route's in its route test.

let testDb: TestDb;
let storage: FakeBlobStorage;
const NOW = new Date("2026-11-04T10:00:00Z");
const MINUTE = 60_000;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  storage = createFakeBlobStorage();
});

afterAll(async () => {
  await testDb.close();
});

function deps(target: BlobStorage = storage) {
  return { db: testDb.db, storage: target, now: () => NOW };
}

/** A deadline no test here comes near, for the runs that are not about it. */
function roomy(): number {
  return Date.now() + 60_000;
}

/** The real storage over an SDK whose del() never answers, as a store that keeps the connection open. */
function silentStorage(): { storage: BlobStorage; del: Mock<BlobSdk["del"]> } {
  const del = vi.fn<BlobSdk["del"]>(() => new Promise<never>(() => undefined));
  const sdk: BlobSdk = { put: vi.fn<BlobSdk["put"]>(), del, head: vi.fn<BlobSdk["head"]>() };
  return { storage: createBlobStorage("vercel_blob_rw_fakestore_notarealsecret", sdk), del };
}

/** Queues `count` stored files of one deleted item, as deleteItem does. */
async function queueItem(
  count: number,
  row: Partial<Pick<BlobCleanup, "attempts" | "lastAttemptAt" | "createdAt">> = {},
): Promise<{ itemId: string; urls: string[] }> {
  const itemId = randomUUID();
  const urls = Array.from(
    { length: count },
    (_, index) => storage.upload(`items/${itemId}/${index}.webp`, Buffer.from("x"), "image/webp").url,
  );
  await testDb.db.insert(blobCleanup).values(urls.map((url) => ({ url, itemId, reason: "item_deleted", ...row })));
  return { itemId, urls };
}

async function queued(): Promise<BlobCleanup[]> {
  return testDb.db.select().from(blobCleanup).orderBy(blobCleanup.createdAt, blobCleanup.url);
}

function delTargets(): string[][] {
  return storage.calls.filter((call) => call.method === "del").map((call) => [...call.target].sort());
}

describe("deleteOrQueue (D-245)", () => {
  it("deletes the files and queues nothing when Blob answers", async () => {
    const itemId = randomUUID();
    const file = storage.upload(`items/${itemId}/original.jpg`, Buffer.from("x"), "image/jpeg");
    await deleteOrQueue(testDb.db, storage, [file.url], itemId, "upload_abandoned", "a test");
    expect(storage.blobs.has(file.url)).toBe(false);
    expect(await queued()).toEqual([]);
  });

  it("queues the files with their reason when Blob fails, for the cron to retry", async () => {
    const itemId = randomUUID();
    const file = storage.upload(`items/${itemId}/original.jpg`, Buffer.from("x"), "image/jpeg");
    storage.failNext("del", new Error("Blob is down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await deleteOrQueue(testDb.db, storage, [file.url], itemId, "upload_abandoned", "a test");
    error.mockRestore();

    expect(await queued()).toMatchObject([{ url: file.url, itemId, reason: "upload_abandoned", attempts: 0 }]);
    expect(await runBlobCleanup(deps(), { deadlineAt: roomy(), maxItems: 10 })).toMatchObject({ deleted: 1, pending: 0 });
    expect(storage.blobs.has(file.url)).toBe(false);
  });

  it("never throws, even when the queue cannot be written either", async () => {
    storage.failNext("del", new Error("Blob is down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const insert = vi.spyOn(testDb.db, "insert").mockImplementation(() => {
      throw new Error("database is down");
    });
    try {
      await expect(deleteOrQueue(testDb.db, storage, ["https://x.example/a"], randomUUID(), "upload_abandoned", "a test")).resolves.toBeUndefined();
      expect(String(error.mock.calls.at(-1)?.[0])).toMatch(/could not queue/);
    } finally {
      insert.mockRestore();
      error.mockRestore();
    }
  });

  it("does nothing for no files", async () => {
    await deleteOrQueue(testDb.db, storage, [], randomUUID(), "upload_abandoned", "a test");
    expect(storage.calls).toEqual([]);
  });
});

describe("runBlobCleanup", () => {
  it("makes no Blob call for an empty queue", async () => {
    expect(await runBlobCleanup(deps(), { deadlineAt: roomy(), maxItems: 10 })).toEqual({ deleted: 0, pending: 0, error: null });
    expect(storage.calls).toEqual([]);
  });

  it("deletes every queued file with one call per item and empties the queue", async () => {
    const a = await queueItem(4, { createdAt: new Date(NOW.getTime() - 2 * MINUTE) });
    const b = await queueItem(2, { createdAt: new Date(NOW.getTime() - MINUTE) });

    expect(await runBlobCleanup(deps(), { deadlineAt: roomy(), maxItems: 10 })).toEqual({ deleted: 6, pending: 0, error: null });

    expect(delTargets()).toEqual([[...a.urls].sort(), [...b.urls].sort()]);
    for (const url of [...a.urls, ...b.urls]) expect(storage.blobs.has(url)).toBe(false);
    expect(await queued()).toEqual([]);
  });

  it("counts a file the store no longer has as deleted", async () => {
    const { urls } = await queueItem(2);
    // The real storage over an SDK that says the blobs do not exist.
    const del = vi.fn<BlobSdk["del"]>(async () => {
      throw new BlobNotFoundError();
    });
    const sdk: BlobSdk = { put: vi.fn<BlobSdk["put"]>(), del, head: vi.fn<BlobSdk["head"]>() };
    const real = createBlobStorage("vercel_blob_rw_fakestore_notarealsecret", sdk);

    expect(await runBlobCleanup(deps(real), { deadlineAt: roomy(), maxItems: 10 })).toEqual({ deleted: 2, pending: 0, error: null });
    // One call for the item, then one per URL after the store's "not found".
    const [group, ...singles] = del.mock.calls.map((call) => call[0]);
    expect(Array.isArray(group) ? [...group].sort() : group).toEqual([...urls].sort());
    expect([...singles].sort()).toEqual([...urls].sort());
    expect(await queued()).toEqual([]);
  });

  it("records the attempt before the Blob call", async () => {
    await queueItem(2);
    const seen: Array<Pick<BlobCleanup, "attempts" | "lastAttemptAt">> = [];
    const recording: BlobStorage = {
      ...storage,
      async del(target) {
        for (const row of await queued()) seen.push({ attempts: row.attempts, lastAttemptAt: row.lastAttemptAt });
        return storage.del(target);
      },
    };

    await runBlobCleanup(deps(recording), { deadlineAt: roomy(), maxItems: 10 });

    expect(seen).toEqual([
      { attempts: 1, lastAttemptAt: NOW },
      { attempts: 1, lastAttemptAt: NOW },
    ]);
  });

  it("keeps the files queued with the error and ends the run at the first failure", async () => {
    const first = await queueItem(2, { createdAt: new Date(NOW.getTime() - 2 * MINUTE) });
    const second = await queueItem(1, { createdAt: new Date(NOW.getTime() - MINUTE) });
    storage.failNext("del", new Error("socket hang up"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const summary = await runBlobCleanup(deps(), { deadlineAt: roomy(), maxItems: 10 });

    expect(summary).toEqual({
      deleted: 0,
      pending: 3,
      error: { code: "UPSTREAM", message: "The photo store is not responding. Try again in a moment." },
    });
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
    // The second item was not tried: the store had just failed.
    expect(delTargets()).toEqual([[...first.urls].sort()]);
    const rows = await queued();
    for (const row of rows.filter((entry) => entry.itemId === first.itemId)) {
      expect(row).toMatchObject({ attempts: 1, lastAttemptAt: NOW });
      expect(row.lastError).toBe("UPSTREAM: The photo store is not responding. Try again in a moment. (socket hang up)");
    }
    expect(rows.find((entry) => entry.itemId === second.itemId)).toMatchObject({
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    });
    for (const url of [...first.urls, ...second.urls]) expect(storage.blobs.has(url)).toBe(true);
  });

  it("tries a file that failed after the others, so it cannot block them", async () => {
    const failing = await queueItem(1, { createdAt: new Date(NOW.getTime() - 2 * MINUTE) });
    const other = await queueItem(1, { createdAt: new Date(NOW.getTime() - MINUTE) });
    storage.failNext("del", new Error("bad request"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runBlobCleanup(deps(), { deadlineAt: roomy(), maxItems: 10 });
    consoleError.mockRestore();

    expect(await runBlobCleanup(deps(), { deadlineAt: roomy(), maxItems: 10 })).toEqual({ deleted: 2, pending: 0, error: null });
    // The second run took the never-tried file first.
    expect(delTargets()).toEqual([failing.urls, other.urls, failing.urls]);
  });

  it("returns a token problem as CONFIG without its detail and stores the detail", async () => {
    await queueItem(1);
    storage.failNext("del", new AppError("CONFIG", "Vercel Blob refused to delete an image: check BLOB_READ_WRITE_TOKEN."));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const summary = await runBlobCleanup(deps(), { deadlineAt: roomy(), maxItems: 10 });

    consoleError.mockRestore();
    expect(summary.error).toEqual({ code: "CONFIG", message: CONFIG_ERROR_MESSAGE });
    expect((await queued())[0]?.lastError).toBe(
      "CONFIG: Vercel Blob refused to delete an image: check BLOB_READ_WRITE_TOKEN.",
    );
  });

  it("takes the given item first and at most maxItems items", async () => {
    const oldest = await queueItem(4, { createdAt: new Date(NOW.getTime() - 3 * MINUTE) });
    const middle = await queueItem(4, { createdAt: new Date(NOW.getTime() - 2 * MINUTE) });
    const newest = await queueItem(4, { createdAt: new Date(NOW.getTime() - MINUTE) });

    expect(await runBlobCleanup(deps(), { deadlineAt: roomy(), maxItems: 2, firstItemId: newest.itemId })).toEqual({
      deleted: 8,
      pending: 4,
      error: null,
    });

    expect(delTargets()).toEqual([[...newest.urls].sort(), [...oldest.urls].sort()]);
    expect((await queued()).map((row) => row.itemId)).toEqual(Array(4).fill(middle.itemId));
  });

  it("leaves files tried within retryAfterMs for a later run", async () => {
    const recent = await queueItem(1, { attempts: 1, lastAttemptAt: new Date(NOW.getTime() - 10 * MINUTE) });
    const earlier = await queueItem(1, { attempts: 3, lastAttemptAt: new Date(NOW.getTime() - 61 * MINUTE) });
    const never = await queueItem(1);

    expect(await runBlobCleanup(deps(), { deadlineAt: roomy(), maxItems: 10, retryAfterMs: 60 * MINUTE })).toEqual({
      deleted: 2,
      pending: 1,
      error: null,
    });

    expect(delTargets()).toEqual([never.urls, earlier.urls]);
    expect((await queued()).map((row) => row.url)).toEqual(recent.urls);
  });

  it("ends a call the store does not answer at the deadline, stores that failure and starts no other item", async () => {
    const first = await queueItem(2, { createdAt: new Date(NOW.getTime() - 2 * MINUTE) });
    const second = await queueItem(1, { createdAt: new Date(NOW.getTime() - MINUTE) });
    const silent = silentStorage();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const started = Date.now();

    const summary = await runBlobCleanup(deps(silent.storage), { deadlineAt: started + MIN_CALL_MS + 300, maxItems: 10 });

    expect(Date.now() - started).toBeLessThan(MIN_CALL_MS + 1_000);
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
    expect(summary).toEqual({
      deleted: 0,
      pending: 3,
      error: { code: "UPSTREAM", message: "The photo store is not responding. Try again in a moment." },
    });
    expect(silent.del).toHaveBeenCalledOnce();
    const rows = await queued();
    for (const row of rows.filter((entry) => entry.itemId === first.itemId)) {
      expect(row).toMatchObject({ attempts: 1, lastAttemptAt: NOW });
      expect(row.lastError).toMatch(
        /^UPSTREAM: The photo store is not responding\. Try again in a moment\. \(Vercel Blob did not answer within \d+ ms\)$/,
      );
    }
    expect(rows.find((entry) => entry.itemId === second.itemId)).toMatchObject({ attempts: 0, lastError: null });
  });

  it("gives each Blob call the time left before the deadline, at most CLEANUP_CALL_TIMEOUT_MS", async () => {
    const timeouts: Array<number | undefined> = [];
    const recording: BlobStorage = {
      ...storage,
      async del(target, options) {
        timeouts.push(options?.timeoutMs);
        return storage.del(target);
      },
    };

    await queueItem(1);
    await runBlobCleanup(deps(recording), { deadlineAt: Date.now() + 10 * MINUTE, maxItems: 10 });
    await queueItem(1);
    await runBlobCleanup(deps(recording), { deadlineAt: Date.now() + 5_000, maxItems: 10 });

    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]).toBe(CLEANUP_CALL_TIMEOUT_MS);
    expect(timeouts[1]).toBeGreaterThan(4_000);
    expect(timeouts[1]).toBeLessThanOrEqual(5_000);
  });

  it("refuses a deadline that is not a finite time before touching the queue or Blob", async () => {
    await queueItem(1);
    for (const deadlineAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runBlobCleanup(deps(), { deadlineAt, maxItems: 10 })).rejects.toMatchObject({ code: "INTERNAL" });
    }
    expect(storage.calls).toEqual([]);
    expect(await queued()).toMatchObject([{ attempts: 0 }]);
  });

  it("starts no item with less than MIN_CALL_MS left, and ends the run without an error", async () => {
    const first = await queueItem(1, { createdAt: new Date(NOW.getTime() - 2 * MINUTE) });
    const second = await queueItem(1, { createdAt: new Date(NOW.getTime() - MINUTE) });
    // The first delete succeeds, but answers only once less than MIN_CALL_MS is left.
    const slow: BlobStorage = {
      ...storage,
      async del(target) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return storage.del(target);
      },
    };

    expect(await runBlobCleanup(deps(slow), { deadlineAt: Date.now() + MIN_CALL_MS + 400, maxItems: 10 })).toEqual({
      deleted: 1,
      pending: 1,
      error: null,
    });

    expect(delTargets()).toEqual([first.urls]);
    expect(await queued()).toMatchObject([{ itemId: second.itemId, attempts: 0, lastAttemptAt: null }]);
  });
});
