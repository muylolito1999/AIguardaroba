// The review form's data model, kept free of React so it can be unit tested:
// the form schema (built from the shared field validators in
// src/lib/items/contracts.ts, so the form accepts exactly what ItemPatchSchema
// accepts), defaults from an item card, the dirty-field patch, and the
// low-confidence hints. Client-safe: no server imports.

import { z } from "zod"

import type { ConfidenceKey } from "@/lib/ai/tagging/schema"
import { SEASONS, type Season } from "@/lib/db/enums"
import {
  ITEM_FIELD_SCHEMAS,
  ItemPatchFieldsSchema,
  ItemPatchSchema,
  TAG_LIMITS,
  WARMTH_LEVELS,
  type EditableTagField,
  type ItemCardDto,
  type ItemPatch,
  type WarmthLevel,
} from "@/lib/items/contracts"

// ---------------------------------------------------------------------------
// Low-confidence hints
// ---------------------------------------------------------------------------

/** Below this, a tag gets a visible "Check this" hint until the owner edits it. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6

/**
 * The editable fields each confidence score covers. Editing any of them counts
 * as having checked the score's field (colour names and swatches are one
 * control, and the material guess sits next to the material list).
 */
export const CONFIDENCE_FIELDS = {
  category: ["category"],
  colors: ["colors", "color_hex"],
  materials: ["materials", "material_guess"],
  warmth_level: ["warmth_level"],
  waterproof: ["waterproof"],
  windproof: ["windproof"],
  insulated: ["insulated"],
  formality: ["formality"],
  condition: ["condition"],
  brand: ["brand"],
} as const satisfies Record<ConfidenceKey, readonly EditableTagField[]>

export type HintField = keyof typeof CONFIDENCE_FIELDS

const HINT_FIELDS = Object.keys(CONFIDENCE_FIELDS) as HintField[]

/**
 * Confidence (0 to 1) of every field Claude was unsure about and the owner has
 * not edited yet. Unknown keys in ai_confidence are ignored.
 */
export function lowConfidenceFields(
  item: Pick<ItemCardDto, "aiConfidence" | "userEditedFields">
): Map<HintField, number> {
  const hints = new Map<HintField, number>()
  const confidence = item.aiConfidence
  if (confidence === null) return hints
  const edited = new Set(item.userEditedFields)
  for (const field of HINT_FIELDS) {
    const score = confidence[field]
    if (typeof score !== "number" || score >= LOW_CONFIDENCE_THRESHOLD) continue
    if (CONFIDENCE_FIELDS[field].some((name) => edited.has(name))) continue
    hints.set(field, score)
  }
  return hints
}

// ---------------------------------------------------------------------------
// Form schema
// ---------------------------------------------------------------------------

export const BREATHABLE_CHOICES = ["yes", "no", "unknown"] as const
export type BreathableChoice = (typeof BREATHABLE_CHOICES)[number]

const patchFields = ItemPatchFieldsSchema.shape

function blankToNull(value: string): string | null {
  return value.trim() === "" ? null : value
}

/** Text inputs hold "", which the patch stores as null for nullable columns. */
function nullableText<T extends z.ZodType<string | null, string | null>>(schema: T) {
  return z.string().transform(blankToNull).pipe(schema)
}

function hasDuplicateNames(entries: readonly { name: string }[]): boolean {
  const names = entries.map((entry) => entry.name.trim().toLowerCase())
  return new Set(names).size !== names.length
}

/** One colour chip: its name and swatch stay together, so the two patch lists cannot drift apart. */
export const ColorEntrySchema = z.object({
  name: ITEM_FIELD_SCHEMAS.colors.element,
  hex: ITEM_FIELD_SCHEMAS.color_hex.element,
})
export type ColorEntry = z.input<typeof ColorEntrySchema>

const priceSchema = z
  .string()
  .transform((value, ctx) => {
    const trimmed = value.trim()
    if (trimmed === "") return null
    // A comma is the decimal separator on Italian and German keyboards.
    const amount = Number(trimmed.replace(",", "."))
    if (!Number.isFinite(amount)) {
      ctx.addIssue({ code: "custom", message: "Enter an amount such as 49.90." })
      return z.NEVER
    }
    return amount
  })
  .pipe(patchFields.purchase_price.unwrap())

/**
 * Every control of the review form. Inputs are what the controls hold (text
 * for price and dates, colour chips as name and hex pairs, breathable as
 * yes/no/unknown); the output has the ItemPatch field names and types.
 */
const tagFormFields = z.object({
  name: ITEM_FIELD_SCHEMAS.name,
  category: ITEM_FIELD_SCHEMAS.category,
  subcategory: ITEM_FIELD_SCHEMAS.subcategory,
  colors: z
    .array(ColorEntrySchema)
    .min(TAG_LIMITS.colorsMin, "Add at least one colour.")
    .max(TAG_LIMITS.colorsMax, `Use at most ${TAG_LIMITS.colorsMax} colours.`)
    .refine((entries) => !hasDuplicateNames(entries), "Each colour can appear once."),
  material_guess: ITEM_FIELD_SCHEMAS.material_guess,
  materials: ITEM_FIELD_SCHEMAS.materials,
  warmth_level: ITEM_FIELD_SCHEMAS.warmth_level,
  waterproof: ITEM_FIELD_SCHEMAS.waterproof,
  windproof: ITEM_FIELD_SCHEMAS.windproof,
  insulated: ITEM_FIELD_SCHEMAS.insulated,
  breathable: z.enum(BREATHABLE_CHOICES).transform((choice) => (choice === "unknown" ? null : choice === "yes")),
  seasons: ITEM_FIELD_SCHEMAS.seasons,
  formality: ITEM_FIELD_SCHEMAS.formality,
  pattern: ITEM_FIELD_SCHEMAS.pattern,
  fit: nullableText(ITEM_FIELD_SCHEMAS.fit),
  condition: ITEM_FIELD_SCHEMAS.condition,
  brand: nullableText(ITEM_FIELD_SCHEMAS.brand),
  description: ITEM_FIELD_SCHEMAS.description,
  size: nullableText(patchFields.size.unwrap()),
  notes: patchFields.notes.unwrap(),
  purchase_price: priceSchema,
  currency: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(patchFields.currency.unwrap()),
  purchase_date: nullableText(patchFields.purchase_date.unwrap()),
  location: patchFields.location.unwrap(),
  decision: patchFields.decision.unwrap(),
})

export const tagFormSchema = tagFormFields.transform(({ colors, ...rest }) => ({
  ...rest,
  colors: colors.map((entry) => entry.name),
  color_hex: colors.map((entry) => entry.hex),
}))

export type TagFormValues = z.input<typeof tagFormSchema>
export type TagFormOutput = z.output<typeof tagFormSchema>
export type TagFormField = keyof TagFormValues

/** Every control's name, for mapping server-side validation issues back onto the form. */
export const TAG_FORM_FIELDS = Object.keys(tagFormFields.shape) as TagFormField[]

export function isTagFormField(value: string): value is TagFormField {
  return (TAG_FORM_FIELDS as readonly string[]).includes(value)
}

/** Plain-English messages for zod's built-in checks; messages set in the schemas take precedence. */
export const tagFormErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string") {
        return Number(issue.minimum) <= 1 ? "Required." : `Use at least ${issue.minimum} characters.`
      }
      if (issue.origin === "array") return `Add at least ${issue.minimum}.`
      if (issue.origin === "number") return `Use ${issue.minimum} or more.`
      return undefined
    case "too_big":
      if (issue.origin === "string") return `Use at most ${issue.maximum} characters.`
      if (issue.origin === "array") return `Use at most ${issue.maximum}.`
      if (issue.origin === "number") return `Use ${issue.maximum} or less.`
      return undefined
    case "invalid_value":
      return "Choose one of the options."
    case "invalid_type":
      return "Required."
    case "invalid_format":
      return issue.format === "date" ? "Use a valid date." : "Check the format."
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Defaults, baseline and patch
// ---------------------------------------------------------------------------

export function isWarmthLevel(value: number): value is WarmthLevel {
  return (WARMTH_LEVELS as readonly number[]).includes(value)
}

export function isSeason(value: string): value is Season {
  return (SEASONS as readonly string[]).includes(value)
}

/** Seasons in calendar-list order, so toggling one off and on again leaves the value unchanged. */
export function sortSeasons(seasons: readonly Season[]): Season[] {
  return SEASONS.filter((season) => seasons.includes(season))
}

function breathableChoice(value: boolean | null): BreathableChoice {
  if (value === null) return "unknown"
  return value ? "yes" : "no"
}

/** A tagged item with every field the form needs; pending items have none of them. */
export type TaggedItemCard = ItemCardDto & {
  name: string
  category: NonNullable<ItemCardDto["category"]>
  warmthLevel: WarmthLevel
  waterproof: boolean
  windproof: boolean
  insulated: boolean
  formality: NonNullable<ItemCardDto["formality"]>
  condition: NonNullable<ItemCardDto["condition"]>
}

/**
 * True when the card carries the fields the database requires of tagged and
 * confirmed items (items_tagged_complete_check), so the form can show it.
 */
export function hasTags(item: ItemCardDto): item is TaggedItemCard {
  return (
    (item.status === "tagged" || item.status === "confirmed") &&
    item.name !== null &&
    item.category !== null &&
    item.warmthLevel !== null &&
    isWarmthLevel(item.warmthLevel) &&
    item.waterproof !== null &&
    item.windproof !== null &&
    item.insulated !== null &&
    item.formality !== null &&
    item.condition !== null
  )
}

/** The form's starting values for a tagged item. */
export function tagFormDefaults(item: TaggedItemCard): TagFormValues {
  return {
    name: item.name,
    category: item.category,
    subcategory: item.subcategory ?? "",
    // Paired by position: register and tagging always write equal-length lists.
    colors: item.colors.map((name, index) => ({ name, hex: item.colorHex[index] ?? "" })),
    material_guess: item.materialGuess ?? "",
    materials: [...item.materials],
    warmth_level: item.warmthLevel,
    waterproof: item.waterproof,
    windproof: item.windproof,
    insulated: item.insulated,
    breathable: breathableChoice(item.breathable),
    seasons: sortSeasons(item.seasons),
    formality: item.formality,
    pattern: item.pattern ?? "",
    fit: item.fit ?? "",
    condition: item.condition,
    brand: item.brand ?? "",
    description: item.description ?? "",
    size: item.size ?? "",
    notes: item.notes,
    purchase_price: item.purchasePrice === null ? "" : String(item.purchasePrice),
    currency: item.currency,
    purchase_date: item.purchaseDate ?? "",
    location: item.location,
    decision: item.decision,
  }
}

/** The three required choices a hand-tagged item starts without, unless the card already has them. */
type ManualChoiceField = "category" | "formality" | "condition"

/**
 * Starting values for tagging a pending item by hand. They are default values
 * rather than complete form values: category, formality and condition stay
 * unset (the selects show "Choose…") until the owner picks them, so nothing is
 * guessed for them. Every other known value is prefilled; warmth starts at the
 * middle of the scale and the switches start off.
 */
export type ManualTagFormDefaults = Omit<TagFormValues, ManualChoiceField> &
  Partial<Pick<TagFormValues, ManualChoiceField>>

/** The hand-tagging form's starting values for any item card, pending ones included. */
export function manualTagFormDefaults(item: ItemCardDto): ManualTagFormDefaults {
  return {
    name: item.name ?? "",
    ...(item.category === null ? {} : { category: item.category }),
    subcategory: item.subcategory ?? "",
    colors: item.colors.map((name, index) => ({ name, hex: item.colorHex[index] ?? "" })),
    material_guess: item.materialGuess ?? "",
    materials: [...item.materials],
    warmth_level: item.warmthLevel !== null && isWarmthLevel(item.warmthLevel) ? item.warmthLevel : 3,
    waterproof: item.waterproof ?? false,
    windproof: item.windproof ?? false,
    insulated: item.insulated ?? false,
    breathable: breathableChoice(item.breathable),
    seasons: sortSeasons(item.seasons),
    ...(item.formality === null ? {} : { formality: item.formality }),
    pattern: item.pattern ?? "",
    fit: item.fit ?? "",
    ...(item.condition === null ? {} : { condition: item.condition }),
    brand: item.brand ?? "",
    description: item.description ?? "",
    size: item.size ?? "",
    notes: item.notes,
    purchase_price: item.purchasePrice === null ? "" : String(item.purchasePrice),
    currency: item.currency,
    purchase_date: item.purchaseDate ?? "",
    location: item.location,
    decision: item.decision,
  }
}

/** What the item holds now, in the form's output shape: the baseline a patch is measured against. */
export function tagFormBaseline(item: TaggedItemCard): TagFormOutput {
  return {
    name: item.name,
    category: item.category,
    subcategory: item.subcategory ?? "",
    colors: [...item.colors],
    color_hex: [...item.colorHex],
    material_guess: item.materialGuess ?? "",
    materials: [...item.materials],
    warmth_level: item.warmthLevel,
    waterproof: item.waterproof,
    windproof: item.windproof,
    insulated: item.insulated,
    breathable: item.breathable,
    seasons: [...item.seasons],
    formality: item.formality,
    pattern: item.pattern ?? "",
    fit: item.fit,
    condition: item.condition,
    brand: item.brand,
    description: item.description ?? "",
    size: item.size,
    notes: item.notes,
    purchase_price: item.purchasePrice,
    currency: item.currency,
    purchase_date: item.purchaseDate,
    location: item.location,
    decision: item.decision,
  }
}

type PatchValue = TagFormOutput[keyof TagFormOutput]

function sameValue(a: PatchValue, b: PatchValue, orderMatters: boolean): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    if (!orderMatters) {
      const left = [...a].sort()
      const right = [...b].sort()
      return left.every((value, index) => value === right[index])
    }
    return a.every((value, index) => value === b[index])
  }
  return Object.is(a, b)
}

// Seasons are a set; colours are ordered (dominant first) and so are materials.
const ORDER_INSENSITIVE = new Set<keyof TagFormOutput>(["seasons"])

/**
 * The fields whose value differs from the baseline, as an ItemPatch. colors and
 * color_hex always travel together (ItemPatchSchema requires both), because
 * one chip edit can change either list.
 */
export function diffPatch(baseline: TagFormOutput, current: TagFormOutput): ItemPatch {
  const changed: Record<string, PatchValue> = {}
  for (const key of Object.keys(current) as (keyof TagFormOutput)[]) {
    if (!sameValue(baseline[key], current[key], !ORDER_INSENSITIVE.has(key))) changed[key] = current[key]
  }
  if ("colors" in changed || "color_hex" in changed) {
    changed.colors = current.colors
    changed.color_hex = current.color_hex
  }
  // The form output already passed the same field validators; this re-check
  // narrows the type and catches a schema drift before the request is sent.
  return ItemPatchSchema.parse(changed)
}

/** True when the patch changes nothing. */
export function isEmptyPatch(patch: ItemPatch): boolean {
  return Object.keys(patch).length === 0
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** The best photo for a card: background removed, then processed, then the thumbnail. */
export function cardPhoto(item: ItemCardDto) {
  return item.images.nobg ?? item.images.processed ?? item.images.thumb
}

/** A tagged item the owner has not edited, which "Confirm all untouched" may confirm as is. */
export function isUntouched(item: ItemCardDto): boolean {
  return item.status === "tagged" && item.userEditedFields.length === 0 && hasTags(item)
}

/** A short, human name for an item in headings, alt text and announcements. */
export function itemTitle(item: ItemCardDto): string {
  return item.name ?? "Untagged item"
}
