import "server-only";

import { and, asc, countDistinct, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { analyses, outfitItems, outfits, wearLogs } from "@/lib/db/schema";
import type { HistoryEntry, TasteEntry, VarietyHistory } from "@/lib/outfits/style/types";
import { parseIsoDate } from "@/lib/relocation/contracts";

// What a paid outfit suggestion is told about the past (D-257), so "Suggest
// again" gives something new: the outfits suggested and worn lately, the saved
// outfits the owner liked or disliked, today's and yesterday's style
// directions and how many suggestions today already has. The deterministic
// scorer reads the same history to penalise repeats.
//
// Item ids are passed on as stored, even for items deleted, archived or moved
// to running gear since: the caller maps them to today's aliases and drops
// the ones it does not know.

export const HISTORY_LIMITS = { suggestedDays: 7, wornDays: 14, liked: 8, disliked: 4 } as const;

const DAY_MS = 86_400_000;

function utcDay(day: string): number {
  const parsed = parseIsoDate(day);
  if (parsed === null) throw new RangeError(`Not a valid date: ${day}`);
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day);
}

/** The calendar day `days` days after a YYYY-MM-DD day (negative goes back). Throws a RangeError for an invalid day. */
export function addDays(day: string, days: number): string {
  return new Date(utcDay(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD): 0 for the same day, 1 when `from` is the day before. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS);
}

// ---------------------------------------------------------------------------
// The stored suggestion, read leniently
// ---------------------------------------------------------------------------

/**
 * Only what the history needs from analyses.result. Unknown keys are ignored
 * and the newer optional fields (an outfit's direction, meta.directions) may
 * be missing or malformed, so results of every prompt version are read.
 */
const StoredSuggestionSchema = z.object({
  outfits: z.array(
    z.object({
      items: z.array(z.object({ itemId: z.string().min(1) })),
      direction: z.string().min(1).nullish().catch(null),
    }),
  ),
  meta: z.object({ directions: z.unknown() }).partial().nullish().catch(null),
});
type StoredSuggestion = z.infer<typeof StoredSuggestionSchema>;

const DirectionListSchema = z.array(z.string().min(1)).min(1);

/** The directions of a run: those assigned to all its candidates when stored, else those of the outfits shown. */
function runDirections(result: StoredSuggestion): string[] {
  const assigned = DirectionListSchema.safeParse(result.meta?.directions);
  if (assigned.success) return assigned.data;
  return result.outfits.flatMap((outfit) => (typeof outfit.direction === "string" ? [outfit.direction] : []));
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Complete suggestions for the home city from `from` to `today`, and today's
 * failed ones (which only runIndex counts), newest first.
 */
function suggestionRows(db: Db, profileId: string, from: string, today: string) {
  return db
    .select({ dateFrom: analyses.dateFrom, status: analyses.status, result: analyses.result })
    .from(analyses)
    .where(
      and(
        eq(analyses.kind, "outfit_suggestion"),
        or(eq(analyses.status, "complete"), and(eq(analyses.status, "failed"), eq(analyses.dateFrom, today))),
        eq(analyses.climateProfileId, profileId),
        gte(analyses.dateFrom, from),
        lte(analyses.dateFrom, today),
      ),
    )
    // DESC alone would put a row without completed_at first.
    .orderBy(
      desc(analyses.dateFrom),
      sql`${analyses.completedAt} DESC NULLS LAST`,
      desc(analyses.createdAt),
      asc(analyses.id),
    );
}

/**
 * The wear logs from `from` to `today`, newest first. The app logs one row per
 * item; a log of an outfit alone (allowed by the schema) stands for every item
 * the outfit holds now.
 */
function wearRows(db: Db, from: string, today: string) {
  return db
    .select({
      wornOn: wearLogs.wornOn,
      outfitId: wearLogs.outfitId,
      itemId: sql<string | null>`coalesce(${wearLogs.itemId}, ${outfitItems.itemId})`,
    })
    .from(wearLogs)
    .leftJoin(outfitItems, and(isNull(wearLogs.itemId), eq(outfitItems.outfitId, wearLogs.outfitId)))
    .where(and(gte(wearLogs.wornOn, from), lte(wearLogs.wornOn, today)))
    .orderBy(desc(wearLogs.wornOn), desc(wearLogs.createdAt), asc(wearLogs.id), asc(outfitItems.itemId));
}

/** Days an outfit was worn on: each day counts once, however many of its items were logged. */
function timesWorn() {
  return countDistinct(wearLogs.wornOn);
}

function tasteSelect(db: Db) {
  return db
    .select({ id: outfits.id, rating: outfits.rating, source: outfits.source, timesWorn: timesWorn() })
    .from(outfits)
    .leftJoin(wearLogs, eq(wearLogs.outfitId, outfits.id));
}

/** Rated 4 or 5, or worn on two days or more and not rated 1 or 2; best rated, then most worn, then newest. */
function likedRows(db: Db) {
  return tasteSelect(db)
    .where(or(isNull(outfits.rating), gt(outfits.rating, 2)))
    .groupBy(outfits.id)
    .having(or(gte(outfits.rating, 4), gte(timesWorn(), 2)))
    .orderBy(sql`${outfits.rating} DESC NULLS LAST`, desc(timesWorn()), desc(outfits.createdAt), asc(outfits.id))
    .limit(HISTORY_LIMITS.liked);
}

/** Rated 1 or 2, newest first. */
function dislikedRows(db: Db) {
  return tasteSelect(db)
    .where(lte(outfits.rating, 2))
    .groupBy(outfits.id)
    .orderBy(desc(outfits.createdAt), asc(outfits.id))
    .limit(HISTORY_LIMITS.disliked);
}

// ---------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------

type TasteRow = { id: string; rating: number | null; source: TasteEntry["source"]; timesWorn: number };
type WearRow = { wornOn: string; outfitId: string | null; itemId: string | null };
type SuggestionRow = { dateFrom: string | null; status: string; result: unknown };

/**
 * What the stored suggestions say (suggestionRows, newest first): the outfits
 * of complete runs, today's and yesterday's directions, and runIndex, today's
 * complete and failed runs. A failed run counts only for runIndex, so a click
 * after it draws other directions; its outfits and directions are never read,
 * even when a result was stored.
 */
function readSuggestions(
  rows: readonly SuggestionRow[],
  today: string,
): Pick<VarietyHistory, "suggested" | "recentDirections" | "runIndex"> {
  const suggested: VarietyHistory["suggested"][number][] = [];
  const recentDirections: VarietyHistory["recentDirections"][number][] = [];
  let runIndex = 0;
  for (const row of rows) {
    if (row.dateFrom === null) continue;
    const ageDays = daysBetween(row.dateFrom, today);
    // Every complete or failed run of today counts, a result that cannot be read included.
    if (ageDays === 0) runIndex += 1;
    if (row.status !== "complete") continue;
    const parsed = StoredSuggestionSchema.safeParse(row.result);
    if (!parsed.success) continue;
    suggested.push(
      ...parsed.data.outfits.map((outfit) => ({
        itemIds: unique(outfit.items.map((entry) => entry.itemId)),
        ageDays,
        direction: outfit.direction ?? null,
      })),
    );
    if (ageDays <= 1) recentDirections.push(...runDirections(parsed.data).map((key) => ({ key, ageDays })));
  }
  return { suggested, recentDirections, runIndex };
}

function groupWears(rows: readonly WearRow[], today: string): HistoryEntry[] {
  // Map order is first-seen order, and the rows come newest first.
  const groups = new Map<string, { wornOn: string; itemIds: Set<string> }>();
  for (const row of rows) {
    if (row.itemId === null) continue;
    // Loose logs of a day (no outfit) form one group.
    const key = `${row.wornOn}|${row.outfitId ?? ""}`;
    const group = groups.get(key) ?? { wornOn: row.wornOn, itemIds: new Set<string>() };
    group.itemIds.add(row.itemId);
    groups.set(key, group);
  }
  const worn: HistoryEntry[] = [];
  for (const group of groups.values()) {
    // A single "+1 worn today" press is not an outfit.
    if (group.itemIds.size < 2) continue;
    worn.push({ itemIds: [...group.itemIds], ageDays: daysBetween(group.wornOn, today) });
  }
  return worn;
}

/**
 * The variety history of the home city `profileId` as of `today` (YYYY-MM-DD
 * in the home time zone), see VarietyHistory. Five queries whatever the
 * history holds; a stored result that cannot be read is left out. runIndex
 * counts today's complete and failed runs, not running ones (readSuggestions).
 */
export async function loadVarietyHistory(
  db: Db,
  input: { profileId: string; today: string },
): Promise<VarietyHistory> {
  await requireSession();
  const { profileId, today } = input;
  const suggestedFrom = addDays(today, -(HISTORY_LIMITS.suggestedDays - 1));
  const wornFrom = addDays(today, -(HISTORY_LIMITS.wornDays - 1));

  const [suggestionList, wearList, likedList, dislikedList] = await Promise.all([
    suggestionRows(db, profileId, suggestedFrom, today),
    wearRows(db, wornFrom, today),
    likedRows(db),
    dislikedRows(db),
  ]);

  const { suggested, recentDirections, runIndex } = readSuggestions(suggestionList, today);

  const tasteIds = unique([...likedList, ...dislikedList].map((row) => row.id));
  const itemRows =
    tasteIds.length === 0
      ? []
      : await db
          .select({ outfitId: outfitItems.outfitId, itemId: outfitItems.itemId })
          .from(outfitItems)
          .where(inArray(outfitItems.outfitId, tasteIds))
          .orderBy(asc(outfitItems.outfitId), asc(outfitItems.itemId));
  const itemsByOutfit = new Map<string, string[]>();
  for (const row of itemRows) {
    const list = itemsByOutfit.get(row.outfitId) ?? [];
    list.push(row.itemId);
    itemsByOutfit.set(row.outfitId, list);
  }
  const toTaste = (row: TasteRow): TasteEntry => ({
    itemIds: itemsByOutfit.get(row.id) ?? [],
    rating: row.rating,
    timesWorn: row.timesWorn,
    source: row.source,
  });

  return {
    suggested,
    worn: groupWears(wearList, today),
    liked: likedList.map(toTaste),
    disliked: dislikedList.map(toTaste),
    recentDirections,
    runIndex,
  };
}
