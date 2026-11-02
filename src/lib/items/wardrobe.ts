// Wardrobe list and item detail contracts shared by the query service, the
// /wardrobe grid, the detail page and the item actions. Client components
// import this module, so it must stay free of `server-only`, env access and
// the database client.

import { z } from "zod";

import {
  ITEM_CATEGORIES,
  ITEM_DECISIONS,
  ITEM_LOCATIONS,
  ITEM_STATUSES,
  type ItemCategory,
  type ItemDecision,
  type ItemLocation,
  type ItemStatus,
} from "@/lib/db/enums";
import { CATEGORY_LABELS } from "@/components/items/tag-options";
import type { ItemCardDto, ItemImageRef } from "@/lib/items/contracts";

/**
 * Most items one list response carries. The grid is virtualised, so the limit
 * only bounds the payload; when more items match, the page says so and asks
 * for a narrower filter.
 */
export const WARDROBE_LIST_LIMIT = 2000;

/** One grid tile: only what the card shows, so 2000 of them stay small. */
export type WardrobeItemDto = {
  id: string;
  name: string | null;
  category: ItemCategory | null;
  subcategory: string | null;
  status: ItemStatus;
  decision: ItemDecision;
  location: ItemLocation;
  warmthLevel: number | null;
  waterproof: boolean | null;
  windproof: boolean | null;
  insulated: boolean | null;
  /** Dominant colour first. */
  colors: string[];
  /** Parallel to colors. */
  colorHex: string[];
  wearCount: number;
  multipleItemsDetected: boolean;
  /** The thumb image; null until processing has made one. */
  thumb: ItemImageRef | null;
};

const ImageRefSchema = z.object({
  url: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/** Parses wardrobe tiles (tests, JSON round trips). Unknown keys are dropped. */
export const WardrobeItemDtoSchema: z.ZodType<WardrobeItemDto> = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  category: z.enum(ITEM_CATEGORIES).nullable(),
  subcategory: z.string().nullable(),
  status: z.enum(ITEM_STATUSES),
  decision: z.enum(ITEM_DECISIONS),
  location: z.enum(ITEM_LOCATIONS),
  warmthLevel: z.number().int().min(1).max(5).nullable(),
  waterproof: z.boolean().nullable(),
  windproof: z.boolean().nullable(),
  insulated: z.boolean().nullable(),
  colors: z.array(z.string()),
  colorHex: z.array(z.string()),
  wearCount: z.number().int().nonnegative(),
  multipleItemsDetected: z.boolean(),
  thumb: ImageRefSchema.nullable(),
});

/**
 * The chip badges, each counting what pressing its chip would list. Every
 * count honours every filter except category and status; those two are what
 * the chips set. byCategory, uncategorized and total use the statuses All and
 * the category chips switch to (statusesAfterChip: the default ones when the
 * Untagged view is on, otherwise the current ones).
 */
export type CategoryCounts = {
  byCategory: Record<ItemCategory, number>;
  /** Items without a category, under the same statuses as byCategory. */
  uncategorized: number;
  /** The sum of byCategory and uncategorized: the All chip's badge. */
  total: number;
  /** Items waiting for tags, whatever their category: the Untagged chip's badge. */
  untagged: number;
  /** Archived items: what Status = Archived alone would list. */
  archived: number;
};

const countSchema = z.number().int().nonnegative();

export const CategoryCountsSchema: z.ZodType<CategoryCounts> = z.object({
  // An enum-keyed record requires every category.
  byCategory: z.record(z.enum(ITEM_CATEGORIES), countSchema),
  uncategorized: countSchema,
  total: countSchema,
  untagged: countSchema,
  archived: countSchema,
});

/** Zero counts for every category; the service fills them in. */
export function emptyCategoryCounts(): CategoryCounts {
  const byCategory = Object.fromEntries(ITEM_CATEGORIES.map((category) => [category, 0])) as Record<
    ItemCategory,
    number
  >;
  return { byCategory, uncategorized: 0, total: 0, untagged: 0, archived: 0 };
}

/** Colours the filter panel offers at most, most common first. */
export const COLOR_FACET_MAX = 24;

/** A colour the filter panel offers. */
export type ColorFacet = {
  /** Lowercased, as the colour filter stores it. */
  name: string;
  /** A swatch colour when an item carries one for this name. */
  hex: string | null;
  /** Items with this colour under every filter except colour. */
  count: number;
};

const ColorFacetSchema: z.ZodType<ColorFacet> = z.object({
  name: z.string().min(1),
  hex: z.string().nullable(),
  count: countSchema,
});

export type WardrobeListDto = {
  /** At most WARDROBE_LIST_LIMIT items, in the requested sort order. */
  items: WardrobeItemDto[];
  /** Items matching every filter, including those past the limit. */
  total: number;
  counts: CategoryCounts;
  /**
   * The colours of the items every filter except colour matches, at most
   * COLOR_FACET_MAX, most common first (ties alphabetical). Choosing one
   * therefore never hides the others, and items past the cap count too.
   */
  colors: ColorFacet[];
  /** True when total is above WARDROBE_LIST_LIMIT and items holds only the first ones. */
  capped: boolean;
};

export const WardrobeListDtoSchema: z.ZodType<WardrobeListDto> = z.object({
  items: z.array(WardrobeItemDtoSchema),
  total: countSchema,
  counts: CategoryCountsSchema,
  colors: z.array(ColorFacetSchema).max(COLOR_FACET_MAX),
  capped: z.boolean(),
});

/** The item detail page: the card plus wear history and the original photo. */
export type ItemDetailDto = ItemCardDto & {
  /** ISO 8601 timestamp. */
  updatedAt: string;
  wearCount: number;
  /** ISO 8601 timestamp; null when never worn. */
  lastWornAt: string | null;
  /** The uploaded photo as stored; null if the item has no original row. */
  original: { url: string; width: number; height: number; bytes: number } | null;
};

function present(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** The name a card, heading or accessible label shows for an item. */
export function itemDisplayName(item: {
  name: string | null;
  subcategory: string | null;
  category: ItemCategory | null;
}): string {
  return (
    present(item.name) ??
    present(item.subcategory) ??
    (item.category === null ? "Untagged item" : CATEGORY_LABELS[item.category])
  );
}
