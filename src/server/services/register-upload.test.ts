import { createHash, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { appSettings, blobCleanup, itemImages, items } from "@/lib/db/schema";
import type { BlobStorage } from "@/lib/images/blob";
import { originalUploadPathname, type RegisterBody } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeItem } from "../../../test/factories";
import { createFakeBlobStorage, type FakeBlob, type FakeBlobStorage } from "../../../test/fakes/blob";
import { solidJpeg } from "../../../test/fixtures/images";
import { runBlobCleanup } from "./blob-cleanup";
import { deleteItem } from "./item-lifecycle";
import {
  processedPathname,
  registerUpload,
  thumbPathname,
  uniqueViolationConstraint,
  type RegisterUploadDeps,
} from "./register-upload";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

let testDb: TestDb;
let fake: FakeBlobStorage;
let photo: Buffer;
let otherPhoto: Buffer;

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

beforeAll(async () => {
  testDb = await makeTestDb();
  // 1200x1600 keeps sharp fast while still exercising both resizes.
  photo = await solidJpeg(1200, 1600, { r: 30, g: 50, b: 120 });
  otherPhoto = await solidJpeg(1200, 1600, { r: 200, g: 160, b: 40 });
});

beforeEach(async () => {
  await testDb.truncateAll();
  // A non-default location proves the item takes it from app_settings.
  await testDb.db.insert(appSettings).values({ id: 1, defaultItemLocation: "hamburg" });
  fake = createFakeBlobStorage();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterAll(async () => {
  await testDb.close();
});

function deps(overrides: Partial<RegisterUploadDeps> = {}): RegisterUploadDeps {
  return { db: testDb.db, storage: fake, fetch: fake.fetch, ...overrides };
}

/** Simulates the browser's upload() of a prepared photo for a new item id. */
function upload(body: Buffer = photo, itemId: string = randomUUID()): { itemId: string; blob: FakeBlob } {
  return { itemId, blob: fake.upload(originalUploadPathname(itemId), body, "image/jpeg") };
}

function registerBody(itemId: string, blob: FakeBlob, sourceHash = sha256(`${itemId}-source`)): RegisterBody {
  return { itemId, url: blob.url, pathname: blob.pathname, sourceHash, originalFilename: "IMG_0001.HEIC" };
}

async function itemRows() {
  return testDb.db.select().from(items);
}

async function imageRows(itemId: string) {
  return testDb.db.select().from(itemImages).where(eq(itemImages.itemId, itemId));
}

function putPathnames(): string[] {
  return fake.calls.filter((call) => call.method === "put").map((call) => String(call.target));
}

function deletedUrls(): string[] {
  return fake.calls.filter((call) => call.method === "del").flatMap((call) => call.target);
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

/** Storage that runs `beforePut` once, at the first put, i.e. after every pre-check passed. */
function racingStorage(beforePut: () => Promise<unknown>): BlobStorage {
  let raced = false;
  return {
    ...fake,
    async put(pathname, body, options) {
      if (!raced) {
        raced = true;
        await beforePut();
      }
      return fake.put(pathname, body, options);
    },
  };
}

describe("registerUpload", () => {
  it("creates one pending item with original, processed and thumb images", async () => {
    const { itemId, blob } = upload();
    const input = registerBody(itemId, blob);

    const result = await registerUpload(deps(), input);

    const [item] = await itemRows();
    expect(item).toMatchObject({
      id: itemId,
      status: "pending_tagging",
      location: "hamburg",
      sourceHash: input.sourceHash,
    });
    expect(item?.imageHash).toMatch(/^[0-9a-f]{64}$/);

    const images = await imageRows(itemId);
    const byKind = Object.fromEntries(images.map((image) => [image.kind, image]));
    expect(Object.keys(byKind).sort()).toEqual(["original", "processed", "thumb"]);
    expect(byKind.original).toMatchObject({
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      contentType: "image/jpeg",
      width: 1200,
      height: 1600,
      bytes: photo.length,
    });
    expect(byKind.processed).toMatchObject({ contentType: "image/webp", width: 768, height: 1024 });
    expect(byKind.thumb).toMatchObject({ contentType: "image/webp", width: 300, height: 400 });

    // The rows point at blobs that exist, and image_hash is the processed blob's sha256.
    const processedBlob = fake.blobs.get(byKind.processed?.blobUrl ?? "");
    expect(processedBlob?.pathname.startsWith("items/" + itemId + "/processed")).toBe(true);
    expect(item?.imageHash).toBe(sha256(processedBlob?.body ?? Buffer.alloc(0)));
    expect(byKind.processed?.bytes).toBe(processedBlob?.body.length);
    expect(fake.blobs.has(byKind.thumb?.blobUrl ?? "")).toBe(true);

    expect(putPathnames()).toEqual([processedPathname(itemId), thumbPathname(itemId)]);
    expect(fake.fetched).toEqual([blob.url]);

    expect(result).toEqual({
      duplicate: false,
      item: expect.objectContaining({
        id: itemId,
        status: "pending_tagging",
        location: "hamburg",
        images: {
          thumb: { url: byKind.thumb?.blobUrl, width: 300, height: 400 },
          processed: { url: byKind.processed?.blobUrl, width: 768, height: 1024 },
          nobg: null,
        },
      }),
    });
  });

  it("returns the same item again for a repeated register without redoing any work", async () => {
    const { itemId, blob } = upload();
    const input = registerBody(itemId, blob);
    const first = await registerUpload(deps(), input);
    const callsAfterFirst = fake.calls.length;

    const second = await registerUpload(deps(), input);

    expect(second).toEqual(first);
    expect(fake.calls).toHaveLength(callsAfterFirst);
    expect(fake.fetched).toHaveLength(1);
    expect(await itemRows()).toHaveLength(1);
    expect(fake.blobs.has(blob.url)).toBe(true);
  });

  it("deletes the new original and points at the existing item when the processed image is a duplicate", async () => {
    const first = upload();
    await registerUpload(deps(), registerBody(first.itemId, first.blob));
    const putsBefore = putPathnames().length;

    // The same photo again, from a file with a different source hash.
    const second = upload(Buffer.from(photo));
    const result = await registerUpload(deps(), registerBody(second.itemId, second.blob));

    expect(result).toEqual({ duplicate: true, existingItemId: first.itemId });
    expect(fake.blobs.has(second.blob.url)).toBe(false);
    expect(deletedUrls()).toEqual([second.blob.url]);
    expect(putPathnames()).toHaveLength(putsBefore);
    expect((await itemRows()).map((row) => row.id)).toEqual([first.itemId]);
  });

  it("treats a known source hash as a duplicate before fetching anything", async () => {
    const sourceHash = sha256("the same picked file");
    const existing = await makeItem(testDb.db, { sourceHash });
    const { itemId, blob } = upload(otherPhoto);

    const result = await registerUpload(deps(), registerBody(itemId, blob, sourceHash));

    expect(result).toEqual({ duplicate: true, existingItemId: existing.id });
    expect(fake.fetched).toEqual([]);
    expect(deletedUrls()).toEqual([blob.url]);
    expect(await itemRows()).toHaveLength(1);
  });

  it("queues a duplicate's original for the cron when deleting it fails (D-245)", async () => {
    const sourceHash = sha256("the same picked file, while Blob fails");
    await makeItem(testDb.db, { sourceHash });
    const { itemId, blob } = upload(otherPhoto);
    fake.failNext("del", new Error("socket hang up"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await registerUpload(deps(), registerBody(itemId, blob, sourceHash))).toMatchObject({ duplicate: true });
    } finally {
      consoleError.mockRestore();
    }
    expect(fake.blobs.has(blob.url)).toBe(true);
    expect(await testDb.db.select().from(blobCleanup)).toMatchObject([{ url: blob.url, itemId, reason: "upload_abandoned" }]);
  });

  it("settles a lost source-hash race as a duplicate and removes every blob it wrote", async () => {
    const { itemId, blob } = upload();
    const input = registerBody(itemId, blob);
    let racerId = "";
    const storage = racingStorage(async () => {
      racerId = (await makeItem(testDb.db, { sourceHash: input.sourceHash })).id;
    });

    const result = await registerUpload(deps({ storage }), input);

    expect(result).toEqual({ duplicate: true, existingItemId: racerId });
    expect(fake.urlsUnder(`items/${itemId}/`)).toEqual([]);
    expect((await itemRows()).map((row) => row.id)).toEqual([racerId]);
    expect(await imageRows(itemId)).toEqual([]);
  });

  it("returns the item when a concurrent register of the same upload won, keeping its original", async () => {
    const { itemId, blob } = upload();
    const input = registerBody(itemId, blob);
    const storage = racingStorage(() =>
      makeItem(testDb.db, { id: itemId, sourceHash: input.sourceHash, imageHash: sha256("racer") }),
    );

    const result = await registerUpload(deps({ storage }), input);

    expect(result).toMatchObject({ duplicate: false, item: { id: itemId } });
    // Only the derived images of the losing request go; the shared original stays.
    expect(fake.blobs.has(blob.url)).toBe(true);
    expect(fake.urlsUnder(`items/${itemId}/processed`)).toEqual([]);
    expect(fake.urlsUnder(`items/${itemId}/thumb`)).toEqual([]);
  });

  it("deletes the blobs it wrote when the transaction fails, and keeps the original for a retry", async () => {
    const { itemId, blob } = upload();
    await testDb.db.delete(appSettings);

    const error = await thrownBy(registerUpload(deps(), registerBody(itemId, blob)));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "CONFIG" });
    expect(await itemRows()).toEqual([]);
    expect(fake.urlsUnder(`items/${itemId}/processed`)).toEqual([]);
    expect(fake.urlsUnder(`items/${itemId}/thumb`)).toEqual([]);
    expect(fake.blobs.has(blob.url)).toBe(true);

    // With the settings back, the same request succeeds.
    await testDb.db.insert(appSettings).values({ id: 1, defaultItemLocation: "bologna" });
    expect(await registerUpload(deps(), registerBody(itemId, blob))).toMatchObject({ duplicate: false });
  });

  it("removes the other derived image when one put fails", async () => {
    const { itemId, blob } = upload();
    fake.failNext("put", new AppError("UPSTREAM", "store down"));

    await expect(registerUpload(deps(), registerBody(itemId, blob))).rejects.toMatchObject({ code: "UPSTREAM" });
    expect(fake.urlsUnder(`items/${itemId}/processed`)).toEqual([]);
    expect(fake.urlsUnder(`items/${itemId}/thumb`)).toEqual([]);
    expect(fake.blobs.has(blob.url)).toBe(true);
    expect(await itemRows()).toEqual([]);
  });

  it("rejects an unreadable upload with VALIDATION and deletes it", async () => {
    const { itemId, blob } = upload(Buffer.from("not an image at all"));

    await expect(registerUpload(deps(), registerBody(itemId, blob))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(fake.blobs.has(blob.url)).toBe(false);
    expect(await itemRows()).toEqual([]);
  });

  it("refuses another item's upload without fetching or deleting it", async () => {
    const victim = upload();
    const itemId = randomUUID();

    const error = await thrownBy(registerUpload(deps(), registerBody(itemId, victim.blob)));

    expect(error).toMatchObject({ code: "VALIDATION", details: { reason: "wrong_pathname" } });
    expect(fake.fetched).toEqual([]);
    expect(deletedUrls()).toEqual([]);
    expect(fake.blobs.has(victim.blob.url)).toBe(true);
  });

  it("refuses a pathname that does not match the stored blob", async () => {
    const { itemId, blob } = upload();
    const input = { ...registerBody(itemId, blob), pathname: originalUploadPathname(itemId) };
    await expect(registerUpload(deps(), input)).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "pathname_mismatch" },
    });
  });

  it("keeps the original when reading it fails, so the register can be retried", async () => {
    const { itemId, blob } = upload();
    const failing: typeof fetch = async () => new Response("busy", { status: 503 });
    await expect(registerUpload(deps({ fetch: failing }), registerBody(itemId, blob))).rejects.toMatchObject({
      code: "UPSTREAM",
      details: { status: 503 },
    });

    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(registerUpload(deps({ fetch: offline }), registerBody(itemId, blob))).rejects.toMatchObject({
      code: "UPSTREAM",
    });

    expect(fake.blobs.has(blob.url)).toBe(true);
    expect(await itemRows()).toEqual([]);
  });

  it("does not process (or delete) an original that arrived incomplete", async () => {
    const { itemId, blob } = upload();
    const truncated: typeof fetch = async () => new Response(new Uint8Array(photo.subarray(0, 100)));

    await expect(registerUpload(deps({ fetch: truncated }), registerBody(itemId, blob))).rejects.toMatchObject({
      code: "UPSTREAM",
      details: { reason: "incomplete" },
    });
    expect(fake.blobs.has(blob.url)).toBe(true);
  });

  it("stops reading a body larger than the upload limit", async () => {
    const { itemId, blob } = upload();
    const huge: typeof fetch = async () =>
      new Response(new Uint8Array(11 * 1024 * 1024), { headers: { "content-length": String(11 * 1024 * 1024) } });

    await expect(registerUpload(deps({ fetch: huge }), registerBody(itemId, blob))).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "too_large" },
    });
  });

  it("checks the session before touching anything", async () => {
    const { itemId, blob } = upload();
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in"));
    const callsBefore = fake.calls.length;

    await expect(registerUpload(deps(), registerBody(itemId, blob))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(fake.calls).toHaveLength(callsBefore);
    expect(fake.fetched).toEqual([]);
  });
});

describe("registerUpload after the item was deleted (D-238)", () => {
  const ITEM_DELETED = {
    code: "VALIDATION",
    message: "That item was deleted. Upload the photo again.",
    details: { reason: "item_deleted" },
  };

  /** Deletes the item while Blob fails, so its files stay in the store, queued, as after an outage. */
  async function deleteWhileBlobFails(itemId: string): Promise<void> {
    fake.failNext("del", new Error("socket hang up"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await deleteItem(testDb.db, itemId, { storage: fake })).toEqual({ deleted: true });
    } finally {
      consoleError.mockRestore();
    }
  }

  async function queuedUrls(): Promise<string[]> {
    return (await testDb.db.select({ url: blobCleanup.url }).from(blobCleanup)).map((row) => row.url).sort();
  }

  it("refuses a retry with the same body before reading anything, and the cleanup then deletes the queued photos", async () => {
    const { itemId, blob } = upload();
    const input = registerBody(itemId, blob);
    await registerUpload(deps(), input);
    const registeredUrls = (await imageRows(itemId)).map((row) => row.blobUrl);
    await deleteWhileBlobFails(itemId);
    expect(fake.blobs.has(blob.url)).toBe(true);
    const callsBefore = fake.calls.length;
    const fetchedBefore = fake.fetched.length;

    // The add page's Retry, after a register whose answer was lost.
    await expect(registerUpload(deps(), input)).rejects.toMatchObject(ITEM_DELETED);

    // Refused before head(), the fetch and any put; no item came back.
    expect(fake.calls).toHaveLength(callsBefore);
    expect(fake.fetched).toHaveLength(fetchedBefore);
    expect(await itemRows()).toEqual([]);
    expect(await imageRows(itemId)).toEqual([]);

    // The next cleanup run deletes the queued photos, the original among them.
    expect(await queuedUrls()).toEqual([...registeredUrls].sort());
    expect(
      await runBlobCleanup({ db: testDb.db, storage: fake }, { deadlineAt: Date.now() + 60_000, maxItems: 10 }),
    ).toEqual({ deleted: 3, pending: 0, error: null });
    expect(fake.urlsUnder(`items/${itemId}/`)).toEqual([]);
  });

  it("refuses a register whose item is registered and deleted while it runs, and keeps none of its own images", async () => {
    const { itemId, blob } = upload();
    const input = registerBody(itemId, blob);
    // Once this register's checks have passed, another request registers the
    // same upload (its answer lost) and the owner deletes that item while
    // Blob fails, so the item id is free again when this one inserts.
    const storage = racingStorage(async () => {
      await registerUpload(deps(), input);
      await deleteWhileBlobFails(itemId);
    });

    await expect(registerUpload(deps({ storage }), input)).rejects.toMatchObject(ITEM_DELETED);

    expect(await itemRows()).toEqual([]);
    expect(await imageRows(itemId)).toEqual([]);
    // What is left in the store is the first register's three files, all
    // queued; the derived images this register stored were deleted again.
    const queued = await queuedUrls();
    expect(queued).toHaveLength(3);
    expect(queued).toContain(blob.url);
    expect(fake.urlsUnder(`items/${itemId}/`).sort()).toEqual(queued);
  });
});

describe("uniqueViolationConstraint", () => {
  it("finds the constraint on the driver error under Drizzle's wrapper", () => {
    const driverError = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "items_source_hash_key" });
    expect(uniqueViolationConstraint(new Error("Failed query", { cause: driverError }))).toBe("items_source_hash_key");
    expect(uniqueViolationConstraint(driverError)).toBe("items_source_hash_key");
  });

  it("returns null for anything else", () => {
    expect(uniqueViolationConstraint(Object.assign(new Error("fk"), { code: "23503" }))).toBeNull();
    expect(uniqueViolationConstraint(new Error("plain"))).toBeNull();
    expect(uniqueViolationConstraint("text")).toBeNull();
  });

  it("reads a real unique violation from the test database", async () => {
    const hash = sha256("dup");
    await makeItem(testDb.db, { sourceHash: hash });
    const error = await thrownBy(makeItem(testDb.db, { sourceHash: hash }));
    expect(uniqueViolationConstraint(error)).toBe("items_source_hash_key");
  });
});
