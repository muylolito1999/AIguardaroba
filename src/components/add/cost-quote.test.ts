import { describe, expect, it } from "vitest"

import {
  estimateTaggingBatchRunUsd,
  estimateTaggingCostUsd,
  estimateTaggingDryRunUsd,
  taggingCostRates,
} from "@/lib/ai/cost"

import {
  estimateBatchRun,
  estimateForCount,
  formatResetDate,
  formatUsd,
  formatUsdEstimate,
  modelLabel,
  type TaggingCostQuote,
} from "./cost-quote"

describe("estimateForCount", () => {
  it("matches the server's estimate for any count", () => {
    for (const batch of [false, true]) {
      const rates = taggingCostRates("claude-haiku-5-5", { batch })
      for (const count of [0, 1, 2, 21, 300]) {
        expect(estimateForCount(rates, count)).toBeCloseTo(
          estimateTaggingCostUsd({ count, model: "claude-haiku-5-5", batch }),
          12,
        )
      }
    }
  })
})

describe("estimateBatchRun", () => {
  it("matches what startTaggingBatch checks against the budget", () => {
    for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5"] as const) {
      const quote: TaggingCostQuote = {
        standard: taggingCostRates(model),
        batch: taggingCostRates(model, { batch: true }),
        dryRunUsd: estimateTaggingDryRunUsd(model),
      }
      for (const count of [1, 21, 300]) {
        expect(estimateBatchRun(quote, count)).toBeCloseTo(estimateTaggingBatchRunUsd({ count, model }).totalUsd, 12)
      }
    }
  })

  it("prices the dry run above a standard first item, because it writes the 1-hour cache", () => {
    const standard = taggingCostRates("claude-haiku-5-5")
    expect(estimateTaggingDryRunUsd("claude-haiku-5-5")).toBeGreaterThan(standard.firstItemUsd)
  })
})

describe("formatting", () => {
  it("shows tiny estimates as under a cent instead of free", () => {
    expect(formatUsdEstimate(0)).toBe("$0.00")
    expect(formatUsdEstimate(0.0006)).toBe("< $0.01")
    expect(formatUsdEstimate(0.056)).toBe("$0.06")
    expect(formatUsd(19.874)).toBe("$19.87")
    expect(formatUsd(-0.5)).toBe("$0.00")
  })

  it("names models the way the spec does", () => {
    expect(modelLabel("claude-haiku-5-5")).toBe("Haiku 5.5")
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5")
    expect(modelLabel("claude-opus-5")).toBe("Opus 5")
    expect(modelLabel("custom-model")).toBe("custom-model")
  })

  it("formats the reset date in UTC", () => {
    expect(formatResetDate("2026-12-01T00:00:00.000Z")).toBe("1 December")
  })
})
