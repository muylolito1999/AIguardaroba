import { describe, expect, it } from "vitest"

import { BOLOGNA } from "@/lib/climate/bologna"
import { HAMBURG } from "@/lib/climate/hamburg"
import { ClimateMonthSchema } from "@/lib/climate/types"

import {
  checkDraft,
  checkMonth,
  CLIMATE_FIELD_SPECS,
  CLIMATE_FIELDS,
  ClimateProfileUpdateSchema,
  draftChanged,
  monthName,
  monthToDraft,
  parseCell,
  profileToDraft,
  type ClimateField,
  type MonthDraft,
} from "./climate-model"

const ID = "00000000-0000-4000-8000-000000000001"

function at<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`no entry ${index}`)
  return value
}

/** Hamburg's January with some cells retyped. */
function january(cells: Partial<Record<ClimateField, string>>): MonthDraft {
  const draft = monthToDraft(at(HAMBURG.months, 0))
  for (const field of CLIMATE_FIELDS) {
    const text = cells[field]
    if (text !== undefined) draft.cells[field] = { text, bad: false }
  }
  return draft
}

describe("parseCell", () => {
  it("reads empty text as unknown and numbers within the bounds", () => {
    expect(parseCell("tmax", { text: "  ", bad: false })).toEqual({ ok: true, value: null })
    expect(parseCell("tmin", { text: "-0.5", bad: false })).toEqual({ ok: true, value: -0.5 })
    expect(parseCell("precip_days", { text: "31", bad: false })).toEqual({ ok: true, value: 31 })
  })

  it("rejects text the browser could not read, and values outside the bounds", () => {
    expect(parseCell("tmax", { text: "", bad: true })).toEqual({
      ok: false,
      message: "Max °C: enter a number, or leave it empty.",
    })
    expect(parseCell("precip_days", { text: "32", bad: false })).toEqual({
      ok: false,
      message: "Rain days must be between 0 and 31.",
    })
    expect(parseCell("tmin", { text: "-61", bad: false })).toEqual({
      ok: false,
      message: "Min °C must be between −60 and 60.",
    })
  })
})

describe("checkMonth", () => {
  it("passes a row the schema accepts, unknown values as null", () => {
    const check = checkMonth(january({ tmean: "", sunshine_h: "" }))
    expect(check.errors).toEqual([])
    expect(check.value).toMatchObject({ month: 1, tmax: 4.2, tmin: -0.5, tmean: null, sunshine_h: null })
    expect(ClimateMonthSchema.safeParse(check.value).success).toBe(true)
  })

  it("names the temperatures that are out of order", () => {
    const check = checkMonth(january({ tmin: "6", tmean: "" }))
    expect(check.value).toBeNull()
    expect(check.errors).toEqual(["Temperatures must go Min ≤ Mean ≤ Max."])
    expect(check.invalidFields).toEqual(["tmax", "tmin"])
    // The schema agrees.
    expect(ClimateMonthSchema.safeParse({ ...HAMBURG.months[0], tmin: 6, tmean: null }).success).toBe(false)
  })

  it("lists every unreadable cell before checking the order", () => {
    const check = checkMonth(january({ tmax: "abc", precip_mm: "-1" }))
    expect(check.invalidFields).toEqual(["tmax", "precip_mm"])
    expect(check.errors).toHaveLength(2)
  })

  it("uses the schema's bounds", () => {
    for (const field of CLIMATE_FIELDS) {
      const { min, max } = CLIMATE_FIELD_SPECS[field]
      const base = { ...HAMBURG.months[5], tmax: 60, tmean: null, tmin: -60 }
      expect(ClimateMonthSchema.safeParse({ ...base, [field]: max }).success).toBe(true)
      expect(ClimateMonthSchema.safeParse({ ...base, [field]: min }).success).toBe(true)
      expect(ClimateMonthSchema.safeParse({ ...base, [field]: max + 1 }).success).toBe(false)
      expect(ClimateMonthSchema.safeParse({ ...base, [field]: min - 1 }).success).toBe(false)
    }
  })
})

describe("checkDraft and the update schema", () => {
  it("turns an unchanged profile back into the same months, which the update schema accepts", () => {
    for (const profile of [HAMBURG, BOLOGNA]) {
      const check = checkDraft(profileToDraft(profile))
      expect(check.update?.months).toEqual(profile.months)
      expect(ClimateProfileUpdateSchema.safeParse({ id: ID, ...check.update }).success).toBe(true)
    }
  })

  it("holds no update while a row has an error", () => {
    const draft = profileToDraft(BOLOGNA)
    at(draft.months, 3).cells.precip_days = { text: "40", bad: false }
    const check = checkDraft(draft)
    expect(check.update).toBeNull()
    expect(check.months[3]?.errors).toEqual(["Rain days must be between 0 and 31."])
  })

  it("rejects notes over 2,000 characters", () => {
    const update = { id: ID, months: BOLOGNA.months, windNotes: "", notes: "x".repeat(2001) }
    expect(ClimateProfileUpdateSchema.safeParse(update).success).toBe(false)
  })
})

describe("draftChanged", () => {
  it("ignores spelling of the same number and surrounding spaces in the notes", () => {
    const draft = profileToDraft(HAMBURG)
    at(draft.months, 0).cells.tmax = { text: "4.20", bad: false }
    draft.notes = `${HAMBURG.notes}  `
    expect(draftChanged(draft, HAMBURG)).toBe(false)
  })

  it("sees a new value, a cleared value, an unreadable cell and edited notes", () => {
    const changedValue = profileToDraft(HAMBURG)
    at(changedValue.months, 0).cells.tmax = { text: "4.3", bad: false }
    expect(draftChanged(changedValue, HAMBURG)).toBe(true)

    const cleared = profileToDraft(HAMBURG)
    at(cleared.months, 11).cells.sunshine_h = { text: "", bad: false }
    expect(draftChanged(cleared, HAMBURG)).toBe(true)

    const unreadable = profileToDraft(BOLOGNA)
    at(unreadable.months, 1).cells.tmin = { text: "", bad: true }
    expect(draftChanged(unreadable, BOLOGNA)).toBe(true)

    const notes = profileToDraft(BOLOGNA)
    notes.windNotes = "Foggy"
    expect(draftChanged(notes, BOLOGNA)).toBe(true)
  })
})

describe("monthName", () => {
  it("spells the month out", () => {
    expect(monthName(1)).toBe("January")
    expect(monthName(12)).toBe("December")
  })
})
