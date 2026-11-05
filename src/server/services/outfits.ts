import "server-only";

import { and, asc, countDistinct, desc, eq, inArray, isNotNull, max, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { OUTFIT_SLOTS, type OutfitSlot } from "@/lib/db/enums";
import { itemImages, items, outfitItems, outfits, wearLogs, type Outfit } from "@/lib/db/schema";
import { isUuid } from "@/lib/items/contracts";
import { itemDisplayName } from "@/lib/items/wardrobe";
import {
  OutfitInputSchema,
  SLOT_CATEGORIES,
  sortBySlot,
  validateOutfit,
  type OutfitCheckItem,
  type OutfitDetailDto,
  type OutfitInputValues,
  type OutfitItemDto,
  type OutfitListItemDto,
  type SlotCandidateDto,
} from "@/lib/outfits/contracts";
import { AppError } from "@/lib/result";
import { escapeLikePattern } from "@/server/services/items-query";

// Saved outfits (/outfits): the builder's saves, AI suggestions saved from
// /today, and the reads behind the list, the outfit page and the slot
// pickers. The slot rules (validateOutfit, D-038) run here on the items as
// they are inside the saving transaction, whatever the browser checked.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Longest search text the slot picker sends. */
export const SLOT_SEARCH_MAX = 100;
/** A slot lists at most this many items; a single wardrobe has a few hundred in all. */
export const SLOT_CANDIDATES_MAX = 500;

function validationError(error: z.ZodError): AppError {
  return new AppError("VALIDATION", "Some fields are missing or invalid.", {
    issues: error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

function outfitNotFound(id: string): AppError {
  return new AppError("NOT_FOUND", "That outfit no longer exists.", { outfitId: id });
}

function thumbJoin() {
  // (item_id, kind) is unique, so the join adds at most one row per item.
  return and(eq(itemImages.itemId, items.id), eq(itemImages.kind, "thumb"));
}

/** Display name first, then id, so the order is stable. */
function byName<T extends { name: string; id: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id);
}

/**
 * The DTOs of these outfit rows, in the rows' order: their items (in
 * SLOT_ORDER, with thumbs and wear counts) and how often each outfit was worn.
 * Every item is listed, archived ones and ones moved to running gear included,
 * each with its status and collection, so the outfit can flag them (D-250).
 * Two queries whatever the number of outfits.
 */
async function toDtos(db: Db | Tx, rows: readonly Outfit[]): Promise<OutfitDetailDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [itemRows, wearRows] = await Promise.all([
    db
      .select({
        outfitId: outfitItems.outfitId,
        slot: outfitItems.slot,
        itemId: outfitItems.itemId,
        name: items.name,
        subcategory: items.subcategory,
        category: items.category,
        status: items.status,
        collection: items.collection,
        wearCount: items.wearCount,
        thumbUrl: itemImages.blobUrl,
      })
      .from(outfitItems)
      .innerJoin(items, eq(items.id, outfitItems.itemId))
      .leftJoin(itemImages, thumbJoin())
      .where(inArray(outfitItems.outfitId, ids)),
    db
      .select({
        outfitId: wearLogs.outfitId,
        lastWornOn: max(wearLogs.wornOn),
        timesWorn: countDistinct(wearLogs.wornOn),
      })
      .from(wearLogs)
      .where(inArray(wearLogs.outfitId, ids))
      .groupBy(wearLogs.outfitId),
  ]);

  const itemsByOutfit = new Map<string, OutfitItemDto[]>();
  const sorted = itemRows
    .map((row) => ({ ...row, id: row.itemId, name: itemDisplayName(row) }))
    .sort(byName);
  for (const row of sorted) {
    const list = itemsByOutfit.get(row.outfitId) ?? [];
    list.push({
      itemId: row.itemId,
      slot: row.slot,
      name: row.name,
      category: row.category,
      thumbUrl: row.thumbUrl,
      status: row.status,
      collection: row.collection,
      wearCount: row.wearCount,
      // outfit_items cascades when an item is deleted, so a listed item exists.
      exists: true,
    });
    itemsByOutfit.set(row.outfitId, list);
  }
  const wearByOutfit = new Map(wearRows.map((row) => [row.outfitId, row]));

  return rows.map((row) => {
    const wear = wearByOutfit.get(row.id);
    return {
      id: row.id,
      name: row.name,
      occasion: row.occasion,
      weatherMinC: row.weatherMinC,
      weatherMaxC: row.weatherMaxC,
      rainOk: row.rainOk,
      source: row.source,
      rating: row.rating,
      createdAt: row.createdAt.toISOString(),
      items: sortBySlot(itemsByOutfit.get(row.id) ?? []),
      lastWornOn: wear?.lastWornOn ?? null,
      timesWorn: wear?.timesWorn ?? 0,
      notes: row.notes,
      aiReasoning: row.aiReasoning,
    };
  });
}

/** The list leaves out the notes and Claude's reason, which only the outfit page shows. */
function listItem(detail: OutfitDetailDto): OutfitListItemDto {
  return {
    id: detail.id,
    name: detail.name,
    occasion: detail.occasion,
    weatherMinC: detail.weatherMinC,
    weatherMaxC: detail.weatherMaxC,
    rainOk: detail.rainOk,
    source: detail.source,
    rating: detail.rating,
    createdAt: detail.createdAt,
    items: detail.items,
    lastWornOn: detail.lastWornOn,
    timesWorn: detail.timesWorn,
  };
}

/** Every saved outfit, newest first. */
export async function listOutfits(db: Db): Promise<OutfitListItemDto[]> {
  await requireSession();
  const rows = await db.select().from(outfits).orderBy(desc(outfits.createdAt), asc(outfits.id));
  return (await toDtos(db, rows)).map(listItem);
}

async function loadOutfit(db: Db | Tx, id: string): Promise<OutfitDetailDto> {
  const [row] = await db.select().from(outfits).where(eq(outfits.id, id));
  if (row === undefined) throw outfitNotFound(id);
  const [dto] = await toDtos(db, [row]);
  if (dto === undefined) throw new Error("loadOutfit: no DTO for an existing row");
  return dto;
}

/** One outfit with its notes and Claude's reason, or NOT_FOUND (also for a malformed id). */
export async function getOutfit(db: Db, id: string): Promise<OutfitDetailDto> {
  await requireSession();
  if (!isUuid(id)) throw outfitNotFound(id);
  return loadOutfit(db, id);
}

type CandidateRow = {
  id: string;
  name: string | null;
  subcategory: string | null;
  category: SlotCandidateDto["category"] | null;
  colors: string[];
  warmthLevel: number | null;
  waterproof: boolean | null;
  thumbUrl: string | null;
  wearCount: number;
  lastWornAt: Date | null;
  location: SlotCandidateDto["location"];
};

function candidateDto(row: CandidateRow & { category: SlotCandidateDto["category"] }): SlotCandidateDto {
  return {
    id: row.id,
    name: itemDisplayName(row),
    category: row.category,
    subcategory: row.subcategory,
    colors: row.colors,
    warmthLevel: row.warmthLevel,
    waterproof: row.waterproof,
    thumbUrl: row.thumbUrl,
    wearCount: row.wearCount,
    lastWornAt: row.lastWornAt === null ? null : row.lastWornAt.toISOString(),
    location: row.location,
  };
}

const CANDIDATE_COLUMNS = {
  id: items.id,
  name: items.name,
  subcategory: items.subcategory,
  category: items.category,
  colors: items.colors,
  warmthLevel: items.warmthLevel,
  waterproof: items.waterproof,
  thumbUrl: itemImages.blobUrl,
  wearCount: items.wearCount,
  lastWornAt: items.lastWornAt,
  location: items.location,
};

async function candidateRows(db: Db, slots: readonly OutfitSlot[], query: string): Promise<SlotCandidateDto[]> {
  const categories = [...new Set(slots.flatMap((slot) => SLOT_CATEGORIES[slot]))];
  const text = query.trim().slice(0, SLOT_SEARCH_MAX);
  const pattern = `%${escapeLikePattern(text)}%`;
  const matches =
    text === ""
      ? undefined
      : or(
          sql`${items.name} ILIKE ${pattern} ESCAPE '\\'`,
          sql`${items.subcategory} ILIKE ${pattern} ESCAPE '\\'`,
          sql`${items.brand} ILIKE ${pattern} ESCAPE '\\'`,
          sql`EXISTS (SELECT 1 FROM unnest(${items.colors}) AS entry(value) WHERE entry.value ILIKE ${pattern} ESCAPE '\\')`,
        );
  const rows = await db
    .select(CANDIDATE_COLUMNS)
    .from(items)
    .leftJoin(itemImages, thumbJoin())
    // Clothing only, in the positive form (D-248, D-249): running gear and any
    // later collection never reach a slot picker.
    .where(
      and(
        ne(items.status, "archived"),
        eq(items.collection, "clothing"),
        inArray(items.category, categories),
        matches,
      ),
    )
    .orderBy(asc(items.name), asc(items.id))
    .limit(SLOT_CANDIDATES_MAX * slots.length);
  return rows
    .flatMap((row) => (row.category === null ? [] : [candidateDto({ ...row, category: row.category })]))
    .sort(byName);
}

/**
 * The items a slot can take (its categories, not archived, clothing only:
 * D-249), by name, each with its thumb, wear count and last wear. `query`
 * narrows them by name, type, brand or colour.
 */
export async function listSlotCandidates(db: Db, slot: OutfitSlot, query = ""): Promise<SlotCandidateDto[]> {
  await requireSession();
  return (await candidateRows(db, [slot], query)).slice(0, SLOT_CANDIDATES_MAX);
}

/** Every slot's candidates from one query, for the builder, which searches them in the browser. */
export async function listCandidatesBySlot(db: Db): Promise<Record<OutfitSlot, SlotCandidateDto[]>> {
  await requireSession();
  const rows = await candidateRows(db, OUTFIT_SLOTS, "");
  const bySlot = Object.fromEntries(OUTFIT_SLOTS.map((slot) => [slot, [] as SlotCandidateDto[]])) as Record<
    OutfitSlot,
    SlotCandidateDto[]
  >;
  for (const row of rows) {
    for (const slot of OUTFIT_SLOTS) {
      if (SLOT_CATEGORIES[slot].includes(row.category) && bySlot[slot].length < SLOT_CANDIDATES_MAX) {
        bySlot[slot].push(row);
      }
    }
  }
  return bySlot;
}

/**
 * The outfit's items as validateOutfit sees them, read under FOR SHARE so
 * none can be archived, deleted or moved to running gear before the outfit is
 * written.
 */
async function lockCheckItems(tx: Tx, itemIds: readonly string[]): Promise<Map<string, OutfitCheckItem>> {
  const rows = await tx
    .select({ id: items.id, category: items.category, status: items.status, collection: items.collection })
    .from(items)
    .where(inArray(items.id, [...new Set(itemIds)]))
    .orderBy(asc(items.id))
    .for("share");
  return new Map(rows.map((row) => [row.id, row]));
}

export type SaveOutfitFields = {
  source?: Outfit["source"];
  aiReasoning?: string | null;
};

/**
 * Writes the outfit and its items in one transaction: a new outfit without
 * `id`, otherwise that outfit's fields and its whole item list, replaced.
 * The slot rules run on the items as they are now, so an item deleted,
 * archived or moved to running gear since the builder read it is refused
 * (unknown_item, archived_item, not_clothing: D-250), and so is an edit that
 * keeps such an item until it is swapped out. A failure is VALIDATION with
 * `details.outfitIssues` (validateOutfit's issues, for the builder to show
 * next to each slot). `fields` sets the source and Claude's reason of a new
 * outfit (an AI suggestion saved from /today); an edit keeps both.
 */
export async function saveOutfit(
  db: Db,
  input: OutfitInputValues,
  id?: string,
  fields: SaveOutfitFields = {},
): Promise<OutfitDetailDto> {
  await requireSession();
  const parsed = OutfitInputSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error);
  const { items: entries, ...values } = parsed.data;
  if (id !== undefined && !isUuid(id)) throw outfitNotFound(id);

  return db.transaction(async (tx) => {
    if (id !== undefined) {
      const [existing] = await tx.select({ id: outfits.id }).from(outfits).where(eq(outfits.id, id)).for("update");
      if (existing === undefined) throw outfitNotFound(id);
    }

    const check = validateOutfit(entries, await lockCheckItems(tx, entries.map((entry) => entry.itemId)));
    if (!check.ok) {
      throw new AppError("VALIDATION", check.issues[0]?.message ?? "This outfit cannot be saved.", {
        outfitIssues: check.issues,
      });
    }

    let outfitId: string;
    if (id === undefined) {
      const [row] = await tx
        .insert(outfits)
        .values({ ...values, source: fields.source ?? "user", aiReasoning: fields.aiReasoning ?? null })
        .returning({ id: outfits.id });
      if (row === undefined) throw new Error("saveOutfit: insert returned no row");
      outfitId = row.id;
    } else {
      await tx.update(outfits).set(values).where(eq(outfits.id, id));
      await tx.delete(outfitItems).where(eq(outfitItems.outfitId, id));
      outfitId = id;
    }
    await tx.insert(outfitItems).values(entries.map((entry) => ({ outfitId, itemId: entry.itemId, slot: entry.slot })));

    return loadOutfit(tx, outfitId);
  });
}

/**
 * Deletes the outfit; its items stay, and so does their wear history: the
 * outfit's wear logs become item-only logs instead of cascading away, so
 * wear counts and their logs keep agreeing.
 */
export async function deleteOutfit(db: Db, id: string): Promise<{ deleted: true }> {
  await requireSession();
  if (!isUuid(id)) throw outfitNotFound(id);
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: outfits.id }).from(outfits).where(eq(outfits.id, id)).for("update");
    if (existing === undefined) throw outfitNotFound(id);
    await tx
      .update(wearLogs)
      .set({ outfitId: null })
      .where(and(eq(wearLogs.outfitId, id), isNotNull(wearLogs.itemId)));
    await tx.delete(outfits).where(eq(outfits.id, id));
  });
  return { deleted: true };
}
