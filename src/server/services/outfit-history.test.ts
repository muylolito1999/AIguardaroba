import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BOLOGNA } from "@/lib/climate/bologna";
import { HAMBURG } from "@/lib/climate/hamburg";
import {
  analyses,
  climateProfiles,
  outfitItems,
  outfits,
  wearLogs,
  type ClimateProfile,
  type Item,
} from "@/lib/db/schema";
import { EMPTY_HISTORY } from "@/lib/outfits/style/types";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeItem } from "../../../test/factories";
import { makeWeatherSnapshot } from "../../../test/outfit-fixtures";
import { addDays, daysBetween, HISTORY_LIMITS, loadVarietyHistory } from "./outfit-history";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const TODAY = "2026-11-06";
const NOW = new Date("2026-11-06T13:20:00.000Z");

let testDb: TestDb;
let hamburg: ClimateProfile;
let bologna: ClimateProfile;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  const rows = await testDb.db.insert(climateProfiles).values([HAMBURG, BOLOGNA]).returning();
  const h = rows.find((row) => row.slug === "hamburg");
  const b = rows.find((row) => row.slug === "bologna");
  if (h === undefined || b === undefined) throw new Error("profiles missing");
  hamburg = h;
  bologna = b;
});

afterAll(async () => {
  await testDb.close();
});

function load(profile: ClimateProfile = hamburg, today = TODAY) {
  return loadVarietyHistory(testDb.db, { profileId: profile.id, today });
}

function ids(count: number): string[] {
  return Array.from({ length: count }, () => randomUUID());
}

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

// ---------------------------------------------------------------------------
// Stored suggestions
// ---------------------------------------------------------------------------

const SLOTS = ["top", "bottom", "shoes", "outerwear"] as const;

/** A result as prompt v2 stored it: no direction on the outfits, no directions in meta. */
function v2Result(outfitItemIds: readonly (readonly string[])[], date = TODAY) {
  return {
    outfits: outfitItemIds.map((itemIds, index) => ({
      title: `Outfit ${index + 1}`,
      why: "Warm enough for the wind.",
      rain_ok: true,
      items: itemIds.map((itemId, position) => ({ slot: SLOTS[position % SLOTS.length], itemId })),
    })),
    weather: makeWeatherSnapshot({ date }),
    meta: { prompt_version: "outfits-v2", model: "claude-sonnet-5-5", effort: "low", item_count: 12, dropped_count: 0 },
  };
}

/** A newer result: a direction per outfit and, optionally, the directions of every candidate in meta. */
function v3Result(
  outfitList: readonly { itemIds: readonly string[]; direction?: unknown }[],
  options: { date?: string; directions?: unknown } = {},
) {
  const base = v2Result(
    outfitList.map((outfit) => outfit.itemIds),
    options.date,
  );
  return {
    ...base,
    outfits: base.outfits.map((outfit, index) => ({ ...outfit, direction: outfitList[index]?.direction ?? null })),
    meta: {
      ...base.meta,
      prompt_version: "outfits-v3",
      candidate_count: 6,
      ...(options.directions === undefined ? {} : { directions: options.directions }),
    },
  };
}

async function storeRun(options: {
  dateFrom: string;
  result: unknown;
  profile?: ClimateProfile;
  status?: "complete" | "failed" | "running";
  completedAt?: Date | null;
  createdAt?: Date;
}): Promise<string> {
  const [row] = await testDb.db
    .insert(analyses)
    .values({
      kind: "outfit_suggestion",
      status: options.status ?? "complete",
      climateProfileId: (options.profile ?? hamburg).id,
      dateFrom: options.dateFrom,
      dateTo: options.dateFrom,
      params: {},
      model: "claude-sonnet-5-5",
      effort: "low",
      promptVersion: "outfits-v3",
      result: options.result,
      costUsd: 0.04,
      completedAt: options.completedAt === undefined ? NOW : options.completedAt,
      createdAt: options.createdAt ?? NOW,
    })
    .returning({ id: analyses.id });
  if (row === undefined) throw new Error("no analysis");
  return row.id;
}

// ---------------------------------------------------------------------------
// Saved outfits and wears
// ---------------------------------------------------------------------------

async function items(count: number): Promise<Item[]> {
  return Promise.all(Array.from({ length: count }, () => makeItem(testDb.db)));
}

async function saveOutfit(
  itemList: readonly Item[],
  options: { rating?: number | null; source?: "user" | "ai"; createdAt?: Date; name?: string } = {},
): Promise<string> {
  const [row] = await testDb.db
    .insert(outfits)
    .values({
      name: options.name ?? "Outfit",
      rating: options.rating ?? null,
      source: options.source ?? "user",
      createdAt: options.createdAt ?? NOW,
    })
    .returning({ id: outfits.id });
  if (row === undefined) throw new Error("no outfit");
  if (itemList.length > 0) {
    await testDb.db
      .insert(outfitItems)
      .values(
        itemList.map((item, position) => ({ outfitId: row.id, itemId: item.id, slot: SLOTS[position % SLOTS.length] })),
      );
  }
  return row.id;
}

async function logWears(
  itemList: readonly Item[],
  wornOn: string,
  options: { outfitId?: string; createdAt?: Date } = {},
): Promise<void> {
  await testDb.db.insert(wearLogs).values(
    itemList.map((item) => ({
      itemId: item.id,
      outfitId: options.outfitId ?? null,
      wornOn,
      createdAt: options.createdAt ?? NOW,
    })),
  );
}

/** Logs every item of a saved outfit on each of these days. */
async function wearOutfit(outfitId: string, itemList: readonly Item[], days: readonly string[]): Promise<void> {
  for (const day of days) await logWears(itemList, day, { outfitId });
}

const sorted = (values: readonly string[]) => [...values].sort();

// ---------------------------------------------------------------------------

describe("addDays and daysBetween", () => {
  it("count calendar days across months, years and DST changes", () => {
    expect(addDays("2026-11-06", -6)).toBe("2026-10-31");
    expect(addDays("2026-11-06", -13)).toBe("2026-10-24");
    expect(addDays("2026-01-03", -5)).toBe("2025-12-29");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    // Europe's clocks went back on 25 Oct 2026; UTC days do not notice.
    expect(addDays("2026-10-26", -1)).toBe("2026-10-25");
    expect(daysBetween("2026-10-24", "2026-11-06")).toBe(13);
    expect(daysBetween("2026-11-06", "2026-11-06")).toBe(0);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
  });

  it("refuse a day that is not a real date", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => daysBetween("today", "2026-11-06")).toThrow(RangeError);
  });
});

describe("loadVarietyHistory", () => {
  it("checks the session first and lets its rejection through", async () => {
    await load();
    expect(requireSession).toHaveBeenCalledTimes(1);

    requireSession.mockRejectedValueOnce(new Error("signed out"));
    await expect(load()).rejects.toThrow("signed out");
  });

  it("answers the empty history for an empty database", async () => {
    expect(await load()).toEqual(EMPTY_HISTORY);
  });

  describe("suggested", () => {
    it("lists the outfits of complete suggestions of the last 7 days for the home city, newest first", async () => {
      const [t1, t2, y1, d6] = [ids(4), ids(3), ids(4), ids(3)];
      const [d7, other, failed, running] = [ids(3), ids(3), ids(3), ids(3)];
      await storeRun({
        dateFrom: TODAY,
        result: v3Result([{ itemIds: t1, direction: "dark_monochrome" }, { itemIds: t2 }]),
      });
      await storeRun({ dateFrom: addDays(TODAY, -1), result: v3Result([{ itemIds: y1, direction: "earth_tones" }]) });
      await storeRun({ dateFrom: addDays(TODAY, -6), result: v2Result([d6]) });
      await storeRun({ dateFrom: addDays(TODAY, -7), result: v2Result([d7]) });
      await storeRun({ dateFrom: TODAY, profile: bologna, result: v2Result([other]) });
      await storeRun({ dateFrom: TODAY, status: "failed", completedAt: null, result: v2Result([failed]) });
      await storeRun({ dateFrom: TODAY, status: "running", completedAt: null, result: v2Result([running]) });

      const history = await load();

      expect(history.suggested).toEqual([
        { itemIds: t1, ageDays: 0, direction: "dark_monochrome" },
        { itemIds: t2, ageDays: 0, direction: null },
        { itemIds: y1, ageDays: 1, direction: "earth_tones" },
        { itemIds: d6, ageDays: 6, direction: null },
      ]);
    });

    it("orders runs of one day by completion, a run without completed_at last", async () => {
      const [early, late, unfinished] = [ids(2), ids(2), ids(2)];
      await storeRun({ dateFrom: TODAY, completedAt: null, createdAt: minutesAgo(1), result: v2Result([unfinished]) });
      const run = (completedMinutesAgo: number, result: unknown) =>
        storeRun({
          dateFrom: TODAY,
          completedAt: minutesAgo(completedMinutesAgo),
          createdAt: minutesAgo(completedMinutesAgo + 1),
          result,
        });
      await run(30, v2Result([early]));
      await run(5, v2Result([late]));

      const history = await load();

      expect(history.suggested.map((entry) => entry.itemIds)).toEqual([late, early, unfinished]);
    });

    it("reads old v2 results, drops repeated item ids and skips results it cannot read", async () => {
      const [a, b, c] = ids(3) as [string, string, string];
      await storeRun({ dateFrom: TODAY, result: v2Result([[a, b, a, c]]) });
      await storeRun({ dateFrom: TODAY, result: { outfits: "not a list" } });
      await storeRun({ dateFrom: TODAY, result: null });
      await storeRun({ dateFrom: TODAY, result: { outfits: [{ items: [{ slot: "top" }] }] } });
      // A malformed direction alone does not make the outfit unreadable.
      await storeRun({ dateFrom: addDays(TODAY, -2), result: v3Result([{ itemIds: [a, b], direction: 42 }]) });

      const history = await load();

      expect(history.suggested).toEqual([
        { itemIds: [a, b, c], ageDays: 0, direction: null },
        { itemIds: [a, b], ageDays: 2, direction: null },
      ]);
    });

    it("keeps ids of items that no longer exist: the caller drops them", async () => {
      const gone = ids(3);
      await storeRun({ dateFrom: TODAY, result: v2Result([gone]) });

      expect((await load()).suggested).toEqual([{ itemIds: gone, ageDays: 0, direction: null }]);
    });
  });

  describe("recentDirections", () => {
    it("takes every candidate's directions when stored, else the shown outfits', for today and yesterday", async () => {
      await storeRun({
        dateFrom: TODAY,
        result: v3Result(
          [
            { itemIds: ids(3), direction: "dark_monochrome" },
            { itemIds: ids(3), direction: "earth_tones" },
          ],
          { directions: ["dark_monochrome", "earth_tones", "smart_collar", "knit_layers"] },
        ),
      });
      await storeRun({
        dateFrom: addDays(TODAY, -1),
        result: v3Result([
          { itemIds: ids(3), direction: "sporty_clean" },
          { itemIds: ids(3), direction: null },
          { itemIds: ids(3), direction: "texture_play" },
        ]),
      });
      // Not an array of strings: the outfits' directions stand in.
      await storeRun({
        dateFrom: addDays(TODAY, -1),
        completedAt: minutesAgo(60 * 24 + 5),
        result: v3Result([{ itemIds: ids(3), direction: "cosy_winter" }], { directions: [1, 2] }),
      });
      // Too old for the directions, still in suggested.
      await storeRun({
        dateFrom: addDays(TODAY, -2),
        result: v3Result([{ itemIds: ids(3), direction: "preppy_layers" }], { directions: ["preppy_layers"] }),
      });

      const history = await load();

      expect(history.recentDirections).toEqual([
        { key: "dark_monochrome", ageDays: 0 },
        { key: "earth_tones", ageDays: 0 },
        { key: "smart_collar", ageDays: 0 },
        { key: "knit_layers", ageDays: 0 },
        { key: "sporty_clean", ageDays: 1 },
        { key: "texture_play", ageDays: 1 },
        { key: "cosy_winter", ageDays: 1 },
      ]);
      expect(history.suggested.map((entry) => entry.direction)).toContain("preppy_layers");
    });

    it("is empty when the recent runs have no directions (v2 results)", async () => {
      await storeRun({ dateFrom: TODAY, result: v2Result([ids(3), ids(3), ids(3)]) });

      expect((await load()).recentDirections).toEqual([]);
    });
  });

  describe("runIndex", () => {
    it("counts today's complete and failed suggestions for the home city only, not running ones", async () => {
      await storeRun({ dateFrom: TODAY, result: v2Result([ids(3)]) });
      await storeRun({ dateFrom: TODAY, result: v3Result([{ itemIds: ids(3) }]) });
      // Complete but unreadable: still a run of today.
      await storeRun({ dateFrom: TODAY, result: { broken: true } });
      await storeRun({ dateFrom: TODAY, status: "failed", completedAt: null, result: null });
      await storeRun({ dateFrom: TODAY, status: "running", completedAt: null, result: null });
      await storeRun({ dateFrom: addDays(TODAY, -1), result: v2Result([ids(3)]) });
      await storeRun({ dateFrom: addDays(TODAY, -1), status: "failed", completedAt: null, result: null });
      await storeRun({ dateFrom: TODAY, profile: bologna, result: v2Result([ids(3)]) });
      await storeRun({ dateFrom: TODAY, profile: bologna, status: "failed", completedAt: null, result: null });

      expect((await load()).runIndex).toBe(4);
      expect((await load(bologna)).runIndex).toBe(2);
    });

    it("moves on after a failed run, so the next one draws other directions, but reads nothing from it", async () => {
      const failedIds = ids(3);
      await storeRun({ dateFrom: TODAY, result: v3Result([{ itemIds: ids(3), direction: "earth_tones" }]) });
      const before = await load();
      // A failed run with a result stored anyway: counted, never read.
      await storeRun({
        dateFrom: TODAY,
        status: "failed",
        completedAt: null,
        result: v3Result([{ itemIds: failedIds, direction: "dark_monochrome" }], { directions: ["dark_monochrome"] }),
      });

      const after = await load();

      expect(before.runIndex).toBe(1);
      expect(after.runIndex).toBe(2);
      expect(after.suggested).toEqual(before.suggested);
      expect(after.recentDirections).toEqual(before.recentDirections);
      expect(after.suggested.some((entry) => entry.itemIds === failedIds)).toBe(false);
    });
  });

  describe("worn", () => {
    it("groups the logs of the last 14 days by day and outfit, loose logs of a day as one group", async () => {
      const [a, b, c, d, e, f] = (await items(6)) as [Item, Item, Item, Item, Item, Item];
      const office = await saveOutfit([a, b, c]);
      const weekend = await saveOutfit([d, e, f]);

      // Today: the office outfit, and two loose "+1 worn today" presses earlier.
      await logWears([a, b, c], TODAY, { outfitId: office, createdAt: minutesAgo(10) });
      await logWears([d], TODAY, { createdAt: minutesAgo(120) });
      await logWears([e], TODAY, { createdAt: minutesAgo(115) });
      // Yesterday: a single loose press, not an outfit.
      await logWears([a], addDays(TODAY, -1));
      // Three days ago: the weekend outfit and loose items of the same day apart.
      await logWears([d, e, f], addDays(TODAY, -3), { outfitId: weekend, createdAt: minutesAgo(3 * 1440) });
      await logWears([a, b], addDays(TODAY, -3), { createdAt: minutesAgo(3 * 1440 + 60) });
      // The edges of the window.
      await logWears([b, c], addDays(TODAY, -13));
      await logWears([e, f], addDays(TODAY, -14));

      const history = await load();

      expect(history.worn.map((entry) => ({ itemIds: sorted(entry.itemIds), ageDays: entry.ageDays }))).toEqual([
        { itemIds: sorted([a.id, b.id, c.id]), ageDays: 0 },
        { itemIds: sorted([d.id, e.id]), ageDays: 0 },
        { itemIds: sorted([d.id, e.id, f.id]), ageDays: 3 },
        { itemIds: sorted([a.id, b.id]), ageDays: 3 },
        { itemIds: sorted([b.id, c.id]), ageDays: 13 },
      ]);
    });

    it("skips an outfit group of one item and reads an outfit-only log as the outfit's items", async () => {
      const [a, b, c] = (await items(3)) as [Item, Item, Item];
      const single = await saveOutfit([a, b]);
      const whole = await saveOutfit([b, c]);
      // Only one item of this outfit was logged that day.
      await logWears([a], addDays(TODAY, -2), { outfitId: single });
      // The schema allows a log of an outfit without an item.
      await testDb.db.insert(wearLogs).values({ outfitId: whole, wornOn: addDays(TODAY, -4) });

      const history = await load();

      expect(history.worn.map((entry) => ({ itemIds: sorted(entry.itemIds), ageDays: entry.ageDays }))).toEqual([
        { itemIds: sorted([b.id, c.id]), ageDays: 4 },
      ]);
    });
  });

  describe("liked and disliked", () => {
    it("ranks rated 4-5 first, then outfits worn on two days or more, never one rated 1 or 2", async () => {
      const [a, b, c, d, e, f] = (await items(6)) as [Item, Item, Item, Item, Item, Item];
      const day = (n: number) => addDays(TODAY, -n);

      await saveOutfit([a, b], { rating: 5, createdAt: minutesAgo(500), source: "ai" });
      await saveOutfit([b, c], { rating: 4, createdAt: minutesAgo(100) });
      const fourWorn = await saveOutfit([c, d], { rating: 4, createdAt: minutesAgo(400) });
      await wearOutfit(fourWorn, [c, d], [day(1), day(20), day(40)]);
      const threeWorn = await saveOutfit([d, e], { rating: 3, createdAt: minutesAgo(300) });
      await wearOutfit(threeWorn, [d, e], [day(2), day(30)]);
      const unratedWorn = await saveOutfit([e, f], { createdAt: minutesAgo(50), source: "ai" });
      await wearOutfit(unratedWorn, [e, f], [day(3), day(60)]);
      // Many logs on one day count as one wear.
      const unratedOnce = await saveOutfit([a, c, e], { createdAt: minutesAgo(10) });
      await wearOutfit(unratedOnce, [a, c, e], [day(5)]);
      await logWears([b], day(5), { outfitId: unratedOnce });
      const threeOnce = await saveOutfit([a, f], { rating: 3, createdAt: minutesAgo(20) });
      await wearOutfit(threeOnce, [a, f], [day(6)]);
      const twoWorn = await saveOutfit([b, f], { rating: 2, createdAt: minutesAgo(200) });
      await wearOutfit(twoWorn, [b, f], [day(7), day(8), day(9)]);
      await saveOutfit([c, f], { rating: 1, createdAt: minutesAgo(30) });

      const history = await load();

      expect(history.liked.map((entry) => ({ ...entry, itemIds: sorted(entry.itemIds) }))).toEqual([
        { itemIds: sorted([a.id, b.id]), rating: 5, timesWorn: 0, source: "ai" },
        { itemIds: sorted([c.id, d.id]), rating: 4, timesWorn: 3, source: "user" },
        { itemIds: sorted([b.id, c.id]), rating: 4, timesWorn: 0, source: "user" },
        { itemIds: sorted([d.id, e.id]), rating: 3, timesWorn: 2, source: "user" },
        { itemIds: sorted([e.id, f.id]), rating: null, timesWorn: 2, source: "ai" },
      ]);
      expect(history.disliked.map((entry) => ({ ...entry, itemIds: sorted(entry.itemIds) }))).toEqual([
        { itemIds: sorted([c.id, f.id]), rating: 1, timesWorn: 0, source: "user" },
        { itemIds: sorted([b.id, f.id]), rating: 2, timesWorn: 3, source: "user" },
      ]);
    });

    it("keeps the newest outfits of equal rank up to the caps", async () => {
      const likedItems = await items(HISTORY_LIMITS.liked + 2);
      const dislikedItems = await items(HISTORY_LIMITS.disliked + 2);
      // Each outfit holds an item of its own, created one minute after the one before.
      for (const [index, item] of likedItems.entries()) {
        await saveOutfit([item], { rating: 5, createdAt: minutesAgo(1000 - index) });
      }
      for (const [index, item] of dislikedItems.entries()) {
        await saveOutfit([item], { rating: 2, createdAt: minutesAgo(500 - index) });
      }

      const history = await load();

      const newestFirst = (list: readonly Item[], cap: number) =>
        list
          .slice(-cap)
          .reverse()
          .map((item) => [item.id]);
      expect(history.liked.map((entry) => entry.itemIds)).toEqual(newestFirst(likedItems, HISTORY_LIMITS.liked));
      expect(history.disliked.map((entry) => entry.itemIds)).toEqual(
        newestFirst(dislikedItems, HISTORY_LIMITS.disliked),
      );
    });
  });
});
