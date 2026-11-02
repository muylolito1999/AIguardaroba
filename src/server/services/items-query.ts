import "server-only";

import { and, arrayOverlaps, asc, desc, eq, gte, inArray, lte, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { ITEM_CATEGORIES, type ItemCategory, type ItemStatus } from "@/lib/db/enums";
import { itemImages, items } from "@/lib/db/schema";
import { statusesAfterChip, type ItemFilters, type ItemSort } from "@/lib/items/filters";
import {
  COLOR_FACET_MAX,
  emptyCategoryCounts,
  WARDROBE_LIST_LIMIT,
  type CategoryCounts,
  type ColorFacet,
  type WardrobeItemDto,
  type WardrobeListDto,
} from "@/lib/items/wardrobe";

// The /wardrobe list. Filters arrive parsed (parseItemFilters already dropped
// invalid values), so nothing is validated twice here. Each filter becomes one
// condition, built once. The list uses all of them. The chip counts leave out
// status and category, the two fields the chips set, and are grouped by both,
// so each badge can count what pressing its chip would list in any view. The
// colour facet leaves out only the colour condition, so choosing a colour
// never hides the other colours.

export type ListWardrobeOptions = {
  /** Most items returned; defaults to WARDROBE_LIST_LIMIT. Tests pass a small one to reach the cap. */
  limit?: number;
};

/**
 * Escapes LIKE wildcards so search text matches literally. The backslash goes
 * first, otherwise the escapes added for % and _ would be escaped again. Used
 * with an explicit ESCAPE '\' so the meaning does not depend on server defaults.
 */
export function escapeLikePattern(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

const ARRAY_ENTRY = sql.raw("entry.value");
const OR = sql.raw(" OR ");

/** Text search over the item's words, colours and materials (any element, case-insensitive). */
function searchCondition(q: string): SQL {
  const pattern = `%${escapeLikePattern(q)}%`;
  const matches = (operand: SQLWrapper) => sql`${operand} ILIKE ${pattern} ESCAPE '\\'`;
  const anyElementMatches = (column: SQLWrapper) =>
    sql`EXISTS (SELECT 1 FROM unnest(${column}) AS entry(value) WHERE ${matches(ARRAY_ENTRY)})`;
  const alternatives = [
    matches(items.name),
    matches(items.description),
    matches(items.brand),
    matches(items.subcategory),
    matches(items.notes),
    anyElementMatches(items.colors),
    anyElementMatches(items.materials),
  ];
  // A null column (no brand yet) makes its ILIKE null, which OR treats as false.
  return sql`(${sql.join(alternatives, OR)})`;
}

/** One condition per filter field. Values within a field are alternatives; fields combine with AND. */
type FilterConditions = {
  status: SQL;
  /** Null when no category is chosen. */
  category: SQL | null;
  /** Null when no colour is chosen. */
  color: SQL | null;
  /** The conditions of every other field that is set. */
  rest: SQL[];
};

function filterConditions(filters: ItemFilters): FilterConditions {
  const rest: SQL[] = [];
  if (filters.q !== "") rest.push(searchCondition(filters.q));
  if (filters.season.length > 0) rest.push(arrayOverlaps(items.seasons, filters.season));
  // Inclusive bounds; a null warmth fails both comparisons, so untagged items drop out.
  if (filters.warmthMin !== null) rest.push(gte(items.warmthLevel, filters.warmthMin));
  if (filters.warmthMax !== null) rest.push(lte(items.warmthLevel, filters.warmthMax));
  if (filters.waterproof !== null) rest.push(eq(items.waterproof, filters.waterproof));
  if (filters.windproof !== null) rest.push(eq(items.windproof, filters.windproof));
  if (filters.formality.length > 0) rest.push(inArray(items.formality, filters.formality));
  if (filters.condition.length > 0) rest.push(inArray(items.condition, filters.condition));
  if (filters.location.length > 0) rest.push(inArray(items.location, filters.location));
  if (filters.decision.length > 0) rest.push(inArray(items.decision, filters.decision));
  return {
    status: inArray(items.status, filters.status),
    category: filters.category.length > 0 ? inArray(items.category, filters.category) : null,
    // filters.color is already lowercased; stored colours keep Claude's or the owner's casing.
    color:
      filters.color.length > 0
        ? sql`EXISTS (SELECT 1 FROM unnest(${items.colors}) AS entry(value) WHERE lower(entry.value) IN ${filters.color})`
        : null,
    rest,
  };
}

function whereAll(...conditions: (SQL | null)[]): SQL | undefined {
  return and(...conditions.filter((condition): condition is SQL => condition !== null));
}

/** Newest first breaks every tie, and the id makes the order total, so equal rows never swap between loads. */
function orderBy(sort: ItemSort): SQL[] {
  const newestFirst = [desc(items.createdAt), desc(items.id)];
  switch (sort) {
    case "created_desc":
      return newestFirst;
    case "created_asc":
      return [asc(items.createdAt), asc(items.id)];
    case "warmth_desc":
      return [sql`${items.warmthLevel} DESC NULLS LAST`, ...newestFirst];
    case "warmth_asc":
      return [sql`${items.warmthLevel} ASC NULLS LAST`, ...newestFirst];
    case "wear_desc":
      return [desc(items.wearCount), ...newestFirst];
  }
}

function isCategory(value: string | null): value is ItemCategory {
  return value !== null && (ITEM_CATEGORIES as readonly string[]).includes(value);
}

/** Matching items per category and status, under every filter but those two. */
type CountRow = { category: string | null; status: ItemStatus; count: number };

function countRows(db: Db, where: SQL | undefined): Promise<CountRow[]> {
  return db
    .select({ category: items.category, status: items.status, count: sql<number>`count(*)`.mapWith(Number) })
    .from(items)
    .where(where)
    .groupBy(items.category, items.status);
}

/** Each chip's badge: what pressing that chip would list from the current filters (see CategoryCounts). */
function chipCounts(rows: readonly CountRow[], filters: ItemFilters): CategoryCounts {
  const chipStatuses = new Set<ItemStatus>(statusesAfterChip(filters));
  const counts = emptyCategoryCounts();
  for (const row of rows) {
    if (row.status === "pending_tagging") counts.untagged += row.count;
    if (row.status === "archived") counts.archived += row.count;
    if (!chipStatuses.has(row.status)) continue;
    if (isCategory(row.category)) counts.byCategory[row.category] += row.count;
    else counts.uncategorized += row.count;
    counts.total += row.count;
  }
  return counts;
}

/** Items the list itself matches (its statuses and chosen categories), from the same rows. */
function listMatchCount(rows: readonly CountRow[], filters: ItemFilters): number {
  const statuses = new Set<ItemStatus>(filters.status);
  const categories = new Set<string>(filters.category);
  let count = 0;
  for (const row of rows) {
    const categoryMatches = categories.size === 0 || (row.category !== null && categories.has(row.category));
    if (statuses.has(row.status) && categoryMatches) count += row.count;
  }
  return count;
}

/** The colours of the matching items, most common first (ties alphabetical), at most COLOR_FACET_MAX. */
async function colorFacet(db: Db, where: SQL | undefined): Promise<ColorFacet[]> {
  // Two set-returning functions in one select list run in lockstep, so each
  // colour comes with the hex at the same position (null past the end of a
  // shorter color_hex).
  const entries = db
    .select({
      id: items.id,
      name: sql<string>`lower(unnest(${items.colors}))`.as("name"),
      hex: sql<string | null>`unnest(${items.colorHex})`.as("hex"),
    })
    .from(items)
    .where(where)
    .as("entries");
  const rows = await db
    .select({
      name: entries.name,
      hex: sql<string | null>`min(${entries.hex})`,
      // An item listing "Navy" and "navy" counts once.
      count: sql<number>`count(DISTINCT ${entries.id})`.mapWith(Number),
    })
    .from(entries)
    .where(sql`btrim(${entries.name}) <> ''`)
    .groupBy(entries.name);
  // Sorted here rather than in SQL, so ties do not depend on the database's collation.
  return rows
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en"))
    .slice(0, COLOR_FACET_MAX);
}

/**
 * The wardrobe grid for the given filters: at most `limit` tiles in the
 * requested order, how many items match in all, the chip counts and the colour
 * facet. One query for the tiles (the thumb joined in, no query per item), one
 * grouped count and one grouped colour count.
 */
export async function listWardrobeItems(
  db: Db,
  filters: ItemFilters,
  opts: ListWardrobeOptions = {},
): Promise<WardrobeListDto> {
  await requireSession();
  const limit = opts.limit ?? WARDROBE_LIST_LIMIT;

  const conditions = filterConditions(filters);
  const listWhere = whereAll(conditions.status, conditions.category, conditions.color, ...conditions.rest);
  // No status or category: the chips set those two, and the rows are grouped by them.
  const countsWhere = whereAll(conditions.color, ...conditions.rest);
  // No colour: the panel offers the colours the other filters leave.
  const colorsWhere = whereAll(conditions.status, conditions.category, ...conditions.rest);

  const [rows, counted, colors] = await Promise.all([
    db
      .select({
        id: items.id,
        name: items.name,
        category: items.category,
        subcategory: items.subcategory,
        status: items.status,
        decision: items.decision,
        location: items.location,
        warmthLevel: items.warmthLevel,
        waterproof: items.waterproof,
        windproof: items.windproof,
        insulated: items.insulated,
        colors: items.colors,
        colorHex: items.colorHex,
        wearCount: items.wearCount,
        // ai_raw is the validated tagging output; a missing key (older rows,
        // hand-tagged items with no ai_raw) reads as false, like toItemCardDto.
        multipleItemsDetected: sql<boolean>`coalesce((${items.aiRaw} -> 'multiple_items_detected') = 'true'::jsonb, false)`,
        thumbUrl: itemImages.blobUrl,
        thumbWidth: itemImages.width,
        thumbHeight: itemImages.height,
      })
      .from(items)
      // (item_id, kind) is unique, so the join adds at most one row per item.
      .leftJoin(itemImages, and(eq(itemImages.itemId, items.id), eq(itemImages.kind, "thumb")))
      .where(listWhere)
      .orderBy(...orderBy(filters.sort))
      // One past the limit tells whether more items match.
      .limit(limit + 1),
    countRows(db, countsWhere),
    colorFacet(db, colorsWhere),
  ]);

  const capped = rows.length > limit;
  const tiles: WardrobeItemDto[] = rows.slice(0, limit).map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory,
    status: row.status,
    decision: row.decision,
    location: row.location,
    warmthLevel: row.warmthLevel,
    waterproof: row.waterproof,
    windproof: row.windproof,
    insulated: row.insulated,
    colors: row.colors,
    colorHex: row.colorHex,
    wearCount: row.wearCount,
    multipleItemsDetected: row.multipleItemsDetected === true,
    thumb:
      row.thumbUrl === null || row.thumbWidth === null || row.thumbHeight === null
        ? null
        : { url: row.thumbUrl, width: row.thumbWidth, height: row.thumbHeight },
  }));

  // The grouped counts cover every other filter, so the full match count
  // follows from them without another query. The queries are separate
  // statements, so a write between them could skew the derived figure; the
  // tiles fetched here stay authoritative for the uncapped case and the lower
  // bound.
  const total = capped ? Math.max(listMatchCount(counted, filters), limit + 1) : tiles.length;

  return { items: tiles, total, counts: chipCounts(counted, filters), colors, capped };
}
