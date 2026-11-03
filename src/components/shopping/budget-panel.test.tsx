// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { BudgetPanel } from "./budget-panel"
import { shoppingItem } from "./test-fixtures"

afterEach(() => {
  cleanup()
})

const PLAN_ID = "00000000-0000-4000-8000-0000000000a1"

function hintOf(input: HTMLElement): string {
  const ids = (input.getAttribute("aria-describedby") ?? "").split(" ")
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
}

describe("BudgetPanel", () => {
  it("says the plan's budget is prefilled without subtracting purchases made since (D-231)", () => {
    render(
      <BudgetPanel
        items={[shoppingItem({ estPriceMinEur: 50, estPriceMaxEur: 80 })]}
        latestBudgetEur={600}
        latestAnalysisId={PLAN_ID}
      />
    )
    const input = screen.getByLabelText("Budget for new purchases (€)")
    expect(hintOf(input)).toBe(
      "Prefilled from your latest relocation plan; purchases since then are not subtracted. Only used for this comparison; changes are not saved."
    )
    expect(screen.getByRole("link", { name: "your latest relocation plan" }).getAttribute("href")).toBe(`/relocate/${PLAN_ID}`)
  })

  it("keeps the plain hint when no plan sets a budget", () => {
    render(<BudgetPanel items={[]} latestBudgetEur={null} latestAnalysisId={null} />)
    expect(hintOf(screen.getByLabelText("Budget for new purchases (€)"))).toBe(
      "Only used for this comparison; it is not saved."
    )
  })
})
