import { randomUUID } from "node:crypto";

import type { Db } from "@/lib/db/client";
import { itemImages, items, type Item, type ItemImage, type NewItem, type NewItemImage } from "@/lib/db/schema";

// Insert helpers for DB tests. Defaults are the minimum a valid row needs;
// tests pass only the fields they care about.

/** Fields that satisfy items_tagged_complete_check, for tagged or confirmed items. */
export const TAGGED_ITEM_FIELDS = {
  name: "Navy wool coat",
  category: "outerwear",
  subcategory: "coat",
  colors: ["navy"],
  colorHex: ["#1f2a44"],
  materials: ["wool"],
  warmthLevel: 4,
  waterproof: false,
  windproof: true,
  insulated: true,
  breathable: null,
  seasons: ["winter", "autumn"],
  formality: "smart_casual",
  condition: "good",
  description: "Knee-length navy wool coat.",
} satisfies Partial<NewItem>;

function fakeSha256(): string {
  // Unique per call and shaped like a hex digest, which is all the schema needs.
  return (randomUUID() + randomUUID()).replaceAll("-", "").slice(0, 64);
}

/** Inserts an item (pending_tagging unless overridden) and returns the row. */
export async function makeItem(db: Db, overrides: Partial<NewItem> = {}): Promise<Item> {
  const [row] = await db
    .insert(items)
    .values({ imageHash: fakeSha256(), ...overrides })
    .returning();
  if (row === undefined) throw new Error("makeItem: insert returned no row");
  return row;
}

/** Inserts a tagged item with every field the tagged CHECK requires. */
export function makeTaggedItem(db: Db, overrides: Partial<NewItem> = {}): Promise<Item> {
  return makeItem(db, { ...TAGGED_ITEM_FIELDS, status: "tagged", ...overrides });
}

/** Inserts an image row for an item (kind "processed" unless overridden). */
export async function makeImage(
  db: Db,
  itemId: string,
  overrides: Partial<Omit<NewItemImage, "itemId">> = {},
): Promise<ItemImage> {
  const kind = overrides.kind ?? "processed";
  const pathname = `items/${itemId}/${kind}-test.webp`;
  const [row] = await db
    .insert(itemImages)
    .values({
      itemId,
      kind,
      blobUrl: `https://example.invalid/${pathname}`,
      blobPathname: pathname,
      contentType: "image/webp",
      width: 1024,
      height: 768,
      bytes: 120_000,
      ...overrides,
    })
    .returning();
  if (row === undefined) throw new Error("makeImage: insert returned no row");
  return row;
}
