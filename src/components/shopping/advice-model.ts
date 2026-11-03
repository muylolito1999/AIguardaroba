// "What to buy next" (D-040): the shapes the shopping advice service answers
// with, the schema the browser checks the route's answer against, and the
// wording helpers of the panel. Client- and server-safe: zod and plain values
// only. The service (src/server/services/shopping-advice.ts) builds these
// objects; the prompt and the estimate stay on the server (D-156).

import { z } from "zod"

import { ITEM_CATEGORIES, SHOPPING_STATUSES, type ItemCategory } from "@/lib/db/enums"

export const ADVICE_SOURCES = ["list", "gap"] as const
export type AdviceSource = (typeof ADVICE_SOURCES)[number]

/**
 * The categories the outfit count is made of (combinatorics.ts): a candidate
 * of any other category (a base layer, a hat, a bag) always unlocks 0, which
 * the panel says instead of showing zeros.
 */
export const COUNTED_CATEGORIES: readonly ItemCategory[] = ["top", "bottom", "dress", "shoes", "outerwear"]

/** One month the counts refer to, with the outfits the wardrobe makes in it now. */
export const AdviceScenarioSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  tmeanC: z.number(),
  rainy: z.boolean(),
  outfitsNow: z.number().int().min(0),
})
export type AdviceScenarioDto = z.infer<typeof AdviceScenarioSchema>

/** A purchase the advice can rank: an open shopping list row or a relocation gap not on the list yet. */
export const AdviceCandidateSchema = z.object({
  /** The shopping list row's id (source list) or the relocation gap's key (source gap). */
  key: z.string().min(1),
  source: z.enum(ADVICE_SOURCES),
  itemType: z.string(),
  category: z.enum(ITEM_CATEGORIES).nullable(),
  /** False when the candidate's category is not part of the outfit count, so it unlocks 0 by definition. */
  counted: z.boolean(),
  priority: z.number().int().min(1).max(3).nullable(),
  quantity: z.number().int().min(1),
  estPriceMinEur: z.number().nullable(),
  estPriceMaxEur: z.number().nullable(),
  /** The relocation run the row or gap came from; null for a row added by hand. */
  relocationAnalysisId: z.string().nullable(),
  /** New outfits per scenario key (unlockCount), computed in TypeScript, not by Claude. */
  unlocks: z.record(z.string(), z.number().int().min(0)),
})
export type AdviceCandidateDto = z.infer<typeof AdviceCandidateSchema>

/**
 * The purchase budget the advice works with: the latest complete relocation
 * run's purchase budget minus the lowest estimate of every row bought under
 * that plan (its own rows, and rows added by hand since it finished; min
 * price, else max price, times quantity), rounded down to whole euros and
 * never below 0. Bought rows without any price are counted as 0 and reported
 * in unpricedBought.
 */
export const AdviceBudgetSchema = z.object({
  purchaseBudgetEur: z.number().int().min(0).nullable(),
  boughtMinimumEur: z.number().min(0),
  unpricedBought: z.number().int().min(0),
  remainingEur: z.number().int().min(0).nullable(),
  /** The relocation run the budget comes from. */
  relocationAnalysisId: z.string().nullable(),
})
export type AdviceBudgetDto = z.infer<typeof AdviceBudgetSchema>

export const AdviceRecommendationSchema = z.object({
  rank: z.number().int().min(1),
  why: z.string(),
  budgetEur: z.number().int().min(0),
  /** The candidate as the run listed it, its unlock counts included. */
  candidate: AdviceCandidateSchema,
  /** Now: a gap is on the shopping list, or a list row still exists. */
  onList: z.boolean(),
  /** Now: the list row's status (for a gap on the list, that row's); null when there is no row. */
  rowStatus: z.enum(SHOPPING_STATUSES).nullable(),
})
export type AdviceRecommendationDto = z.infer<typeof AdviceRecommendationSchema>

export const StoredAdviceSchema = z.object({
  analysisId: z.string(),
  completedAt: z.string(),
  model: z.string(),
  costUsd: z.number().min(0),
  remainingBudgetEur: z.number().int().min(0).nullable(),
  scenarios: z.array(AdviceScenarioSchema),
  recommendations: z.array(AdviceRecommendationSchema),
  /** The candidates, their counts, the budget, the model or the prompt changed since this run. */
  stale: z.boolean(),
})
export type StoredAdviceDto = z.infer<typeof StoredAdviceSchema>

export const ShoppingAdviceReadySchema = z.object({
  enabled: z.literal(true),
  /** Why the advice cannot run now (no candidates, no budget left, climate data missing); null when it can. */
  blocker: z.string().nullable(),
  /** The climate the counts use; null when its profile is missing. */
  climate: z.object({ city: z.string(), country: z.string() }).nullable(),
  scenarios: z.array(AdviceScenarioSchema),
  candidates: z.array(AdviceCandidateSchema),
  /** Candidates left out of the prompt beyond its limit (least important first). */
  omittedCandidates: z.number().int().min(0),
  budget: AdviceBudgetSchema,
  model: z.string(),
  /** Estimated USD of one run; null while blocked. */
  estimateUsd: z.number().min(0).nullable(),
  /** The newest finished advice, or null. */
  latest: StoredAdviceSchema.nullable(),
})
export type ShoppingAdviceReadyDto = z.infer<typeof ShoppingAdviceReadySchema>

/** With FEATURE_SHOPPING_AI off the server reads nothing else and the section is not rendered. */
export type ShoppingAdviceStateDto = { enabled: false } | ShoppingAdviceReadyDto

/** POST /api/shopping/advice: "reused" when the latest advice was made from the same inputs (no call, no cost). */
export const ShoppingAdviceRunSchema = z.object({
  outcome: z.enum(["ran", "reused"]),
  state: ShoppingAdviceReadySchema,
})
export type ShoppingAdviceRunDto = z.infer<typeof ShoppingAdviceRunSchema>

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const EUR = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
const ONE_DECIMAL = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

export function formatAdviceEur(value: number): string {
  return `€${EUR.format(value)}`
}

/** "January, 2.1 °C, rainy". */
export function scenarioCaption(scenario: Pick<AdviceScenarioDto, "label" | "tmeanC" | "rainy">): string {
  return `${scenario.label}, ${ONE_DECIMAL.format(scenario.tmeanC)} °C${scenario.rainy ? ", rainy" : ""}`
}

/**
 * An outfit count worded as the estimate it is: "about 4 outfits", "about 1
 * new outfit", "likely none". The counts follow fixed rules, but over tags
 * and over attributes guessed from a purchase's description (D-191, D-225),
 * so a number shown as exact would claim more than it knows (D-231).
 */
export function estimatedOutfits(count: number, kind: "total" | "new"): string {
  if (count === 0) return "likely none"
  const noun = count === 1 ? "outfit" : "outfits"
  const words = kind === "new" ? ["about", WHOLE.format(count), "new", noun] : ["about", WHOLE.format(count), noun]
  return words.join(" ")
}

/** The section's one note on what the outfit counts are and are not (D-231). */
export const OUTFIT_COUNT_NOTE =
  "The outfit counts are estimates from tags and descriptions: combinations that suit the month, not a measure of what a purchase is worth."

/** "€120–€200 each", "€80", or null when unpriced; per item, as the list shows prices. */
export function candidatePrice(candidate: Pick<AdviceCandidateDto, "estPriceMinEur" | "estPriceMaxEur" | "quantity">): string | null {
  const low = candidate.estPriceMinEur ?? candidate.estPriceMaxEur
  const high = candidate.estPriceMaxEur ?? candidate.estPriceMinEur
  if (low === null || high === null) return null
  const range = low === high ? formatAdviceEur(low) : `${formatAdviceEur(low)}–${formatAdviceEur(high)}`
  return candidate.quantity > 1 ? `${candidate.quantity} × ${range} each` : range
}

/** The list's own budget box, which only compares prices and is never sent (D-210). */
const LIST_BUDGET_NOTE = `The "Budget for new purchases" box on this page only compares the list's prices and is not used here.`

/**
 * Why the remaining budget is an estimate (D-219, D-231): the app records
 * neither what a purchase cost nor when it was made, so a bought row counts
 * at its lowest estimated price, and belongs to the plan it came from or, for
 * a row added by hand, to the plan by the day it was added. An older plan's
 * gap added to the list later stays that plan's, so the note names only rows
 * added by hand (D-233).
 */
export const REMAINING_BUDGET_NOTE =
  "It is an estimate: each bought item counts at its lowest estimated price, and only if it came from that plan or you added it by hand since."

/** " 1 bought item has no price and is not counted.", or "" when every bought item has a price. */
function unpricedNote(count: number): string {
  if (count === 0) return ""
  if (count === 1) return " 1 bought item has no price and is not counted."
  return ` ${count} bought items have no price and are not counted.`
}

/** The budget the ranking works with, as the figure it is: "Estimated remaining budget: €495"; null with no budget. */
export function remainingBudgetHeadline(budget: AdviceBudgetDto): string | null {
  if (budget.purchaseBudgetEur === null || budget.remainingEur === null) return null
  return `Estimated remaining budget: ${formatAdviceEur(budget.remainingEur)}`
}

/**
 * The budget line above the button. It names where the budget comes from, the
 * latest relocation plan, because the list's own budget box on the same page
 * is not used for the ranking.
 */
export function budgetSummary(budget: AdviceBudgetDto): string {
  if (budget.purchaseBudgetEur === null || budget.remainingEur === null) {
    const source =
      budget.relocationAnalysisId === null
        ? "No relocation plan sets a purchase budget"
        : "Your latest relocation plan sets no purchase budget"
    return `${source}, so only what the climate makes necessary is recommended. ${LIST_BUDGET_NOTE}`
  }
  const plan = `Purchase budget ${formatAdviceEur(budget.purchaseBudgetEur)} from your latest relocation plan`
  const unpriced = unpricedNote(budget.unpricedBought)
  if (budget.boughtMinimumEur > 0) {
    return `${plan}, minus at least ${formatAdviceEur(budget.boughtMinimumEur)} for items bought under it.${unpriced}`
  }
  // Bought rows that all lack a price are not "nothing bought": say only that they are not counted.
  if (budget.unpricedBought > 0) return `${plan}.${unpriced}`
  return `${plan}; nothing is bought under it yet.`
}
