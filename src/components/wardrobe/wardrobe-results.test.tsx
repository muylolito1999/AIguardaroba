// @vitest-environment jsdom
import { Activity } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { REFRESH_INTERVAL_MS } from "@/components/items/refresh-after-item-changes"
import { DEFAULT_ITEM_FILTERS, type ItemFilters } from "@/lib/items/filters"
import { emptyCategoryCounts, type WardrobeItemDto, type WardrobeListDto } from "@/lib/items/wardrobe"
import { noteWardrobeChange } from "@/lib/items/wardrobe-changes"

import { installBrowserStubs } from "./test-helpers"
import { WardrobeResults } from "./wardrobe-results"

// With Cache Components, Next keeps /wardrobe in a hidden <Activity> and
// serves back/forward from its client cache, so a return hands the list the
// same props it had (node_modules/next/dist/docs/01-app/02-guides/
// preserving-ui-state.md). These tests stand in for that with <Activity>.

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

beforeAll(installBrowserStubs)

beforeEach(() => {
  router.replace.mockClear()
  router.refresh.mockClear()
})

afterEach(cleanup)

function tile(index: number): WardrobeItemDto {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Item ${index}`,
    category: "outerwear",
    subcategory: null,
    status: "confirmed",
    decision: "undecided",
    location: "bologna",
    warmthLevel: 3,
    waterproof: false,
    windproof: false,
    insulated: false,
    colors: ["navy"],
    colorHex: ["#1f2a44"],
    wearCount: 0,
    multipleItemsDetected: false,
    thumb: null,
  }
}

function listOf(count: number): WardrobeListDto {
  const counts = emptyCategoryCounts()
  counts.byCategory.outerwear = count
  counts.total = count
  return {
    items: Array.from({ length: count }, (_, index) => tile(index)),
    total: count,
    counts,
    colors: count > 0 ? [{ name: "navy", hex: "#1f2a44", count }] : [],
    capped: false,
  }
}

function renderInActivity(initial: WardrobeListDto) {
  const ui = (mode: "visible" | "hidden", list: WardrobeListDto) => (
    <Activity mode={mode}>
      <WardrobeResults filters={DEFAULT_ITEM_FILTERS} list={list} />
    </Activity>
  )
  let list = initial
  const view = render(ui("visible", list))
  return {
    hide: () => view.rerender(ui("hidden", list)),
    show: () => view.rerender(ui("visible", list)),
    /** A newer server render: the same page instance gets a new list object. */
    serve: (next: WardrobeListDto) => {
      list = next
      view.rerender(ui("visible", list))
    },
  }
}

describe("WardrobeResults after a return", () => {
  it("does not read the list again when nothing changed", () => {
    const page = renderInActivity(listOf(2))
    expect(screen.getByRole("status").textContent).toBe("2 items")
    page.hide()
    page.show()
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("reads the list again once when an item changed while the page was hidden", () => {
    const page = renderInActivity(listOf(2))
    page.hide()
    // The owner changed an item on its detail page, then went back.
    act(() => noteWardrobeChange())
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The refreshed list arrives: fresh, so no second read, and none on later returns.
    page.serve(listOf(1))
    expect(screen.getByRole("status").textContent).toBe("1 item")
    page.hide()
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("does not read again when the return brought a list read after the change", () => {
    const page = renderInActivity(listOf(3))
    page.hide()
    act(() => noteWardrobeChange())
    // A fresh navigation (the Wardrobe tab) renders the page with a new list.
    page.serve(listOf(2))
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("reads the list again when a save answers after the owner came back", () => {
    // Donate was pressed on an item page, then Back before the server answered:
    // the list was shown (and checked) first, the change is noted after.
    const page = renderInActivity(listOf(2))
    page.hide()
    page.show()
    expect(router.refresh).not.toHaveBeenCalled()
    act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    page.serve(listOf(2))
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })
})

describe("WardrobeResults while a background tagging run answers", () => {
  it("reads the list a few times, not once per answer", () => {
    vi.useFakeTimers()
    try {
      const page = renderInActivity(listOf(2))
      // A "Tag N waiting items" run left running on /add/review: 40 answers,
      // each noted, each followed by a new list (a refresh landing, D-130).
      for (let i = 0; i < 40; i += 1) {
        act(() => noteWardrobeChange())
        page.serve(listOf(2))
      }
      expect(router.refresh).toHaveBeenCalledTimes(1)
      act(() => {
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS)
      })
      expect(router.refresh.mock.calls.length).toBeLessThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("WardrobeResults empty states", () => {
  it("says where the items are when every one is archived", () => {
    const list = listOf(0)
    list.counts.archived = 2
    render(<WardrobeResults filters={DEFAULT_ITEM_FILTERS} list={list} />)
    expect(screen.getByRole("heading", { name: "All 2 items are archived" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Show archived items" }).getAttribute("href")).toBe(
      "/wardrobe?status=archived"
    )
    expect(screen.queryByRole("heading", { name: "No items yet" })).toBeNull()
  })

  it("says the wardrobe is empty when nothing is archived either", () => {
    render(<WardrobeResults filters={DEFAULT_ITEM_FILTERS} list={listOf(0)} />)
    expect(screen.getByRole("heading", { name: "No items yet" })).toBeTruthy()
  })
})

describe("WardrobeResults focus after Reset filters", () => {
  const SEARCHED: ItemFilters = { ...DEFAULT_ITEM_FILTERS, q: "zzz" }

  function resetFromNoMatches(next: WardrobeListDto) {
    const view = render(<WardrobeResults filters={SEARCHED} list={listOf(0)} />)
    const reset = screen.getByRole("button", { name: "Reset filters" })
    reset.focus()
    expect(document.activeElement).toBe(reset)
    act(() => {
      fireEvent.click(reset)
    })
    expect(router.replace).toHaveBeenCalledWith("/wardrobe", { scroll: false })
    // The reset's list arrives; the empty state, with the button, leaves.
    view.rerender(<WardrobeResults filters={DEFAULT_ITEM_FILTERS} list={next} />)
    expect(reset.isConnected).toBe(false)
    return view
  }

  it("moves focus to the result count when the new results arrive", () => {
    resetFromNoMatches(listOf(2))
    const count = screen.getByRole("status")
    expect(count.textContent).toBe("2 items")
    expect(document.activeElement).toBe(count)
  })

  it("does the same when the reset finds an empty wardrobe", () => {
    resetFromNoMatches(listOf(0))
    expect(screen.getByRole("heading", { name: "No items yet" })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole("status"))
  })

  it("moves focus only once, never on later lists", () => {
    const view = resetFromNoMatches(listOf(2))
    const elsewhere = screen.getByRole("button", { name: /^Filters/ })
    elsewhere.focus()
    // A later list (a refresh, a filter change) leaves focus where the owner put it.
    view.rerender(<WardrobeResults filters={DEFAULT_ITEM_FILTERS} list={listOf(1)} />)
    expect(document.activeElement).toBe(elsewhere)
  })

  it("does not take focus from <body> for a later list once the reset was handled", () => {
    const view = resetFromNoMatches(listOf(2))
    const count = screen.getByRole("status")
    expect(document.activeElement).toBe(count)
    // Focus is lost again for another reason; a later list (a D-107 refresh) arrives.
    act(() => count.blur())
    expect(document.activeElement).toBe(document.body)
    view.rerender(<WardrobeResults filters={DEFAULT_ITEM_FILTERS} list={listOf(1)} />)
    expect(document.activeElement).toBe(document.body)
  })

  it("does not move focus when Next shows the page again after a reset", () => {
    const ui = (mode: "visible" | "hidden", filters: ItemFilters, list: WardrobeListDto) => (
      <Activity mode={mode}>
        <WardrobeResults filters={filters} list={list} />
      </Activity>
    )
    const view = render(ui("visible", SEARCHED, listOf(0)))
    const reset = screen.getByRole("button", { name: "Reset filters" })
    reset.focus()
    act(() => {
      fireEvent.click(reset)
    })
    const results = listOf(2)
    view.rerender(ui("visible", DEFAULT_ITEM_FILTERS, results))
    const count = screen.getByRole("status")
    expect(document.activeElement).toBe(count)
    // jsdom ignores blur() inside a hidden Activity, so focus leaves while it is shown.
    act(() => count.blur())
    view.rerender(ui("hidden", DEFAULT_ITEM_FILTERS, results))
    view.rerender(ui("visible", DEFAULT_ITEM_FILTERS, results))
    expect(document.activeElement).toBe(document.body)
  })
})

describe("WardrobeResults focus when the Untagged chip leaves", () => {
  // A search in the Untagged view: waiting items have no name or colours, so
  // none match, and the chip stays only because its view is on.
  const UNTAGGED_SEARCH: ItemFilters = { ...DEFAULT_ITEM_FILTERS, q: "navy", status: ["pending_tagging"] }
  const SEARCH: ItemFilters = { ...DEFAULT_ITEM_FILTERS, q: "navy" }

  function noWaitingItems(): WardrobeListDto {
    const list = listOf(0)
    list.counts.total = 3
    list.counts.byCategory.outerwear = 3
    return list
  }

  it("moves focus to All when pressing the pressed Untagged chip removes it", () => {
    const counts = noWaitingItems()
    const ui = (mode: "visible" | "hidden", filters: ItemFilters) => (
      <Activity mode={mode}>
        <WardrobeResults filters={filters} list={counts} />
      </Activity>
    )
    const view = render(ui("visible", UNTAGGED_SEARCH))
    const untagged = screen.getByRole("button", { name: "Untagged, 0 items" })
    expect(untagged.getAttribute("aria-pressed")).toBe("true")
    untagged.focus()
    act(() => {
      fireEvent.click(untagged)
    })
    expect(router.replace).toHaveBeenCalledWith("/wardrobe?q=navy", { scroll: false })

    // The server's answer: the usual statuses, still no waiting item.
    view.rerender(ui("visible", SEARCH))
    expect(screen.queryByRole("button", { name: /^Untagged/ })).toBeNull()
    const all = screen.getByRole("button", { name: "All, 3 items" })
    expect(document.activeElement).toBe(all)

    // Once only: focus lost later and the page shown again does not pull it back.
    act(() => all.blur())
    view.rerender(ui("hidden", SEARCH))
    view.rerender(ui("visible", SEARCH))
    expect(document.activeElement).toBe(document.body)
  })
})

describe("WardrobeResults colour options", () => {
  it("keeps the other colours on offer once one is chosen", async () => {
    const list = listOf(2)
    // Every listed item is navy; the facet ignores the colour filter itself.
    list.colors = [
      { name: "navy", hex: "#1f2a44", count: 2 },
      { name: "black", hex: "#111111", count: 3 },
    ]
    render(<WardrobeResults filters={{ ...DEFAULT_ITEM_FILTERS, color: ["navy"] }} list={list} />)
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }))
    const dialog = await screen.findByRole("dialog", { name: "Filters" })
    const colour = within(dialog).getByRole("group", { name: "Colour" })
    expect(within(colour).getByRole("button", { name: "navy" }).getAttribute("aria-pressed")).toBe("true")
    expect(within(colour).getByRole("button", { name: "black" }).getAttribute("aria-pressed")).toBe("false")
  })
})
