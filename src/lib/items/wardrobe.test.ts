import { describe, expect, it } from "vitest";

import { ITEM_CATEGORIES } from "@/lib/db/enums";

import {
  CategoryCountsSchema,
  emptyCategoryCounts,
  itemDisplayName,
  WARDROBE_LIST_LIMIT,
  WardrobeItemDtoSchema,
  WardrobeListDtoSchema,
  type WardrobeItemDto,
} from "./wardrobe";

const ITEM: WardrobeItemDto = {
  id: "3f1c2a8e-5b7d-4e2f-9a6c-1d2e3f4a5b6c",
  name: "Navy down parka",
  category: "outerwear",
  subcategory: "parka",
  status: "confirmed",
  decision: "bring",
  location: "bologna",
  warmthLevel: 5,
  waterproof: true,
  windproof: true,
  insulated: true,
  colors: ["navy", "black"],
  colorHex: ["#1f2a44", "#111111"],
  wearCount: 3,
  multipleItemsDetected: false,
  thumb: { url: "https://example.public.blob.vercel-storage.com/items/x/thumb.webp", width: 400, height: 533 },
};

describe("itemDisplayName", () => {
  it("prefers the name", () => {
    expect(itemDisplayName({ name: "Navy down parka", subcategory: "parka", category: "outerwear" })).toBe(
      "Navy down parka",
    );
  });

  it("falls back to the subcategory, then the category label", () => {
    expect(itemDisplayName({ name: null, subcategory: "parka", category: "outerwear" })).toBe("parka");
    expect(itemDisplayName({ name: "  ", subcategory: "", category: "hat_beanie" })).toBe("Hat or beanie");
  });

  it("names an untagged item", () => {
    expect(itemDisplayName({ name: null, subcategory: null, category: null })).toBe("Untagged item");
  });
});

describe("WardrobeItemDtoSchema", () => {
  it("accepts a valid tile, with or without a thumb", () => {
    expect(WardrobeItemDtoSchema.parse(ITEM)).toEqual(ITEM);
    const pending: WardrobeItemDto = {
      ...ITEM,
      name: null,
      category: null,
      subcategory: null,
      status: "pending_tagging",
      decision: "undecided",
      warmthLevel: null,
      waterproof: null,
      windproof: null,
      insulated: null,
      colors: [],
      colorHex: [],
      wearCount: 0,
      thumb: null,
    };
    expect(WardrobeItemDtoSchema.parse(pending)).toEqual(pending);
  });

  it("rejects a bad tile", () => {
    expect(WardrobeItemDtoSchema.safeParse({ ...ITEM, category: "hat" }).success).toBe(false);
    expect(WardrobeItemDtoSchema.safeParse({ ...ITEM, warmthLevel: 7 }).success).toBe(false);
    expect(WardrobeItemDtoSchema.safeParse({ ...ITEM, wearCount: -1 }).success).toBe(false);
    expect(WardrobeItemDtoSchema.safeParse({ ...ITEM, thumb: { url: "x" } }).success).toBe(false);
    const withoutStatus: Partial<WardrobeItemDto> = { ...ITEM };
    delete withoutStatus.status;
    expect(WardrobeItemDtoSchema.safeParse(withoutStatus).success).toBe(false);
  });
});

describe("category counts and the list DTO", () => {
  it("starts every category at zero", () => {
    const counts = emptyCategoryCounts();
    expect(Object.keys(counts.byCategory)).toEqual([...ITEM_CATEGORIES]);
    expect(Object.values(counts.byCategory).every((count) => count === 0)).toBe(true);
    expect(counts).toMatchObject({ uncategorized: 0, total: 0, untagged: 0, archived: 0 });
    // Each call returns a fresh object the service can fill in.
    counts.byCategory.shoes = 2;
    expect(emptyCategoryCounts().byCategory.shoes).toBe(0);
  });

  it("requires a count for every category", () => {
    const counts = emptyCategoryCounts();
    expect(CategoryCountsSchema.safeParse(counts).success).toBe(true);
    const missingShoes: Partial<Record<string, number>> = { ...counts.byCategory };
    delete missingShoes.shoes;
    expect(CategoryCountsSchema.safeParse({ ...counts, byCategory: missingShoes }).success).toBe(false);
  });

  it("parses a list response", () => {
    const counts = emptyCategoryCounts();
    counts.byCategory.outerwear = 1;
    counts.total = 1;
    const list = {
      items: [ITEM],
      total: 1,
      counts,
      colors: [{ name: "navy", hex: "#1f2a44", count: 1 }],
      capped: false,
    };
    expect(WardrobeListDtoSchema.parse(list)).toEqual(list);
    expect(WARDROBE_LIST_LIMIT).toBe(2000);
    // A list without its colour facet is not a list response.
    expect(WardrobeListDtoSchema.safeParse({ ...list, colors: undefined }).success).toBe(false);
  });
});
