import { describe, expect, it } from "vitest"

import type { OutfitSlot } from "@/lib/db/enums"
import type { OutfitDetailDto, OutfitItemDto, SlotCandidateDto } from "@/lib/outfits/contracts"

import {
  checkForm,
  itemInfoFrom,
  orderCandidates,
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
const RUNNING = "66666666-6666-4666-8666-666666666666"
const HOODIE = "77777777-7777-4777-8777-777777777777"
const SOCKS = "88888888-8888-4888-8888-888888888888"

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
  mid_layer: [],
  base_layer: [],
  top: [],
  bottom: [],
  socks: [],
  shoes: [],
  hat: [],
  gloves: [],
  scarf: [],
  accessory: [],
}

const CANDIDATES: Record<OutfitSlot, SlotCandidateDto[]> = {
  ...EMPTY,
  mid_layer: [candidate(TOP, "top", "Grey sweater"), candidate(HOODIE, "top", "Hoodie")],
  top: [candidate(TOP, "top", "Grey sweater"), candidate(HOODIE, "top", "Hoodie"), candidate(DRESS, "dress", "Black dress")],
  bottom: [candidate(BOTTOM, "bottom", "Jeans")],
  socks: [candidate(SOCKS, "socks", "Wool socks")],
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

  it("takes a top as the mid layer over another top, and socks, but one item only once (D-253)", () => {
    const info = itemInfoFrom(CANDIDATES, [])
    const layered = [
      { slot: "top" as const, itemId: TOP },
      { slot: "mid_layer" as const, itemId: HOODIE },
      { slot: "bottom" as const, itemId: BOTTOM },
      { slot: "socks" as const, itemId: SOCKS },
    ]
    expect(checkForm(values({ entries: layered }), info)).toMatchObject({ ok: true })

    // The top's item is not added to the mid layer as well.
    const top = [{ slot: "top" as const, itemId: TOP }]
    expect(withItem(top, "mid_layer", TOP)).toEqual(top)
    const twice = checkForm(
      values({
        entries: [
          { slot: "top", itemId: TOP },
          { slot: "mid_layer", itemId: TOP },
          { slot: "bottom", itemId: BOTTOM },
        ],
      }),
      info
    )
    expect(twice).toEqual({ ok: false, fields: {}, slots: { mid_layer: ["An item can be in an outfit only once."] } })
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
        collection: "clothing",
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

  it("flags an item the outfit holds that moved to running gear, before sending (D-250)", () => {
    const running: OutfitItemDto = {
      itemId: RUNNING,
      slot: "bottom",
      name: "Running tights",
      category: "bottom",
      thumbUrl: null,
      status: "confirmed",
      collection: "running",
      wearCount: 4,
      exists: true,
    }
    const entries = [
      { slot: "top" as const, itemId: TOP },
      { slot: "bottom" as const, itemId: RUNNING },
    ]
    expect(itemInfoFrom(CANDIDATES, [running]).get(RUNNING)?.collection).toBe("running")
    expect(checkForm(values({ entries }), itemInfoFrom(CANDIDATES, [running]))).toEqual({
      ok: false,
      fields: {},
      slots: { bottom: ["This item is running gear, which outfits leave out."] },
    })

    // A candidate list read at another moment may still hold the item: the
    // collection the outfit's read gave wins over the candidates' default.
    const listed = { ...CANDIDATES, bottom: [...CANDIDATES.bottom, candidate(RUNNING, "bottom", "Running tights")] }
    const info = itemInfoFrom(listed, [running])
    expect(info.get(RUNNING)).toMatchObject({ collection: "running", name: "Running tights" })
    expect(checkForm(values({ entries }), info)).toMatchObject({
      ok: false,
      slots: { bottom: ["This item is running gear, which outfits leave out."] },
    })
    // A candidate the outfit does not hold counts as clothing.
    expect(info.get(BOTTOM)?.collection).toBe("clothing")
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
        message: "This item is running gear, which outfits leave out.",
        details: {
          outfitIssues: [
            { code: "not_clothing", slot: "bottom", itemId: RUNNING, message: "This item is running gear, which outfits leave out." },
          ],
        },
      })
    ).toEqual({ fields: {}, slots: { bottom: ["This item is running gear, which outfits leave out."] } })
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

  describe("orderCandidates", () => {
    // As the server lists them: by name. Names decide the role here (no subcategory), except where given.
    const tee = candidate("a-tee", "top", "Breton striped tee")
    const cardigan = candidate("b-cardigan", "top", "Camel cardigan")
    const blazer = { ...candidate("c-blazer", "top", "Charcoal favourite"), subcategory: "blazer" }
    const hoodie = candidate("d-hoodie", "top", "Navy cotton hoodie")
    const turtleneck = candidate("e-turtleneck", "top", "Oatmeal turtleneck")
    const shirt = candidate("f-shirt", "top", "White oxford shirt")
    const dress = candidate("g-dress", "dress", "Wrap dress")
    const tops = [tee, cardigan, blazer, hoodie, turtleneck, shirt]
    const names = (list: readonly SlotCandidateDto[]) => list.map((entry) => entry.name)

    it("lists the layer tops first for the mid layer, then the unplaced, then tees and shirts", () => {
      expect(names(orderCandidates("mid_layer", tops))).toEqual([
        "Camel cardigan",
        "Charcoal favourite",
        "Navy cotton hoodie",
        "Oatmeal turtleneck",
        "Breton striped tee",
        "White oxford shirt",
      ])
    })

    it("lists tees and shirts first for the top, then the unplaced and dresses, then the layer tops", () => {
      expect(names(orderCandidates("top", [dress, ...tops]))).toEqual([
        "Breton striped tee",
        "White oxford shirt",
        "Wrap dress",
        "Oatmeal turtleneck",
        "Camel cardigan",
        "Charcoal favourite",
        "Navy cotton hoodie",
      ])
    })

    it("keeps the given order within a role, whatever it is", () => {
      const reversed = [...tops].reverse()
      expect(names(orderCandidates("mid_layer", reversed))).toEqual([
        "Navy cotton hoodie",
        "Charcoal favourite",
        "Camel cardigan",
        "Oatmeal turtleneck",
        "White oxford shirt",
        "Breton striped tee",
      ])
      // Already in order: unchanged.
      const ordered = orderCandidates("top", [dress, ...tops])
      expect(orderCandidates("top", ordered)).toEqual(ordered)
    })

    it("leaves every other slot's order alone, and never drops or changes an item", () => {
      const bottoms = [candidate("z", "bottom", "Wool trousers"), candidate("y", "bottom", "Jeans")]
      expect(orderCandidates("bottom", bottoms)).toEqual(bottoms)
      expect(orderCandidates("outerwear", [])).toEqual([])
      const socks = [candidate("s2", "socks", "Wool socks"), candidate("s1", "socks", "Ankle socks")]
      expect(orderCandidates("socks", socks)).toEqual(socks)

      const given = [dress, ...tops]
      const copy = [...given]
      const byId = (list: readonly SlotCandidateDto[]) => [...list].sort((a, b) => a.id.localeCompare(b.id))
      const ordered = orderCandidates("mid_layer", given)
      expect(ordered).not.toBe(given)
      // The input is not reordered in place, and the output holds the same items, unchanged.
      expect(given).toEqual(copy)
      expect(byId(ordered)).toEqual(byId(given))
      expect(orderCandidates("bottom", given)).not.toBe(given)
      // Not a top at all: last in the mid layer.
      expect(ordered.at(-1)).toBe(dress)
    })
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
