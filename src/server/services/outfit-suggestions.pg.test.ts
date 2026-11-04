import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { relations } from "@/lib/db/relations";
import { analyses, appSettings, climateProfiles, items, outfitItems, outfits, wearLogs } from "@/lib/db/schema";
import type { OutfitEntry } from "@/lib/outfits/contracts";
import type { OutfitSuggestionResult } from "@/lib/outfits/suggestion";
import { calendarDayIn } from "@/lib/wear/contracts";

import { makeOutfitWardrobe, makeWeatherSnapshot, type OutfitFixtureItem } from "../../../test/outfit-fixtures";
import { saveSuggestedOutfit } from "./outfit-suggestions";
import { logWear } from "./wear";

// Opt-in check against real Postgres (D-236), because PGlite runs one
// transaction at a time and cannot show two requests reading the same rows.
//
// 1. Two suggestions of the same day share three of their four items, and
//    "Wore this today" was pressed on both cards. Both are saved at once,
//    as from two tabs. A third connection holds the day's logs until both
//    Saves are waiting for a lock, so they overlap at the worst point. Without
//    the item locks both read the same logs with no outfit, and the second
//    moved the shared ones away from the first outfit; now the first takes
//    the whole wear and the second, finding the shared logs taken, none.
// 2. A Save and the card's "Wore this today" of the same items run at once
//    while a third connection holds the second item in id order, so each has
//    to wait in the middle of taking its locks. Taken in different orders
//    they deadlock (40P01); in id order they queue.
//
// Run it against a migrated and seeded database (logWear needs a home city),
// for example the Docker e2e one:
//
//   TEST_DATABASE_URL=postgres://wardrobe:wardrobe@localhost:5433/wardrobe_e2e \
//     pnpm exec vitest run src/server/services/outfit-suggestions.pg.test.ts
//
// It only touches its own rows (five items named after a random prefix, two
// analyses, their outfits and wear logs) and deletes them afterwards.

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));
// Save never reads the forecast; the module's cached fetch needs Next's cache runtime.
vi.mock("@/server/weather", () => ({ loadTodayWeather: vi.fn() }));

const url = process.env.TEST_DATABASE_URL;
const ROUNDS = 5;
/** How long both requests may take to reach their lock waits. */
const WAIT_LIMIT_MS = 10_000;

/** The Postgres error under the wrappers, as "40P01 deadlock detected". */
function driverError(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ("code" in current && typeof current.code === "string") return `${current.code} ${current.message}`;
    current = current.cause;
  }
  return String(error);
}

/** Plain code-unit order: lowercase uuid strings sort the way Postgres orders the uuids. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function sorted(values: readonly (string | null)[]): (string | null)[] {
  return [...values].sort((a, b) => byCodeUnit(a ?? "", b ?? ""));
}

describe.skipIf(!url)("saveSuggestedOutfit on real Postgres", () => {
  // Names this test's connections, so the lock waits counted are its own.
  const applicationName = `pg-save-${randomUUID().slice(0, 8)}`;
  const prefix = `pg-save-${randomUUID()}`;
  let pool: Pool;
  let db: Db;
  const wardrobe = makeOutfitWardrobe();
  const { shell, oxford, sweater, jeans, boots } = wardrobe;
  const mine = [shell, oxford, sweater, jeans, boots].map((item) => item.id);
  // Three shared items; the top differs.
  const outfitX: OutfitEntry[] = [
    { slot: "outerwear", itemId: shell.id },
    { slot: "top", itemId: oxford.id },
    { slot: "bottom", itemId: jeans.id },
    { slot: "shoes", itemId: boots.id },
  ];
  const outfitY: OutfitEntry[] = outfitX.map((entry) => (entry.slot === "top" ? { ...entry, itemId: sweater.id } : entry));
  const idsOf = (outfit: readonly OutfitEntry[]) => outfit.map((entry) => entry.itemId);
  let analysisX = "";
  let analysisY = "";

  async function insertItem(item: OutfitFixtureItem): Promise<void> {
    await db.insert(items).values({
      id: item.id,
      imageHash: `${randomUUID()}${randomUUID()}`.replaceAll("-", "").slice(0, 64),
      status: item.status,
      location: item.location,
      decision: item.decision,
      name: `${prefix} ${item.name ?? ""}`,
      category: item.category,
      subcategory: item.subcategory,
      colors: [...item.colors],
      materials: [...item.materials],
      warmthLevel: item.warmthLevel,
      waterproof: item.waterproof,
      windproof: item.windproof,
      insulated: item.insulated,
      breathable: item.breathable,
      seasons: [...item.seasons],
      formality: item.formality,
      condition: item.condition ?? "good",
    });
  }

  async function insertSuggestion(outfit: OutfitEntry[], profileId: string, day: string, timeZone: string) {
    const result: OutfitSuggestionResult = {
      outfits: [0, 1, 2].map((index) => ({
        title: `${prefix} ${index}`,
        why: "Shared pieces for a test of concurrent saves.",
        rain_ok: true,
        items: outfit,
      })),
      weather: makeWeatherSnapshot({ date: day, timezone: timeZone }),
      meta: { prompt_version: "pg-test", model: "claude-sonnet-5-5", effort: "low", item_count: 5, dropped_count: 0 },
    };
    const [row] = await db
      .insert(analyses)
      .values({
        kind: "outfit_suggestion",
        status: "complete",
        climateProfileId: profileId,
        dateFrom: day,
        dateTo: day,
        params: {},
        model: "claude-sonnet-5-5",
        effort: "low",
        promptVersion: "pg-test",
        result,
        completedAt: new Date(),
      })
      .returning({ id: analyses.id });
    if (row === undefined) throw new Error("analysis not inserted");
    return row.id;
  }

  /** Removes what a round made: its outfits and wear logs, the counts, the saves on the analyses. */
  async function reset(): Promise<void> {
    const made = db.select({ id: outfitItems.outfitId }).from(outfitItems).where(inArray(outfitItems.itemId, mine));
    await db.delete(outfits).where(inArray(outfits.id, made));
    await db.delete(wearLogs).where(inArray(wearLogs.itemId, mine));
    await db.update(items).set({ wearCount: 0, lastWornAt: null }).where(inArray(items.id, mine));
    await db.update(analyses).set({ params: {} }).where(inArray(analyses.id, [analysisX, analysisY]));
  }

  async function lockWaits(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'",
      [applicationName],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * Starts both requests while another connection holds some rows, waits
   * until both are waiting for a lock, then lets go. Without the wait the
   * first request could finish before the second reads anything.
   */
  async function whileHeld<T>(
    lock: { text: string; values: unknown[] },
    start: () => Promise<T>[],
  ): Promise<PromiseSettledResult<T>[]> {
    const holder = await pool.connect();
    let settled: Promise<PromiseSettledResult<T>[]>;
    try {
      await holder.query("begin");
      await holder.query(lock.text, lock.values);
      settled = Promise.allSettled(start());
      const until = Date.now() + WAIT_LIMIT_MS;
      while ((await lockWaits()) < 2) {
        if (Date.now() > until) throw new Error("the two requests never both waited for a lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await holder.query("commit");
      holder.release();
    }
    return await settled;
  }

  function failuresOf(outcomes: readonly PromiseSettledResult<unknown>[]): string {
    return outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [driverError(outcome.reason)] : [])).join("; ");
  }

  async function logsOf(itemIds: readonly string[]) {
    return await db
      .select({ id: wearLogs.id, itemId: wearLogs.itemId, outfitId: wearLogs.outfitId })
      .from(wearLogs)
      .where(inArray(wearLogs.itemId, [...itemIds]));
  }

  async function wearCounts(itemIds: readonly string[]): Promise<number[]> {
    const rows = await db.select({ wearCount: items.wearCount }).from(items).where(inArray(items.id, [...itemIds]));
    return rows.map((row) => row.wearCount);
  }

  beforeAll(async () => {
    requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
    pool = new Pool({ connectionString: url, max: 8, application_name: applicationName });
    db = drizzle({ client: pool, relations });
    const [home] = await db
      .select({ id: climateProfiles.id, timeZone: climateProfiles.timezone })
      .from(appSettings)
      .innerJoin(climateProfiles, eq(climateProfiles.id, appSettings.homeProfileId))
      .where(eq(appSettings.id, 1));
    if (home === undefined) throw new Error("Seed the database first: no home city is set.");
    const day = calendarDayIn(home.timeZone, new Date());
    for (const item of [shell, oxford, sweater, jeans, boots]) await insertItem(item);
    analysisX = await insertSuggestion(outfitX, home.id, day, home.timeZone);
    analysisY = await insertSuggestion(outfitY, home.id, day, home.timeZone);
  });

  afterAll(async () => {
    const made = db.select({ id: outfitItems.outfitId }).from(outfitItems).where(inArray(outfitItems.itemId, mine));
    await db.delete(outfits).where(inArray(outfits.id, made));
    const suggestions = [analysisX, analysisY].filter((id) => id !== "");
    if (suggestions.length > 0) await db.delete(analyses).where(inArray(analyses.id, suggestions));
    // Their wear logs and outfit rows cascade.
    await db.delete(items).where(inArray(items.id, mine));
    await pool.end();
  });

  it("gives the day's wear, whole, to one of two suggestions saved at once with shared items", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await reset();
      // "Wore this today" on both cards: X logs its four items, Y only the
      // sweater, since the shared three are already logged for the day.
      const cardX = await logWear(db, { kind: "items", itemIds: idsOf(outfitX) }, { now: new Date() });
      const cardY = await logWear(db, { kind: "items", itemIds: idsOf(outfitY) }, { now: new Date() });
      expect(cardX.logIds).toHaveLength(4);
      expect(cardY.logIds).toHaveLength(1);

      const dayLogs = [...cardX.logIds, ...cardY.logIds];
      const outcomes = await whileHeld(
        { text: "select id from wear_logs where id = any($1::uuid[]) for update", values: [dayLogs] },
        () => [
          saveSuggestedOutfit(db, { analysisId: analysisX, index: 0 }),
          saveSuggestedOutfit(db, { analysisId: analysisY, index: 0 }),
        ],
      );

      expect(failuresOf(outcomes), `round ${round}`).toBe("");
      const [savedX, savedY] = outcomes.map((outcome) => (outcome.status === "fulfilled" ? outcome.value.outfitId : ""));
      const logs = await logsOf(mine);
      expect(logs, `round ${round}`).toHaveLength(5);
      const holders = [...new Set(logs.flatMap((log) => (log.outfitId === null ? [] : [log.outfitId])))];
      // One outfit has the wear, with a log for each of its items; the other has none.
      expect(holders, `round ${round}`).toHaveLength(1);
      const winner = holders[0] ?? "";
      expect([savedX, savedY], `round ${round}`).toContain(winner);
      const winnerItems = winner === savedX ? idsOf(outfitX) : idsOf(outfitY);
      expect(
        sorted(logs.filter((log) => log.outfitId === winner).map((log) => log.itemId)),
        `round ${round}`,
      ).toEqual(sorted(winnerItems));
      expect(await wearCounts(mine), `round ${round}`).toEqual(mine.map(() => 1));

      // The winner's own "Wore this today" counts nothing again.
      const again = await logWear(db, { kind: "outfit", outfitId: winner }, { now: new Date() });
      expect(again.logIds, `round ${round}`).toEqual([]);
      expect(sorted(again.alreadyLogged), `round ${round}`).toEqual(sorted(winnerItems));
      expect(await wearCounts(mine), `round ${round}`).toEqual(mine.map(() => 1));
    }
  }, 120_000);

  it("runs a Save and the card's wear of the same items at once without a deadlock", async () => {
    const itemIds = idsOf(outfitX);
    const second = [...itemIds].sort(byCodeUnit)[1];
    if (second === undefined) throw new Error("no items");
    for (let round = 0; round < ROUNDS; round += 1) {
      await reset();

      const outcomes = await whileHeld<unknown>(
        { text: "select id from items where id = $1 for update", values: [second] },
        () => [
          saveSuggestedOutfit(db, { analysisId: analysisX, index: 0 }),
          logWear(db, { kind: "items", itemIds }, { now: new Date() }),
        ],
      );

      expect(failuresOf(outcomes), `round ${round}`).toBe("");
      const logs = await logsOf(itemIds);
      expect(logs, `round ${round}`).toHaveLength(itemIds.length);
      // Whichever ran first, the wear is either all the outfit's or all loose.
      expect(new Set(logs.map((log) => log.outfitId)).size, `round ${round}`).toBe(1);
      expect(await wearCounts(itemIds), `round ${round}`).toEqual(itemIds.map(() => 1));
    }
  }, 120_000);
});
