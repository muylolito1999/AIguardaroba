import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { items } from "@/lib/db/schema";
import { EDITABLE_TAG_FIELDS } from "@/lib/items/contracts";

import {
  CONFIDENCE_KEYS,
  ItemTagsSchema,
  ItemTagsWireSchema,
  TAG_FIELD_TO_COLUMN,
  TAG_FIELD_TO_TAGS_KEY,
  tagsToItemColumns,
  type ItemTags,
} from "./schema";

const VALID: ItemTags = {
  name: "Navy wool coat",
  category: "outerwear",
  subcategory: "coat",
  colors: ["navy", "black"],
  color_hex: ["#1f2a44", "#111111"],
  material_guess: "wool blend",
  materials: ["wool", "polyamide"],
  warmth_level: 4,
  waterproof: false,
  windproof: true,
  insulated: true,
  breathable: null,
  seasons: ["winter", "autumn"],
  formality: "smart_casual",
  pattern: "solid",
  fit: "regular",
  condition: "good",
  brand_guess: "Acme",
  description: "Knee-length navy wool coat with a notch collar.",
  confidence: {
    category: 0.95,
    colors: 0.9,
    materials: 0.6,
    warmth_level: 0.8,
    waterproof: 0.7,
    windproof: 0.6,
    insulated: 0.5,
    formality: 0.8,
    condition: 0.7,
    brand: 0.3,
  },
  multiple_items_detected: false,
};

describe("ItemTagsSchema", () => {
  it("accepts a valid reply, which also passes the wire schema", () => {
    expect(ItemTagsSchema.parse(VALID)).toEqual(VALID);
    expect(ItemTagsWireSchema.parse(VALID)).toEqual(VALID);
  });

  it.each<[string, Partial<ItemTags>]>([
    ["a 201-character description", { description: "x".repeat(201) }],
    ["confidence 1.2", { confidence: { ...VALID.confidence, category: 1.2 } }],
    ["negative confidence", { confidence: { ...VALID.confidence, brand: -0.1 } }],
    ["short hex #FFF", { colors: ["white"], color_hex: ["#FFF"] }],
    ["colors and color_hex of different length", { color_hex: ["#1f2a44"] }],
    ["duplicate seasons", { seasons: ["winter", "winter"] }],
    ["empty seasons", { seasons: [] }],
    ["empty colors", { colors: [], color_hex: [] }],
    ["five colors", { colors: ["a", "b", "c", "d", "e"], color_hex: Array<string>(5).fill("#000000") }],
    ["duplicate colors", { colors: ["navy", "Navy"] }],
    ["six materials", { materials: ["a", "b", "c", "d", "e", "f"] }],
    ["an empty name", { name: "" }],
    ["a 61-character name", { name: "x".repeat(61) }],
    ["a long subcategory", { subcategory: "x".repeat(41) }],
    ["a long brand", { brand_guess: "x".repeat(61) }],
  ])("rejects %s after parsing while the wire schema accepts it", (_label, change) => {
    const reply = { ...VALID, ...change };
    expect(ItemTagsWireSchema.safeParse(reply).success).toBe(true);
    expect(ItemTagsSchema.safeParse(reply).success).toBe(false);
  });

  it("lowercases an uppercase hex colour instead of rejecting the reply", () => {
    const reply = { ...VALID, colors: ["navy", "black"], color_hex: ["#1A2B3C", " #FFFFFF "] };
    expect(ItemTagsSchema.parse(reply).color_hex).toEqual(["#1a2b3c", "#ffffff"]);
  });

  it("rejects values outside the enums in both schemas", () => {
    const changes = [{ category: "jacket" }, { warmth_level: 6 }, { seasons: ["monsoon"] }, { formality: "black_tie" }];
    for (const change of changes) {
      const reply = { ...VALID, ...change };
      expect(ItemTagsWireSchema.safeParse(reply).success).toBe(false);
      expect(ItemTagsSchema.safeParse(reply).success).toBe(false);
    }
  });

  it("rejects missing and extra keys in both schemas", () => {
    const missing: Record<string, unknown> = { ...VALID };
    delete missing.fit;
    const extraConfidence = { ...VALID, confidence: { ...VALID.confidence, fit: 1 } };
    for (const reply of [missing, { ...VALID, extra: true }, extraConfidence]) {
      expect(ItemTagsWireSchema.safeParse(reply).success).toBe(false);
      expect(ItemTagsSchema.safeParse(reply).success).toBe(false);
    }
  });
});

describe("ItemTagsWireSchema", () => {
  const jsonSchema = z.toJSONSchema(ItemTagsWireSchema);

  function collectKeys(node: unknown, keys: string[] = []): string[] {
    if (Array.isArray(node)) {
      for (const child of node) collectKeys(child, keys);
    } else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        keys.push(key);
        collectKeys(value, keys);
      }
    }
    return keys;
  }

  function objects(node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(node)) {
      for (const child of node) objects(child, found);
    } else if (typeof node === "object" && node !== null) {
      const record = node as Record<string, unknown>;
      if (record.type === "object") found.push(record);
      for (const value of Object.values(record)) objects(value, found);
    }
    return found;
  }

  it("has no key the API reserves for its own reasoning", () => {
    const keys = collectKeys(jsonSchema);
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.filter((key) => /reasoning|thinking|thought/i.test(key))).toEqual([]);
  });

  it("requires every key and allows no others, at every level", () => {
    const found = objects(jsonSchema);
    expect(found).toHaveLength(2);
    for (const object of found) {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties as object));
    }
  });

  /** Keywords used by schema nodes; property names (one of which is "pattern") are left out. */
  function keywords(node: unknown, found: string[] = []): string[] {
    if (Array.isArray(node)) {
      for (const child of node) keywords(child, found);
    } else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        found.push(key);
        if (key === "properties" && typeof value === "object" && value !== null) {
          for (const property of Object.values(value)) keywords(property, found);
        } else {
          keywords(value, found);
        }
      }
    }
    return found;
  }

  it("carries no constraints the API would reject", () => {
    const keys = keywords(jsonSchema);
    expect(keys).toContain("enum");
    for (const unsupported of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern"]) {
      expect(keys).not.toContain(unsupported);
    }
  });

  it("keeps the enums, warmth included", () => {
    type Property = { enum?: unknown[]; items?: { enum?: unknown[] } };
    const { properties } = jsonSchema as { properties: Record<string, Property> };
    expect(properties.warmth_level?.enum).toEqual([1, 2, 3, 4, 5]);
    expect(properties.category?.enum).toContain("hat_beanie");
    expect(properties.seasons?.items?.enum).toEqual(["winter", "spring", "summer", "autumn"]);
    expect(properties.formality?.enum).toContain("smart_casual");
    expect(properties.condition?.enum).toContain("needs_repair");
  });

  it("uses only three nullable unions and no optional keys", () => {
    const serialized = JSON.stringify(jsonSchema);
    expect(serialized.match(/"null"/g)).toHaveLength(3);
    expect(serialized).not.toContain("anyOf");
    expect(serialized).not.toContain("oneOf");
  });

  it("rates exactly the confidence keys", () => {
    expect(Object.keys(VALID.confidence).sort()).toEqual([...CONFIDENCE_KEYS].sort());
  });
});

describe("tagsToItemColumns", () => {
  it("maps every tag to its column", () => {
    expect(tagsToItemColumns(ItemTagsSchema.parse(VALID))).toEqual({
      name: "Navy wool coat",
      category: "outerwear",
      subcategory: "coat",
      colors: ["navy", "black"],
      colorHex: ["#1f2a44", "#111111"],
      materialGuess: "wool blend",
      materials: ["wool", "polyamide"],
      warmthLevel: 4,
      waterproof: false,
      windproof: true,
      insulated: true,
      breathable: null,
      seasons: ["winter", "autumn"],
      formality: "smart_casual",
      pattern: "solid",
      fit: "regular",
      condition: "good",
      brand: "Acme",
      description: "Knee-length navy wool coat with a notch collar.",
      aiConfidence: VALID.confidence,
    });
  });

  it("writes only real item columns and covers every editable field", () => {
    const columns = Object.keys(getTableColumns(items));
    const written = Object.keys(tagsToItemColumns(VALID));
    for (const key of written) expect(columns).toContain(key);
    for (const field of EDITABLE_TAG_FIELDS) expect(written).toContain(TAG_FIELD_TO_COLUMN[field]);
    expect(written).toContain("aiConfidence");
  });

  it("copies the confidence object instead of sharing it", () => {
    const tags = ItemTagsSchema.parse(VALID);
    expect(tagsToItemColumns(tags).aiConfidence).not.toBe(tags.confidence);
  });

  it("names the tags key behind every editable field", () => {
    expect(Object.keys(TAG_FIELD_TO_TAGS_KEY).sort()).toEqual([...EDITABLE_TAG_FIELDS].sort());
    for (const key of Object.values(TAG_FIELD_TO_TAGS_KEY)) expect(Object.keys(VALID)).toContain(key);
    expect(TAG_FIELD_TO_TAGS_KEY.brand).toBe("brand_guess");
  });
});
