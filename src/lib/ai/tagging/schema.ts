// The tagging output in two forms (D-019):
// - ItemTagsWireSchema is what Claude is constrained to. It carries only what
//   a structured-output JSON Schema supports: every key required, no length,
//   range or pattern limits (those are stated in the descriptions instead),
//   and just three nullable unions (breathable, fit, brand_guess).
// - ItemTagsSchema is applied to the JSON.parse'd reply and enforces the limits.
// Shared with client code (the review form reads the limits), so no
// `server-only`, env or Node APIs here. No key may mention reasoning, thinking
// or thought: the API reserves those words.

import { z } from "zod";

import { FORMALITIES, ITEM_CATEGORIES, ITEM_CONDITIONS, SEASONS } from "@/lib/db/enums";
import {
  checkColorHexLength,
  ITEM_FIELD_SCHEMAS,
  TAG_LIMITS,
  WARMTH_LEVELS,
  type EditableTagField,
  type ItemPatchColumns,
} from "@/lib/items/contracts";

export { TAG_FIELD_TO_COLUMN } from "@/lib/items/contracts";

/** Fields Claude rates from 0 to 1; the review form highlights low values. */
export const CONFIDENCE_KEYS = [
  "category",
  "colors",
  "materials",
  "warmth_level",
  "waterproof",
  "windproof",
  "insulated",
  "formality",
  "condition",
  "brand",
] as const;
export type ConfidenceKey = (typeof CONFIDENCE_KEYS)[number];

const confidenceShape = <T extends z.ZodType>(value: T) =>
  Object.fromEntries(CONFIDENCE_KEYS.map((key) => [key, value])) as Record<ConfidenceKey, T>;

export const ItemTagsWireSchema = z.strictObject({
  name: z.string().describe(`Short display name, at most ${TAG_LIMITS.nameMax} characters.`),
  category: z.enum(ITEM_CATEGORIES),
  subcategory: z
    .string()
    .describe(`For example coat, jeans, chelsea boots. At most ${TAG_LIMITS.shortTextMax} characters.`),
  colors: z
    .array(z.string())
    .describe(`${TAG_LIMITS.colorsMin} to ${TAG_LIMITS.colorsMax} distinct colour names, dominant first.`),
  color_hex: z.array(z.string()).describe("One lowercase #rrggbb value per entry in colors, in the same order."),
  material_guess: z
    .string()
    .describe(`The main material in a few words, at most ${TAG_LIMITS.shortTextMax} characters.`),
  materials: z.array(z.string()).describe(`Up to ${TAG_LIMITS.materialsMax} materials, main one first.`),
  warmth_level: z.literal(WARMTH_LEVELS).describe("1 to 5 on the warmth rubric."),
  waterproof: z.boolean(),
  windproof: z.boolean(),
  insulated: z.boolean(),
  breathable: z.boolean().nullable().describe("null when the photo cannot tell."),
  seasons: z.array(z.enum(SEASONS)).describe("Every season the item suits, at least one, no repeats."),
  formality: z.enum(FORMALITIES),
  pattern: z.string().describe(`For example solid, striped, checked. At most ${TAG_LIMITS.shortTextMax} characters.`),
  fit: z.string().nullable().describe("For example slim, regular, oversized; null when the photo cannot tell."),
  condition: z.enum(ITEM_CONDITIONS),
  brand_guess: z.string().nullable().describe("Only from a legible logo or label; otherwise null."),
  description: z.string().describe("One sentence, at most 180 characters."),
  confidence: z.strictObject(confidenceShape(z.number())).describe("Confidence per field from 0 to 1."),
  multiple_items_detected: z.boolean(),
});
export type ItemTagsWire = z.infer<typeof ItemTagsWireSchema>;

/** The validated tags. Same keys as the wire schema, with the limits enforced. */
export const ItemTagsSchema = z
  .strictObject({
    name: ITEM_FIELD_SCHEMAS.name,
    category: ITEM_FIELD_SCHEMAS.category,
    subcategory: ITEM_FIELD_SCHEMAS.subcategory,
    colors: ITEM_FIELD_SCHEMAS.colors,
    color_hex: ITEM_FIELD_SCHEMAS.color_hex,
    material_guess: ITEM_FIELD_SCHEMAS.material_guess,
    materials: ITEM_FIELD_SCHEMAS.materials,
    warmth_level: ITEM_FIELD_SCHEMAS.warmth_level,
    waterproof: ITEM_FIELD_SCHEMAS.waterproof,
    windproof: ITEM_FIELD_SCHEMAS.windproof,
    insulated: ITEM_FIELD_SCHEMAS.insulated,
    breathable: ITEM_FIELD_SCHEMAS.breathable,
    seasons: ITEM_FIELD_SCHEMAS.seasons,
    formality: ITEM_FIELD_SCHEMAS.formality,
    pattern: ITEM_FIELD_SCHEMAS.pattern,
    fit: ITEM_FIELD_SCHEMAS.fit,
    condition: ITEM_FIELD_SCHEMAS.condition,
    brand_guess: ITEM_FIELD_SCHEMAS.brand,
    description: ITEM_FIELD_SCHEMAS.description,
    confidence: z.strictObject(confidenceShape(z.number().min(0).max(1))),
    multiple_items_detected: z.boolean(),
  })
  .superRefine(checkColorHexLength);
export type ItemTags = z.infer<typeof ItemTagsSchema>;

/** The item columns tagging writes, all set (aiRaw, aiModel and status are the caller's). */
export type ItemTagColumns = Required<
  Pick<
    ItemPatchColumns,
    | "name"
    | "category"
    | "subcategory"
    | "colors"
    | "colorHex"
    | "materialGuess"
    | "materials"
    | "warmthLevel"
    | "waterproof"
    | "windproof"
    | "insulated"
    | "breathable"
    | "seasons"
    | "formality"
    | "pattern"
    | "fit"
    | "condition"
    | "brand"
    | "description"
  >
> & { aiConfidence: Record<string, number> };

/** Maps validated tags to drizzle item columns: brand_guess -> brand, confidence -> aiConfidence. */
export function tagsToItemColumns(tags: ItemTags): ItemTagColumns {
  return {
    name: tags.name,
    category: tags.category,
    subcategory: tags.subcategory,
    colors: tags.colors,
    colorHex: tags.color_hex,
    materialGuess: tags.material_guess,
    materials: tags.materials,
    warmthLevel: tags.warmth_level,
    waterproof: tags.waterproof,
    windproof: tags.windproof,
    insulated: tags.insulated,
    breathable: tags.breathable,
    seasons: tags.seasons,
    formality: tags.formality,
    pattern: tags.pattern,
    fit: tags.fit,
    condition: tags.condition,
    brand: tags.brand_guess,
    description: tags.description,
    aiConfidence: { ...tags.confidence },
  };
}

/** The ItemTags key each editable field comes from, for comparing an edit with ai_raw. */
export const TAG_FIELD_TO_TAGS_KEY = {
  name: "name",
  category: "category",
  subcategory: "subcategory",
  colors: "colors",
  color_hex: "color_hex",
  material_guess: "material_guess",
  materials: "materials",
  warmth_level: "warmth_level",
  waterproof: "waterproof",
  windproof: "windproof",
  insulated: "insulated",
  breathable: "breathable",
  seasons: "seasons",
  formality: "formality",
  pattern: "pattern",
  fit: "fit",
  condition: "condition",
  brand: "brand_guess",
  description: "description",
} as const satisfies Record<EditableTagField, keyof ItemTags>;
