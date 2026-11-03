import { describe, expect, it } from "vitest"

import {
  budgetVerdict,
  compareShoppingItems,
  formatEurRange,
  gapPosition,
  groupByPriority,
  parseBudgetInput,
  ShoppingItemUpdateSchema,
  toBuyTotals,
} from "./shopping-model"
import { shoppingItem } from "./test-fixtures"

describe("toBuyTotals", () => {
  it("sums the To buy rows times their quantity and leaves the others out", () => {
    const totals = toBuyTotals([
      shoppingItem({ quantity: 2, estPriceMinEur: 40, estPriceMaxEur: 70 }),
      shoppingItem({ estPriceMinEur: 150, estPriceMaxEur: 250 }),
      shoppingItem({ status: "bought", estPriceMinEur: 999, estPriceMaxEur: 999 }),
      shoppingItem({ status: "skipped", estPriceMinEur: 999, estPriceMaxEur: 999 }),
    ])

    expect(totals).toEqual({ count: 2, units: 3, minEur: 230, maxEur: 390, unpriced: 0 })
  })

  it("counts a single price at both ends and a row without any price as unpriced", () => {
    const totals = toBuyTotals([
      shoppingItem({ estPriceMinEur: 30 }),
      shoppingItem({ quantity: 3, estPriceMaxEur: 10 }),
      shoppingItem({ quantity: 4 }),
    ])

    expect(totals).toEqual({ count: 3, units: 8, minEur: 60, maxEur: 60, unpriced: 1 })
  })

  it("keeps cents exact", () => {
    const totals = toBuyTotals([
      shoppingItem({ estPriceMinEur: 0.1, estPriceMaxEur: 0.2 }),
      shoppingItem({ estPriceMinEur: 0.2, estPriceMaxEur: 0.1 + 0.2 }),
    ])
    expect(totals.minEur).toBe(0.3)
    expect(totals.maxEur).toBe(0.5)
  })
})

describe("budgetVerdict", () => {
  const totals = { minEur: 300, maxEur: 500 }

  it("is within when even the high end fits", () => {
    expect(budgetVerdict(totals, 600)).toEqual({ kind: "within", leftEur: 100 })
    expect(budgetVerdict(totals, 500)).toEqual({ kind: "within", leftEur: 0 })
  })

  it("may go over when only the high end is above the budget", () => {
    expect(budgetVerdict(totals, 400)).toEqual({ kind: "maybe_over", overEur: 100 })
  })

  it("is over when even the low end is above the budget", () => {
    expect(budgetVerdict(totals, 250)).toEqual({ kind: "over", overEur: 50 })
  })

  it("says nothing without a budget", () => {
    expect(budgetVerdict(totals, null)).toEqual({ kind: "none" })
  })
})

describe("parseBudgetInput", () => {
  it("reads empty as no budget and whole euros as a budget", () => {
    expect(parseBudgetInput("  ")).toEqual({ ok: true, value: null })
    expect(parseBudgetInput(" 600 ")).toEqual({ ok: true, value: 600 })
    expect(parseBudgetInput("0")).toEqual({ ok: true, value: 0 })
  })

  it("rejects cents, negatives, text and amounts over the limit", () => {
    for (const text of ["12.5", "-1", "abc", "100001"]) {
      expect(parseBudgetInput(text).ok).toBe(false)
    }
  })
})

describe("formatEurRange", () => {
  it("formats both ends, one end or none", () => {
    expect(formatEurRange(80, 120)).toBe("€80–€120")
    expect(formatEurRange(1200, 1200)).toBe("€1,200")
    expect(formatEurRange(80, null)).toBe("from €80")
    expect(formatEurRange(null, 120)).toBe("up to €120")
    expect(formatEurRange(null, null)).toBeNull()
    expect(formatEurRange(9.5, 12)).toBe("€9.5–€12")
  })
})

describe("ordering and grouping", () => {
  it("reads a gap's position from its key", () => {
    expect(gapPosition("g3-shell")).toBe(3)
    expect(gapPosition("g12")).toBe(12)
    expect(gapPosition("gift")).toBe(Number.POSITIVE_INFINITY)
    expect(gapPosition(null)).toBe(Number.POSITIVE_INFINITY)
  })

  it("orders by priority, status, age and gap position", () => {
    const rows = [
      shoppingItem({ itemType: "c", priority: 2, gapKey: "g10-c" }),
      shoppingItem({ itemType: "b", priority: 2, gapKey: "g2-b" }),
      shoppingItem({ itemType: "skipped", priority: 1, status: "skipped" }),
      shoppingItem({ itemType: "older", priority: 1, createdAt: "2026-11-01T09:00:00.000Z" }),
      shoppingItem({ itemType: "a", priority: 1 }),
    ]
    expect([...rows].sort(compareShoppingItems).map((row) => row.itemType)).toEqual(["older", "a", "skipped", "b", "c"])
  })

  it("groups by priority in order and leaves out empty groups", () => {
    const groups = groupByPriority([shoppingItem({ priority: 3 }), shoppingItem({ priority: 1 }), shoppingItem({ priority: 3 })])
    expect(groups.map((group) => [group.priority, group.items.length])).toEqual([
      [1, 1],
      [3, 2],
    ])
  })
})

describe("ShoppingItemUpdateSchema", () => {
  const id = "00000000-0000-4000-8000-000000000001"

  it("accepts one change at a time, and null to unlink", () => {
    expect(ShoppingItemUpdateSchema.safeParse({ id, status: "bought" }).success).toBe(true)
    expect(ShoppingItemUpdateSchema.safeParse({ id, linkedItemId: null }).success).toBe(true)
    expect(ShoppingItemUpdateSchema.safeParse({ id, priority: 3 }).success).toBe(true)
  })

  it("rejects an empty change, unknown keys and values outside the lists", () => {
    expect(ShoppingItemUpdateSchema.safeParse({ id }).success).toBe(false)
    expect(ShoppingItemUpdateSchema.safeParse({ id, status: "lost" }).success).toBe(false)
    expect(ShoppingItemUpdateSchema.safeParse({ id, priority: 4 }).success).toBe(false)
    expect(ShoppingItemUpdateSchema.safeParse({ id, status: "bought", note: "x" }).success).toBe(false)
  })
})
