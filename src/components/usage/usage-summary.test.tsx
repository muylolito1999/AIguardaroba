// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { UsageSummary } from "@/server/services/usage"

import { UsageSummaryView } from "./usage-summary"

afterEach(cleanup)

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  const totals = {
    calls: 2,
    inputTokens: 1_100,
    outputTokens: 250,
    cacheReadTokens: 600,
    cacheWriteTokens: 300,
    costUsd: 3.23,
  }
  return {
    monthStartsAt: "2026-11-01T00:00:00.000Z",
    month: {
      spentUsd: 3.23,
      budgetUsd: 20,
      pendingBatchUsd: 0.03,
      remainingUsd: 16.74,
      resetsAt: "2026-12-01T00:00:00.000Z",
      totals,
    },
    allTime: { spentUsd: 6.25, creditUsd: 100, remainingCreditUsd: 93.75 },
    cache: { readTokens: 600, writeTokens: 300, hitRatio: 0.3 },
    pendingBatches: { count: 2, estimatedUsd: 0.03 },
    byPurpose: [{ key: "tagging", ...totals, allTimeCostUsd: 6.25, allTimeCalls: 5 }],
    byModel: [{ key: "claude-haiku-5-5", ...totals, allTimeCostUsd: 6.25, allTimeCalls: 5 }],
    recentCalls: [
      {
        id: "call-1",
        createdAt: "2026-11-03T08:05:00.000Z",
        purpose: "tagging",
        model: "claude-haiku-5-5",
        status: "invalid_output",
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 600,
        cacheWriteTokens: 0,
        costUsd: 0.0006,
        latencyMs: 1_850,
        isBatch: false,
        errorCode: "AI_INVALID_OUTPUT",
      },
    ],
    blob: { serverPuts: 8, clientUploads: 5, estimatedAdvancedOps: 13, limit: 2_000 },
    ...overrides,
  }
}

describe("UsageSummaryView", () => {
  it("shows the month against the budget with its reset date and reserved batches", () => {
    render(<UsageSummaryView summary={summary()} />)

    const month = screen.getByRole("region", { name: "This month" })
    expect(within(month).getByText("$3.23 of $20.00")).toBeTruthy()
    expect(within(month).getByText(/resets on 1 December 2026 \(UTC\)/)).toBeTruthy()
    expect(within(month).getByText("$0.03 reserved for 2 pending batches")).toBeTruthy()
    const meter = within(month).getByRole("progressbar")
    expect(meter.getAttribute("aria-valuetext")).toBe("$3.23 of $20.00")
  })

  it("lists spend by purpose and recent calls in scrollable tables", () => {
    render(<UsageSummaryView summary={summary()} />)

    const purpose = screen.getByRole("region", { name: "By purpose" })
    expect(purpose.getAttribute("tabindex")).toBe("0")
    const row = within(purpose).getByRole("row", { name: /Tagging/ })
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "2",
      "1,100",
      "250",
      "600",
      "300",
      "$3.23",
      "$6.25",
    ])
    expect(screen.getByText("Invalid output")).toBeTruthy()
    expect(screen.getByText("$0.0006")).toBeTruthy()
    expect(screen.getByText("1.9 s")).toBeTruthy()
    expect(screen.getByText("30%")).toBeTruthy()
  })

  it("says in words when a limit is reached", () => {
    render(
      <UsageSummaryView
        summary={summary({
          month: { ...summary().month, spentUsd: 20.5, remainingUsd: 0 },
          blob: { serverPuts: 1_000, clientUploads: 650, estimatedAdvancedOps: 1_650, limit: 2_000 },
        })}
      />
    )

    expect(within(screen.getByRole("region", { name: "This month" })).getByText("Limit reached")).toBeTruthy()
    expect(within(screen.getByRole("region", { name: "Blob uploads this month" })).getByText("83% used")).toBeTruthy()
  })
})
