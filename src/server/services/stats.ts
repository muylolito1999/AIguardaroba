import "server-only";

import { and, desc, inArray, notInArray, sql } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import {
  ITEM_CATEGORIES,
  ITEM_DECISIONS,
  ITEM_LOCATIONS,
  type ItemCategory,
  type ItemDecision,
  type ItemLocation,
} from "@/lib/db/enums";
import { items } from "@/lib/db/schema";
import { WARMTH_LEVELS, type WarmthLevel } from "@/lib/items/contracts";
import {
  READINESS_CATEGORIES,
  READINESS_EXCLUDED_DECISIONS,
  READINESS_STATUSES,
  computeWinterReadiness,
  type WinterReadinessRow,
} from "@/lib/items/winter-readiness";

// The numbers behind /stats (spec section 3, Phase 4). Archived items are left
// out of everything except their own count. Running gear, and any collection
// other than clothing, is counted in its own tile only (D-249); the
// winter-readiness checklist still counts it, since running gloves or a beanie
// keep the owner warm in Hamburg too. Numbers read from tags (category,
// warmth, weather flags, winter readiness) use tagged and confirmed items
// only, since a pending item has no tags yet; decision and location are the
// owner's own choices, set from the start, so those breakdowns include
// pending items too.

export type StatsTotals = {
  /** Every clothing item that is not archived: confirmed + tagged + pending. */
  all: number;
  confirmed: number;
  /** Tagged by Claude or by hand, not yet confirmed. */
  tagged: number;
  /** Waiting for tags; counted in `all` but in no tag-based number. */
  pending: number;
  /** Counted here only, whatever the collection. */
  archived: number;
  /** Non-archived items outside the clothing collection (D-249); counted here only. */
  running: number;
};

export type WardrobeStatsDto = {
  totals: StatsTotals;
  /** Tagged and confirmed clothing items per category; every category is present, zeros included. */
  byCategory: Record<ItemCategory, number>;
  /** Tagged and confirmed clothing items per warmth level 1 to 5. */
  warmth: Record<WarmthLevel, number>;
  /** Tagged and confirmed clothing items with each weather flag set to true. */
  flags: { waterproof: number; windproof: number; insulated: number };
  /** Every non-archived clothing item, pending included, per decision. */
  byDecision: Record<ItemDecision, number>;
  /** Every non-archived clothing item, pending included, per location. */
  byLocation: Record<ItemLocation, number>;
  /**
   * The winter-ready checklist, from tagged and confirmed items not marked
   * leave, donate or sell, running gear included (D-249).
   */
  winterReadiness: WinterReadinessRow[];
};

function zeroCounts<K extends PropertyKey>(keys: readonly K[]): Record<K, number> {
  const counts = {} as Record<K, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}

function isWarmthLevel(value: number | null): value is WarmthLevel {
  return WARMTH_LEVELS.some((level) => level === value);
}

/** Everything /stats shows, from one grouped count and one readiness read. */
export async function getWardrobeStats(db: Db): Promise<WardrobeStatsDto> {
  await requireSession();

  const [groups, readinessItems] = await Promise.all([
    // One row per distinct combination of the low-cardinality columns the page
    // breaks down by, so every count comes back in a single round trip; the
    // result has at most as many rows as there are items, and far fewer in practice.
    db
      .select({
        status: items.status,
        collection: items.collection,
        category: items.category,
        warmthLevel: items.warmthLevel,
        waterproof: items.waterproof,
        windproof: items.windproof,
        insulated: items.insulated,
        decision: items.decision,
        location: items.location,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(items)
      .groupBy(
        items.status,
        items.collection,
        items.category,
        items.warmthLevel,
        items.waterproof,
        items.windproof,
        items.insulated,
        items.decision,
        items.location,
      ),
    // The rules need per-item fields (materials, names), so the candidates are
    // read row by row; the filters mirror computeWinterReadiness, which checks
    // status and decision again itself. No collection filter: the checklist
    // counts running gear too (D-249).
    db
      .select({
        id: items.id,
        name: items.name,
        subcategory: items.subcategory,
        category: items.category,
        status: items.status,
        decision: items.decision,
        materials: items.materials,
        materialGuess: items.materialGuess,
        warmthLevel: items.warmthLevel,
        waterproof: items.waterproof,
        windproof: items.windproof,
        insulated: items.insulated,
      })
      .from(items)
      .where(
        and(
          inArray(items.status, [...READINESS_STATUSES]),
          notInArray(items.decision, [...READINESS_EXCLUDED_DECISIONS]),
          inArray(items.category, [...READINESS_CATEGORIES]),
        ),
      )
      .orderBy(desc(items.createdAt), desc(items.id)),
  ]);

  const totals: StatsTotals = { all: 0, confirmed: 0, tagged: 0, pending: 0, archived: 0, running: 0 };
  const byCategory = zeroCounts(ITEM_CATEGORIES);
  const warmth = zeroCounts(WARMTH_LEVELS);
  const flags = { waterproof: 0, windproof: 0, insulated: 0 };
  const byDecision = zeroCounts(ITEM_DECISIONS);
  const byLocation = zeroCounts(ITEM_LOCATIONS);

  for (const group of groups) {
    const { count } = group;
    if (group.status === "archived") {
      totals.archived += count;
      continue;
    }
    // Positive form (D-248): only clothing feeds the breakdowns below, so a
    // collection added later lands in its own tile instead of the clothes'.
    if (group.collection !== "clothing") {
      totals.running += count;
      continue;
    }
    totals.all += count;
    byDecision[group.decision] += count;
    byLocation[group.location] += count;
    if (group.status === "pending_tagging") {
      totals.pending += count;
      continue;
    }
    if (group.status === "confirmed") totals.confirmed += count;
    else totals.tagged += count;
    // The tagged CHECK makes these columns non-null for tagged and confirmed
    // items; the guards only keep the types honest.
    if (group.category !== null) byCategory[group.category] += count;
    if (isWarmthLevel(group.warmthLevel)) warmth[group.warmthLevel] += count;
    if (group.waterproof === true) flags.waterproof += count;
    if (group.windproof === true) flags.windproof += count;
    if (group.insulated === true) flags.insulated += count;
  }

  return {
    totals,
    byCategory,
    warmth,
    flags,
    byDecision,
    byLocation,
    winterReadiness: computeWinterReadiness(readinessItems),
  };
}
