// The outfit builder's form state and checks, kept apart from the component
// so they are easy to test. The browser runs the same checks the server runs
// (OutfitInputSchema, then validateOutfit); the server checks again with the
// items as they are when it writes.

import { z } from "zod"

import { OUTFIT_SLOTS, type ItemCategory, type ItemStatus, type OutfitSlot } from "@/lib/db/enums"
import {
  OUTFIT_ISSUE_CODES,
  OutfitInputSchema,
  validateOutfit,
  type OutfitCheckItem,
  type OutfitDetailDto,
  type OutfitEntry,
  type OutfitInputValues,
  type OutfitIssue,
  type OutfitItemDto,
  type SlotCandidateDto,
} from "@/lib/outfits/contracts"
import type { AppErrorPayload } from "@/lib/result"

import { parseCelsius } from "./format"

export type OutfitFormValues = {
  name: string
  occasion: string
  /** As typed; a comma counts as the decimal point. */
  weatherMin: string
  weatherMax: string
  rainOk: boolean
  /** "" for no rating, or "1" to "5". */
  rating: string
  notes: string
  entries: OutfitEntry[]
}

export type FieldName = "name" | "occasion" | "weatherMin" | "weatherMax" | "rating" | "notes"
export type FieldErrors = Partial<Record<FieldName, string>>
/** Messages per slot, plus ones about the outfit as a whole. */
export type SlotMessages = Partial<Record<OutfitSlot | "outfit", string[]>>

/** What the builder shows about an item it lists. */
export type ItemInfo = {
  id: string
  name: string
  category: ItemCategory | null
  /** null when the server did not say; only "archived" matters to the checks. */
  status: ItemStatus | null
  thumbUrl: string | null
}

export const FIELD_ORDER: readonly FieldName[] = ["name", "occasion", "weatherMin", "weatherMax", "rating", "notes"]

function celsiusText(value: number | null): string {
  return value === null ? "" : String(value)
}

/** The form's starting values: empty for a new outfit, otherwise the saved outfit's. */
export function valuesFromOutfit(outfit: OutfitDetailDto | null): OutfitFormValues {
  if (outfit === null) {
    return {
      name: "",
      occasion: "",
      weatherMin: "",
      weatherMax: "",
      rainOk: false,
      rating: "",
      notes: "",
      entries: [],
    }
  }
  return {
    name: outfit.name,
    occasion: outfit.occasion ?? "",
    weatherMin: celsiusText(outfit.weatherMinC),
    weatherMax: celsiusText(outfit.weatherMaxC),
    rainOk: outfit.rainOk,
    rating: outfit.rating === null ? "" : String(outfit.rating),
    notes: outfit.notes,
    entries: outfit.items.map((item) => ({ slot: item.slot, itemId: item.itemId })),
  }
}

/** The form as the saveOutfit action takes it; the schema does the checking. */
export function toOutfitInput(values: OutfitFormValues): OutfitInputValues {
  return {
    name: values.name,
    occasion: values.occasion,
    weatherMinC: parseCelsius(values.weatherMin),
    weatherMaxC: parseCelsius(values.weatherMax),
    rainOk: values.rainOk,
    rating: values.rating === "" ? null : Number(values.rating),
    notes: values.notes,
    items: values.entries,
  }
}

const SCHEMA_FIELDS: Readonly<Record<string, FieldName>> = {
  name: "name",
  occasion: "occasion",
  weatherMinC: "weatherMin",
  weatherMaxC: "weatherMax",
  rating: "rating",
  notes: "notes",
}

/** One message per field from zod issues (from the browser's check, or a server answer's `details.issues`). */
export function fieldErrorsFrom(issues: readonly { path: string; message: string }[]): FieldErrors {
  const errors: FieldErrors = {}
  for (const issue of issues) {
    const field = SCHEMA_FIELDS[issue.path.split(".")[0] ?? ""]
    if (field === undefined || errors[field] !== undefined) continue
    errors[field] = field === "rating" ? "Choose a rating from 1 to 5, or none." : issue.message
  }
  return errors
}

/** The outfit check's issues by slot; issues without a slot are about the outfit as a whole. */
export function slotMessagesFrom(issues: readonly OutfitIssue[]): SlotMessages {
  const messages: SlotMessages = {}
  for (const issue of issues) {
    const key = issue.slot ?? "outfit"
    const list = messages[key] ?? []
    if (!list.includes(issue.message)) list.push(issue.message)
    messages[key] = list
  }
  return messages
}

/**
 * The items as validateOutfit sees them. A slot candidate is never archived
 * (the server lists none), so an item without a status counts as confirmed.
 */
export function checkItems(info: ReadonlyMap<string, ItemInfo>): Map<string, OutfitCheckItem> {
  return new Map(
    [...info.values()].map((item) => [item.id, { id: item.id, category: item.category, status: item.status ?? "confirmed" }])
  )
}

/**
 * What the builder knows about each item: the slot candidates (current names
 * and photos) and the outfit's own items, which may include an archived one
 * no slot lists any more.
 */
export function itemInfoFrom(
  candidates: Readonly<Record<OutfitSlot, readonly SlotCandidateDto[]>>,
  current: readonly OutfitItemDto[]
): Map<string, ItemInfo> {
  const info = new Map<string, ItemInfo>()
  for (const item of current) {
    info.set(item.itemId, {
      id: item.itemId,
      name: item.name,
      category: item.category,
      status: item.status,
      thumbUrl: item.thumbUrl,
    })
  }
  for (const slot of OUTFIT_SLOTS) {
    for (const candidate of candidates[slot]) {
      const known = info.get(candidate.id)
      info.set(candidate.id, {
        id: candidate.id,
        name: candidate.name,
        category: candidate.category,
        // A candidate is not archived; keep a status the outfit's read gave.
        status: known?.status === "archived" ? null : (known?.status ?? null),
        thumbUrl: candidate.thumbUrl,
      })
    }
  }
  return info
}

export type FormCheck =
  | { ok: true; input: OutfitInputValues }
  | { ok: false; fields: FieldErrors; slots: SlotMessages }

/** The checks the server runs, in the browser: the form's fields, then the slot rules. */
export function checkForm(values: OutfitFormValues, info: ReadonlyMap<string, ItemInfo>): FormCheck {
  const input = toOutfitInput(values)
  const parsed = OutfitInputSchema.safeParse(input)
  const fields = parsed.success
    ? {}
    : fieldErrorsFrom(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })))
  const outfit = validateOutfit(values.entries, checkItems(info))
  const slots = outfit.ok ? {} : slotMessagesFrom(outfit.issues)
  if (Object.keys(fields).length === 0 && Object.keys(slots).length === 0) return { ok: true, input }
  return { ok: false, fields, slots }
}

const OutfitIssuesSchema = z.array(
  z.object({
    code: z.enum(OUTFIT_ISSUE_CODES),
    slot: z.enum(OUTFIT_SLOTS).optional(),
    itemId: z.string().optional(),
    message: z.string(),
  })
)
const FieldIssuesSchema = z.array(z.object({ path: z.string(), message: z.string() }))

/** What a VALIDATION answer from saveOutfit says about the form, or null for any other error. */
export function serverErrorsFrom(error: AppErrorPayload): { fields: FieldErrors; slots: SlotMessages } | null {
  if (error.code !== "VALIDATION") return null
  const outfitIssues = OutfitIssuesSchema.safeParse(error.details?.outfitIssues)
  if (outfitIssues.success) return { fields: {}, slots: slotMessagesFrom(outfitIssues.data) }
  const fieldIssues = FieldIssuesSchema.safeParse(error.details?.issues)
  if (fieldIssues.success) {
    const fields = fieldErrorsFrom(fieldIssues.data)
    if (Object.keys(fields).length > 0) return { fields, slots: {} }
  }
  return null
}

/** Puts `item` in `slot`: it replaces the slot's item, except accessories, which are added. */
export function withItem(entries: readonly OutfitEntry[], slot: OutfitSlot, itemId: string): OutfitEntry[] {
  if (entries.some((entry) => entry.itemId === itemId)) return [...entries]
  if (slot === "accessory") return [...entries, { slot, itemId }]
  const index = entries.findIndex((entry) => entry.slot === slot)
  if (index === -1) return [...entries, { slot, itemId }]
  return entries.map((entry, at) => (at === index ? { slot, itemId } : entry))
}
