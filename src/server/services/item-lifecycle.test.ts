import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aiCalls,
  analyses,
  itemImages,
  items,
  outfitItems,
  outfits,
  packingChecklistItems,
  shoppingListItems,
  wearLogs,
  type Item,
} from "@/lib/db/schema";
import type { BlobStorage } from "@/lib/images/blob";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import { createFakeBlobStorage, type FakeBlobStorage } from "../../../test/fakes/blob";
import { archiveItem, deleteItem, statusAfterUnarchive, unarchiveItem } from "./item-lifecycle";

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
  let storage: FakeBlobStorage;

  beforeEach(() => {
    storage = createFakeBlobStorage();
  });

  it("deletes every photo in one call while the rows still exist, then the rows", async () => {
    const { item, urls } = await itemWithPhotos();
    const other = await itemWithPhotos();
    const rowsAtDel: number[] = [];
    // Wraps the fake to record what the database held when Blob was asked.
    const recording: BlobStorage = {
      ...storage,
      async del(target) {
        const images = await testDb.db.select().from(itemImages).where(eq(itemImages.itemId, item.id));
        rowsAtDel.push(images.length + ((await findItem(item.id)) === undefined ? 0 : 1));
        return storage.del(target);
      },
    };

    expect(await deleteItem(testDb.db, item.id, { storage: recording })).toEqual({ deleted: true });

    const delCalls = storage.calls.filter((call) => call.method === "del");
    expect(delCalls).toHaveLength(1);
    expect([...(delCalls[0]?.target ?? [])].sort()).toEqual([...urls].sort());
    // The item row and its four image rows were all there when the photos went.
    expect(rowsAtDel).toEqual([5]);
    expect(await findItem(item.id)).toBeUndefined();
    expect(await testDb.db.select().from(itemImages).where(eq(itemImages.itemId, item.id))).toEqual([]);
    // Another item is untouched.
    expect(await findItem(other.item.id)).toBeDefined();
    expect(await testDb.db.select().from(itemImages).where(eq(itemImages.itemId, other.item.id))).toHaveLength(4);
  });

  it("keeps every row and answers UPSTREAM when Blob fails", async () => {
    const { item } = await itemWithPhotos();
    storage.failNext("del", new Error("socket hang up"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await appError(deleteItem(testDb.db, item.id, { storage }));

    expect(error.code).toBe("UPSTREAM");
    expect(error.message).toMatch(/item was kept/);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    expect(await findItem(item.id)).toBeDefined();
    expect(await testDb.db.select().from(itemImages).where(eq(itemImages.itemId, item.id))).toHaveLength(4);
  });

  it("passes a CONFIG failure from Blob through and keeps the rows", async () => {
    const { item } = await itemWithPhotos();
    storage.failNext("del", new AppError("CONFIG", "Vercel Blob refused to delete an image: check BLOB_READ_WRITE_TOKEN."));

    expect((await appError(deleteItem(testDb.db, item.id, { storage }))).code).toBe("CONFIG");
    expect(await findItem(item.id)).toBeDefined();
  });

  it("answers NOT_FOUND for a missing or malformed id without calling Blob", async () => {
    expect((await appError(deleteItem(testDb.db, randomUUID(), { storage }))).code).toBe("NOT_FOUND");
    expect((await appError(deleteItem(testDb.db, "nope", { storage }))).code).toBe("NOT_FOUND");
    expect(storage.calls).toEqual([]);
  });

  it("deletes an item without photos without calling Blob", async () => {
    const item = await makeItem(testDb.db);
    expect(await deleteItem(testDb.db, item.id, { storage })).toEqual({ deleted: true });
    expect(storage.calls).toEqual([]);
    expect(await findItem(item.id)).toBeUndefined();
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

    expect(await deleteItem(testDb.db, item.id, { storage })).toEqual({ deleted: true });

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

  it("checks the session before touching Blob", async () => {
    const { item } = await itemWithPhotos();
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Signed out."));
    expect((await appError(deleteItem(testDb.db, item.id, { storage }))).code).toBe("UNAUTHENTICATED");
    expect(storage.calls).toEqual([]);
    expect(await findItem(item.id)).toBeDefined();
  });
});
