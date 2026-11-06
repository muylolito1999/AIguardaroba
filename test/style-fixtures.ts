// Builders for the style library's tests (src/lib/outfits/style). Plain data,
// no database: a StyleItem with sensible defaults and a by-id map.

import type { ItemCategory, OutfitSlot } from "@/lib/db/enums";
import type { OutfitCheckItem } from "@/lib/outfits/contracts";
import type { StyleEntry, StyleItem } from "@/lib/outfits/style/types";

let counter = 0;

/** A clothing item that suits a mild autumn day; override what the test is about. */
export function makeStyleItem(overrides: Partial<StyleItem> & { category?: ItemCategory } = {}): StyleItem {
  counter += 1;
  return {
    id: overrides.id ?? `item-${counter}`,
    category: "top",
    subcategory: null,
    name: null,
    colors: ["grey"],
    colorHex: ["#808080"],
    pattern: null,
    fit: null,
    materials: ["cotton"],
    formality: "casual",
    warmthLevel: 2,
    waterproof: false,
    windproof: false,
    insulated: false,
    seasons: ["spring", "autumn"],
    condition: "good",
    wearCount: 0,
    daysSinceWorn: null,
    ...overrides,
  };
}

/** The items by id. */
export function styleMap(...items: readonly StyleItem[]): Map<string, StyleItem> {
  return new Map(items.map((item) => [item.id, item]));
}

/** What validateOutfit needs for these items: clothing, confirmed. */
export function checkMap(...items: readonly StyleItem[]): Map<string, OutfitCheckItem> {
  return new Map(
    items.map((item) => [item.id, { id: item.id, category: item.category, status: "confirmed", collection: "clothing" }]),
  );
}

/** Entries from [slot, item] pairs. */
export function entriesOf(...pairs: readonly (readonly [OutfitSlot, StyleItem])[]): StyleEntry[] {
  return pairs.map(([slot, item]) => ({ slot, itemId: item.id }));
}
