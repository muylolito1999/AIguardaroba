import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aiCalls,
  analyses,
  blobCleanup,
  deletedItems,
  itemImages,
  items,
  outfitItems,
  outfits,
  packingChecklistItems,
  shoppingListItems,
  wearLogs,
  type BlobCleanup,
  type Item,
} from "@/lib/db/schema";
import { createBlobStorage, type BlobSdk, type BlobStorage } from "@/lib/images/blob";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import { createFakeBlobStorage, type FakeBlobStorage } from "../../../test/fakes/blob";
import { MIN_CALL_MS, runBlobCleanup } from "./blob-cleanup";
import { AFTER_DELETE_BUDGET_MS, archiveItem, deleteItem, statusAfterUnarchive, unarchiveItem } from "./item-lifecycle";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterAll(async () => {
  await testDb.close();
});

async function findItem(id: string): Promise<Item | undefined> {
  const [found] = await testDb.db.select().from(items).where(eq(items.id, id));
  return found;
}

async function row(id: string): Promise<Item> {
  const found = await findItem(id);
  if (found === undefined) throw new Error(`item ${id} is gone`);
  return found;
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

/** An item with the four photo rows registration and a cut-out leave behind. */
async function itemWithPhotos(overrides: Parameters<typeof makeTaggedItem>[1] = {}): Promise<{ item: Item; urls: string[] }> {
  const item = await makeTaggedItem(testDb.db, { status: "confirmed", ...overrides });
  const urls: string[] = [];
  for (const kind of ["original", "processed", "thumb", "nobg"] as const) {
    urls.push((await makeImage(testDb.db, item.id, { kind })).blobUrl);
  }
  return { item, urls };
}

describe("archiveItem", () => {
  it("archives from any status and is idempotent", async () => {
    const pending = await makeItem(testDb.db);
    const tagged = await makeTaggedItem(testDb.db);
    const confirmed = await makeTaggedItem(testDb.db, { status: "confirmed" });

    for (const item of [pending, tagged, confirmed]) {
      expect(await archiveItem(testDb.db, item.id)).toMatchObject({ id: item.id, status: "archived" });
      expect((await row(item.id)).status).toBe("archived");
    }

    const before = await row(confirmed.id);
    expect(await archiveItem(testDb.db, confirmed.id)).toMatchObject({ status: "archived" });
    // The second archive writes nothing, so the last change stays the first archive.
    expect((await row(confirmed.id)).updatedAt).toEqual(before.updatedAt);
    expect(requireSession).toHaveBeenCalled();
  });

  it("keeps the tags, decision and location of the archived item", async () => {
    const item = await makeTaggedItem(testDb.db, { status: "confirmed", decision: "donate", location: "hamburg" });
    await archiveItem(testDb.db, item.id);
    expect(await row(item.id)).toMatchObject({
      status: "archived",
      decision: "donate",
      location: "hamburg",
      name: item.name,
      category: item.category,
    });
  });

  it("answers NOT_FOUND for a missing or malformed id", async () => {
    expect((await appError(archiveItem(testDb.db, randomUUID()))).code).toBe("NOT_FOUND");
    expect((await appError(archiveItem(testDb.db, "nope"))).code).toBe("NOT_FOUND");
  });
});

describe("unarchiveItem", () => {
  // Each case goes through archiveItem, so archived_from is what archiving wrote.
  it("returns an item the owner had confirmed to confirmed", async () => {
    const item = await makeTaggedItem(testDb.db, { status: "confirmed" });
    await archiveItem(testDb.db, item.id);
    expect((await row(item.id)).archivedFrom).toBe("confirmed");

    expect(await unarchiveItem(testDb.db, item.id)).toMatchObject({ status: "confirmed" });
    expect(await row(item.id)).toMatchObject({ status: "confirmed", archivedFrom: null });
  });

  it("returns a tagged item to tagged, so its unchecked tags stay in the review queue", async () => {
    const item = await makeTaggedItem(testDb.db, { status: "tagged" });
    await archiveItem(testDb.db, item.id);
    expect((await row(item.id)).archivedFrom).toBe("tagged");

    expect(await unarchiveItem(testDb.db, item.id)).toMatchObject({ status: "tagged" });
    expect(await row(item.id)).toMatchObject({ status: "tagged", archivedFrom: null });
  });

  it("returns an item archived while waiting for tags to pending_tagging", async () => {
    const item = await makeItem(testDb.db);
    await archiveItem(testDb.db, item.id);
    expect((await row(item.id)).archivedFrom).toBe("pending_tagging");

    expect(await unarchiveItem(testDb.db, item.id)).toMatchObject({ status: "pending_tagging" });
    expect(await row(item.id)).toMatchObject({ status: "pending_tagging", archivedFrom: null });
  });

  it("returns a waiting item that was tagged while archived to tagged, not confirmed", async () => {
    const pending = await makeItem(testDb.db);
    await archiveItem(testDb.db, pending.id);
    // What a batch result or a Re-tag writes to an archived item: Claude's
    // tags, the status kept archived (statusAfterTagging).
    const tags = await makeTaggedItem(testDb.db, { status: "tagged" });
    await testDb.db
      .update(items)
      .set({
        name: tags.name,
        category: tags.category,
        colors: tags.colors,
        warmthLevel: tags.warmthLevel,
        waterproof: tags.waterproof,
        windproof: tags.windproof,
        insulated: tags.insulated,
        seasons: tags.seasons,
        formality: tags.formality,
        condition: tags.condition,
        aiRaw: tags.aiRaw,
      })
      .where(eq(items.id, pending.id));
    expect(await row(pending.id)).toMatchObject({ status: "archived", archivedFrom: "pending_tagging" });

    expect(await unarchiveItem(testDb.db, pending.id)).toMatchObject({ status: "tagged" });
  });

  it("keeps the earlier rule for a row archived before archived_from existed", async () => {
    const complete = await makeTaggedItem(testDb.db, { status: "archived" });
    const untagged = await makeItem(testDb.db, { status: "archived" });
    // Tags partly filled in (no formality, no seasons): still not complete.
    const partial = await makeItem(testDb.db, { status: "archived", name: "Grey scarf", category: "scarf", colors: ["grey"] });
    for (const item of [complete, untagged, partial]) expect(item.archivedFrom).toBeNull();

    expect(await unarchiveItem(testDb.db, complete.id)).toMatchObject({ status: "confirmed" });
    expect(await unarchiveItem(testDb.db, untagged.id)).toMatchObject({ status: "pending_tagging" });
    expect(await unarchiveItem(testDb.db, partial.id)).toMatchObject({ status: "pending_tagging" });
    expect((await row(partial.id)).status).toBe("pending_tagging");
  });

  it("does not record a status when an archived item is archived again", async () => {
    const item = await makeTaggedItem(testDb.db, { status: "tagged" });
    await archiveItem(testDb.db, item.id);
    await archiveItem(testDb.db, item.id);
    expect((await row(item.id)).archivedFrom).toBe("tagged");
  });

  it("leaves an item that is not archived alone", async () => {
    const tagged = await makeTaggedItem(testDb.db);
    const pending = await makeItem(testDb.db);
    expect(await unarchiveItem(testDb.db, tagged.id)).toMatchObject({ status: "tagged" });
    expect(await unarchiveItem(testDb.db, pending.id)).toMatchObject({ status: "pending_tagging" });
  });

  it("answers NOT_FOUND for a missing item", async () => {
    expect((await appError(unarchiveItem(testDb.db, randomUUID()))).code).toBe("NOT_FOUND");
  });

  it("decides on the name and colours as well as the columns the database requires", () => {
    const complete = {
      name: "Navy wool coat",
      category: "outerwear",
      colors: ["navy"],
      warmthLevel: 4,
      waterproof: false,
      windproof: true,
      insulated: true,
      seasons: ["winter"],
      formality: "smart_casual",
      condition: "good",
      archivedFrom: "confirmed",
    } as const;
    expect(statusAfterUnarchive({ ...complete, colors: [...complete.colors], seasons: [...complete.seasons] })).toBe(
      "confirmed",
    );
    expect(statusAfterUnarchive({ ...complete, name: " ", colors: ["navy"], seasons: ["winter"] })).toBe(
      "pending_tagging",
    );
    expect(statusAfterUnarchive({ ...complete, colors: [], seasons: ["winter"] })).toBe("pending_tagging");
    // Incomplete tags win over the status the item was archived from.
    expect(
      statusAfterUnarchive({ ...complete, colors: [], seasons: ["winter"], archivedFrom: "tagged" }),
    ).toBe("pending_tagging");
  });
});

describe("deleteItem", () => {
  const NOW = new Date("2026-11-04T10:00:00Z");
  let storage: FakeBlobStorage;

  beforeEach(() => {
    storage = createFakeBlobStorage();
  });

  function deps(target: BlobStorage = storage) {
    return { storage: target, now: () => NOW };
  }

  /** Like itemWithPhotos, but the four photos are really in the fake store, so a delete can be seen there. */
  async function itemWithStoredPhotos(): Promise<{ item: Item; urls: string[] }> {
    const item = await makeTaggedItem(testDb.db, { status: "confirmed" });
    const urls: string[] = [];
    for (const kind of ["original", "processed", "thumb", "nobg"] as const) {
      const blob = storage.upload(`items/${item.id}/${kind}.webp`, Buffer.from(kind), "image/webp");
      await makeImage(testDb.db, item.id, { kind, blobUrl: blob.url, blobPathname: blob.pathname });
      urls.push(blob.url);
    }
    return { item, urls };
  }

  async function queued(): Promise<BlobCleanup[]> {
    return testDb.db.select().from(blobCleanup).orderBy(blobCleanup.url);
  }

  /** The ids listed in deleted_items. */
  async function tombstones(): Promise<string[]> {
    return (await testDb.db.select({ itemId: deletedItems.itemId }).from(deletedItems)).map((entry) => entry.itemId);
  }

  /** A deadline the later cleanup runs of these tests never come near. */
  function roomy(): number {
    return Date.now() + 60_000;
  }

  /** Makes every statement of `table`'s `event` fail inside its transaction, as a database fault would. */
  async function failOn(table: "items" | "blob_cleanup", event: "DELETE"): Promise<() => Promise<void>> {
    await testDb.client.exec(`
      CREATE FUNCTION test_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$;
      CREATE TRIGGER test_injected_failure BEFORE ${event} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION test_injected_failure();
    `);
    return async () => {
      await testDb.client.exec(`
        DROP TRIGGER IF EXISTS test_injected_failure ON ${table};
        DROP FUNCTION IF EXISTS test_injected_failure();
      `);
    };
  }

  it("deletes the item and queues its photo URLs in one transaction, then deletes the photos and empties the queue", async () => {
    const { item, urls } = await itemWithStoredPhotos();
    const other = await itemWithStoredPhotos();
    const seenAtDel: Array<{ item: boolean; images: number; queued: string[] }> = [];
    // Wraps the fake to record what the database held when Blob was asked.
    const recording: BlobStorage = {
      ...storage,
      async del(target) {
        seenAtDel.push({
          item: (await findItem(item.id)) !== undefined,
          images: (await testDb.db.select().from(itemImages).where(eq(itemImages.itemId, item.id))).length,
          queued: (await queued()).map((row) => row.url),
        });
        return storage.del(target);
      },
    };

    expect(await deleteItem(testDb.db, item.id, deps(recording))).toEqual({ deleted: true });

    // Blob was asked once, after the commit: the item and its image rows were
    // gone and every photo URL was in the queue.
    const delCalls = storage.calls.filter((call) => call.method === "del");
    expect(delCalls).toHaveLength(1);
    expect([...(delCalls[0]?.target ?? [])].sort()).toEqual([...urls].sort());
    expect(seenAtDel).toEqual([{ item: false, images: 0, queued: [...urls].sort() }]);
    // Then the photos left the store and the queue is empty again. The id
    // stays listed as deleted (D-238).
    for (const url of urls) expect(storage.blobs.has(url)).toBe(false);
    expect(await queued()).toEqual([]);
    expect(await tombstones()).toEqual([item.id]);
    // Another item is untouched.
    expect(await findItem(other.item.id)).toBeDefined();
    expect(await testDb.db.select().from(itemImages).where(eq(itemImages.itemId, other.item.id))).toHaveLength(4);
    for (const url of other.urls) expect(storage.blobs.has(url)).toBe(true);
  });

  it("deletes no photo and changes nothing when the transaction fails", async () => {
    const { item, urls } = await itemWithStoredPhotos();
    const restore = await failOn("items", "DELETE");
    try {
      await expect(deleteItem(testDb.db, item.id, deps())).rejects.toThrow();
    } finally {
      await restore();
    }

    // The queue rows and the deleted_items row were rolled back with the
    // failed delete, and Blob was never asked.
    expect(storage.calls.filter((call) => call.method === "del")).toEqual([]);
    for (const url of urls) expect(storage.blobs.has(url)).toBe(true);
    expect(await findItem(item.id)).toBeDefined();
    expect(await testDb.db.select().from(itemImages).where(eq(itemImages.itemId, item.id))).toHaveLength(4);
    expect(await queued()).toEqual([]);
    expect(await tombstones()).toEqual([]);

    // Nothing is left half done: the owner's retry deletes it all.
    expect(await deleteItem(testDb.db, item.id, deps())).toEqual({ deleted: true });
    expect(await findItem(item.id)).toBeUndefined();
    for (const url of urls) expect(storage.blobs.has(url)).toBe(false);
    expect(await queued()).toEqual([]);
  });

  it("keeps the item deleted and its URLs queued when Blob fails after the commit; a later run deletes them", async () => {
    const { item, urls } = await itemWithStoredPhotos();
    storage.failNext("del", new Error("socket hang up"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // The owner sees the item deleted.
    expect(await deleteItem(testDb.db, item.id, deps())).toEqual({ deleted: true });

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    expect(await findItem(item.id)).toBeUndefined();
    expect(await testDb.db.select().from(itemImages).where(eq(itemImages.itemId, item.id))).toEqual([]);
    for (const url of urls) expect(storage.blobs.has(url)).toBe(true);
    const rows = await queued();
    expect(rows.map((row) => row.url)).toEqual([...urls].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ itemId: item.id, reason: "item_deleted", attempts: 1, lastAttemptAt: NOW });
      expect(row.lastError).toMatch(/^UPSTREAM: .*\(socket hang up\)$/);
    }

    expect(await runBlobCleanup({ db: testDb.db, storage }, { deadlineAt: roomy(), maxItems: 10 })).toEqual({
      deleted: 4,
      pending: 0,
      error: null,
    });
    for (const url of urls) expect(storage.blobs.has(url)).toBe(false);
    expect(await queued()).toEqual([]);
  });

  it("answers deleted within its budget when Blob never answers, with the failure stored on the queued files", async () => {
    const { item, urls } = await itemWithStoredPhotos();
    // The real storage over an SDK whose del() never settles: a store that
    // keeps the connection open, or keeps answering 5xx while the SDK retries.
    const del = vi.fn<BlobSdk["del"]>(() => new Promise<never>(() => undefined));
    const silent = createBlobStorage("vercel_blob_rw_fakestore_notarealsecret", {
      put: vi.fn<BlobSdk["put"]>(),
      del,
      head: vi.fn<BlobSdk["head"]>(),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const budgetMs = MIN_CALL_MS + 300;
    const started = Date.now();

    expect(await deleteItem(testDb.db, item.id, { ...deps(silent), cleanupBudgetMs: budgetMs })).toEqual({
      deleted: true,
    });

    expect(Date.now() - started).toBeLessThan(budgetMs + 1_000);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    expect(del).toHaveBeenCalledOnce();
    expect(await findItem(item.id)).toBeUndefined();
    const rows = await queued();
    expect(rows.map((row) => row.url)).toEqual([...urls].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ itemId: item.id, attempts: 1, lastAttemptAt: NOW });
      expect(row.lastError).toMatch(/^UPSTREAM: .*\(Vercel Blob did not answer within \d+ ms\)$/);
    }
  });

  it("gives the Blob call after the commit no more than AFTER_DELETE_BUDGET_MS by default", async () => {
    const { item } = await itemWithStoredPhotos();
    const timeouts: Array<number | undefined> = [];
    const recording: BlobStorage = {
      ...storage,
      async del(target, options) {
        timeouts.push(options?.timeoutMs);
        return storage.del(target);
      },
    };

    expect(await deleteItem(testDb.db, item.id, deps(recording))).toEqual({ deleted: true });

    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(AFTER_DELETE_BUDGET_MS);
    expect(timeouts[0]).toBeGreaterThan(AFTER_DELETE_BUDGET_MS - 1_000);
  });

  it("keeps the item deleted and records CONFIG when Blob refuses the token after the commit", async () => {
    const { item, urls } = await itemWithStoredPhotos();
    storage.failNext("del", new AppError("CONFIG", "Vercel Blob refused to delete an image: check BLOB_READ_WRITE_TOKEN."));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await deleteItem(testDb.db, item.id, deps())).toEqual({ deleted: true });

    // Logged for the operator; the files wait in the queue until the token is fixed.
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    expect(await findItem(item.id)).toBeUndefined();
    const rows = await queued();
    expect(rows).toHaveLength(urls.length);
    for (const row of rows) expect(row.lastError).toMatch(/^CONFIG: Vercel Blob refused/);
  });

  it("keeps the item deleted when the cleanup after the commit stops halfway; a later run finishes it", async () => {
    const { item, urls } = await itemWithStoredPhotos();
    // The photos are deleted, but the queue rows cannot be removed: the state
    // a function stopped right after the del() call leaves behind.
    const restore = await failOn("blob_cleanup", "DELETE");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await deleteItem(testDb.db, item.id, deps())).toEqual({ deleted: true });
    } finally {
      await restore();
    }
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    expect(await findItem(item.id)).toBeUndefined();
    for (const url of urls) expect(storage.blobs.has(url)).toBe(false);
    expect((await queued()).map((row) => row.attempts)).toEqual([1, 1, 1, 1]);

    // The files are already gone, which counts as deleted.
    expect(await runBlobCleanup({ db: testDb.db, storage }, { deadlineAt: roomy(), maxItems: 10 })).toEqual({
      deleted: 4,
      pending: 0,
      error: null,
    });
  });

  it("also deletes files earlier deletes left queued, except those tried within the last hour", async () => {
    const stale = randomUUID();
    const fresh = randomUUID();
    const staleBlob = storage.upload(`items/${stale}/thumb.webp`, Buffer.from("a"), "image/webp");
    const freshBlob = storage.upload(`items/${fresh}/thumb.webp`, Buffer.from("b"), "image/webp");
    await testDb.db.insert(blobCleanup).values([
      { url: staleBlob.url, itemId: stale, reason: "item_deleted", attempts: 2, lastAttemptAt: new Date(NOW.getTime() - 2 * 3_600_000) },
      { url: freshBlob.url, itemId: fresh, reason: "item_deleted", attempts: 1, lastAttemptAt: new Date(NOW.getTime() - 600_000) },
    ]);
    const { item, urls } = await itemWithStoredPhotos();

    expect(await deleteItem(testDb.db, item.id, deps())).toEqual({ deleted: true });

    // The deleted item's photos went first, then the file last tried two hours ago.
    const delCalls = storage.calls.filter((call) => call.method === "del").map((call) => [...call.target].sort());
    expect(delCalls).toEqual([[...urls].sort(), [staleBlob.url]]);
    expect(storage.blobs.has(staleBlob.url)).toBe(false);
    expect(storage.blobs.has(freshBlob.url)).toBe(true);
    expect((await queued()).map((row) => row.url)).toEqual([freshBlob.url]);
  });

  it("answers NOT_FOUND for a missing or malformed id without calling Blob", async () => {
    expect((await appError(deleteItem(testDb.db, randomUUID(), deps()))).code).toBe("NOT_FOUND");
    expect((await appError(deleteItem(testDb.db, "nope", deps()))).code).toBe("NOT_FOUND");
    expect(storage.calls).toEqual([]);
  });

  it("deletes an item without photos without calling Blob", async () => {
    const item = await makeItem(testDb.db);
    expect(await deleteItem(testDb.db, item.id, deps())).toEqual({ deleted: true });
    expect(storage.calls).toEqual([]);
    expect(await findItem(item.id)).toBeUndefined();
    expect(await queued()).toEqual([]);
  });

  it("follows the schema's foreign keys for rows that point at the item", async () => {
    const { item } = await itemWithPhotos({ wearCount: 2 });
    const keep = await makeTaggedItem(testDb.db, { status: "confirmed" });
    const [outfit] = await testDb.db.insert(outfits).values({ name: "Rainy commute" }).returning();
    if (outfit === undefined) throw new Error("outfit not inserted");
    await testDb.db.insert(outfitItems).values([
      { outfitId: outfit.id, itemId: item.id, slot: "outerwear" },
      { outfitId: outfit.id, itemId: keep.id, slot: "base_layer" },
    ]);
    await testDb.db.insert(wearLogs).values([
      { itemId: item.id, wornOn: "2026-10-01" },
      { itemId: item.id, outfitId: outfit.id, wornOn: "2026-10-02" },
      { outfitId: outfit.id, wornOn: "2026-10-03" },
    ]);
    const [shopping] = await testDb.db
      .insert(shoppingListItems)
      .values({ itemType: "Rain shell", linkedItemId: item.id })
      .returning();
    const [analysis] = await testDb.db
      .insert(analyses)
      .values({ kind: "relocation", model: "claude-sonnet-5", promptVersion: "test" })
      .returning();
    if (analysis === undefined || shopping === undefined) throw new Error("rows not inserted");
    const [packing] = await testDb.db
      .insert(packingChecklistItems)
      .values({ analysisId: analysis.id, itemId: item.id, label: "Navy wool coat", group: "suitcase" })
      .returning();
    const [call] = await testDb.db
      .insert(aiCalls)
      .values({ model: "claude-haiku-5-5", purpose: "tagging", status: "success", costUsd: 0.002, itemId: item.id })
      .returning();
    if (packing === undefined || call === undefined) throw new Error("rows not inserted");

    expect(await deleteItem(testDb.db, item.id, deps())).toEqual({ deleted: true });

    // CASCADE: the item leaves its outfit, and its wear logs go (also the one naming the outfit).
    expect(await testDb.db.select().from(outfits)).toHaveLength(1);
    expect(await testDb.db.select({ itemId: outfitItems.itemId }).from(outfitItems)).toEqual([{ itemId: keep.id }]);
    expect(await testDb.db.select({ wornOn: wearLogs.wornOn, itemId: wearLogs.itemId }).from(wearLogs)).toEqual([
      { wornOn: "2026-10-03", itemId: null },
    ]);
    // SET NULL: the entries stay, without the link.
    expect(await testDb.db.select().from(shoppingListItems)).toMatchObject([{ id: shopping.id, linkedItemId: null }]);
    expect(await testDb.db.select().from(packingChecklistItems)).toMatchObject([
      { id: packing.id, itemId: null, label: "Navy wool coat" },
    ]);
    expect(await testDb.db.select().from(aiCalls)).toMatchObject([{ id: call.id, itemId: null, costUsd: 0.002 }]);
  });

  it("checks the session before touching Blob or the queue", async () => {
    const { item } = await itemWithPhotos();
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Signed out."));
    expect((await appError(deleteItem(testDb.db, item.id, deps()))).code).toBe("UNAUTHENTICATED");
    expect(storage.calls).toEqual([]);
    expect(await findItem(item.id)).toBeDefined();
    expect(await queued()).toEqual([]);
    expect(await tombstones()).toEqual([]);
  });
});
