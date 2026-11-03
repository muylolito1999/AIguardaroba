import { describe, expect, it } from "vitest"

import { HAND_TAG_DEFAULT_FIELDS, HAND_TAG_DEFAULTS, isHandTagDefault, ItemPatchSchema } from "@/lib/items/contracts"

import {
  cardPhoto,
  diffPatch,
  hasTags,
  isAtManualStart,
  isEmptyPatch,
  isUntouched,
  lowConfidenceFields,
  MANUAL_START_VALUES,
  manualDefaultFields,
  manualTagFormDefaults,
  sortSeasons,
  tagFormBaseline,
  tagFormDefaults,
  tagFormErrorMap,
  tagFormSchema,
  uncheckedDefaults,
  type TagFormValues,
  type TaggedItemCard,
} from "./tag-form-model"
import { pendingCard, taggedCard } from "./test-fixtures"

function tagged(overrides: Parameters<typeof taggedCard>[0] = {}): TaggedItemCard {
  const card = taggedCard(overrides)
  if (!hasTags(card)) throw new Error("fixture is not tagged")
  return card
}

function parse(values: TagFormValues) {
  return tagFormSchema.parse(values, { error: tagFormErrorMap })
}

describe("lowConfidenceFields", () => {
  it("lists fields below 0.6 that the owner has not edited", () => {
    const hints = lowConfidenceFields(taggedCard())
    expect([...hints.entries()]).toEqual([
      ["materials", 0.45],
      ["brand", 0.2],
    ])
  })

  it("drops a hint once any field it covers is edited", () => {
    expect(lowConfidenceFields(taggedCard({ userEditedFields: ["material_guess", "brand"] })).size).toBe(0)
    const colors = lowConfidenceFields(
      taggedCard({ aiConfidence: { colors: 0.3 }, userEditedFields: ["color_hex"] })
    )
    expect(colors.size).toBe(0)
  })

  it("ignores missing scores, unknown keys and items without confidence", () => {
    expect(lowConfidenceFields(taggedCard({ aiConfidence: { mystery: 0.1, category: 0.6 } })).size).toBe(0)
    expect(lowConfidenceFields(pendingCard()).size).toBe(0)
  })
})

describe("hasTags and isUntouched", () => {
  it("accepts complete tagged items only", () => {
    expect(hasTags(taggedCard())).toBe(true)
    expect(hasTags(pendingCard())).toBe(false)
    expect(hasTags(taggedCard({ warmthLevel: 9 }))).toBe(false)
    expect(hasTags(taggedCard({ status: "archived" }))).toBe(false)
  })

  it("treats a tagged item without edits as untouched", () => {
    expect(isUntouched(taggedCard())).toBe(true)
    expect(isUntouched(taggedCard({ userEditedFields: ["name"] }))).toBe(false)
    expect(isUntouched(taggedCard({ status: "confirmed" }))).toBe(false)
    expect(isUntouched(pendingCard())).toBe(false)
  })
})

describe("cardPhoto", () => {
  it("prefers the background-removed photo, then the processed one, then the thumbnail", () => {
    const nobg = { url: "https://blob.example/nobg.webp", width: 1, height: 1 }
    const card = taggedCard()
    expect(cardPhoto({ ...card, images: { ...card.images, nobg } })).toBe(nobg)
    expect(cardPhoto(card)).toBe(card.images.processed)
    expect(cardPhoto({ ...card, images: { ...card.images, processed: null } })).toBe(card.images.thumb)
    expect(cardPhoto({ ...card, images: { thumb: null, processed: null, nobg: null } })).toBeNull()
  })
})

describe("tagFormSchema", () => {
  it("round-trips an item: its defaults parse to its baseline", () => {
    const item = tagged({
      breathable: true,
      brand: "Barbour",
      purchasePrice: 249.9,
      purchaseDate: "2025-10-04",
      size: "M",
      seasons: ["autumn", "winter"],
    })
    expect(parse(tagFormDefaults(item))).toEqual({ ...tagFormBaseline(item), seasons: ["winter", "autumn"] })
  })

  it("turns blank optional text into null and reads a comma as the decimal point", () => {
    const values = {
      ...tagFormDefaults(tagged()),
      fit: "  ",
      brand: "",
      size: "",
      purchase_price: " 49,90 ",
      purchase_date: "",
      currency: " eur ",
      breathable: "no" as const,
    }
    expect(parse(values)).toMatchObject({
      fit: null,
      brand: null,
      size: null,
      purchase_price: 49.9,
      purchase_date: null,
      currency: "EUR",
      breathable: false,
    })
  })

  it("splits colour chips into the two parallel patch lists", () => {
    const values = {
      ...tagFormDefaults(tagged()),
      colors: [
        { name: "Olive", hex: "#556b2f" },
        { name: "cream", hex: "#fffdd0" },
      ],
    }
    expect(parse(values)).toMatchObject({ colors: ["Olive", "cream"], color_hex: ["#556b2f", "#fffdd0"] })
  })

  it.each([
    ["an empty name", { name: "  " }, "name", "Required."],
    ["a long description", { description: "x".repeat(201) }, "description", "Use at most 200 characters."],
    ["no colours", { colors: [] }, "colors", "Add at least one colour."],
    [
      "a repeated colour",
      { colors: [{ name: "Navy", hex: "#000080" }, { name: "navy", hex: "#000081" }] },
      "colors",
      "Each colour can appear once.",
    ],
    ["no seasons", { seasons: [] }, "seasons", "Pick at least one season."],
    ["a word as price", { purchase_price: "cheap" }, "purchase_price", "Enter an amount such as 49.90."],
    ["a negative price", { purchase_price: "-1" }, "purchase_price", "Use 0 or more."],
    ["a bad currency", { currency: "EURO" }, "currency", "Use a three-letter currency code such as EUR."],
  ])("rejects %s with a plain message", (_label, change, path, message) => {
    const result = tagFormSchema.safeParse({ ...tagFormDefaults(tagged()), ...change }, { error: tagFormErrorMap })
    expect(result.success).toBe(false)
    const issue = result.error?.issues.find((candidate) => candidate.path[0] === path)
    expect(issue?.message).toBe(message)
  })
})

describe("diffPatch", () => {
  it("is empty when nothing changed", () => {
    const item = tagged()
    const patch = diffPatch(tagFormBaseline(item), parse(tagFormDefaults(item)))
    expect(isEmptyPatch(patch)).toBe(true)
  })

  it("keeps only the changed fields", () => {
    const item = tagged()
    const values = { ...tagFormDefaults(item), name: "Navy overcoat", warmth_level: 5 as const, notes: "Dry clean" }
    expect(diffPatch(tagFormBaseline(item), parse(values))).toEqual({
      name: "Navy overcoat",
      warmth_level: 5,
      notes: "Dry clean",
    })
  })

  it("sends colours and swatches together when either changes", () => {
    const item = tagged()
    const values = {
      ...tagFormDefaults(item),
      colors: [
        { name: "navy", hex: "#000080" },
        { name: "black", hex: "#111111" },
      ],
    }
    const patch = diffPatch(tagFormBaseline(item), parse(values))
    expect(patch).toEqual({ colors: ["navy", "black"], color_hex: ["#000080", "#111111"] })
    expect(ItemPatchSchema.safeParse(patch).success).toBe(true)
  })

  it("ignores the order of seasons but not of materials", () => {
    const item = tagged({ seasons: ["autumn", "winter"], materials: ["wool", "cashmere"] })
    const sameSeasons = { ...tagFormDefaults(item), seasons: sortSeasons(["autumn", "winter"]) }
    expect(isEmptyPatch(diffPatch(tagFormBaseline(item), parse(sameSeasons)))).toBe(true)
    const swapped = { ...tagFormDefaults(item), materials: ["cashmere", "wool"] }
    expect(diffPatch(tagFormBaseline(item), parse(swapped))).toEqual({ materials: ["cashmere", "wool"] })
  })

  it("records clearing an optional field as null", () => {
    const item = tagged({ brand: "Barbour", purchasePrice: 120 })
    const values = { ...tagFormDefaults(item), brand: "", purchase_price: "" }
    expect(diffPatch(tagFormBaseline(item), parse(values))).toEqual({ brand: null, purchase_price: null })
  })
})

describe("manualTagFormDefaults", () => {
  it("prefills what a pending item knows and leaves the required choices unset", () => {
    const item = pendingCard({
      notes: "From the flea market",
      size: "L",
      purchasePrice: 12.5,
      currency: "CHF",
      purchaseDate: "2025-03-01",
      location: "hamburg",
      decision: "bring",
    })
    const defaults = manualTagFormDefaults(item)

    expect(defaults).toEqual({
      name: "",
      subcategory: "",
      colors: [],
      material_guess: "",
      materials: [],
      warmth_level: 3,
      waterproof: false,
      windproof: false,
      insulated: false,
      breathable: "unknown",
      seasons: [],
      pattern: "",
      fit: "",
      brand: "",
      description: "",
      size: "L",
      notes: "From the flea market",
      purchase_price: "12.5",
      currency: "CHF",
      purchase_date: "2025-03-01",
      location: "hamburg",
      decision: "bring",
    })
    expect("category" in defaults).toBe(false)
    expect("formality" in defaults).toBe(false)
    expect("condition" in defaults).toBe(false)
  })

  it("keeps known tags, warmth, switches and breathable, and sorts the seasons", () => {
    const defaults = manualTagFormDefaults(
      pendingCard({
        name: "Rain shell",
        colors: ["olive", "black"],
        colorHex: ["#556b2f", "#111111"],
        seasons: ["autumn", "spring"],
        warmthLevel: 2,
        waterproof: true,
        windproof: null,
        insulated: false,
        breathable: true,
      })
    )

    expect(defaults).toMatchObject({
      name: "Rain shell",
      colors: [
        { name: "olive", hex: "#556b2f" },
        { name: "black", hex: "#111111" },
      ],
      seasons: ["spring", "autumn"],
      warmth_level: 2,
      waterproof: true,
      windproof: false,
      insulated: false,
      breathable: "yes",
    })
  })

  it("starts warmth at 3 when the stored level is not on the scale", () => {
    expect(manualTagFormDefaults(pendingCard({ warmthLevel: 9 })).warmth_level).toBe(3)
    expect(manualTagFormDefaults(pendingCard({ breathable: false })).breathable).toBe("no")
  })

  it("fails the form schema until the required fields are filled in", () => {
    const result = tagFormSchema.safeParse(manualTagFormDefaults(pendingCard()), { error: tagFormErrorMap })
    expect(result.success).toBe(false)
    const paths = new Set(result.error?.issues.map((issue) => issue.path[0]))
    expect([...paths].sort()).toEqual(["category", "colors", "condition", "formality", "name", "seasons"])
  })
})

describe("the hand-tagging form's own starting values (D-232)", () => {
  /** A pending card's form, completed with the required choices and parsed to what Save sends. */
  function completed(item = pendingCard()) {
    return parse({
      ...manualTagFormDefaults(item),
      name: "Grey scarf",
      category: "scarf",
      colors: [{ name: "grey", hex: "#808080" }],
      seasons: ["winter"],
      formality: "casual",
      condition: "good",
    })
  }

  it("start where HAND_TAG_DEFAULTS say, as the controls and as the patch hold them", () => {
    expect(manualTagFormDefaults(pendingCard())).toMatchObject(MANUAL_START_VALUES)
    const output = completed()
    expect(HAND_TAG_DEFAULT_FIELDS.every((field) => isHandTagDefault(field, output[field]))).toBe(true)
    expect(output).toMatchObject(HAND_TAG_DEFAULTS)
  })

  it("are the form's own only where the item has no value and the owner set none", () => {
    expect(manualDefaultFields(pendingCard())).toEqual([...HAND_TAG_DEFAULT_FIELDS])
    expect(
      manualDefaultFields(
        pendingCard({ warmthLevel: 2, waterproof: false, windproof: true, insulated: null, breathable: false })
      )
    ).toEqual(["insulated"])
    // A breathable "Unknown" the owner saved earlier is theirs; an off-scale warmth is replaced by the start.
    expect(manualDefaultFields(pendingCard({ userEditedFields: ["breathable"], warmthLevel: 9 }))).toEqual([
      "warmth_level",
      "waterproof",
      "windproof",
      "insulated",
    ])
  })

  it("tells a control at its start from one that moved", () => {
    expect(isAtManualStart("warmth_level", 3)).toBe(true)
    expect(isAtManualStart("warmth_level", 4)).toBe(false)
    expect(isAtManualStart("insulated", false)).toBe(true)
    expect(isAtManualStart("insulated", true)).toBe(false)
    expect(isAtManualStart("breathable", "unknown")).toBe(true)
    expect(isAtManualStart("breathable", "no")).toBe(false)
  })

  it("are sent as left alone while they hold the start and the owner did not keep them", () => {
    const fields = manualDefaultFields(pendingCard())
    const atStart = completed()
    expect(uncheckedDefaults(fields, atStart, new Set())).toEqual([...HAND_TAG_DEFAULT_FIELDS])
    expect(uncheckedDefaults(fields, atStart, new Set(["warmth_level", "breathable"]))).toEqual([
      "waterproof",
      "windproof",
      "insulated",
    ])
    // A changed value is a choice; the value decides, so one set back to the start is left alone again.
    const changed = { ...atStart, warmth_level: 4 as const, waterproof: true, breathable: false }
    expect(uncheckedDefaults(fields, changed, new Set())).toEqual(["windproof", "insulated"])
    // Only fields that started at the form's own value can be sent.
    expect(uncheckedDefaults(["insulated"], atStart, new Set())).toEqual(["insulated"])
  })
})
