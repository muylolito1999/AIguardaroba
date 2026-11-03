import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { items } from "@/lib/db/schema";

import {
  BlobClientPayloadSchema,
  CheckHashesBodySchema,
  DRY_RUN_ITEM_DETAIL,
  dryRunItemIdFrom,
  EDITABLE_TAG_FIELDS,
  HAND_TAG_DEFAULT_FIELDS,
  HAND_TAG_DEFAULTS,
  isHandTagDefault,
  isUuid,
  ITEM_API,
  ITEM_PATCH_FIELD_TO_COLUMN,
  ItemCardDtoSchema,
  ItemPatchFieldsSchema,
  ItemPatchSchema,
  matchesUploadPathname,
  nobgUploadPathname,
  nobgUploadPrefix,
  NobgBodySchema,
  originalUploadPathname,
  originalUploadPrefix,
  patchToItemColumns,
  RegisterBodySchema,
  RegisterDataSchema,
  resultSchema,
  SourceHashSchema,
  TAG_FIELD_TO_COLUMN,
  TAGGED_ITEM_DETAIL,
  taggedItemIdFrom,
  TagBodySchema,
  TagDataSchema,
  UncheckedDefaultsSchema,
  type ItemCardDto,
} from "./contracts";

const ITEM_ID = "3f1c2a8e-5b7d-4e2f-9a6c-1d2e3f4a5b6c";
const HASH = "a".repeat(64);

const CARD: ItemCardDto = {
  id: ITEM_ID,
  status: "tagged",
  createdAt: "2026-11-02T08:00:00.000Z",
  name: "Navy wool coat",
  category: "outerwear",
  subcategory: "coat",
  colors: ["navy"],
  colorHex: ["#1f2a44"],
  materialGuess: "wool",
  materials: ["wool"],
  warmthLevel: 4,
  waterproof: false,
  windproof: true,
  insulated: true,
  breathable: null,
  seasons: ["winter"],
  formality: "smart_casual",
  pattern: "solid",
  fit: null,
  condition: "good",
  brand: null,
  size: null,
  description: "Knee-length navy wool coat.",
  notes: "",
  purchasePrice: null,
  currency: "EUR",
  purchaseDate: null,
  location: "bologna",
  decision: "undecided",
  aiConfidence: { category: 0.9 },
  multipleItemsDetected: false,
  userEditedFields: [],
  taggingError: null,
  taggingBatchId: null,
  aiModel: "claude-haiku-5-5",
  images: { thumb: { url: "https://example.invalid/t.webp", width: 400, height: 300 }, processed: null, nobg: null },
};

describe("SourceHashSchema", () => {
  it("accepts a lowercase sha256 hex digest only", () => {
    expect(SourceHashSchema.safeParse(HASH).success).toBe(true);
    expect(SourceHashSchema.safeParse("A".repeat(64)).success).toBe(false);
    expect(SourceHashSchema.safeParse("a".repeat(63)).success).toBe(false);
  });
});

describe("isUuid", () => {
  it("separates uuids from other strings", () => {
    expect(isUuid(ITEM_ID)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});

describe("ItemPatchSchema", () => {
  it("accepts an empty patch and partial patches", () => {
    expect(ItemPatchSchema.parse({})).toEqual({});
    expect(ItemPatchSchema.parse({ name: "  Rain shell  ", warmth_level: 2 })).toEqual({
      name: "Rain shell",
      warmth_level: 2,
    });
    expect(
      ItemPatchSchema.parse({
        colors: ["navy", "white"],
        color_hex: ["#1f2a44", "#ffffff"],
        breathable: null,
        fit: null,
        brand: null,
        size: null,
        purchase_price: 129.9,
        currency: "EUR",
        purchase_date: "2025-10-01",
        location: "hamburg",
        decision: "bring",
        seasons: ["winter", "autumn"],
      }).colors,
    ).toEqual(["navy", "white"]);
  });

  it("rejects unknown keys", () => {
    expect(ItemPatchSchema.safeParse({ brand_guess: "Acme" }).success).toBe(false);
    expect(ItemPatchSchema.safeParse({ status: "confirmed" }).success).toBe(false);
  });

  it.each([
    ["empty name", { name: "  " }],
    ["long name", { name: "x".repeat(61) }],
    ["unknown category", { category: "jacket" }],
    ["warmth 0", { warmth_level: 0 }],
    ["warmth 2.5", { warmth_level: 2.5 }],
    ["null waterproof", { waterproof: null }],
    ["empty seasons", { seasons: [] }],
    ["duplicate seasons", { seasons: ["winter", "winter"] }],
    ["long description", { description: "x".repeat(201) }],
    ["too many materials", { materials: ["a", "b", "c", "d", "e", "f"] }],
    ["negative price", { purchase_price: -1 }],
    ["huge price", { purchase_price: 100_001 }],
    ["lowercase currency", { currency: "eur" }],
    ["impossible date", { purchase_date: "2025-02-30" }],
    ["unknown location", { location: "berlin" }],
    ["unknown decision", { decision: "keep" }],
    ["long notes", { notes: "x".repeat(2001) }],
    ["long brand", { brand: "x".repeat(61) }],
    ["short hex", { colors: ["white"], color_hex: ["#fff"] }],
    ["length mismatch", { colors: ["navy", "white"], color_hex: ["#1f2a44"] }],
    ["colors without hex", { colors: ["navy"] }],
    ["hex without colors", { color_hex: ["#1f2a44"] }],
    ["duplicate colours", { colors: ["Navy", "navy"], color_hex: ["#1f2a44", "#1f2a44"] }],
    ["five colours", { colors: ["a", "b", "c", "d", "e"], color_hex: Array(5).fill("#000000") }],
    ["no colours", { colors: [], color_hex: [] }],
  ])("rejects %s", (_label, patch) => {
    expect(ItemPatchSchema.safeParse(patch).success).toBe(false);
  });

  it("lowercases hex colours", () => {
    expect(ItemPatchSchema.parse({ colors: ["navy"], color_hex: ["#1F2A44"] })).toEqual({
      colors: ["navy"],
      color_hex: ["#1f2a44"],
    });
  });

  it("keeps the unrefined fields schema usable for pick", () => {
    expect(ItemPatchFieldsSchema.pick({ name: true }).parse({ name: "Coat" })).toEqual({ name: "Coat" });
  });
});

describe("hand-tagging defaults", () => {
  it("are valid tag values of editable fields, listed in field order", () => {
    expect(ItemPatchSchema.parse(HAND_TAG_DEFAULTS)).toEqual(HAND_TAG_DEFAULTS);
    expect(HAND_TAG_DEFAULT_FIELDS).toEqual(["warmth_level", "waterproof", "windproof", "insulated", "breathable"]);
    for (const field of HAND_TAG_DEFAULT_FIELDS) expect(EDITABLE_TAG_FIELDS).toContain(field);
  });

  it("tells a default from any other value, a missing one included", () => {
    expect(HAND_TAG_DEFAULT_FIELDS.every((field) => isHandTagDefault(field, HAND_TAG_DEFAULTS[field]))).toBe(true);
    expect(isHandTagDefault("warmth_level", 4)).toBe(false);
    expect(isHandTagDefault("waterproof", true)).toBe(false);
    expect(isHandTagDefault("breathable", false)).toBe(false);
    expect(isHandTagDefault("breathable", undefined)).toBe(false);
    expect(isHandTagDefault("insulated", undefined)).toBe(false);
  });

  it("accepts a list of default fields, each once, and nothing else", () => {
    expect(UncheckedDefaultsSchema.parse([])).toEqual([]);
    expect(UncheckedDefaultsSchema.parse(["breathable", "warmth_level"])).toEqual(["breathable", "warmth_level"]);
    expect(UncheckedDefaultsSchema.safeParse(["name"]).success).toBe(false);
    expect(UncheckedDefaultsSchema.safeParse(["seasons"]).success).toBe(false);
    expect(UncheckedDefaultsSchema.safeParse(["waterproof", "waterproof"]).success).toBe(false);
    expect(UncheckedDefaultsSchema.safeParse("warmth_level").success).toBe(false);
  });
});

describe("column maps", () => {
  const columns = Object.keys(getTableColumns(items));

  it("maps every editable tag field to an item column", () => {
    expect(Object.keys(TAG_FIELD_TO_COLUMN).sort()).toEqual([...EDITABLE_TAG_FIELDS].sort());
    for (const column of Object.values(TAG_FIELD_TO_COLUMN)) expect(columns).toContain(column);
  });

  it("maps every patch field to an item column", () => {
    expect(Object.keys(ITEM_PATCH_FIELD_TO_COLUMN).sort()).toEqual(Object.keys(ItemPatchFieldsSchema.shape).sort());
    for (const column of Object.values(ITEM_PATCH_FIELD_TO_COLUMN)) expect(columns).toContain(column);
  });

  it("patchToItemColumns renames keys and leaves out unset ones", () => {
    expect(patchToItemColumns({})).toEqual({});
    expect(
      patchToItemColumns(
        ItemPatchSchema.parse({
          name: "Coat",
          colors: ["navy"],
          color_hex: ["#1f2a44"],
          material_guess: "wool",
          warmth_level: 4,
          breathable: null,
          brand: null,
          purchase_price: 10,
          purchase_date: null,
          decision: "donate",
        }),
      ),
    ).toEqual({
      name: "Coat",
      colors: ["navy"],
      colorHex: ["#1f2a44"],
      materialGuess: "wool",
      warmthLevel: 4,
      breathable: null,
      brand: null,
      purchasePrice: 10,
      purchaseDate: null,
      decision: "donate",
    });
  });

  it("patchToItemColumns covers every patch field", () => {
    const full = ItemPatchSchema.parse({
      name: "Coat",
      category: "outerwear",
      subcategory: "coat",
      colors: ["navy"],
      color_hex: ["#1f2a44"],
      material_guess: "wool",
      materials: ["wool"],
      warmth_level: 4,
      waterproof: false,
      windproof: true,
      insulated: true,
      breathable: true,
      seasons: ["winter"],
      formality: "casual",
      pattern: "solid",
      fit: "regular",
      condition: "good",
      brand: "Acme",
      description: "A coat.",
      size: "M",
      notes: "Gift",
      purchase_price: 99,
      currency: "EUR",
      purchase_date: "2025-01-02",
      location: "hamburg",
      decision: "bring",
    });
    expect(Object.keys(patchToItemColumns(full)).sort()).toEqual(Object.values(ITEM_PATCH_FIELD_TO_COLUMN).sort());
  });
});

describe("BlobClientPayloadSchema", () => {
  it("accepts both kinds", () => {
    expect(BlobClientPayloadSchema.parse({ kind: "original", itemId: ITEM_ID, sourceHash: HASH })).toEqual({
      kind: "original",
      itemId: ITEM_ID,
      sourceHash: HASH,
    });
    expect(BlobClientPayloadSchema.parse({ kind: "nobg", itemId: ITEM_ID })).toEqual({ kind: "nobg", itemId: ITEM_ID });
  });

  it.each([
    ["nobg with a source hash", { kind: "nobg", itemId: ITEM_ID, sourceHash: HASH }],
    ["original without a source hash", { kind: "original", itemId: ITEM_ID }],
    ["unknown kind", { kind: "thumb", itemId: ITEM_ID }],
    ["bad item id", { kind: "nobg", itemId: "item-1" }],
    ["bad hash", { kind: "original", itemId: ITEM_ID, sourceHash: "xyz" }],
  ])("rejects %s", (_label, payload) => {
    expect(BlobClientPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe("upload paths", () => {
  it("builds the requested pathnames and prefixes", () => {
    expect(originalUploadPathname(ITEM_ID)).toBe(`items/${ITEM_ID}/original.jpg`);
    expect(nobgUploadPathname(ITEM_ID)).toBe(`items/${ITEM_ID}/nobg.png`);
    expect(originalUploadPrefix(ITEM_ID)).toBe(`items/${ITEM_ID}/original`);
    expect(nobgUploadPrefix(ITEM_ID)).toBe(`items/${ITEM_ID}/nobg`);
    expect(originalUploadPathname(ITEM_ID).startsWith(originalUploadPrefix(ITEM_ID))).toBe(true);
  });

  it("matches the requested pathname with or without a random suffix", () => {
    const requested = originalUploadPathname(ITEM_ID);
    expect(matchesUploadPathname(requested, requested)).toBe(true);
    expect(matchesUploadPathname(`items/${ITEM_ID}/original-Ab12Cd34Ef.jpg`, requested)).toBe(true);
    expect(matchesUploadPathname(`items/${ITEM_ID}/original-Ab12/x.jpg`, requested)).toBe(false);
    expect(matchesUploadPathname(`items/${ITEM_ID}/original-Ab12.png`, requested)).toBe(false);
    expect(matchesUploadPathname(`items/${ITEM_ID}/original.jpg.exe`, requested)).toBe(false);
    expect(matchesUploadPathname(`items/other/original-Ab12.jpg`, requested)).toBe(false);
    expect(matchesUploadPathname(`items/${ITEM_ID}/originalAb12.jpg`, requested)).toBe(false);
  });
});

describe("route bodies", () => {
  it("validates check-hashes", () => {
    expect(CheckHashesBodySchema.safeParse({ sourceHashes: [HASH] }).success).toBe(true);
    expect(CheckHashesBodySchema.safeParse({ sourceHashes: [] }).success).toBe(false);
    expect(CheckHashesBodySchema.safeParse({ sourceHashes: Array(501).fill(HASH) }).success).toBe(false);
  });

  it("validates register", () => {
    const body = {
      itemId: ITEM_ID,
      url: `https://store.public.blob.vercel-storage.com/items/${ITEM_ID}/original-Ab12.jpg`,
      pathname: `items/${ITEM_ID}/original-Ab12.jpg`,
      sourceHash: HASH,
      originalFilename: "IMG_0001.HEIC",
    };
    expect(RegisterBodySchema.safeParse(body).success).toBe(true);
    expect(RegisterBodySchema.safeParse({ ...body, url: "http://example.com/x.jpg" }).success).toBe(false);
    expect(RegisterBodySchema.safeParse({ ...body, pathname: "x".repeat(301) }).success).toBe(false);
    expect(RegisterBodySchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });

  it("defaults force to false on tag", () => {
    expect(TagBodySchema.parse({})).toEqual({ force: false });
    expect(TagBodySchema.parse({ force: true })).toEqual({ force: true });
  });

  it("accepts an optional batch id on tag, which must be a uuid", () => {
    expect(TagBodySchema.parse({ force: true, batchId: ITEM_ID })).toEqual({ force: true, batchId: ITEM_ID });
    expect(TagBodySchema.safeParse({ force: true, batchId: "batch-1" }).success).toBe(false);
    expect(TagBodySchema.safeParse({ force: true, batchId: null }).success).toBe(false);
  });

  it("validates nobg", () => {
    expect(NobgBodySchema.safeParse({ url: "https://example.com/n.png", pathname: "items/x/nobg.png" }).success).toBe(
      true,
    );
    expect(NobgBodySchema.safeParse({ url: "https://example.com/n.png" }).success).toBe(false);
  });
});

describe("response schemas", () => {
  it("round-trips an item card", () => {
    expect(ItemCardDtoSchema.parse(JSON.parse(JSON.stringify(CARD)))).toEqual(CARD);
  });

  it("parses Result envelopes", () => {
    expect(resultSchema(TagDataSchema).parse({ ok: true, data: { cached: true, item: CARD } })).toEqual({
      ok: true,
      data: { cached: true, item: CARD },
    });
    expect(
      resultSchema(RegisterDataSchema).parse({ ok: true, data: { duplicate: true, existingItemId: ITEM_ID } }),
    ).toEqual({ ok: true, data: { duplicate: true, existingItemId: ITEM_ID } });
    const failure = { ok: false, error: { code: "BUDGET_EXCEEDED", message: "Budget reached.", details: { x: 1 } } };
    expect(resultSchema(TagDataSchema).parse(failure)).toEqual(failure);
    expect(resultSchema(TagDataSchema).safeParse({ ok: false, error: { code: "NOPE", message: "" } }).success).toBe(
      false,
    );
  });
});

describe("batch start details", () => {
  it("reads the tagged item id of a failed batch start", () => {
    expect(TAGGED_ITEM_DETAIL).toBe("taggedItemId");
    expect(taggedItemIdFrom({ [TAGGED_ITEM_DETAIL]: ITEM_ID })).toBe(ITEM_ID);
    expect(taggedItemIdFrom({ [TAGGED_ITEM_DETAIL]: 42 })).toBeNull();
    expect(taggedItemIdFrom({ [DRY_RUN_ITEM_DETAIL]: ITEM_ID })).toBeNull();
    expect(taggedItemIdFrom(undefined)).toBeNull();
  });

  it("reads the item whose dry run failed", () => {
    expect(DRY_RUN_ITEM_DETAIL).toBe("dryRunItemId");
    expect(dryRunItemIdFrom({ [DRY_RUN_ITEM_DETAIL]: ITEM_ID, status: 400 })).toBe(ITEM_ID);
    expect(dryRunItemIdFrom({ [DRY_RUN_ITEM_DETAIL]: null })).toBeNull();
    expect(dryRunItemIdFrom({ [TAGGED_ITEM_DETAIL]: ITEM_ID })).toBeNull();
    expect(dryRunItemIdFrom({})).toBeNull();
    expect(dryRunItemIdFrom(undefined)).toBeNull();
  });
});

describe("ITEM_API", () => {
  it("builds item routes", () => {
    expect(ITEM_API.tag(ITEM_ID)).toBe(`/api/items/${ITEM_ID}/tag`);
    expect(ITEM_API.nobg(ITEM_ID)).toBe(`/api/items/${ITEM_ID}/nobg`);
  });
});
