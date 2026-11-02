// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_ITEM_FILTERS, DEFAULT_STATUSES, isUntaggedView, type ItemFilters } from "@/lib/items/filters"
import { emptyCategoryCounts, type CategoryCounts } from "@/lib/items/wardrobe"

import { applyChip, CategoryChips, pressedChips } from "./category-chips"
import type { FiltersChange } from "./use-wardrobe-filters"

afterEach(cleanup)

function filters(overrides: Partial<ItemFilters> = {}): ItemFilters {
  return { ...DEFAULT_ITEM_FILTERS, ...overrides }
}

/** Chip counts with every waiting item uncategorized, as in the default view. */
function counts(byCategory: Partial<CategoryCounts["byCategory"]>, untagged = 0): CategoryCounts {
  const result = emptyCategoryCounts()
  Object.assign(result.byCategory, byCategory)
  result.uncategorized = untagged
  result.untagged = untagged
  result.total = Object.values(result.byCategory).reduce((sum, count) => sum + count, untagged)
  return result
}

describe("applyChip", () => {
  it("toggles a category in and out, keeping the other filters", () => {
    const base = filters({ q: "wool", waterproof: true })
    const withShoes = applyChip(base, "shoes")
    expect(withShoes).toMatchObject({ category: ["shoes"], q: "wool", waterproof: true })
    expect(applyChip(withShoes, "scarf").category).toEqual(["shoes", "scarf"])
    expect(applyChip(withShoes, "shoes").category).toEqual([])
  })

  it("clears the categories with All", () => {
    expect(applyChip(filters({ category: ["shoes", "scarf"] }), "all").category).toEqual([])
  })

  it("maps Untagged to the waiting-for-tags status, and back", () => {
    const untagged = applyChip(filters({ category: ["shoes"] }), "untagged")
    expect(untagged).toMatchObject({ category: [], status: ["pending_tagging"] })
    expect(isUntaggedView(untagged)).toBe(true)
    expect(applyChip(untagged, "untagged").status).toEqual([...DEFAULT_STATUSES])
  })

  it("leaves the Untagged view when a category or All is chosen", () => {
    const untagged = filters({ status: ["pending_tagging"] })
    expect(applyChip(untagged, "shoes")).toMatchObject({ category: ["shoes"], status: [...DEFAULT_STATUSES] })
    expect(applyChip(untagged, "all")).toMatchObject({ category: [], status: [...DEFAULT_STATUSES] })
  })

  it("keeps a custom status set when switching categories outside the Untagged view", () => {
    const archived = filters({ status: ["archived"] })
    expect(applyChip(archived, "shoes").status).toEqual(["archived"])
  })

  it("treats waiting-for-tags with a category chosen as a custom status set, not the Untagged view", () => {
    const shoesWaiting = filters({ category: ["shoes"], status: ["pending_tagging"] })
    expect(isUntaggedView(shoesWaiting)).toBe(false)
    expect(applyChip(shoesWaiting, "shoes")).toMatchObject({ category: [], status: ["pending_tagging"] })
    expect(applyChip(shoesWaiting, "untagged")).toMatchObject({ category: [], status: ["pending_tagging"] })
  })
})

describe("pressedChips", () => {
  it("presses All, the chosen categories or Untagged", () => {
    expect(pressedChips(filters())).toEqual(["all"])
    expect(pressedChips(filters({ category: ["shoes", "scarf"] }))).toEqual(["shoes", "scarf"])
    expect(pressedChips(filters({ status: ["pending_tagging"] }))).toEqual(["untagged"])
  })

  it("keeps a chosen category pressed when the status is narrowed to waiting for tags", () => {
    expect(pressedChips(filters({ category: ["shoes"], status: ["pending_tagging"] }))).toEqual(["shoes"])
  })
})

describe("CategoryChips", () => {
  function renderChips(current: ItemFilters, chipCounts: CategoryCounts) {
    const onChange = vi.fn<(change: FiltersChange) => void>()
    render(<CategoryChips filters={current} counts={chipCounts} onChange={onChange} />)
    /** The filters the last change would produce from `current`. */
    const applied = () => {
      const change = onChange.mock.lastCall?.[0]
      if (typeof change !== "function") throw new Error("expected a functional change")
      return change(current)
    }
    return { onChange, applied }
  }

  it("labels every chip with its count and marks the pressed ones", () => {
    renderChips(filters({ category: ["shoes"] }), counts({ outerwear: 3, shoes: 1 }))
    const group = screen.getByRole("group", { name: "Category" })
    expect(group).toBeTruthy()
    expect(screen.getByRole("button", { name: "All, 4 items" }).getAttribute("aria-pressed")).toBe("false")
    expect(screen.getByRole("button", { name: "Outerwear, 3 items" }).getAttribute("aria-pressed")).toBe("false")
    expect(screen.getByRole("button", { name: "Shoes, 1 item" }).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByRole("button", { name: "Hat or beanie, 0 items" })).toBeTruthy()
  })

  it("shows Untagged only while items wait for tags or it is on", () => {
    renderChips(filters(), counts({ outerwear: 1 }))
    expect(screen.queryByRole("button", { name: /^Untagged/ })).toBeNull()
    cleanup()
    renderChips(filters(), counts({ outerwear: 1 }, 2))
    expect(screen.getByRole("button", { name: "Untagged, 2 items" })).toBeTruthy()
    cleanup()
    renderChips(filters({ status: ["pending_tagging"] }), counts({}, 0))
    expect(screen.getByRole("button", { name: "Untagged, 0 items" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("badges each chip with the count the service gives for it, whatever the view", () => {
    // Archived view: the categories count archived items, Untagged the waiting
    // ones (none of the archived items lacks a category here).
    const archivedView = counts({ outerwear: 1 })
    archivedView.untagged = 2
    archivedView.uncategorized = 0
    archivedView.total = 1
    renderChips(filters({ status: ["archived"] }), archivedView)
    expect(screen.getByRole("button", { name: "Untagged, 2 items" }).getAttribute("aria-pressed")).toBe("false")
    expect(screen.getByRole("button", { name: "All, 1 item" }).getAttribute("aria-pressed")).toBe("true")
    cleanup()

    // Untagged view: the other chips count what they would show, not muted.
    const untaggedView = counts({ shoes: 2 }, 1)
    renderChips(filters({ status: ["pending_tagging"] }), untaggedView)
    const shoes = screen.getByRole("button", { name: "Shoes, 2 items" })
    expect(shoes.className).not.toContain("text-muted-foreground")
    expect(screen.getByRole("button", { name: "All, 3 items" }).getAttribute("aria-pressed")).toBe("false")
  })

  it("shows the chosen category as pressed, not Untagged, when only waiting items are listed", () => {
    const current = filters({ category: ["shoes"], status: ["pending_tagging"] })
    const { applied } = renderChips(current, counts({ shoes: 0 }, 1))
    expect(screen.getByRole("button", { name: "Shoes, 0 items" }).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByRole("button", { name: "Untagged, 1 item" }).getAttribute("aria-pressed")).toBe("false")
    // Pressing Shoes removes the category it shows as chosen.
    fireEvent.click(screen.getByRole("button", { name: "Shoes, 0 items" }))
    expect(applied()).toMatchObject({ category: [], status: ["pending_tagging"] })
  })

  it("applies the pressed chip's meaning", () => {
    const { onChange, applied } = renderChips(filters(), counts({ outerwear: 3, shoes: 1 }, 2))
    fireEvent.click(screen.getByRole("button", { name: "Shoes, 1 item" }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(applied().category).toEqual(["shoes"])

    fireEvent.click(screen.getByRole("button", { name: "Untagged, 2 items" }))
    expect(applied()).toMatchObject({ category: [], status: ["pending_tagging"] })
  })

  it("clears the categories when All is pressed", () => {
    const { applied } = renderChips(filters({ category: ["shoes"] }), counts({ shoes: 1 }))
    fireEvent.click(screen.getByRole("button", { name: "All, 1 item" }))
    expect(applied().category).toEqual([])
  })
})
