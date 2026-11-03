import { describe, expect, it } from "vitest"

import type { OutfitSlot } from "@/lib/db/enums"
import type { OutfitDetailDto, SlotCandidateDto } from "@/lib/outfits/contracts"

import {
  checkForm,
  itemInfoFrom,
  serverErrorsFrom,
  toOutfitInput,
  valuesFromOutfit,
  withItem,
  type OutfitFormValues,
} from "./outfit-form-model"

const TOP = "11111111-1111-4111-8111-111111111111"
const DRESS = "22222222-2222-4222-8222-222222222222"
const BOTTOM = "33333333-3333-4333-8333-333333333333"
const BELT = "44444444-4444-4444-8444-444444444444"
const ARCHIVED = "55555555-5555-4555-8555-555555555555"

function candidate(id: string, category: SlotCandidateDto["category"], name: string): SlotCandidateDto {
  return {
    id,
    name,
    category,
    subcategory: null,
    colors: [],
    warmthLevel: 2,
    waterproof: false,
    thumbUrl: null,
    wearCount: 0,
    lastWornAt: null,
    location: "hamburg",
  }
}

const EMPTY: Record<OutfitSlot, SlotCandidateDto[]> = {
  outerwear: [],
  base_layer: [],
  top: [],
  bottom: [],
  shoes: [],
  hat: [],
  gloves: [],
  scarf: [],
  accessory: [],
}

const CANDIDATES: Record<OutfitSlot, SlotCandidateDto[]> = {
  ...EMPTY,
  top: [candidate(TOP, "top", "Grey sweater"), candidate(DRESS, "dress", "Black dress")],
  bottom: [candidate(BOTTOM, "bottom", "Jeans")],
  accessory: [candidate(BELT, "accessory", "Belt")],
}

function values(overrides: Partial<OutfitFormValues> = {}): OutfitFormValues {
  return { ...valuesFromOutfit(null), name: "Weekend", ...overrides }
}

describe("outfit form model", () => {
  it("turns the form into the action's input, reading a comma as the decimal point", () => {
    expect(
      toOutfitInput(
        values({ weatherMin: " 4,5 ", weatherMax: "", rating: "3", entries: [{ slot: "top", itemId: TOP }] })
      )
    ).toEqual({
      name: "Weekend",
      occasion: "",
      weatherMinC: 4.5,
      weatherMaxC: null,
      rainOk: false,
      rating: 3,
      notes: "",
      items: [{ slot: "top", itemId: TOP }],
    })
    expect(toOutfitInput(values({ weatherMin: "warm" })).weatherMinC).toBeNaN()
  })

  it("starts from a saved outfit's values", () => {
    const outfit = {
      name: "Office",
      occasion: null,
      weatherMinC: -2.5,
      weatherMaxC: 8,
      rainOk: true,
      rating: 5,
      notes: "Good",
      items: [{ itemId: TOP, slot: "top" }],
    } as unknown as OutfitDetailDto
    expect(valuesFromOutfit(outfit)).toEqual({
      name: "Office",
      occasion: "",
      weatherMin: "-2.5",
      weatherMax: "8",
      rainOk: true,
      rating: "5",
      notes: "Good",
      entries: [{ slot: "top", itemId: TOP }],
    })
  })

  it("puts each problem next to its slot or field", () => {
    const info = itemInfoFrom(CANDIDATES, [])
    const empty = checkForm(values({ name: "", weatherMin: "9", weatherMax: "3" }), info)
    expect(empty).toEqual({
      ok: false,
      fields: { name: "Give the outfit a name.", weatherMax: "The highest temperature must not be below the lowest." },
      slots: { top: ["Choose a top or a dress."], bottom: ["Choose a bottom, or a dress as the top."] },
    })

    const dress = checkForm(values({ entries: [{ slot: "top", itemId: DRESS }] }), info)
    expect(dress.ok).toBe(true)

    const wrong = checkForm(
      values({
        entries: [
          { slot: "top", itemId: TOP },
          { slot: "bottom", itemId: BELT },
        ],
      }),
      info
    )
    expect(wrong).toMatchObject({ ok: false, slots: { bottom: expect.arrayContaining(["This item does not belong in the bottom slot."]) } })
  })

  it("knows an archived item the outfit holds, which no slot lists", () => {
    const info = itemInfoFrom(CANDIDATES, [
      {
        itemId: ARCHIVED,
        slot: "bottom",
        name: "Old chinos",
        category: "bottom",
        thumbUrl: null,
        status: "archived",
        wearCount: 2,
        exists: true,
      },
    ])
    const check = checkForm(
      values({
        entries: [
          { slot: "top", itemId: TOP },
          { slot: "bottom", itemId: ARCHIVED },
        ],
      }),
      info
    )
    expect(check).toMatchObject({ ok: false, slots: { bottom: ["This item is archived."] } })
  })

  it("reads the server's slot and field issues, and nothing else", () => {
    expect(
      serverErrorsFrom({
        code: "VALIDATION",
        message: "This item is archived.",
        details: { outfitIssues: [{ code: "archived_item", slot: "bottom", itemId: BOTTOM, message: "This item is archived." }] },
      })
    ).toEqual({ fields: {}, slots: { bottom: ["This item is archived."] } })
    expect(
      serverErrorsFrom({
        code: "VALIDATION",
        message: "Some fields are missing or invalid.",
        details: { issues: [{ path: "rating", message: "Too big" }] },
      })
    ).toEqual({ fields: { rating: "Choose a rating from 1 to 5, or none." }, slots: {} })
    expect(serverErrorsFrom({ code: "NOT_FOUND", message: "That outfit no longer exists." })).toBeNull()
    expect(serverErrorsFrom({ code: "VALIDATION", message: "Odd", details: { issues: [{ path: "items.0" }] } })).toBeNull()
  })

  it("replaces a slot's item, but adds accessories", () => {
    const start = [{ slot: "top" as const, itemId: TOP }]
    expect(withItem(start, "top", DRESS)).toEqual([{ slot: "top", itemId: DRESS }])
    expect(withItem(start, "bottom", BOTTOM)).toEqual([...start, { slot: "bottom", itemId: BOTTOM }])
    const one = withItem(start, "accessory", BELT)
    expect(withItem(one, "accessory", ARCHIVED)).toHaveLength(3)
    // An item already in the outfit is not added twice.
    expect(withItem(one, "accessory", BELT)).toEqual(one)
  })
})
