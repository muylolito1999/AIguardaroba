// The outfit feature's shared contract: slot rules, the outfit check, the
// builder's input schema and the DTOs that services, actions and the /outfits
// and /today screens exchange (D-038). Client- and server-safe: value imports
// are zod and the enum lists only, so the builder checks a selection with the
// same rules the server applies before it writes.

import { z } from "zod";

import {
  OUTFIT_SLOTS,
  type ItemCategory,
  type ItemLocation,
  type ItemStatus,
  type OutfitSlot,
  type OutfitSource,
} from "@/lib/db/enums";

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/** The item categories each slot takes. A dress fills the top slot (D-038). */
export const SLOT_CATEGORIES: Readonly<Record<OutfitSlot, readonly ItemCategory[]>> = {
  outerwear: ["outerwear"],
  base_layer: ["base_layer"],
  top: ["top", "dress"],
  bottom: ["bottom"],
  shoes: ["shoes"],
  hat: ["hat_beanie"],
  gloves: ["gloves"],
  scarf: ["scarf"],
  accessory: ["accessory", "bag"],
};

export const SLOT_LABELS: Readonly<Record<OutfitSlot, string>> = {
  outerwear: "Outerwear",
  base_layer: "Base layer",
  top: "Top or dress",
  bottom: "Bottom",
  shoes: "Shoes",
  hat: "Hat",
  gloves: "Gloves",
  scarf: "Scarf",
  accessory: "Accessories",
};

/** Display order: the main pieces first, then the cold-weather extras. */
export const SLOT_ORDER: readonly OutfitSlot[] = [
  "outerwear",
  "top",
  "base_layer",
  "bottom",
  "shoes",
  "hat",
  "scarf",
  "gloves",
  "accessory",
];

/** The only slot that takes more than one item. */
export const MAX_ACCESSORIES = 3;
/** One per slot plus the accessories, with room to spare. */
export const MAX_OUTFIT_ITEMS = 12;

/** The slot whose categories include `category`, or null for a category no slot takes ("other"). */
export function slotForCategory(category: ItemCategory): OutfitSlot | null {
  return SLOT_ORDER.find((slot) => SLOT_CATEGORIES[slot].includes(category)) ?? null;
}

const SLOT_RANK = new Map<OutfitSlot, number>(SLOT_ORDER.map((slot, index) => [slot, index]));

/** Entries sorted by SLOT_ORDER; the order within a slot is kept. */
export function sortBySlot<T extends { slot: OutfitSlot }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (SLOT_RANK.get(a.entry.slot) ?? 0) - (SLOT_RANK.get(b.entry.slot) ?? 0) || a.index - b.index)
    .map(({ entry }) => entry);
}

// ---------------------------------------------------------------------------
// The outfit check
// ---------------------------------------------------------------------------

export type OutfitEntry = { slot: OutfitSlot; itemId: string };

/** What the check needs to know about an item. */
export type OutfitCheckItem = { id: string; category: ItemCategory | null; status: ItemStatus };

export const OUTFIT_ISSUE_CODES = [
  "missing_top",
  "missing_bottom",
  "slot_taken",
  "too_many_accessories",
  "wrong_category",
  "archived_item",
  "unknown_item",
  "duplicate_item",
  "too_many_items",
] as const;
export type OutfitIssueCode = (typeof OUTFIT_ISSUE_CODES)[number];

export type OutfitIssue = { code: OutfitIssueCode; slot?: OutfitSlot; itemId?: string; message: string };

export type OutfitCheck = { ok: true } | { ok: false; issues: OutfitIssue[] };

function slotName(slot: OutfitSlot): string {
  return SLOT_LABELS[slot].toLowerCase();
}

/**
 * The outfit rules (D-038): exactly one item in the top slot; a bottom unless
 * that item is a dress (a dress may still take a bottom); at most one item per
 * slot except accessories (up to MAX_ACCESSORIES); each item's category is one
 * its slot takes; archived and missing items fail; an item appears once; at
 * most MAX_OUTFIT_ITEMS items. Every problem is reported, not only the first,
 * so the builder can mark each slot and the AI check can name them all.
 */
export function validateOutfit(
  entries: readonly OutfitEntry[],
  itemsById: ReadonlyMap<string, OutfitCheckItem>,
): OutfitCheck {
  const issues: OutfitIssue[] = [];

  if (entries.length > MAX_OUTFIT_ITEMS) {
    issues.push({ code: "too_many_items", message: `An outfit holds at most ${MAX_OUTFIT_ITEMS} items.` });
  }

  const seen = new Set<string>();
  const perSlot = new Map<OutfitSlot, number>();
  for (const entry of entries) {
    const { slot, itemId } = entry;
    if (seen.has(itemId)) {
      issues.push({ code: "duplicate_item", slot, itemId, message: "An item can be in an outfit only once." });
      continue;
    }
    seen.add(itemId);

    const taken = perSlot.get(slot) ?? 0;
    perSlot.set(slot, taken + 1);
    if (slot === "accessory") {
      if (taken >= MAX_ACCESSORIES) {
        issues.push({ code: "too_many_accessories", slot, itemId, message: `Choose at most ${MAX_ACCESSORIES} accessories.` });
      }
    } else if (taken > 0) {
      issues.push({ code: "slot_taken", slot, itemId, message: `Only one item fits the ${slotName(slot)} slot.` });
    }

    const item = itemsById.get(itemId);
    if (item === undefined) {
      issues.push({ code: "unknown_item", slot, itemId, message: "This item no longer exists." });
      continue;
    }
    if (item.status === "archived") {
      issues.push({ code: "archived_item", slot, itemId, message: "This item is archived." });
    }
    if (item.category === null || !SLOT_CATEGORIES[slot].includes(item.category)) {
      issues.push({ code: "wrong_category", slot, itemId, message: `This item does not belong in the ${slotName(slot)} slot.` });
    }
  }

  const top = entries.find((entry) => entry.slot === "top");
  if (top === undefined) {
    issues.push({ code: "missing_top", slot: "top", message: "Choose a top or a dress." });
  }
  const topIsDress = top !== undefined && itemsById.get(top.itemId)?.category === "dress";
  if (!topIsDress && !entries.some((entry) => entry.slot === "bottom")) {
    issues.push({ code: "missing_bottom", slot: "bottom", message: "Choose a bottom, or a dress as the top." });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

// ---------------------------------------------------------------------------
// The builder's input
// ---------------------------------------------------------------------------

export const OUTFIT_LIMITS = {
  nameMax: 80,
  occasionMax: 80,
  notesMax: 1000,
  weatherMinC: -40,
  weatherMaxC: 50,
} as const;

const L = OUTFIT_LIMITS;

/** True when `value` has at most one decimal, allowing for float noise (0.1 * 3). */
function hasOneDecimal(value: number): boolean {
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
}

/** A temperature as numeric(4,1) stores it: -40 to 50 °C with at most one decimal, or null. */
const temperatureC = z
  .number({ error: "Enter a temperature in °C." })
  .min(L.weatherMinC, { error: `Use ${L.weatherMinC} °C or more.` })
  .max(L.weatherMaxC, { error: `Use ${L.weatherMaxC} °C or less.` })
  .refine(hasOneDecimal, { error: "Use at most one decimal." })
  .transform((value) => Math.round(value * 10) / 10)
  .nullable();

export const OutfitEntrySchema = z.strictObject({
  slot: z.enum(OUTFIT_SLOTS),
  itemId: z.uuid(),
});

/**
 * The builder's form, as the saveOutfit action takes it. The slot rules need
 * the items' categories, so validateOutfit runs on the server after this.
 */
export const OutfitInputSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, { error: "Give the outfit a name." })
      .max(L.nameMax, { error: `Keep the name under ${L.nameMax} characters.` }),
    /** Empty means no occasion. */
    occasion: z
      .string()
      .trim()
      .max(L.occasionMax, { error: `Keep the occasion under ${L.occasionMax} characters.` })
      .transform((value) => (value === "" ? null : value)),
    weatherMinC: temperatureC,
    weatherMaxC: temperatureC,
    rainOk: z.boolean(),
    rating: z.number().int({ error: "Rate from 1 to 5." }).min(1).max(5).nullable(),
    notes: z.string().trim().max(L.notesMax, { error: `Keep the notes under ${L.notesMax} characters.` }),
    items: z
      .array(OutfitEntrySchema)
      .min(1, { error: "Add at least one item." })
      .max(MAX_OUTFIT_ITEMS, { error: `An outfit holds at most ${MAX_OUTFIT_ITEMS} items.` }),
  })
  .superRefine((input, ctx) => {
    if (input.weatherMinC !== null && input.weatherMaxC !== null && input.weatherMinC > input.weatherMaxC) {
      ctx.addIssue({
        code: "custom",
        path: ["weatherMaxC"],
        message: "The highest temperature must not be below the lowest.",
      });
    }
  });
export type OutfitInput = z.infer<typeof OutfitInputSchema>;
/** What a form sends (occasion as typed). */
export type OutfitInputValues = z.input<typeof OutfitInputSchema>;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type OutfitItemDto = {
  itemId: string;
  slot: OutfitSlot;
  name: string;
  /** null when the item no longer exists or is untagged. */
  category: ItemCategory | null;
  thumbUrl: string | null;
  /** null when the item no longer exists. */
  status: ItemStatus | null;
  wearCount: number;
  /** false when the item was deleted since (only AI suggestions can name one). */
  exists: boolean;
};

export type OutfitListItemDto = {
  id: string;
  name: string;
  occasion: string | null;
  weatherMinC: number | null;
  weatherMaxC: number | null;
  rainOk: boolean;
  source: OutfitSource;
  rating: number | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** In SLOT_ORDER. */
  items: OutfitItemDto[];
  /** YYYY-MM-DD of the latest wear log of this outfit. */
  lastWornOn: string | null;
  /** Days this outfit was logged as worn. */
  timesWorn: number;
};

export type OutfitDetailDto = OutfitListItemDto & { notes: string; aiReasoning: string | null };

/** An item the builder's picker offers for a slot. */
export type SlotCandidateDto = {
  id: string;
  name: string;
  category: ItemCategory;
  subcategory: string | null;
  colors: string[];
  warmthLevel: number | null;
  waterproof: boolean | null;
  thumbUrl: string | null;
  wearCount: number;
  /** ISO 8601 timestamp. */
  lastWornAt: string | null;
  location: ItemLocation;
};
