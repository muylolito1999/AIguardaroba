// Pure helpers shared by the /add page (server) and the add flow (client).
// The client cannot import @/lib/ai/cost itself, because that module reads the
// pricing table in @/lib/ai/models, which the boundary test keeps out of
// client bundles. The page sends the per-item rates from taggingCostRates()
// instead, and the client extends them to any count.

import type { TaggingCostRates } from "@/lib/ai/cost"

/** Standard (one call per item) and Message Batches rates for the tagging model. */
export type TaggingCostQuote = {
  standard: TaggingCostRates
  batch: TaggingCostRates
  /** The synchronous dry run that starts every batch (estimateTaggingDryRunUsd). */
  dryRunUsd: number
}

/**
 * What a page needs to offer tagging: the model, the per-item rates and the
 * month's budget. Read on the server by getTaggingSetup for the add and
 * review pages.
 */
export type TaggingSetup = {
  model: {
    /** Model id, such as claude-haiku-5-5. */
    id: string
    /** Display name, such as Haiku 5.5. */
    label: string
  }
  costQuote: TaggingCostQuote
  budget: {
    budgetUsd: number
    remainingUsd: number
    /** ISO timestamp of the next UTC month start. */
    resetsAt: string
  }
}

/** Same formula as estimateTaggingCostUsd: the first call writes the prompt cache, the rest read it. */
export function estimateForCount(rates: TaggingCostRates, count: number): number {
  if (count <= 0) return 0
  return rates.firstItemUsd + (count - 1) * rates.nextItemUsd
}

/**
 * Same formula as estimateTaggingBatchRunUsd, which startTaggingBatch checks
 * against the budget: one item tagged at once as the dry run, the rest in the
 * batch.
 */
export function estimateBatchRun(quote: TaggingCostQuote, count: number): number {
  if (count <= 0) return 0
  return quote.dryRunUsd + estimateForCount(quote.batch, count - 1)
}

const USD_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** "$19.87"; negative amounts show as $0.00, since the budget never goes below zero for the user. */
export function formatUsd(usd: number): string {
  return USD_CENTS.format(Math.max(0, usd))
}

/**
 * An estimate for display after "≈": "$0.06", or "< $0.01" for tiny amounts.
 * Tagging one item on Haiku costs a fraction of a cent, and "$0.00" would read
 * as free.
 */
export function formatUsdEstimate(usd: number): string {
  if (usd <= 0) return formatUsd(0)
  if (usd < 0.01) return "< $0.01"
  return formatUsd(usd)
}

/** "claude-haiku-5-5" becomes "Haiku 5.5"; ids in another shape are shown as they are. */
export function modelLabel(modelId: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(modelId)
  if (match === null) return modelId
  const [, family = "", major = "", minor] = match
  const version = minor === undefined ? major : `${major}.${minor}`
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`
}

const RESET_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })

/**
 * "1 December" for the budget reset. The budget month is a UTC month, so the
 * date is formatted in UTC, which also gives the same text on the server and
 * in the browser.
 */
export function formatResetDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : RESET_DATE.format(date)
}
