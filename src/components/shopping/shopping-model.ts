// The shopping list's model: labels, the update schema the action and the
// service apply, the list order, and the budget arithmetic. Client- and
// server-safe (zod and the shared contracts only).

import { z } from "zod"

import { SHOPPING_STATUSES, type ItemCategory, type ShoppingStatus } from "@/lib/db/enums"
import {
  MAX_EUR,
  RELOCATION_PRIORITIES,
  type BuyTiming,
  type RelocationPriority,
  type ShoppingItemDto,
  type ThumbRef,
} from "@/lib/relocation/contracts"

export const PRIORITY_LABELS: Record<RelocationPriority, string> = {
  1: "Must have",
  2: "Should have",
  3: "Nice to have",
}

export const SHOPPING_STATUS_LABELS: Record<ShoppingStatus, string> = {
  todo: "To buy",
  bought: "Bought",
  skipped: "Skipped",
}

export const BUY_TIMING_LABELS: Record<BuyTiming, string> = {
  before_move: "Buy before the move",
  after_move: "Buy after the move",
  either: "Before or after the move",
}

/** One owned item the link picker offers. */
export type LinkableItemDto = { id: string; name: string; category: ItemCategory | null; thumb: ThumbRef | null }

/** Longest search text the link picker sends. */
export const LINK_SEARCH_MAX = 100
/** Most items the link picker lists. */
export const LINKABLE_ITEMS_LIMIT = 30
/** Reasons longer than this start collapsed. */
export const REASON_COLLAPSE_CHARS = 140

/** One change to a row: its status, the owned item it is linked to (null unlinks), or its priority. */
export const ShoppingItemUpdateSchema = z
  .strictObject({
    id: z.uuid({ error: "That entry no longer exists." }),
    status: z.enum(SHOPPING_STATUSES).optional(),
    linkedItemId: z.uuid({ error: "Choose an item from the list." }).nullable().optional(),
    priority: z.literal(RELOCATION_PRIORITIES).optional(),
  })
  .refine((input) => input.status !== undefined || input.linkedItemId !== undefined || input.priority !== undefined, {
    error: "Nothing to change.",
  })
export type ShoppingItemUpdate = z.infer<typeof ShoppingItemUpdateSchema>

const STATUS_RANK: Record<ShoppingStatus, number> = { todo: 0, bought: 1, skipped: 2 }

/** The position a relocation gap had in its analysis ("g3-…" is 3); manual entries have none. */
export function gapPosition(gapKey: string | null): number {
  const match = gapKey === null ? null : /^g(\d+)(?:-|$)/.exec(gapKey)
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY
}

/**
 * The list order: priority, then "To buy" before Bought and Skipped, then
 * oldest first. Gaps added together share a created_at, so they keep the
 * analysis's order; the type and the id settle any remaining tie.
 */
export function compareShoppingItems(
  a: Pick<ShoppingItemDto, "priority" | "status" | "createdAt" | "gapKey" | "itemType" | "id">,
  b: Pick<ShoppingItemDto, "priority" | "status" | "createdAt" | "gapKey" | "itemType" | "id">
): number {
  return (
    a.priority - b.priority ||
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    gapPosition(a.gapKey) - gapPosition(b.gapKey) ||
    a.itemType.localeCompare(b.itemType, "en") ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

export type PriorityGroup = { priority: RelocationPriority; items: ShoppingItemDto[] }

/** Rows grouped as Must have, Should have, Nice to have; empty groups are left out and the order within kept. */
export function groupByPriority(items: readonly ShoppingItemDto[]): PriorityGroup[] {
  return RELOCATION_PRIORITIES.map((priority) => ({
    priority,
    items: items.filter((item) => item.priority === priority),
  })).filter((group) => group.items.length > 0)
}

const EUR = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

export function formatEur(value: number): string {
  return `€${EUR.format(value)}`
}

/** "€80–€120", "€80", "from €80", "up to €120", or null without a price. */
export function formatEurRange(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null
  if (min !== null && max !== null) return min === max ? formatEur(min) : `${formatEur(min)}–${formatEur(max)}`
  return min !== null ? `from ${formatEur(min)}` : `up to ${formatEur(max ?? 0)}`
}

export type ToBuyTotals = {
  /** "To buy" rows. */
  count: number
  /** Their summed quantity. */
  units: number
  /** Sum of the low prices × quantity over the priced rows. */
  minEur: number
  /** Sum of the high prices × quantity over the priced rows. */
  maxEur: number
  /** "To buy" rows without any price. */
  unpriced: number
}

/**
 * What the "To buy" rows cost in all. A row with only one price counts that
 * price at both ends; a row with neither is counted as unpriced instead.
 */
export function toBuyTotals(
  items: readonly Pick<ShoppingItemDto, "status" | "quantity" | "estPriceMinEur" | "estPriceMaxEur">[]
): ToBuyTotals {
  const totals: ToBuyTotals = { count: 0, units: 0, minEur: 0, maxEur: 0, unpriced: 0 }
  for (const item of items) {
    if (item.status !== "todo") continue
    totals.count += 1
    totals.units += item.quantity
    const low = item.estPriceMinEur ?? item.estPriceMaxEur
    const high = item.estPriceMaxEur ?? item.estPriceMinEur
    if (low === null || high === null) {
      totals.unpriced += 1
      continue
    }
    totals.minEur += low * item.quantity
    totals.maxEur += high * item.quantity
  }
  // Cents can pile up float error; prices are stored with two decimals.
  totals.minEur = Math.round(totals.minEur * 100) / 100
  totals.maxEur = Math.round(totals.maxEur * 100) / 100
  return totals
}

export type BudgetVerdict =
  | { kind: "none" }
  | { kind: "within"; leftEur: number }
  | { kind: "maybe_over"; overEur: number }
  | { kind: "over"; overEur: number }

/** The totals against a budget: within it even at the high end, over it only at the high end, or over at the low end. */
export function budgetVerdict(totals: Pick<ToBuyTotals, "minEur" | "maxEur">, budgetEur: number | null): BudgetVerdict {
  if (budgetEur === null) return { kind: "none" }
  if (totals.maxEur <= budgetEur) return { kind: "within", leftEur: round2(budgetEur - totals.maxEur) }
  if (totals.minEur <= budgetEur) return { kind: "maybe_over", overEur: round2(totals.maxEur - budgetEur) }
  return { kind: "over", overEur: round2(totals.minEur - budgetEur) }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export type BudgetInput = { ok: true; value: number | null } | { ok: false; message: string }

/** The budget field: empty means no budget; otherwise whole euros from 0 to MAX_EUR. */
export function parseBudgetInput(text: string): BudgetInput {
  const trimmed = text.trim()
  if (trimmed === "") return { ok: true, value: null }
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 0 || value > MAX_EUR) {
    return { ok: false, message: `Enter whole euros from 0 to ${MAX_EUR.toLocaleString("en-US")}.` }
  }
  return { ok: true, value }
}
