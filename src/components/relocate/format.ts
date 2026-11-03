// Labels and formatting for the relocation screens (/relocate, its result and
// print pages). Plain constants and pure functions with no server imports, so
// server-rendered pages and client components share one wording. Dates are
// formatted in Europe/Berlin, the owner's zone, which also gives the server
// render and the browser the same text.

import { MONTH_NAMES } from "@/lib/climate/range"
import type { ItemDecision, PackingGroup } from "@/lib/db/enums"
import type { BuyTiming, RelocationDecision, RelocationPriority } from "@/lib/relocation/contracts"
import type { WarningKind } from "@/lib/relocation/schemas"

export { formatUsd, formatUsdEstimate, modelLabel } from "@/components/add/cost-quote"

export const RELOCATION_TIME_ZONE = "Europe/Berlin"

export const RELOCATION_DECISION_LABELS: Record<RelocationDecision, string> = {
  bring: "Bring",
  leave: "Leave",
  donate: "Donate",
  sell: "Sell",
}

/** The result's three columns: donate and sell share one. */
export const DECISION_COLUMNS = ["bring", "leave", "donate_sell"] as const
export type DecisionColumn = (typeof DECISION_COLUMNS)[number]

export const DECISION_COLUMN_LABELS: Record<DecisionColumn, string> = {
  bring: "Bring",
  leave: "Leave",
  donate_sell: "Donate or sell",
}

export function decisionColumn(decision: RelocationDecision): DecisionColumn {
  return decision === "donate" || decision === "sell" ? "donate_sell" : decision
}

/**
 * Why a packing checklist item is no longer coming, in words, or null when it
 * is: the owner's decision, or the AI's where the owner has not decided, is
 * leave, donate or sell (the same rule as "Bring items not in the
 * checklist"). The Packing tab marks such a row and leaves it out of its
 * counts; the print page lists it under "Not bringing" (D-181).
 */
export function notComingNote(
  ownerDecision: ItemDecision | undefined,
  aiDecision: RelocationDecision | undefined
): string | null {
  if (ownerDecision !== undefined && ownerDecision !== "undecided") {
    return ownerDecision === "bring" ? null : `Yours: ${RELOCATION_DECISION_LABELS[ownerDecision]} · not coming`
  }
  if (aiDecision === undefined || aiDecision === "bring") return null
  return `AI: ${RELOCATION_DECISION_LABELS[aiDecision]} · not coming`
}

/** The order a packer works through: what goes in the bags, what is worn, what follows later. */
export const PACKING_GROUP_ORDER: readonly PackingGroup[] = ["suitcase", "carry_on", "wear_on_travel_day", "ship_later"]

export const PACKING_GROUP_LABELS: Record<PackingGroup, string> = {
  suitcase: "Suitcase",
  carry_on: "Carry-on",
  wear_on_travel_day: "Wear on travel day",
  ship_later: "Ship later",
}

export const BUY_TIMING_LABELS: Record<BuyTiming, string> = {
  before_move: "Buy before the move",
  after_move: "Buy after the move",
  either: "Before or after the move",
}

export const PRIORITY_LABELS: Record<RelocationPriority, string> = {
  1: "Priority 1",
  2: "Priority 2",
  3: "Priority 3",
}

export const WARNING_KIND_LABELS: Record<WarningKind, string> = {
  uncertain_tags: "Uncertain tags",
  duplicate: "Duplicates",
  poor_condition: "Poor condition",
  other: "Other",
  over_budget: "Over budget",
  packing: "Packing",
  placeholder_climate: "Placeholder climate",
}

const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })
const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: RELOCATION_TIME_ZONE,
})
// A YYYY-MM-DD day is a calendar day, not an instant: formatted as UTC midnight.
const CALENDAR_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

/** "1 item", "1,204 items". */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${INTEGER.format(count)} ${count === 1 ? singular : pluralForm}`
}

/** "€120". */
export function formatEur(amount: number): string {
  return EUR.format(amount)
}

/** "€120–€200", or one price when both ends agree. */
export function formatEurRange(min: number, max: number): string {
  return min === max ? formatEur(min) : `${formatEur(min)}–${formatEur(max)}`
}

/** "3 Nov 2026" for an ISO timestamp, in the owner's time zone; the input itself when unreadable. */
export function formatDay(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : DAY.format(date)
}

/** "3 Nov 2026" for a YYYY-MM-DD calendar day. */
export function formatCalendarDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? value : CALENDAR_DAY.format(date)
}

function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month)
}

/**
 * The months a run covers, in range order: "Nov", "Nov–Feb", or "Nov–Oct,
 * all year" for twelve. monthsInRange always gives consecutive months, so the
 * first and the last name the span.
 */
export function formatMonths(months: readonly number[]): string {
  const first = months[0]
  const last = months[months.length - 1]
  if (first === undefined || last === undefined) return "No months"
  if (months.length >= 12) return `${monthName(first)}–${monthName(last)}, all year`
  if (months.length === 1) return monthName(first)
  return `${monthName(first)}–${monthName(last)}`
}

/** "12 waiting for tags, 1 archived and 3 not confirmed", or null when nothing was left out. */
export function describeExcluded(excluded: { pending: number; archived: number; unconfirmed: number }): string | null {
  const parts = [
    excluded.pending > 0 ? `${INTEGER.format(excluded.pending)} waiting for tags` : null,
    excluded.archived > 0 ? `${INTEGER.format(excluded.archived)} archived` : null,
    excluded.unconfirmed > 0 ? `${INTEGER.format(excluded.unconfirmed)} not confirmed` : null,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0] ?? null
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}
