// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { computeWinterReadiness, type WinterReadinessItem } from "@/lib/items/winter-readiness"
import type { WardrobeStatsDto } from "@/server/services/stats"

import { BarTable, barRatio } from "./bar-table"
import { categoryRows, StatsView } from "./stats-view"
import { EVIDENCE_LINKS_SHOWN, WinterChecklist } from "./winter-checklist"

afterEach(cleanup)

const SHELL_ID = "11111111-1111-4111-8111-111111111111"
const SCARF_ID = "22222222-2222-4222-8222-222222222222"

function readinessItem(overrides: Partial<WinterReadinessItem>): WinterReadinessItem {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    name: null,
    subcategory: null,
    category: "top",
    status: "confirmed",
    decision: "undecided",
    materials: [],
    materialGuess: null,
    warmthLevel: 2,
    waterproof: false,
    windproof: false,
    insulated: false,
    ...overrides,
  }
}

function stats(overrides: Partial<WardrobeStatsDto> = {}): WardrobeStatsDto {
  return {
    totals: { all: 7, confirmed: 4, tagged: 1, pending: 2, archived: 3 },
    byCategory: {
      outerwear: 2,
      top: 0,
      bottom: 0,
      dress: 0,
      shoes: 1,
      gloves: 0,
      hat_beanie: 0,
      scarf: 2,
      base_layer: 0,
      accessory: 0,
      bag: 0,
      other: 0,
    },
    warmth: { 1: 0, 2: 1, 3: 1, 4: 2, 5: 1 },
    flags: { waterproof: 2, windproof: 3, insulated: 1 },
    byDecision: { bring: 3, leave: 1, donate: 0, sell: 0, undecided: 3 },
    byLocation: { bologna: 6, hamburg: 0, in_transit: 1, unknown: 0 },
    winterReadiness: computeWinterReadiness([
      readinessItem({ id: SHELL_ID, name: "Rain shell", category: "outerwear", waterproof: true }),
      readinessItem({ id: SCARF_ID, name: "Grey scarf", category: "scarf" }),
    ]),
    ...overrides,
  }
}

/** The text an element's aria-describedby points at. */
function descriptionOf(element: HTMLElement): string | null {
  const id = element.getAttribute("aria-describedby")
  return id === null ? null : (document.getElementById(id)?.textContent ?? null)
}

/** The count printed in a bar table's row, found by the row header's text. */
function countIn(tableName: string, rowLabel: string | RegExp): string | null {
  const table = screen.getByRole("table", { name: tableName })
  const row = within(table).getByRole("rowheader", { name: rowLabel }).closest("tr")
  if (row === null) throw new Error(`no row for ${String(rowLabel)}`)
  return within(row).getByRole("cell").textContent
}

describe("BarTable", () => {
  it("is a named table whose rows print each label and count", () => {
    render(
      <BarTable
        id="t"
        title="By category"
        description="Tagged and confirmed items (5)."
        labelHeader="Category"
        rows={[
          { key: "a", label: "Outerwear", value: 4 },
          { key: "b", label: "Shoes", value: 1, hint: "boots too" },
          { key: "c", label: "Bag", value: 0 },
        ]}
      />
    )

    const table = screen.getByRole("table", { name: "By category" })
    expect(descriptionOf(table)).toBe("Tagged and confirmed items (5).")
    expect(within(table).getByRole("columnheader", { name: "Category" })).toBeDefined()
    expect(within(table).getByRole("columnheader", { name: "Items" })).toBeDefined()
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual([
      "Outerwear",
      "Shoesboots too",
      "Bag",
    ])
    expect(countIn("By category", "Outerwear")).toBe("4")
    expect(countIn("By category", /^Shoes/)).toBe("1")
    expect(countIn("By category", "Bag")).toBe("0")
  })

  it("draws bars against the largest row, or against max with a track, and hides them from assistive tech", () => {
    const { container } = render(
      <BarTable
        id="t"
        title="Chart"
        labelHeader="Label"
        rows={[
          { key: "a", label: "A", value: 4 },
          { key: "b", label: "B", value: 1 },
          { key: "c", label: "C", value: 0 },
        ]}
      />
    )
    // The bar column keeps room for the printed count; the ratio scales what is left.
    const widths = [...container.querySelectorAll<HTMLElement>("[data-slot=bar]")].map((bar) => bar.style.width)
    expect(widths).toHaveLength(3)
    for (const width of widths) expect(width).toContain("(100% - 3.5rem)")
    expect(widths.map((width) => width.replace("(100% - 3.5rem)", "").replace(/[^\d.]/g, ""))).toEqual(["1", "0.25", "0"])
    for (const bar of container.querySelectorAll("[data-slot=bar]")) expect(bar.getAttribute("aria-hidden")).toBe("true")

    cleanup()
    const { container: shares } = render(
      <BarTable id="t" title="Share" labelHeader="Label" max={8} rows={[{ key: "a", label: "A", value: 2 }]} />
    )
    expect(shares.querySelector("[data-slot=bar-track]")?.getAttribute("aria-hidden")).toBe("true")
    expect(shares.querySelector<HTMLElement>("[data-slot=bar]")?.style.width).toBe("25%")
  })

  it("never divides by zero", () => {
    expect(barRatio(0, 0)).toBe(0)
    expect(barRatio(3, 0)).toBe(0)
    expect(barRatio(5, 4)).toBe(1)
  })
})

describe("WinterChecklist", () => {
  it("says Ready or Missing in words and links evidence to the item pages", () => {
    render(<WinterChecklist rows={stats().winterReadiness} />)

    expect(screen.getByText("2 of 6 ready")).toBeDefined()
    const shell = screen.getByRole("heading", { level: 3, name: "Waterproof shell Ready" })
    const shellRow = shell.closest("li")
    if (shellRow === null) throw new Error("no row")
    expect(within(shellRow).getByRole("link", { name: "Rain shell" }).getAttribute("href")).toBe(
      `/wardrobe/${SHELL_ID}`
    )
    expect(within(shellRow).queryByText(/^Needed:/)).toBeNull()

    expect(screen.getByRole("link", { name: "Grey scarf" }).getAttribute("href")).toBe(`/wardrobe/${SCARF_ID}`)

    const gloves = screen.getByRole("heading", { level: 3, name: "Windproof gloves Missing" })
    const glovesRow = gloves.closest("li")
    if (glovesRow === null) throw new Error("no row")
    expect(glovesRow.textContent).toContain("Needed: A pair of windproof gloves.")
    expect(within(glovesRow).queryByRole("link")).toBeNull()
  })

  it("lists a few evidence links and summarises the rest", () => {
    const scarves = Array.from({ length: EVIDENCE_LINKS_SHOWN + 2 }, (_, index) =>
      readinessItem({ id: `scarf-${index}`, name: `Scarf ${index}`, category: "scarf" })
    )
    render(<WinterChecklist rows={computeWinterReadiness(scarves)} />)

    const row = screen.getByRole("heading", { level: 3, name: "Scarf Ready" }).closest("li")
    if (row === null) throw new Error("no row")
    expect(within(row).getAllByRole("link")).toHaveLength(EVIDENCE_LINKS_SHOWN)
    expect(within(row).getByText("and 2 more")).toBeDefined()
  })
})

describe("StatsView", () => {
  it("shows the overview, the untagged items with a review link, and every chart with its counts", () => {
    render(<StatsView stats={stats()} />)

    const overview = screen.getByRole("region", { name: "Overview" })
    const tiles = within(overview).getAllByRole("term").map((term) => [term.textContent, term.nextSibling?.textContent])
    expect(tiles).toEqual([
      ["Items", "7"],
      ["Confirmed", "4"],
      ["Tagged, not confirmed", "1"],
      ["Waiting for tags", "2"],
      ["Archived", "3"],
    ])
    expect(within(overview).getByText(/2 items are waiting for tags/)).toBeDefined()
    expect(within(overview).getByRole("link", { name: "Review untagged items" }).getAttribute("href")).toBe(
      "/add/review"
    )

    // Every category is listed, largest first, zeros included.
    const categories = within(screen.getByRole("table", { name: "By category" })).getAllByRole("rowheader")
    expect(categories).toHaveLength(12)
    expect(categories.slice(0, 3).map((cell) => cell.textContent)).toEqual(["Outerwear", "Scarf", "Shoes"])
    expect(countIn("By category", "Outerwear")).toBe("2")
    expect(countIn("By category", "Dress")).toBe("0")

    expect(countIn("Warmth", /^4 Warm/)).toBe("2")
    expect(countIn("Warmth", /^1 Summer, very light/)).toBe("0")
    expect(descriptionOf(screen.getByRole("table", { name: "Warmth" }))).toBe(
      "Tagged and confirmed items (5). From 1, summer and very light, to 5, heavy winter."
    )

    expect(countIn("Weather protection", "Waterproof")).toBe("2")
    expect(countIn("Weather protection", "Windproof")).toBe("3")
    expect(countIn("Weather protection", "Insulated")).toBe("1")

    expect(countIn("Decisions", "Bring")).toBe("3")
    expect(countIn("Decisions", "Undecided")).toBe("3")
    expect(countIn("Locations", "Bologna")).toBe("6")
    expect(countIn("Locations", "In transit")).toBe("1")

    expect(screen.getByRole("region", { name: "Winter-ready checklist" })).toBeDefined()
  })

  it("leaves out the review prompt when nothing is waiting", () => {
    render(<StatsView stats={stats({ totals: { all: 5, confirmed: 4, tagged: 1, pending: 0, archived: 0 } })} />)
    expect(screen.queryByRole("link", { name: "Review untagged items" })).toBeNull()
  })

  it("replaces the tag-based charts with a note while nothing is tagged", () => {
    render(<StatsView stats={stats({ totals: { all: 2, confirmed: 0, tagged: 0, pending: 2, archived: 0 } })} />)
    expect(screen.queryByRole("table", { name: "By category" })).toBeNull()
    expect(screen.getByText("These appear once at least one item is tagged.")).toBeDefined()
    expect(screen.getByRole("table", { name: "Decisions" })).toBeDefined()
  })

  it("shows an empty state with an add link when there are no items", () => {
    render(<StatsView stats={stats({ totals: { all: 0, confirmed: 0, tagged: 0, pending: 0, archived: 2 } })} />)
    expect(screen.getByText("No items yet")).toBeDefined()
    expect(screen.getByText(/2 items archived and not counted/)).toBeDefined()
    expect(screen.getByRole("link", { name: "Add items" }).getAttribute("href")).toBe("/add")
    expect(screen.queryByRole("table")).toBeNull()
  })
})

describe("categoryRows", () => {
  it("sorts by count, keeping the enum order for ties", () => {
    const rows = categoryRows(stats().byCategory)
    expect(rows.map((row) => row.key).slice(0, 5)).toEqual(["outerwear", "scarf", "shoes", "top", "bottom"])
  })
})
