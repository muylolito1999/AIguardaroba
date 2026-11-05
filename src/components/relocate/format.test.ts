import { describe, expect, it } from "vitest"

import {
  decisionColumn,
  describeExcluded,
  formatCalendarDay,
  formatDay,
  formatEurRange,
  formatMonths,
  plural,
} from "./format"

describe("relocation formatting", () => {
  it("names a range of months by its ends, and twelve as the whole year", () => {
    expect(formatMonths([11])).toBe("Nov")
    expect(formatMonths([11, 12, 1, 2])).toBe("Nov–Feb")
    expect(formatMonths([11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe("Nov–Oct, all year")
    expect(formatMonths([])).toBe("No months")
  })

  it("lists what the snapshot left out, with and and commas", () => {
    expect(describeExcluded({ pending: 0, archived: 0, unconfirmed: 0, running: 0 })).toBeNull()
    expect(describeExcluded({ pending: 1, archived: 0, unconfirmed: 0, running: 0 })).toBe("1 waiting for tags")
    expect(describeExcluded({ pending: 12, archived: 0, unconfirmed: 3, running: 0 })).toBe(
      "12 waiting for tags and 3 not confirmed"
    )
    expect(describeExcluded({ pending: 2, archived: 1, unconfirmed: 1_200, running: 0 })).toBe(
      "2 waiting for tags, 1 archived and 1,200 not confirmed"
    )
  })

  it("names running gear among what was left out (D-249)", () => {
    expect(describeExcluded({ pending: 0, archived: 0, unconfirmed: 0, running: 1 })).toBe("1 running gear item")
    expect(describeExcluded({ pending: 0, archived: 2, unconfirmed: 0, running: 1_500 })).toBe(
      "2 archived and 1,500 running gear items"
    )
    expect(describeExcluded({ pending: 12, archived: 1, unconfirmed: 3, running: 4 })).toBe(
      "12 waiting for tags, 1 archived, 3 not confirmed and 4 running gear items"
    )
  })

  it("formats prices, counts and days", () => {
    expect(formatEurRange(120, 200)).toBe("€120–€200")
    expect(formatEurRange(90, 90)).toBe("€90")
    expect(plural(1, "item", "items")).toBe("1 item")
    expect(plural(1_204, "item", "items")).toBe("1,204 items")
    // 23:30 UTC on 2 Nov is already 3 Nov in Berlin.
    expect(formatDay("2026-11-02T23:30:00.000Z")).toBe("3 Nov 2026")
    expect(formatCalendarDay("2027-11-02")).toBe("2 Nov 2027")
  })

  it("puts donate and sell in one column", () => {
    expect(decisionColumn("bring")).toBe("bring")
    expect(decisionColumn("leave")).toBe("leave")
    expect(decisionColumn("donate")).toBe("donate_sell")
    expect(decisionColumn("sell")).toBe("donate_sell")
  })
})
