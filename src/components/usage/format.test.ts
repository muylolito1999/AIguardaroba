import { describe, expect, it } from "vitest"

import { formatCallTime, formatCount, formatDay, formatLatency, formatRatio, shareOf } from "./format"

describe("usage formatting", () => {
  it("formats counts, ratios and latency", () => {
    expect(formatCount(1_234_567)).toBe("1,234,567")
    expect(formatRatio(0.304)).toBe("30%")
    expect(formatRatio(null)).toBe("n/a")
    expect(formatLatency(null)).toBe("–")
    expect(formatLatency(850)).toBe("850 ms")
    expect(formatLatency(12_345)).toBe("12.3 s")
  })

  it("shows dates and times in UTC, the budget's clock", () => {
    expect(formatDay("2026-12-01T00:00:00.000Z")).toBe("1 December 2026")
    expect(formatCallTime("2026-11-03T23:05:00.000Z")).toBe("3 Nov, 23:05")
  })

  it("clamps a share of a limit to 0..1", () => {
    expect(shareOf(5, 20)).toBe(0.25)
    expect(shareOf(25, 20)).toBe(1)
    expect(shareOf(-1, 20)).toBe(0)
    expect(shareOf(1, 0)).toBe(1)
  })
})
