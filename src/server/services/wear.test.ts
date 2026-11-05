import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HAMBURG } from "@/lib/climate/hamburg";
import { appSettings, climateProfiles, items, outfitItems, outfits, wearLogs, type Item } from "@/lib/db/schema";
import { AppError } from "@/lib/result";
import { WEAR_UNDO_WINDOW_MS } from "@/lib/wear/contracts";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeItem, makeTaggedItem } from "../../../test/factories";
import { makeWeatherSnapshot, OUTFIT_TEMPLATES, type OutfitTemplateKey } from "../../../test/outfit-fixtures";
import { listRecentWears, logWear, undoWear } from "./wear";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
/** 13:20 UTC on 3 Nov 2026: 14:20 in Hamburg, the same calendar day. */
const NOW = new Date("2026-11-03T13:20:00.000Z");
/** Noon on 3 Nov 2026 in Europe/Berlin (UTC+1 in November). */
const NOON_NOV_3 = "2026-11-03T11:00:00.000Z";
const NOON_NOV_1 = "2026-11-01T11:00:00.000Z";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  const [hamburg] = await testDb.db.insert(climateProfiles).values(HAMBURG).returning();
  if (hamburg === undefined) throw new Error("no profile");
  await testDb.db.insert(appSettings).values({ id: 1, homeProfileId: hamburg.id });
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

async function outfitOf(entries: { slot: "top" | "bottom" | "shoes" | "outerwear"; item: Item }[]): Promise<string> {
  const [row] = await testDb.db.insert(outfits).values({ name: "Office day" }).returning();
  if (row === undefined) throw new Error("no outfit");
  await testDb.db
    .insert(outfitItems)
    .values(entries.map((entry) => ({ outfitId: row.id, itemId: entry.item.id, slot: entry.slot })));
  return row.id;
}

async function stored(id: string) {
  const [row] = await testDb.db
    .select({ wearCount: items.wearCount, lastWornAt: items.lastWornAt, updatedAt: items.updatedAt })
    .from(items)
    .where(eq(items.id, id));
  if (row === undefined) throw new Error("no item");
  return { ...row, lastWornAt: row.lastWornAt?.toISOString() ?? null };
}

function at(offsetMs: number): { now: Date } {
  return { now: new Date(NOW.getTime() + offsetMs) };
}

describe("logWear", () => {
  it("logs an outfit wear once per item, counting each item once", async () => {
    const [sweater, jeans, boots] = await Promise.all([item("sweater"), item("jeans"), item("boots")]);
    const outfitId = await outfitOf([
      { slot: "top", item: sweater },
      { slot: "bottom", item: jeans },
      { slot: "shoes", item: boots },
    ]);
    const weather = makeWeatherSnapshot();

    const result = await logWear(testDb.db, { kind: "outfit", outfitId, weather }, at(0));

    expect(result.wornOn).toBe("2026-11-03");
    expect(result.logIds).toHaveLength(3);
    expect(result.alreadyLogged).toEqual([]);
    expect(result.undoUntil).toBe(new Date(NOW.getTime() + WEAR_UNDO_WINDOW_MS).toISOString());
    expect(result.items).toHaveLength(3);
    for (const counts of result.items) expect(counts).toMatchObject({ wearCount: 1, lastWornAt: NOON_NOV_3 });

    const logs = await testDb.db.select().from(wearLogs);
    expect(logs).toHaveLength(3);
    expect(new Set(logs.map((log) => log.itemId))).toEqual(new Set([sweater.id, jeans.id, boots.id]));
    for (const log of logs) {
      expect(log).toMatchObject({ outfitId, wornOn: "2026-11-03", weatherSnapshot: weather });
      expect(log.createdAt.toISOString()).toBe(NOW.toISOString());
    }
    expect(await stored(sweater.id)).toMatchObject({ wearCount: 1, lastWornAt: NOON_NOV_3 });
  });

  it("is idempotent per item, day and target", async () => {
    const [sweater, jeans] = await Promise.all([item("sweater"), item("jeans")]);
    const first = await logWear(testDb.db, { kind: "items", itemIds: [sweater.id] }, at(0));
    expect(first.logIds).toHaveLength(1);

    const second = await logWear(testDb.db, { kind: "items", itemIds: [sweater.id, jeans.id] }, at(60_000));
    expect(second.alreadyLogged).toEqual([sweater.id]);
    expect(second.logIds).toHaveLength(1);
    expect(second.items).toEqual([
      { id: sweater.id, wearCount: 1, lastWornAt: NOON_NOV_3 },
      { id: jeans.id, wearCount: 1, lastWornAt: NOON_NOV_3 },
    ]);

    // The same item worn as part of an outfit that day is a different target.
    const outfitId = await outfitOf([
      { slot: "top", item: sweater },
      { slot: "bottom", item: jeans },
    ]);
    const viaOutfit = await logWear(testDb.db, { kind: "outfit", outfitId }, at(120_000));
    expect(viaOutfit.alreadyLogged).toEqual([]);
    const again = await logWear(testDb.db, { kind: "outfit", outfitId }, at(180_000));
    expect(again.logIds).toEqual([]);
    expect(new Set(again.alreadyLogged)).toEqual(new Set([sweater.id, jeans.id]));
    expect(await stored(sweater.id)).toMatchObject({ wearCount: 2 });
    expect(await testDb.db.select().from(wearLogs)).toHaveLength(4);
  });

  it("never moves last_worn_at backwards", async () => {
    const sweater = await item("sweater");
    await logWear(testDb.db, { kind: "items", itemIds: [sweater.id] }, at(0));
    const older = await logWear(testDb.db, { kind: "items", itemIds: [sweater.id], wornOn: "2026-11-01" }, at(1_000));
    expect(older.wornOn).toBe("2026-11-01");
    expect(older.items).toEqual([{ id: sweater.id, wearCount: 2, lastWornAt: NOON_NOV_3 }]);

    const fresh = await item("jeans");
    await logWear(testDb.db, { kind: "items", itemIds: [fresh.id], wornOn: "2026-11-01" }, at(0));
    expect(await stored(fresh.id)).toMatchObject({ wearCount: 1, lastWornAt: NOON_NOV_1 });
  });

  it("dates today in the home time zone and refuses a future day", async () => {
    const sweater = await item("sweater");
    // 23:30 UTC on 2 Nov is already 3 Nov in Hamburg.
    const late = await logWear(testDb.db, { kind: "items", itemIds: [sweater.id] }, {
      now: new Date("2026-11-02T23:30:00.000Z"),
    });
    expect(late.wornOn).toBe("2026-11-03");

    const error = await appError(logWear(testDb.db, { kind: "items", itemIds: [sweater.id], wornOn: "2026-11-04" }, at(0)));
    expect(error.code).toBe("VALIDATION");
  });

  it("keeps the item's updated_at, since a wear is not an edit", async () => {
    const sweater = await item("sweater", { updatedAt: new Date("2026-10-01T08:00:00.000Z") });
    await testDb.db
      .update(items)
      .set({ updatedAt: new Date("2026-10-01T08:00:00.000Z") })
      .where(eq(items.id, sweater.id));
    await logWear(testDb.db, { kind: "items", itemIds: [sweater.id] }, at(0));
    expect((await stored(sweater.id)).updatedAt.toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });

  it("refuses archived and missing items and missing or empty outfits, writing nothing", async () => {
    const [sweater, archived] = await Promise.all([item("sweater"), item("jeans", { status: "archived" })]);
    expect((await appError(logWear(testDb.db, { kind: "items", itemIds: [sweater.id, archived.id] }, at(0)))).code).toBe(
      "VALIDATION",
    );
    const missing = await appError(logWear(testDb.db, { kind: "items", itemIds: [sweater.id, MISSING_ID] }, at(0)));
    expect(missing).toMatchObject({ code: "NOT_FOUND", details: { itemIds: [MISSING_ID] } });
    expect((await appError(logWear(testDb.db, { kind: "outfit", outfitId: MISSING_ID }, at(0)))).code).toBe("NOT_FOUND");

    const [empty] = await testDb.db.insert(outfits).values({ name: "Emptied" }).returning();
    if (empty === undefined) throw new Error("no outfit");
    expect((await appError(logWear(testDb.db, { kind: "outfit", outfitId: empty.id }, at(0)))).code).toBe("VALIDATION");

    expect(await testDb.db.select().from(wearLogs)).toEqual([]);
    expect(await stored(sweater.id)).toMatchObject({ wearCount: 0, lastWornAt: null });
  });

  it("asks for a home city when none is set", async () => {
    await testDb.db.update(appSettings).set({ homeProfileId: null });
    const sweater = await item("sweater");
    const error = await appError(logWear(testDb.db, { kind: "items", itemIds: [sweater.id] }, at(0)));
    expect(error).toMatchObject({ code: "VALIDATION", details: { reason: "no_home_profile" } });
  });

  it("validates the input and checks the session first", async () => {
    expect((await appError(logWear(testDb.db, { kind: "items", itemIds: [] }, at(0)))).code).toBe("VALIDATION");
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Signed out"));
    expect((await appError(logWear(testDb.db, { kind: "items", itemIds: [MISSING_ID] }, at(0)))).code).toBe(
      "UNAUTHENTICATED",
    );
  });
});

describe("undoWear", () => {
  it("reverts the counts within the window and recomputes last_worn_at from the remaining logs", async () => {
    const [sweater, jeans] = await Promise.all([item("sweater"), item("jeans")]);
    await logWear(testDb.db, { kind: "items", itemIds: [sweater.id], wornOn: "2026-11-01" }, at(-86_400_000));
    const today = await logWear(testDb.db, { kind: "items", itemIds: [sweater.id, jeans.id] }, at(0));
    expect(await stored(sweater.id)).toMatchObject({ wearCount: 2, lastWornAt: NOON_NOV_3 });

    const undone = await undoWear(testDb.db, { logIds: today.logIds }, at(WEAR_UNDO_WINDOW_MS - 1_000));
    expect(new Set(undone.undone)).toEqual(new Set(today.logIds));
    expect(undone.items).toHaveLength(2);
    expect(undone.items).toEqual(
      expect.arrayContaining([
        { id: sweater.id, wearCount: 1, lastWornAt: NOON_NOV_1 },
        { id: jeans.id, wearCount: 0, lastWornAt: null },
      ]),
    );
    expect(await stored(sweater.id)).toMatchObject({ wearCount: 1, lastWornAt: NOON_NOV_1 });
    expect(await stored(jeans.id)).toMatchObject({ wearCount: 0, lastWornAt: null });
    expect(await testDb.db.select().from(wearLogs)).toHaveLength(1);
  });

  it("refuses an undo after the window and changes nothing", async () => {
    const sweater = await item("sweater");
    const logged = await logWear(testDb.db, { kind: "items", itemIds: [sweater.id] }, at(0));
    const error = await appError(undoWear(testDb.db, { logIds: logged.logIds }, at(WEAR_UNDO_WINDOW_MS + 1)));
    expect(error).toMatchObject({ code: "VALIDATION", details: { reason: "undo_window_passed" } });
    expect(await stored(sweater.id)).toMatchObject({ wearCount: 1, lastWornAt: NOON_NOV_3 });
    expect(await testDb.db.select().from(wearLogs)).toHaveLength(1);
  });

  it("answers NOT_FOUND when undone twice, and never counts below zero", async () => {
    const sweater = await item("sweater");
    const logged = await logWear(testDb.db, { kind: "items", itemIds: [sweater.id] }, at(0));
    // Counted by something other than a log (a manual fix), then reset.
    await testDb.db.update(items).set({ wearCount: 0 }).where(eq(items.id, sweater.id));
    await undoWear(testDb.db, { logIds: logged.logIds }, at(1_000));
    expect(await stored(sweater.id)).toMatchObject({ wearCount: 0, lastWornAt: null });
    expect((await appError(undoWear(testDb.db, { logIds: logged.logIds }, at(2_000)))).code).toBe("NOT_FOUND");
  });

  it("undoes an outfit wear", async () => {
    const [sweater, jeans] = await Promise.all([item("sweater"), item("jeans")]);
    const outfitId = await outfitOf([
      { slot: "top", item: sweater },
      { slot: "bottom", item: jeans },
    ]);
    const logged = await logWear(testDb.db, { kind: "outfit", outfitId }, at(0));
    await undoWear(testDb.db, { logIds: logged.logIds }, at(5_000));
    expect(await stored(sweater.id)).toMatchObject({ wearCount: 0, lastWornAt: null });
    expect(await stored(jeans.id)).toMatchObject({ wearCount: 0, lastWornAt: null });
  });
});

describe("running gear (D-250)", () => {
  const NOT_CLOTHING_MESSAGE = "Running gear cannot be logged as part of an outfit. Swap it out first.";

  function runningItem(key: OutfitTemplateKey, overrides: Partial<Item> = {}): Promise<Item> {
    return item(key, { collection: "running", ...overrides });
  }

  async function expectNothingWritten(ids: readonly string[]): Promise<void> {
    expect(await testDb.db.select().from(wearLogs)).toEqual([]);
    for (const id of ids) expect(await stored(id)).toMatchObject({ wearCount: 0, lastWornAt: null });
  }

  it("counts a +1 of running gear logged on the item alone", async () => {
    const runner = await runningItem("sneakers");
    const result = await logWear(testDb.db, { kind: "items", itemIds: [runner.id] }, at(0));
    expect(result.logIds).toHaveLength(1);
    expect(result.items).toEqual([{ id: runner.id, wearCount: 1, lastWornAt: NOON_NOV_3 }]);
    expect(await stored(runner.id)).toMatchObject({ wearCount: 1, lastWornAt: NOON_NOV_3 });

    // asOutfit false is the same as leaving it out.
    const tee = await runningItem("tee");
    const explicit = await logWear(testDb.db, { kind: "items", itemIds: [tee.id], asOutfit: false }, at(1_000));
    expect(explicit.logIds).toHaveLength(1);
    expect(await stored(tee.id)).toMatchObject({ wearCount: 1 });
  });

  it("refuses an outfit wear holding running gear, writing nothing for any of its items", async () => {
    const [sweater, jeans, runner] = await Promise.all([item("sweater"), item("jeans"), runningItem("sneakers")]);
    const outfitId = await outfitOf([
      { slot: "top", item: sweater },
      { slot: "bottom", item: jeans },
      { slot: "shoes", item: runner },
    ]);

    const error = await appError(logWear(testDb.db, { kind: "outfit", outfitId }, at(0)));
    expect(error).toMatchObject({
      code: "VALIDATION",
      message: NOT_CLOTHING_MESSAGE,
      details: { itemIds: [runner.id], reason: "not_clothing" },
    });
    await expectNothingWritten([sweater.id, jeans.id, runner.id]);
  });

  it("applies the outfit rule to items sent asOutfit, and lets clothing through", async () => {
    const [sweater, jeans, runner] = await Promise.all([item("sweater"), item("jeans"), runningItem("sneakers")]);

    const error = await appError(
      logWear(testDb.db, { kind: "items", itemIds: [sweater.id, runner.id], asOutfit: true }, at(0)),
    );
    expect(error).toMatchObject({
      code: "VALIDATION",
      message: NOT_CLOTHING_MESSAGE,
      details: { itemIds: [runner.id], reason: "not_clothing" },
    });
    await expectNothingWritten([sweater.id, jeans.id, runner.id]);

    const clothing = await logWear(testDb.db, { kind: "items", itemIds: [sweater.id, jeans.id], asOutfit: true }, at(0));
    expect(clothing.logIds).toHaveLength(2);
    expect(await stored(sweater.id)).toMatchObject({ wearCount: 1, lastWornAt: NOON_NOV_3 });
    expect(await stored(jeans.id)).toMatchObject({ wearCount: 1, lastWornAt: NOON_NOV_3 });
    expect(await stored(runner.id)).toMatchObject({ wearCount: 0, lastWornAt: null });
  });

  it("reports an archived running item as archived first", async () => {
    const [sweater, retired] = await Promise.all([
      item("sweater"),
      runningItem("sneakers", { status: "archived" }),
    ]);
    const outfitId = await outfitOf([
      { slot: "top", item: sweater },
      { slot: "shoes", item: retired },
    ]);

    const error = await appError(logWear(testDb.db, { kind: "outfit", outfitId }, at(0)));
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toBe("Archived items cannot be logged as worn.");
    expect(error.details).toEqual({ itemIds: [retired.id] });
    await expectNothingWritten([sweater.id, retired.id]);
  });

  it("undoes a +1 of running gear", async () => {
    const runner = await runningItem("sneakers");
    const logged = await logWear(testDb.db, { kind: "items", itemIds: [runner.id] }, at(0));
    const undone = await undoWear(testDb.db, { logIds: logged.logIds }, at(5_000));
    expect(undone).toEqual({ undone: logged.logIds, items: [{ id: runner.id, wearCount: 0, lastWornAt: null }] });
    await expectNothingWritten([runner.id]);
  });
});

describe("listRecentWears", () => {
  it("lists the newest days first, with the outfit's name, for one item or all", async () => {
    const [sweater, jeans] = await Promise.all([item("sweater"), item("jeans")]);
    const outfitId = await outfitOf([
      { slot: "top", item: sweater },
      { slot: "bottom", item: jeans },
    ]);
    await logWear(testDb.db, { kind: "items", itemIds: [sweater.id], wornOn: "2026-11-01" }, at(0));
    await logWear(testDb.db, { kind: "outfit", outfitId }, at(1_000));

    const forSweater = await listRecentWears(testDb.db, { itemId: sweater.id, limit: 10 });
    expect(forSweater.map((wear) => [wear.wornOn, wear.outfitName])).toEqual([
      ["2026-11-03", "Office day"],
      ["2026-11-01", null],
    ]);
    expect(await listRecentWears(testDb.db, { limit: 2 })).toHaveLength(2);
    expect((await appError(listRecentWears(testDb.db, { itemId: "nope", limit: 1 }))).code).toBe("VALIDATION");
  });

  it("logs a wear of an item still waiting for tags", async () => {
    const pending = await makeItem(testDb.db);
    await logWear(testDb.db, { kind: "items", itemIds: [pending.id] }, at(0));
    expect(await listRecentWears(testDb.db, { itemId: pending.id, limit: 5 })).toHaveLength(1);
  });
});
