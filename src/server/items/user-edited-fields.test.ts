import { describe, expect, it } from "vitest";

import type { Item } from "@/lib/db/schema";
import { EDITABLE_TAG_FIELDS, TAG_FIELD_TO_COLUMN, type ItemPatch } from "@/lib/items/contracts";

import { COAT_TAGS, JACKET_TAGS } from "../../../test/fixtures/item-tags";
import {
  computeUserEditedFields,
  handTaggedEditedFields,
  isEditableTagField,
  statusAfterTagging,
  taggedItemUpdate,
} from "./user-edited-fields";

/** A full item row as the database returns it, with COAT_TAGS applied. */
function itemRow(overrides: Partial<Item> = {}): Item {
  return {
    id: "6f1c8e2a-3b4d-4c5e-8f90-a1b2c3d4e5f6",
    createdAt: new Date("2026-11-01T10:00:00.000Z"),
    updatedAt: new Date("2026-11-01T10:00:00.000Z"),
    status: "tagged",
    archivedFrom: null,
    location: "bologna",
    decision: "undecided",
    name: COAT_TAGS.name,
    category: COAT_TAGS.category,
    subcategory: COAT_TAGS.subcategory,
    colors: [...COAT_TAGS.colors],
    colorHex: [...COAT_TAGS.color_hex],
    materialGuess: COAT_TAGS.material_guess,
    materials: [...COAT_TAGS.materials],
    warmthLevel: COAT_TAGS.warmth_level,
    waterproof: COAT_TAGS.waterproof,
    windproof: COAT_TAGS.windproof,
    insulated: COAT_TAGS.insulated,
    breathable: COAT_TAGS.breathable,
    seasons: [...COAT_TAGS.seasons],
    formality: COAT_TAGS.formality,
    pattern: COAT_TAGS.pattern,
    fit: COAT_TAGS.fit,
    condition: COAT_TAGS.condition,
    brand: COAT_TAGS.brand_guess,
    size: null,
    description: COAT_TAGS.description,
    notes: "",
    purchasePrice: null,
    currency: "EUR",
    purchaseDate: null,
    aiRaw: COAT_TAGS,
    aiModel: "claude-haiku-5-5",
    aiPromptVersion: "tag-v1",
    aiConfidence: { ...COAT_TAGS.confidence },
    imageHash: "a".repeat(64),
    sourceHash: "b".repeat(64),
    userEditedFields: [],
    wearCount: 0,
    lastWornAt: null,
    taggingError: null,
    taggingBatchId: null,
    ...overrides,
  };
}

describe("computeUserEditedFields", () => {
  it("marks only fields whose new value differs from Claude's", () => {
    const patch: ItemPatch = { name: "My favourite coat", category: "outerwear", warmth_level: 4, waterproof: true };
    expect(computeUserEditedFields(COAT_TAGS, [], patch)).toEqual(["name", "waterproof"]);
  });

  it("keeps earlier edits even when a field is set back to Claude's value (sticky)", () => {
    const patch: ItemPatch = { name: COAT_TAGS.name };
    expect(computeUserEditedFields(COAT_TAGS, ["name", "pattern"], patch)).toEqual(["name", "pattern"]);
  });

  it("never tracks the fields that are not tags", () => {
    const patch: ItemPatch = {
      size: "M",
      notes: "Dry clean only",
      purchase_price: 120,
      currency: "EUR",
      purchase_date: "2024-10-01",
      location: "hamburg",
      decision: "bring",
    };
    expect(computeUserEditedFields(COAT_TAGS, [], patch)).toEqual([]);
  });

  it.each<[string, ItemPatch, string[]]>([
    ["reordered colours (dominant first matters)", { colors: ["black", "navy"], color_hex: ["#000000", "#1f2a44"] }, ["colors", "color_hex"]],
    ["a changed swatch only, which still marks both parallel lists", { colors: ["navy"], color_hex: ["#000080"] }, ["colors", "color_hex"]],
    ["the same colours", { colors: ["navy"], color_hex: ["#1f2a44"] }, []],
    ["reordered seasons", { seasons: ["winter", "autumn"] }, []],
    ["a changed season set", { seasons: ["winter"] }, ["seasons"]],
    ["reordered materials", { materials: ["polyester", "wool"] }, []],
    ["a changed material", { materials: ["wool", "cashmere"] }, ["materials"]],
    ["an empty brand where Claude saw none", { brand: "" }, []],
    ["a brand where Claude saw none", { brand: "Hackett" }, ["brand"]],
    ["breathable set to unknown", { breathable: null }, ["breathable"]],
    ["fit cleared to an empty string", { fit: "" }, ["fit"]],
    ["the same warmth", { warmth_level: 4 }, []],
  ])("compares %s by the field's rules", (_label, patch, expected) => {
    expect(computeUserEditedFields(COAT_TAGS, [], patch)).toEqual(expected);
  });

  it("compares brand with Claude's brand_guess", () => {
    expect(computeUserEditedFields(JACKET_TAGS, [], { brand: "Barbour" })).toEqual([]);
    expect(computeUserEditedFields(JACKET_TAGS, [], { brand: null })).toEqual(["brand"]);
  });

  it("treats every tag field in the patch as edited when the item has no tags yet", () => {
    const patch: ItemPatch = { name: "Grey scarf", brand: null, notes: "gift" };
    expect(computeUserEditedFields(null, [], patch)).toEqual(["name", "brand"]);
  });

  it("treats a field missing from an older tagging output as edited", () => {
    const older = Object.fromEntries(Object.entries(COAT_TAGS).filter(([key]) => key !== "pattern"));
    expect(computeUserEditedFields(older, [], { pattern: "solid" })).toEqual(["pattern"]);
  });

  it("drops unknown names and returns the fields in a fixed order", () => {
    const result = computeUserEditedFields(COAT_TAGS, ["description", "not_a_field", "category"], {
      name: "Coat",
    });
    expect(result).toEqual(["name", "category", "description"]);
    expect(result.every(isEditableTagField)).toBe(true);
  });

  it("adds color_hex when an earlier edit recorded only colors", () => {
    expect(computeUserEditedFields(COAT_TAGS, ["colors"], {})).toEqual(["colors", "color_hex"]);
  });
});

describe("handTaggedEditedFields", () => {
  /** A hand-tagging patch as the form sends it: every field, the defaults at their start. */
  const HAND_PATCH: ItemPatch = {
    name: "Grey scarf",
    category: "scarf",
    subcategory: "",
    colors: ["grey"],
    color_hex: ["#808080"],
    material_guess: "",
    materials: [],
    warmth_level: 3,
    waterproof: false,
    windproof: false,
    insulated: false,
    breathable: null,
    seasons: ["winter"],
    formality: "casual",
    pattern: "",
    fit: null,
    condition: "good",
    brand: null,
    description: "",
    notes: "gift",
  };

  it("leaves out the defaults listed as left alone and the blank optional fields", () => {
    expect(
      handTaggedEditedFields([], HAND_PATCH, ["warmth_level", "waterproof", "windproof", "insulated", "breathable"]),
    ).toEqual(["name", "category", "colors", "color_hex", "seasons", "formality", "condition"]);
  });

  it("records a default that is not listed, with any value, null included for breathable", () => {
    expect(handTaggedEditedFields([], HAND_PATCH, ["warmth_level"])).toEqual([
      "name",
      "category",
      "colors",
      "color_hex",
      "waterproof",
      "windproof",
      "insulated",
      "breathable",
      "seasons",
      "formality",
      "condition",
    ]);
  });

  it("still records only the optional fields that have a value", () => {
    const patch: ItemPatch = { ...HAND_PATCH, brand: "Hackett", fit: "slim", materials: ["wool"] };
    expect(handTaggedEditedFields([], patch, ["warmth_level", "waterproof", "windproof", "insulated", "breathable"])).toEqual([
      "name",
      "category",
      "colors",
      "color_hex",
      "materials",
      "seasons",
      "formality",
      "fit",
      "condition",
      "brand",
    ]);
  });

  it("keeps earlier marks, also on a field listed now", () => {
    expect(handTaggedEditedFields(["warmth_level", "pattern"], { name: "Scarf", warmth_level: 3 }, ["warmth_level"])).toEqual([
      "name",
      "warmth_level",
      "pattern",
    ]);
  });
});

describe("statusAfterTagging", () => {
  it.each([
    ["pending_tagging", "tagged"],
    ["tagged", "tagged"],
    ["confirmed", "confirmed"],
    ["archived", "archived"],
  ] as const)("%s becomes %s", (from, to) => {
    expect(statusAfterTagging(from)).toBe(to);
  });
});

describe("taggedItemUpdate", () => {
  const meta = { model: "claude-haiku-5-5", promptVersion: "tag-v1" };

  it("writes every tag from a new output when nothing was edited", () => {
    const update = taggedItemUpdate(
      itemRow({ status: "pending_tagging", aiRaw: null, taggingError: "old failure", taggingBatchId: "f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f" }),
      JACKET_TAGS,
      meta,
    );
    expect(update).toEqual({
      name: JACKET_TAGS.name,
      category: "outerwear",
      subcategory: "field jacket",
      colors: ["olive", "brown"],
      colorHex: ["#556b2f", "#6b4423"],
      materialGuess: "waxed cotton",
      materials: ["waxed cotton", "corduroy"],
      warmthLevel: 3,
      waterproof: false,
      windproof: true,
      insulated: true,
      breathable: null,
      seasons: ["spring", "autumn"],
      formality: "casual",
      pattern: "solid",
      fit: null,
      condition: "worn",
      brand: "Barbour",
      description: JACKET_TAGS.description,
      aiConfidence: JACKET_TAGS.confidence,
      aiRaw: JACKET_TAGS,
      aiModel: "claude-haiku-5-5",
      aiPromptVersion: "tag-v1",
      taggingError: null,
      taggingBatchId: null,
      status: "tagged",
    });
  });

  it("keeps the owner's values for edited fields and takes Claude's for the rest", () => {
    const current = itemRow({
      name: "Dad's coat",
      warmthLevel: 5,
      brand: null,
      colors: ["black"],
      colorHex: ["#000000"],
      userEditedFields: ["name", "warmth_level", "brand", "color_hex"],
    });
    const update = taggedItemUpdate(current, JACKET_TAGS, meta);
    expect(update).toMatchObject({
      name: "Dad's coat",
      warmthLevel: 5,
      // null is a choice for brand, so the edit survives Claude's "Barbour".
      brand: null,
      // An edit of either colour list keeps both, so they stay parallel.
      colors: ["black"],
      colorHex: ["#000000"],
      subcategory: "field jacket",
      condition: "worn",
      seasons: ["spring", "autumn"],
      aiRaw: JACKET_TAGS,
    });
  });

  it("takes Claude's value for an edited required field the row lacks", () => {
    const current = itemRow({ status: "pending_tagging", category: null, warmthLevel: null, userEditedFields: ["category", "warmth_level"] });
    expect(taggedItemUpdate(current, JACKET_TAGS, meta)).toMatchObject({ category: "outerwear", warmthLevel: 3 });
  });

  it("replaces both colour lists when the kept ones no longer line up", () => {
    const current = itemRow({ colors: ["black", "white"], colorHex: ["#000000"], userEditedFields: ["colors"] });
    expect(taggedItemUpdate(current, JACKET_TAGS, meta)).toMatchObject({
      colors: JACKET_TAGS.colors,
      colorHex: JACKET_TAGS.color_hex,
    });
  });

  it("keeps a confirmed item confirmed and an archived one archived", () => {
    expect(taggedItemUpdate(itemRow({ status: "confirmed" }), JACKET_TAGS, meta).status).toBe("confirmed");
    expect(taggedItemUpdate(itemRow({ status: "archived" }), JACKET_TAGS, meta).status).toBe("archived");
  });

  it("writes a column for every editable field", () => {
    // Guards against a new editable field that taggedItemUpdate forgets to write.
    const update = taggedItemUpdate(itemRow(), JACKET_TAGS, meta);
    for (const field of EDITABLE_TAG_FIELDS) expect(update, field).toHaveProperty(TAG_FIELD_TO_COLUMN[field]);
  });
});
