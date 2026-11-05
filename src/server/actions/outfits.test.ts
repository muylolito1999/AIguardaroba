import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HAMBURG } from "@/lib/climate/hamburg";
import { appSettings, climateProfiles, type Item } from "@/lib/db/schema";
import type { OutfitInputValues } from "@/lib/outfits/contracts";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeTaggedItem } from "../../../test/factories";
import { OUTFIT_TEMPLATES, type OutfitTemplateKey } from "../../../test/outfit-fixtures";

// Wiring of the outfit and wear actions: session check, strict input
// validation and the Result shape. The services behind them have their own
// tests.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));

const outfitActions = await import("./outfits");
const wearActions = await import("./wear");

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  const [hamburg] = await testDb.db.insert(climateProfiles).values(HAMBURG).returning();
  if (hamburg === undefined) throw new Error("no profile");
  await testDb.db.insert(appSettings).values({ id: 1, homeProfileId: hamburg.id });
});

afterAll(async () => {
  await testDb.close();
});

function item(key: OutfitTemplateKey, overrides: Partial<Item> = {}): Promise<Item> {
  const template = OUTFIT_TEMPLATES[key];
  return makeTaggedItem(testDb.db, {
    ...template,
    colors: [...template.colors],
    materials: [...template.materials],
    seasons: [...template.seasons],
    status: "confirmed",
    ...overrides,
  });
}

function outfit(top: Item, bottom: Item, overrides: Partial<OutfitInputValues> = {}): OutfitInputValues {
  return {
    name: "Weekend",
    occasion: "",
    weatherMinC: null,
    weatherMaxC: null,
    rainOk: false,
    rating: null,
    notes: "",
    items: [
      { slot: "top", itemId: top.id },
      { slot: "bottom", itemId: bottom.id },
    ],
    ...overrides,
  };
}

describe("outfit actions", () => {
  it("saves, edits and deletes an outfit", async () => {
    const [sweater, oxford, jeans] = await Promise.all([item("sweater"), item("oxford"), item("jeans")]);
    const created = await outfitActions.saveOutfit({ outfit: outfit(sweater, jeans) });
    if (!created.ok) throw new Error(created.error.message);
    expect(created.data).toMatchObject({ name: "Weekend", occasion: null, source: "user" });

    const edited = await outfitActions.saveOutfit({ id: created.data.id, outfit: outfit(oxford, jeans, { name: "Smart" }) });
    expect(edited).toMatchObject({ ok: true, data: { id: created.data.id, name: "Smart" } });

    expect(await outfitActions.deleteOutfit({ id: created.data.id })).toEqual({ ok: true, data: { deleted: true } });
    expect(await outfitActions.deleteOutfit({ id: created.data.id })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("passes the slot issues through to the builder", async () => {
    const [sweater, oxford] = await Promise.all([item("sweater"), item("oxford")]);
    const result = await outfitActions.saveOutfit({ outfit: outfit(sweater, oxford) });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION",
        details: { outfitIssues: expect.arrayContaining([expect.objectContaining({ code: "wrong_category" })]) },
      },
    });

    // Running gear is refused with its own issue on its slot (D-250).
    const [jeans, runningTights] = await Promise.all([item("jeans"), item("chinos", { collection: "running" })]);
    expect(await outfitActions.saveOutfit({ outfit: outfit(sweater, runningTights) })).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION",
        message: "This item is running gear, which outfits leave out.",
        details: { outfitIssues: [expect.objectContaining({ code: "not_clothing", slot: "bottom", itemId: runningTights.id })] },
      },
    });
    expect(await outfitActions.saveOutfit({ outfit: outfit(sweater, jeans) })).toMatchObject({ ok: true });
  });

  it("validates strictly and checks the session first", async () => {
    const [sweater, jeans] = await Promise.all([item("sweater"), item("jeans")]);
    const invalid: unknown[] = [
      { outfit: { ...outfit(sweater, jeans), extra: true } },
      { outfit: outfit(sweater, jeans), id: "outfit-1" },
      { outfit: outfit(sweater, jeans, { rating: 6 }) },
      { outfit: outfit(sweater, jeans, { weatherMinC: 4.25 }) },
      { outfit: outfit(sweater, jeans), extra: true },
    ];
    for (const input of invalid) {
      expect(await outfitActions.saveOutfit(input as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    mocks.requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Signed out"));
    expect(await outfitActions.saveOutfit({ outfit: outfit(sweater, jeans) })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });
});

describe("wear actions", () => {
  it("logs a wear and undoes it", async () => {
    const sweater = await item("sweater");
    const logged = await wearActions.logWear({ kind: "items", itemIds: [sweater.id] });
    if (!logged.ok) throw new Error(logged.error.message);
    expect(logged.data.items).toEqual([expect.objectContaining({ id: sweater.id, wearCount: 1 })]);

    const undone = await wearActions.undoWear({ logIds: logged.data.logIds });
    expect(undone).toMatchObject({
      ok: true,
      data: { undone: logged.data.logIds, items: [{ id: sweater.id, wearCount: 0, lastWornAt: null }] },
    });
  });

  it("validates strictly and checks the session first", async () => {
    const invalid: unknown[] = [
      { kind: "items", itemIds: [] },
      { kind: "items", itemIds: ["nope"] },
      { kind: "items", itemIds: [MISSING_ID, MISSING_ID] },
      { kind: "outfit" },
      { kind: "items", itemIds: [MISSING_ID], wornOn: "2026-02-30" },
      { kind: "items", itemIds: [MISSING_ID], extra: 1 },
    ];
    for (const input of invalid) {
      expect(await wearActions.logWear(input as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect(await wearActions.undoWear({ logIds: [] })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    mocks.requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Signed out"));
    expect(await wearActions.logWear({ kind: "items", itemIds: [MISSING_ID] })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });
});
