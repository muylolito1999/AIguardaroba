import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { analyses, shoppingListItems, type NewAnalysis, type NewShoppingListItem } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import {
  addShoppingItem,
  deleteShoppingItem,
  getShoppingList,
  searchLinkableItems,
  updateShoppingItem,
} from "./shopping";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

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

async function appError(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

async function insertRow(overrides: Partial<NewShoppingListItem> = {}) {
  const [row] = await testDb.db
    .insert(shoppingListItems)
    .values({ itemType: "Rain shell", ...overrides })
    .returning();
  if (row === undefined) throw new Error("insert returned no row");
  return row;
}

async function insertAnalysis(overrides: Partial<NewAnalysis> = {}) {
  const [row] = await testDb.db
    .insert(analyses)
    .values({ kind: "relocation", model: "claude-sonnet-5-5", promptVersion: "reloc-v1", ...overrides })
    .returning();
  if (row === undefined) throw new Error("insert returned no row");
  return row;
}

describe("the session check", () => {
  it("runs first in every exported function, before anything is read or written", async () => {
    const row = await insertRow();
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));

    const calls: Promise<unknown>[] = [
      getShoppingList(testDb.db),
      addShoppingItem(testDb.db, { itemType: "Gloves" }),
      updateShoppingItem(testDb.db, { id: row.id, status: "bought" }),
      deleteShoppingItem(testDb.db, row.id),
      searchLinkableItems(testDb.db, ""),
    ];
    for (const call of calls) expect((await appError(call)).code).toBe("UNAUTHENTICATED");

    expect(requireSession).toHaveBeenCalledTimes(calls.length);
    const rows = await testDb.db.select().from(shoppingListItems);
    expect(rows).toEqual([row]);
  });
});

describe("addShoppingItem", () => {
  it("adds a hand-made entry with the defaults", async () => {
    const added = await addShoppingItem(testDb.db, { itemType: "  Windproof gloves " });

    expect(added).toMatchObject({
      analysisId: null,
      gapKey: null,
      itemType: "Windproof gloves",
      category: null,
      priority: 2,
      reason: "",
      specs: [],
      quantity: 1,
      estPriceMinEur: null,
      estPriceMaxEur: null,
      buyTiming: null,
      status: "todo",
      linkedItem: null,
    });
    expect((await getShoppingList(testDb.db)).items.map((item) => item.id)).toEqual([added.id]);
  });

  it("keeps every field given", async () => {
    const added = await addShoppingItem(testDb.db, {
      itemType: "Merino base layer",
      category: "base_layer",
      priority: 1,
      reason: "Cold, wet winters.",
      specs: ["150–250 g/m²", "long sleeves"],
      quantity: 2,
      estPriceMinEur: 40,
      estPriceMaxEur: 70,
      buyTiming: "after_move",
    });

    expect(added).toMatchObject({
      category: "base_layer",
      priority: 1,
      specs: ["150–250 g/m²", "long sleeves"],
      quantity: 2,
      estPriceMinEur: 40,
      estPriceMaxEur: 70,
      buyTiming: "after_move",
    });
  });

  it("rejects an empty type, a high price below the low one and a quantity over 10", async () => {
    for (const input of [
      { itemType: "   " },
      { itemType: "Boots", estPriceMinEur: 120, estPriceMaxEur: 80 },
      { itemType: "Socks", quantity: 11 },
      { itemType: "Socks", estPriceMinEur: 10.5 },
    ]) {
      expect((await appError(addShoppingItem(testDb.db, input))).code).toBe("VALIDATION");
    }
    expect(await testDb.db.select().from(shoppingListItems)).toEqual([]);
  });
});

describe("getShoppingList", () => {
  it("orders by priority, then To buy first, then oldest first, with gaps in their analysis order", async () => {
    const analysis = await insertAnalysis();
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 9, minute));
    await insertRow({ itemType: "p2 todo new", priority: 2, createdAt: at(30) });
    await insertRow({ itemType: "p1 bought", priority: 1, status: "bought", createdAt: at(1) });
    await insertRow({ itemType: "p2 todo old", priority: 2, createdAt: at(10) });
    await insertRow({ itemType: "p3 skipped", priority: 3, status: "skipped", createdAt: at(1) });
    await insertRow({ itemType: "p1 todo", priority: 1, createdAt: at(50) });
    await insertRow({ itemType: "p2 skipped", priority: 2, status: "skipped", createdAt: at(0) });
    await insertRow({ itemType: "p2 bought", priority: 2, status: "bought", createdAt: at(0) });
    // Gaps added together share a created_at; g2 sorts before g10, unlike text order.
    for (const [gapKey, itemType] of [
      ["g10-zip-boots", "a gap ten"],
      ["g2-shell", "z gap two"],
    ] as const) {
      await insertRow({ itemType, priority: 3, analysisId: analysis.id, gapKey, createdAt: at(5) });
    }

    const list = await getShoppingList(testDb.db);

    expect(list.items.map((item) => item.itemType)).toEqual([
      "p1 todo",
      "p1 bought",
      "p2 todo old",
      "p2 todo new",
      "p2 bought",
      "p2 skipped",
      "z gap two",
      "a gap ten",
      "p3 skipped",
    ]);
  });

  it("shows the linked item's name and thumb", async () => {
    const coat = await makeTaggedItem(testDb.db, { name: "Navy wool coat" });
    await makeImage(testDb.db, coat.id, { kind: "thumb", width: 256, height: 192 });
    await makeImage(testDb.db, coat.id, { kind: "processed" });
    const unnamed = await makeItem(testDb.db);
    await insertRow({ itemType: "Coat", linkedItemId: coat.id });
    await insertRow({ itemType: "Something", linkedItemId: unnamed.id });

    const list = await getShoppingList(testDb.db);

    const byType = new Map(list.items.map((item) => [item.itemType, item]));
    expect(byType.get("Coat")?.linkedItem).toEqual({
      id: coat.id,
      name: "Navy wool coat",
      thumb: { url: expect.stringContaining("thumb"), width: 256, height: 192 },
    });
    expect(byType.get("Something")?.linkedItem).toEqual({ id: unnamed.id, name: "Untagged item", thumb: null });
  });

  it("takes the budget from the newest complete relocation run", async () => {
    expect(await getShoppingList(testDb.db)).toMatchObject({ latestBudgetEur: null, latestAnalysisId: null });

    await insertAnalysis({ status: "complete", params: { purchaseBudgetEur: 400 }, completedAt: new Date("2026-10-01T10:00:00Z") });
    const newest = await insertAnalysis({
      status: "complete",
      params: { purchaseBudgetEur: 600 },
      completedAt: new Date("2026-10-20T10:00:00Z"),
    });
    await insertAnalysis({ status: "running", params: { purchaseBudgetEur: 900 } });
    await insertAnalysis({ status: "failed", params: { purchaseBudgetEur: 950 } });
    await insertAnalysis({
      kind: "shopping",
      status: "complete",
      params: { purchaseBudgetEur: 999 },
      completedAt: new Date("2026-10-30T10:00:00Z"),
    });

    expect(await getShoppingList(testDb.db)).toMatchObject({ latestBudgetEur: 600, latestAnalysisId: newest.id });
  });

  it("reports no budget when the newest complete run had none", async () => {
    await insertAnalysis({ status: "complete", params: { purchaseBudgetEur: 400 }, completedAt: new Date("2026-10-01T10:00:00Z") });
    const newest = await insertAnalysis({
      status: "complete",
      params: { purchaseBudgetEur: null },
      completedAt: new Date("2026-10-02T10:00:00Z"),
    });

    expect(await getShoppingList(testDb.db)).toMatchObject({ latestBudgetEur: null, latestAnalysisId: newest.id });
  });
});

describe("updateShoppingItem", () => {
  it("changes the status and the priority", async () => {
    const row = await insertRow();

    expect(await updateShoppingItem(testDb.db, { id: row.id, status: "bought" })).toMatchObject({ status: "bought", priority: 2 });
    expect(await updateShoppingItem(testDb.db, { id: row.id, priority: 1 })).toMatchObject({ status: "bought", priority: 1 });
  });

  it("links an owned item and unlinks it again, leaving the item unchanged", async () => {
    const coat = await makeTaggedItem(testDb.db, { name: "Navy wool coat", status: "confirmed" });
    const row = await insertRow();

    const linked = await updateShoppingItem(testDb.db, { id: row.id, linkedItemId: coat.id });
    expect(linked.linkedItem).toEqual({ id: coat.id, name: "Navy wool coat", thumb: null });

    const unlinked = await updateShoppingItem(testDb.db, { id: row.id, linkedItemId: null });
    expect(unlinked.linkedItem).toBeNull();

    const [after] = await testDb.db.select().from(shoppingListItems).where(eq(shoppingListItems.id, row.id));
    expect(after?.linkedItemId).toBeNull();
    const reread = await searchLinkableItems(testDb.db, "navy");
    expect(reread.map((item) => item.id)).toEqual([coat.id]);
  });

  it("refuses to link an archived or missing item", async () => {
    const archived = await makeTaggedItem(testDb.db, { status: "archived" });
    const row = await insertRow();

    expect((await appError(updateShoppingItem(testDb.db, { id: row.id, linkedItemId: archived.id }))).code).toBe("VALIDATION");
    expect((await appError(updateShoppingItem(testDb.db, { id: row.id, linkedItemId: MISSING_ID }))).code).toBe("NOT_FOUND");
    const [after] = await testDb.db.select().from(shoppingListItems).where(eq(shoppingListItems.id, row.id));
    expect(after?.linkedItemId).toBeNull();
  });

  it("says NOT_FOUND for an unknown row and VALIDATION when there is nothing to change", async () => {
    const row = await insertRow();
    expect((await appError(updateShoppingItem(testDb.db, { id: MISSING_ID, status: "bought" }))).code).toBe("NOT_FOUND");
    expect((await appError(updateShoppingItem(testDb.db, { id: row.id }))).code).toBe("VALIDATION");
  });
});

describe("deleteShoppingItem", () => {
  it("deletes the row once", async () => {
    const row = await insertRow();

    expect(await deleteShoppingItem(testDb.db, row.id)).toEqual({ deleted: true });
    expect(await testDb.db.select().from(shoppingListItems)).toEqual([]);
    expect((await appError(deleteShoppingItem(testDb.db, row.id))).code).toBe("NOT_FOUND");
    expect((await appError(deleteShoppingItem(testDb.db, "not-a-uuid"))).code).toBe("NOT_FOUND");
  });
});

describe("searchLinkableItems", () => {
  it("matches name or subcategory, case-insensitively, and leaves archived items out", async () => {
    const shell = await makeTaggedItem(testDb.db, { name: "Yellow Rain Shell", subcategory: "jacket" });
    const parka = await makeTaggedItem(testDb.db, { name: "Down parka", subcategory: "rain parka" });
    await makeTaggedItem(testDb.db, { name: "Rain boots", status: "archived" });
    await makeTaggedItem(testDb.db, { name: "Wool scarf", subcategory: "scarf" });
    await makeImage(testDb.db, shell.id, { kind: "thumb", width: 200, height: 200 });

    const found = await searchLinkableItems(testDb.db, "  RAIN ");

    expect(found.map((item) => item.id).sort()).toEqual([shell.id, parka.id].sort());
    expect(found.find((item) => item.id === shell.id)).toMatchObject({
      name: "Yellow Rain Shell",
      category: "outerwear",
      thumb: { width: 200, height: 200 },
    });
  });

  it("takes %, _ and backslash literally", async () => {
    const percent = await makeTaggedItem(testDb.db, { name: "100% wool jumper" });
    const underscore = await makeTaggedItem(testDb.db, { name: "wool_blend scarf" });
    const backslash = await makeTaggedItem(testDb.db, { name: "back\\slash tee" });
    await makeTaggedItem(testDb.db, { name: "1000 wool socks" });
    await makeTaggedItem(testDb.db, { name: "woolXblend hat" });

    expect((await searchLinkableItems(testDb.db, "%")).map((item) => item.id)).toEqual([percent.id]);
    expect((await searchLinkableItems(testDb.db, "0% w")).map((item) => item.id)).toEqual([percent.id]);
    expect((await searchLinkableItems(testDb.db, "wool_")).map((item) => item.id)).toEqual([underscore.id]);
    expect((await searchLinkableItems(testDb.db, "\\")).map((item) => item.id)).toEqual([backslash.id]);
  });

  it("lists the newest 30 when the text is empty, pending items included", async () => {
    const start = Date.UTC(2026, 9, 1);
    const created = [];
    for (let index = 0; index < 32; index += 1) {
      created.push(await makeItem(testDb.db, { createdAt: new Date(start + index * 60_000) }));
    }

    const found = await searchLinkableItems(testDb.db, "");

    expect(found).toHaveLength(30);
    expect(found[0]?.id).toBe(created.at(-1)?.id);
    expect(found.every((item) => item.name === "Untagged item")).toBe(true);
  });
});
