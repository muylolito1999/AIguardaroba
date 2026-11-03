// The climate profile editor's model: the update schema the action and the
// service apply, and the pure conversions between a profile's months and the
// text the 12-row table edits. Client- and server-safe (zod and the climate
// types only), so the form and the service validate with the same rules.

import { z } from "zod"

import { ClimateMonthsSchema, type ClimateMonth } from "@/lib/climate/types"

/** Longest wind note or note the editor accepts. */
export const CLIMATE_NOTES_MAX = 2000

/** What Save sends: the 12 months in order, plus both notes. */
export const ClimateProfileUpdateSchema = z.strictObject({
  id: z.uuid({ error: "That climate profile does not exist." }),
  months: ClimateMonthsSchema,
  windNotes: z
    .string()
    .trim()
    .max(CLIMATE_NOTES_MAX, { error: `Keep the wind notes under ${CLIMATE_NOTES_MAX} characters.` }),
  notes: z.string().trim().max(CLIMATE_NOTES_MAX, { error: `Keep the notes under ${CLIMATE_NOTES_MAX} characters.` }),
})
export type ClimateProfileUpdate = z.infer<typeof ClimateProfileUpdateSchema>

/** The six numbers of a month, in table order. */
export const CLIMATE_FIELDS = ["tmax", "tmin", "tmean", "precip_mm", "precip_days", "sunshine_h"] as const
export type ClimateField = (typeof CLIMATE_FIELDS)[number]

type FieldSpec = {
  /** Column heading. */
  label: string
  /** Used in input labels and messages ("January max °C"). */
  short: string
  min: number
  max: number
}

// The bounds are ClimateMonthSchema's, so a row this model accepts always
// passes the schema (climate-model.test.ts checks it).
export const CLIMATE_FIELD_SPECS: Record<ClimateField, FieldSpec> = {
  tmax: { label: "Max °C", short: "max °C", min: -60, max: 60 },
  tmin: { label: "Min °C", short: "min °C", min: -60, max: 60 },
  tmean: { label: "Mean °C", short: "mean °C", min: -60, max: 60 },
  precip_mm: { label: "Rain mm", short: "rain mm", min: 0, max: 2000 },
  precip_days: { label: "Rain days", short: "rain days", min: 0, max: 31 },
  sunshine_h: { label: "Sun h", short: "sun hours", min: 0, max: 744 },
}

/**
 * One table cell. `bad` is the browser's badInput: a number input reports an
 * empty value for text it cannot read ("-" while a negative is being typed,
 * "1e"), which must not count as "unknown".
 */
export type CellDraft = { text: string; bad: boolean }

export type MonthDraft = {
  month: number
  cells: Record<ClimateField, CellDraft>
  /** The month's own note, kept as saved: the table does not edit it. */
  notes: string | null
}

export type ProfileDraft = {
  months: MonthDraft[]
  windNotes: string
  notes: string
}

export type MonthCheck = {
  /** The parsed month, or null when the row has an error. */
  value: ClimateMonth | null
  /** Plain messages for the row, in column order. */
  errors: string[]
  /** Fields to mark invalid. */
  invalidFields: ClimateField[]
}

function cellFromValue(value: number | null): CellDraft {
  return { text: value === null ? "" : String(value), bad: false }
}

export function monthToDraft(month: ClimateMonth): MonthDraft {
  return {
    month: month.month,
    cells: {
      tmax: cellFromValue(month.tmax),
      tmin: cellFromValue(month.tmin),
      tmean: cellFromValue(month.tmean),
      precip_mm: cellFromValue(month.precip_mm),
      precip_days: cellFromValue(month.precip_days),
      sunshine_h: cellFromValue(month.sunshine_h),
    },
    notes: month.notes,
  }
}

export function profileToDraft(profile: { months: readonly ClimateMonth[]; windNotes: string; notes: string }): ProfileDraft {
  return { months: profile.months.map(monthToDraft), windNotes: profile.windNotes, notes: profile.notes }
}

// Full names: the table's row headers and every input label use them.
const MONTH_LONG_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

export function monthName(month: number): string {
  return MONTH_LONG_NAMES[month - 1] ?? `Month ${month}`
}

type CellParse = { ok: true; value: number | null } | { ok: false; message: string }

/** Empty means unknown (null); anything else must be a number inside the field's bounds. */
export function parseCell(field: ClimateField, cell: CellDraft): CellParse {
  const spec = CLIMATE_FIELD_SPECS[field]
  const text = cell.text.trim()
  if (cell.bad) return { ok: false, message: `${capitalize(spec.short)}: enter a number, or leave it empty.` }
  if (text === "") return { ok: true, value: null }
  const value = Number(text)
  if (!Number.isFinite(value)) return { ok: false, message: `${capitalize(spec.short)}: enter a number, or leave it empty.` }
  if (value < spec.min || value > spec.max) {
    return { ok: false, message: `${capitalize(spec.short)} must be between ${formatBound(spec.min)} and ${formatBound(spec.max)}.` }
  }
  return { ok: true, value }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A typographic minus, as the rest of the climate text uses. */
function formatBound(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : String(value)
}

/** Checks one row: every cell, then tmin ≤ tmean ≤ tmax over the known values. */
export function checkMonth(draft: MonthDraft): MonthCheck {
  const errors: string[] = []
  const invalidFields: ClimateField[] = []
  const values: Partial<Record<ClimateField, number | null>> = {}
  for (const field of CLIMATE_FIELDS) {
    const parsed = parseCell(field, draft.cells[field])
    if (parsed.ok) {
      values[field] = parsed.value
    } else {
      errors.push(parsed.message)
      invalidFields.push(field)
    }
  }
  if (errors.length > 0) return { value: null, errors, invalidFields }

  const month: ClimateMonth = {
    month: draft.month,
    tmax: values.tmax ?? null,
    tmin: values.tmin ?? null,
    tmean: values.tmean ?? null,
    precip_mm: values.precip_mm ?? null,
    precip_days: values.precip_days ?? null,
    sunshine_h: values.sunshine_h ?? null,
    notes: draft.notes,
  }
  const { tmin, tmean, tmax } = month
  const ordered =
    (tmin === null || tmax === null || tmin <= tmax) &&
    (tmin === null || tmean === null || tmin <= tmean) &&
    (tmean === null || tmax === null || tmean <= tmax)
  if (!ordered) {
    const temperatures: ClimateField[] = ["tmax", "tmin", "tmean"]
    return {
      value: null,
      errors: ["Temperatures must go Min ≤ Mean ≤ Max."],
      invalidFields: temperatures.filter((field) => values[field] !== null),
    }
  }
  return { value: month, errors: [], invalidFields: [] }
}

export type DraftCheck = {
  /** One check per month, in order. */
  months: MonthCheck[]
  /** The update to send, or null while any row has an error. */
  update: Omit<ClimateProfileUpdate, "id"> | null
}

export function checkDraft(draft: ProfileDraft): DraftCheck {
  const months = draft.months.map(checkMonth)
  const parsed = months.map((check) => check.value)
  const complete = parsed.every((value): value is ClimateMonth => value !== null)
  return {
    months,
    update: complete ? { months: parsed, windNotes: draft.windNotes.trim(), notes: draft.notes.trim() } : null,
  }
}

/**
 * True when Save would change something: a cell whose value differs from the
 * saved one (an unreadable or out-of-range cell always counts), or edited
 * notes. "4.20" for a saved 4.2 is not a change.
 */
export function draftChanged(
  draft: ProfileDraft,
  saved: { months: readonly ClimateMonth[]; windNotes: string; notes: string },
): boolean {
  if (draft.windNotes.trim() !== saved.windNotes.trim() || draft.notes.trim() !== saved.notes.trim()) return true
  if (draft.months.length !== saved.months.length) return true
  return draft.months.some((month, index) => {
    const savedMonth = saved.months[index]
    if (savedMonth === undefined || month.notes !== savedMonth.notes) return true
    return CLIMATE_FIELDS.some((field) => {
      const parsed = parseCell(field, month.cells[field])
      return !parsed.ok || parsed.value !== savedMonth[field]
    })
  })
}
