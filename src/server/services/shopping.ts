import "server-only";

import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { z } from "zod";

import {
  compareShoppingItems,
  LINK_SEARCH_MAX,
  LINKABLE_ITEMS_LIMIT,
  ShoppingItemUpdateSchema,
  type LinkableItemDto,
  type ShoppingItemUpdate,
} from "@/components/shopping/shopping-model";
import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import type { ItemCategory } from "@/lib/db/enums";
import { analyses, itemImages, items, shoppingListItems, type ShoppingListItem } from "@/lib/db/schema";
import { isUuid } from "@/lib/items/contracts";
import { itemDisplayName } from "@/lib/items/wardrobe";
import {
  BUY_TIMINGS,
  MAX_EUR,
  ShoppingItemInputSchema,
  type BuyTiming,
  type RelocationPriority,
  type ShoppingItemDto,
  type ShoppingListDto,
  type ThumbRef,
} from "@/lib/relocation/contracts";
import { AppError } from "@/lib/result";
import { escapeLikePattern } from "@/server/services/items-query";

// The shopping list behind /shopping: relocation gaps (added from
// /relocate/[id] by the relocation service) and entries added by hand. Linking
// a row to an owned item only records the link; the item itself is unchanged.

function validationError(error: z.ZodError): AppError {
  return new AppError("VALIDATION", "Some fields are missing or invalid.", {
    issues: error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

function notFound(id: string): AppError {
  return new AppError("NOT_FOUND", "That shopping list entry no longer exists.", { shoppingItemId: id });
}

function asPriority(value: number): RelocationPriority {
  // shopping_list_items_priority_check keeps the column within 1 to 3.
  if (value === 1 || value === 2 || value === 3) return value;
  throw new Error(`shopping_list_items.priority out of range: ${value}`);
}

function asBuyTiming(value: string | null): BuyTiming | null {
  return BUY_TIMINGS.find((timing) => timing === value) ?? null;
}

type LinkedRow = {
  id: string;
  name: string | null;
  subcategory: string | null;
  category: ItemCategory | null;
  thumbUrl: string | null;
  thumbWidth: number | null;
  thumbHeight: number | null;
};

function thumbRef(row: Pick<LinkedRow, "thumbUrl" | "thumbWidth" | "thumbHeight">): ThumbRef | null {
  return row.thumbUrl === null || row.thumbWidth === null || row.thumbHeight === null
    ? null
    : { url: row.thumbUrl, width: row.thumbWidth, height: row.thumbHeight };
}

function toDto(row: ShoppingListItem, linked: LinkedRow | undefined): ShoppingItemDto {
  return {
    id: row.id,
    analysisId: row.analysisId,
    itemType: row.itemType,
    category: row.category,
    priority: asPriority(row.priority),
    reason: row.reason,
    specs: row.specs,
    quantity: row.quantity,
    estPriceMinEur: row.estPriceMinEur,
    estPriceMaxEur: row.estPriceMaxEur,
    buyTiming: asBuyTiming(row.buyTiming),
    status: row.status,
    linkedItem:
      linked === undefined ? null : { id: linked.id, name: itemDisplayName(linked), thumb: thumbRef(linked) },
    gapKey: row.gapKey,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The linked items of these rows with their thumbs, keyed by item id. One query, whatever the row count. */
async function linkedItems(db: Db, rows: readonly ShoppingListItem[]): Promise<Map<string, LinkedRow>> {
  const ids = [...new Set(rows.flatMap((row) => (row.linkedItemId === null ? [] : [row.linkedItemId])))];
  if (ids.length === 0) return new Map();
  const found = await db
    .select({
      id: items.id,
      name: items.name,
      subcategory: items.subcategory,
      category: items.category,
      thumbUrl: itemImages.blobUrl,
      thumbWidth: itemImages.width,
      thumbHeight: itemImages.height,
    })
    .from(items)
    // (item_id, kind) is unique, so the join adds at most one row per item.
    .leftJoin(itemImages, and(eq(itemImages.itemId, items.id), eq(itemImages.kind, "thumb")))
    .where(inArray(items.id, ids));
  return new Map(found.map((row) => [row.id, row]));
}

async function loadDto(db: Db, id: string): Promise<ShoppingItemDto> {
  const [row] = await db.select().from(shoppingListItems).where(eq(shoppingListItems.id, id));
  if (row === undefined) throw notFound(id);
  const linked = await linkedItems(db, [row]);
  return toDto(row, row.linkedItemId === null ? undefined : linked.get(row.linkedItemId));
}

/** The purchase budget a relocation run stored in analyses.params, if it holds a valid one. */
function budgetFromParams(params: unknown): number | null {
  if (typeof params !== "object" || params === null || !("purchaseBudgetEur" in params)) return null;
  const value = params.purchaseBudgetEur;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_EUR ? value : null;
}

/**
 * Every row in list order (compareShoppingItems), each with its linked item's
 * name and thumb, plus the purchase budget of the newest complete relocation
 * run for the budget panel.
 */
export async function getShoppingList(db: Db): Promise<ShoppingListDto> {
  await requireSession();
  const [rows, [latest]] = await Promise.all([
    db.select().from(shoppingListItems),
    db
      .select({ id: analyses.id, params: analyses.params })
      .from(analyses)
      .where(and(eq(analyses.kind, "relocation"), eq(analyses.status, "complete")))
      .orderBy(sql`${analyses.completedAt} DESC NULLS LAST`, desc(analyses.createdAt))
      .limit(1),
  ]);
  const linked = await linkedItems(db, rows);
  const dtos = rows
    .map((row) => toDto(row, row.linkedItemId === null ? undefined : linked.get(row.linkedItemId)))
    .sort(compareShoppingItems);
  return {
    items: dtos,
    latestBudgetEur: latest === undefined ? null : budgetFromParams(latest.params),
    latestAnalysisId: latest?.id ?? null,
  };
}

/** A row added by hand: no analysis and no gap key. */
export async function addShoppingItem(
  db: Db,
  input: z.input<typeof ShoppingItemInputSchema>,
): Promise<ShoppingItemDto> {
  await requireSession();
  const parsed = ShoppingItemInputSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error);
  const [row] = await db
    .insert(shoppingListItems)
    .values({ ...parsed.data, analysisId: null, gapKey: null })
    .returning();
  if (row === undefined) throw new Error("addShoppingItem: insert returned no row");
  return toDto(row, undefined);
}

/**
 * Changes a row's status, its link to an owned item (null unlinks) or its
 * priority. Only an existing item that is not archived can be linked.
 */
export async function updateShoppingItem(db: Db, input: ShoppingItemUpdate): Promise<ShoppingItemDto> {
  await requireSession();
  const parsed = ShoppingItemUpdateSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error);
  const { id, status, linkedItemId, priority } = parsed.data;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: shoppingListItems.id })
      .from(shoppingListItems)
      .where(eq(shoppingListItems.id, id))
      .for("update");
    if (row === undefined) throw notFound(id);

    if (linkedItemId !== undefined && linkedItemId !== null) {
      // FOR SHARE keeps the item from being archived or deleted before the link is written.
      const [item] = await tx
        .select({ status: items.status })
        .from(items)
        .where(eq(items.id, linkedItemId))
        .for("share");
      if (item === undefined) {
        throw new AppError("NOT_FOUND", "That item no longer exists.", { itemId: linkedItemId });
      }
      if (item.status === "archived") {
        throw new AppError("VALIDATION", "Archived items cannot be linked. Unarchive it first.", {
          itemId: linkedItemId,
        });
      }
    }

    await tx
      .update(shoppingListItems)
      .set({
        ...(status === undefined ? {} : { status }),
        ...(linkedItemId === undefined ? {} : { linkedItemId }),
        ...(priority === undefined ? {} : { priority }),
      })
      .where(eq(shoppingListItems.id, id));
  });
  return await loadDto(db, id);
}

export async function deleteShoppingItem(db: Db, id: string): Promise<{ deleted: true }> {
  await requireSession();
  if (!isUuid(id)) throw notFound(id);
  const deleted = await db
    .delete(shoppingListItems)
    .where(eq(shoppingListItems.id, id))
    .returning({ id: shoppingListItems.id });
  if (deleted.length === 0) throw notFound(id);
  return { deleted: true };
}

/**
 * Owned items the link picker offers: not archived, matching the text in the
 * name or subcategory (case-insensitive, %, _ and \ taken literally), newest
 * first, at most LINKABLE_ITEMS_LIMIT. Empty text lists the newest items.
 */
export async function searchLinkableItems(db: Db, q: string): Promise<LinkableItemDto[]> {
  await requireSession();
  const text = q.trim().slice(0, LINK_SEARCH_MAX);
  const pattern = `%${escapeLikePattern(text)}%`;
  const matches =
    text === ""
      ? undefined
      : or(
          sql`${items.name} ILIKE ${pattern} ESCAPE '\\'`,
          sql`${items.subcategory} ILIKE ${pattern} ESCAPE '\\'`,
        );
  const rows = await db
    .select({
      id: items.id,
      name: items.name,
      subcategory: items.subcategory,
      category: items.category,
      thumbUrl: itemImages.blobUrl,
      thumbWidth: itemImages.width,
      thumbHeight: itemImages.height,
    })
    .from(items)
    .leftJoin(itemImages, and(eq(itemImages.itemId, items.id), eq(itemImages.kind, "thumb")))
    .where(and(ne(items.status, "archived"), matches))
    .orderBy(desc(items.createdAt), desc(items.id))
    .limit(LINKABLE_ITEMS_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    name: itemDisplayName(row),
    category: row.category,
    thumb: thumbRef(row),
  }));
}
