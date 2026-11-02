// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { DEFAULT_ITEM_FILTERS, DEFAULT_STATUSES, type ItemFilters } from "@/lib/items/filters"
import type { ColorFacet } from "@/lib/items/wardrobe"

import { colorOptionsWithChosen, type ColorOption } from "./color-options"
import { FilterPanel, resetPanelFilters } from "./filter-panel"
import { installBrowserStubs } from "./test-helpers"
import type { FiltersChange } from "./use-wardrobe-filters"

beforeAll(installBrowserStubs)
afterEach(cleanup)

function filters(overrides: Partial<ItemFilters> = {}): ItemFilters {
  return { ...DEFAULT_ITEM_FILTERS, ...overrides }
}

const BUSY_FILTERS = filters({
  q: "coat",
  category: ["outerwear"],
  sort: "warmth_desc",
  season: ["winter"],
  warmthMin: 3,
  warmthMax: 5,
  waterproof: true,
  windproof: false,
  color: ["navy"],
  formality: ["casual"],
  condition: ["good"],
  location: ["hamburg"],
  decision: ["bring"],
  status: ["confirmed", "archived"],
})

const NAVY: ColorOption = { name: "navy", hex: "#1f2a44", count: 2 }

function renderPanel(current: ItemFilters, overrides: { total?: number; isPending?: boolean } = {}) {
  const onChange = vi.fn<(change: FiltersChange) => void>()
  render(
    <FilterPanel
      filters={current}
      total={overrides.total ?? 7}
      isPending={overrides.isPending ?? false}
      colorOptions={[NAVY]}
      onChange={onChange}
    />
  )
  return { onChange }
}

async function openPanel(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: /^Filters/ }))
  return screen.findByRole("dialog", { name: "Filters" })
}

describe("resetPanelFilters", () => {
  it("clears every panel filter and keeps search, category and sort", () => {
    expect(resetPanelFilters(BUSY_FILTERS)).toEqual({
      ...DEFAULT_ITEM_FILTERS,
      q: "coat",
      category: ["outerwear"],
      sort: "warmth_desc",
    })
    expect(resetPanelFilters(BUSY_FILTERS).status).toEqual([...DEFAULT_STATUSES])
  })
})

describe("FilterPanel", () => {
  it("resets the panel's filters", async () => {
    const { onChange } = renderPanel(BUSY_FILTERS)
    expect(screen.getByRole("button", { name: "Filters, 10 active" })).toBeTruthy()
    const dialog = await openPanel()
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset filters" }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const change = onChange.mock.lastCall?.[0]
    if (typeof change !== "function") throw new Error("expected a functional change")
    expect(change(BUSY_FILTERS)).toEqual(resetPanelFilters(BUSY_FILTERS))
  })

  it("greys out Reset when no panel filter is set, keeping it focusable", async () => {
    renderPanel(filters({ q: "coat", category: ["shoes"] }))
    const dialog = await openPanel()
    const reset = within(dialog).getByRole("button", { name: "Reset filters" })
    expect(reset.getAttribute("aria-disabled")).toBe("true")
    expect(reset.hasAttribute("disabled")).toBe(false)
  })

  it("changes single filters at once", async () => {
    const { onChange } = renderPanel(filters())
    const dialog = await openPanel()

    const waterproof = within(dialog).getByRole("group", { name: "Waterproof" })
    fireEvent.click(within(waterproof).getByRole("button", { name: "Yes" }))
    expect(onChange).toHaveBeenLastCalledWith({ waterproof: true })

    const seasons = within(dialog).getByRole("group", { name: "Season" })
    fireEvent.click(within(seasons).getByRole("button", { name: "Winter" }))
    expect(onChange).toHaveBeenLastCalledWith({ season: ["winter"] })

    const status = within(dialog).getByRole("group", { name: "Status" })
    fireEvent.click(within(status).getByRole("button", { name: "Archived" }))
    expect(onChange).toHaveBeenLastCalledWith({ status: ["pending_tagging", "tagged", "confirmed", "archived"] })

    fireEvent.change(within(dialog).getByRole("combobox", { name: "From" }), { target: { value: "4" } })
    expect(onChange).toHaveBeenLastCalledWith({ warmthMin: 4 })

    fireEvent.click(within(dialog).getByRole("button", { name: "navy" }))
    expect(onChange).toHaveBeenLastCalledWith({ color: ["navy"] })

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Another colour" }), { target: { value: " Olive " } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }))
    expect(onChange).toHaveBeenLastCalledWith({ color: ["olive"] })
  })

  it("sets a yes/no filter back to Any", async () => {
    const { onChange } = renderPanel(filters({ windproof: false }))
    const dialog = await openPanel()
    const windproof = within(dialog).getByRole("group", { name: "Windproof" })
    expect(within(windproof).getByRole("button", { name: "No" }).getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(within(windproof).getByRole("button", { name: "Any" }))
    expect(onChange).toHaveBeenLastCalledWith({ windproof: null })
  })

  it("closes with Show N items and returns focus to the Filters button", async () => {
    renderPanel(filters({ waterproof: true }), { total: 1 })
    const trigger = screen.getByRole("button", { name: "Filters, 1 active" })
    const dialog = await openPanel()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Show 1 item" }))
    })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it("describes each group with the rule its hint states", async () => {
    renderPanel(filters())
    const dialog = await openPanel()

    /** The text aria-describedby points at, as a screen reader reads it. */
    function description(element: HTMLElement): string {
      const ids = element.getAttribute("aria-describedby")?.split(/\s+/) ?? []
      return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
    }

    expect(description(within(dialog).getByRole("group", { name: "Status" }))).toBe(
      "Archived items stay hidden unless Archived is chosen. None chosen shows the usual three."
    )
    expect(description(within(dialog).getByRole("group", { name: "Warmth" }))).toContain(
      "Items without a warmth are left out."
    )
    expect(description(within(dialog).getByRole("group", { name: "Colour" }))).toContain(
      "Several chosen means any of them."
    )
    expect(description(within(dialog).getByRole("textbox", { name: "Another colour" }))).toContain(
      "Several chosen means any of them."
    )
    // A section without a hint points at nothing.
    expect(within(dialog).getByRole("group", { name: "Season" }).hasAttribute("aria-describedby")).toBe(false)
  })

  it("says it is updating while the new count loads", async () => {
    renderPanel(filters(), { isPending: true })
    const dialog = await openPanel()
    expect(within(dialog).getByRole("button", { name: "Updating…" })).toBeTruthy()
  })
})

describe("colorOptionsWithChosen", () => {
  const FACET: ColorFacet[] = [
    { name: "navy", hex: "#1f2a44", count: 2 },
    { name: "black", hex: null, count: 1 },
  ]

  it("offers the server's colour facet as it is", () => {
    expect(colorOptionsWithChosen(FACET, [])).toEqual(FACET)
    expect(colorOptionsWithChosen(FACET, ["navy"])).toEqual(FACET)
  })

  it("adds chosen colours the facet lacks, so they can be removed", () => {
    expect(colorOptionsWithChosen(FACET, ["olive", "navy"])).toEqual([
      ...FACET,
      { name: "olive", hex: null, count: 0 },
    ])
  })
})
