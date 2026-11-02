// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { DEFAULT_ITEM_FILTERS, type ItemFilters } from "@/lib/items/filters"
import { emptyCategoryCounts } from "@/lib/items/wardrobe"

import { SEARCH_DEBOUNCE_MS } from "./search-field"
import { ControlsHarness, filtersFromHref, installBrowserStubs, type Navigate } from "./test-helpers"

// The router is faked; each replace "renders the server" by handing the
// parsed URL back to the harness as new props, like the page does.
const navigation = vi.hoisted(() => {
  const state: { navigate: Navigate; until: Promise<void> | undefined } = {
    navigate: (filters) => {
      throw new Error(`navigated before the harness was ready: ${JSON.stringify(filters)}`)
    },
    // When set, the next server render waits for this promise (a slow server).
    until: undefined,
  }
  return state
})
const router = vi.hoisted(() => ({
  replace: vi.fn((href: string, options?: { scroll?: boolean }) => {
    void options
    navigation.navigate(filtersFromHref(href), navigation.until)
  }),
}))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

beforeAll(installBrowserStubs)

// React reports misuse (an act that suspends without being awaited) on
// console.error; any such report fails the test instead of passing quietly.
let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  vi.useFakeTimers()
  router.replace.mockClear()
  navigation.until = undefined
  consoleError = vi.spyOn(console, "error")
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  const reports = consoleError.mock.calls.map((call) => String(call[0]))
  consoleError.mockRestore()
  expect(reports).toEqual([])
})

function renderControls(initial: Partial<ItemFilters> = {}) {
  const counts = emptyCategoryCounts()
  counts.byCategory.outerwear = 2
  counts.byCategory.shoes = 1
  counts.total = 3
  render(
    <ControlsHarness
      initial={{ ...DEFAULT_ITEM_FILTERS, ...initial }}
      counts={counts}
      onNavigatorReady={(navigate) => {
        navigation.navigate = navigate
      }}
    />
  )
  return screen.getByRole("searchbox", { name: "Search your wardrobe" })
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/**
 * For steps that start a navigation while the fake server is still rendering:
 * the harness suspends on it, and React wants an act that suspends awaited
 * (it warns otherwise, once per file).
 */
async function waitAsync(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

function lastHref(): string | undefined {
  return router.replace.mock.lastCall?.[0]
}

describe("WardrobeToolbar search", () => {
  it("replaces the URL once typing pauses for 300 ms, without scrolling", () => {
    const input = renderControls()
    type(input, "c")
    type(input, "co")
    type(input, "coat")
    wait(SEARCH_DEBOUNCE_MS - 1)
    expect(router.replace).not.toHaveBeenCalled()
    wait(1)
    expect(router.replace).toHaveBeenCalledTimes(1)
    expect(router.replace).toHaveBeenCalledWith("/wardrobe?q=coat", { scroll: false })
  })

  it("keeps the text as typed when the URL catches up", () => {
    const input = renderControls()
    type(input, "navy coat ")
    wait(SEARCH_DEBOUNCE_MS)
    expect(lastHref()).toBe("/wardrobe?q=navy+coat")
    // The URL holds the trimmed text; the box keeps the trailing space being typed.
    expect(input).toHaveProperty("value", "navy coat ")
  })

  it("keeps typing that continues while the first search is still loading", async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    navigation.until = promise
    const input = renderControls()
    type(input, "wool")
    await waitAsync(SEARCH_DEBOUNCE_MS)
    expect(lastHref()).toBe("/wardrobe?q=wool")
    // The server is still rendering; the box keeps what was typed meanwhile.
    expect(input).toHaveProperty("value", "wool")
    await act(async () => {
      type(input, "wool sc")
    })
    navigation.until = undefined
    // The first search lands now; the newer text must survive it.
    await act(async () => resolve())
    expect(input).toHaveProperty("value", "wool sc")
    wait(SEARCH_DEBOUNCE_MS)
    expect(lastHref()).toBe("/wardrobe?q=wool+sc")
  })

  it("clears at once with Escape", () => {
    const input = renderControls({ q: "coat" })
    expect(input).toHaveProperty("value", "coat")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(input).toHaveProperty("value", "")
    expect(lastHref()).toBe("/wardrobe")
    wait(SEARCH_DEBOUNCE_MS)
    expect(router.replace).toHaveBeenCalledTimes(1)
  })

  it("clears with the visible button and puts focus back in the box", () => {
    const input = renderControls({ q: "coat", sort: "wear_desc" })
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(input).toHaveProperty("value", "")
    expect(document.activeElement).toBe(input)
    expect(lastHref()).toBe("/wardrobe?sort=wear_desc")
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull()
  })

  it("searches at once on Enter", () => {
    const input = renderControls()
    type(input, "boots")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(lastHref()).toBe("/wardrobe?q=boots")
  })

  it("follows a search changed from outside (back to an older URL)", () => {
    const input = renderControls({ q: "coat" })
    act(() => navigation.navigate(filtersFromHref("/wardrobe?q=scarf")))
    expect(input).toHaveProperty("value", "scarf")
    // Following the URL is not a new search.
    wait(SEARCH_DEBOUNCE_MS)
    expect(router.replace).not.toHaveBeenCalled()
  })

  it("drops a pending search when the URL changes from outside", () => {
    const input = renderControls()
    type(input, "half typed")
    act(() => navigation.navigate(filtersFromHref("/wardrobe?q=shoes")))
    expect(input).toHaveProperty("value", "shoes")
    wait(SEARCH_DEBOUNCE_MS)
    expect(router.replace).not.toHaveBeenCalled()
  })
})

describe("WardrobeToolbar controls", () => {
  it("replaces the URL with the sort, keeping the search", () => {
    renderControls({ q: "coat" })
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "warmth_desc" } })
    expect(lastHref()).toBe("/wardrobe?q=coat&sort=warmth_desc")
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveProperty("value", "warmth_desc")
  })

  it("keeps a chip pressed during a search pause when the search goes out", () => {
    const input = renderControls()
    type(input, "boots")
    fireEvent.click(screen.getByRole("button", { name: /^Shoes/ }))
    expect(lastHref()).toBe("/wardrobe?category=shoes")
    wait(SEARCH_DEBOUNCE_MS)
    expect(lastHref()).toBe("/wardrobe?q=boots&category=shoes")
  })

  it("shows a change at once and builds the next one on it while the server is still rendering", async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    navigation.until = promise
    renderControls()
    const shoes = () => screen.getByRole("button", { name: /^Shoes/ })
    const scarf = () => screen.getByRole("button", { name: /^Scarf/ })
    await act(async () => {
      fireEvent.click(shoes())
    })
    expect(lastHref()).toBe("/wardrobe?category=shoes")
    expect(shoes().getAttribute("aria-pressed")).toBe("true")
    // Built on the requested filters, not on the props the server has not replaced yet.
    await act(async () => {
      fireEvent.click(scarf())
    })
    expect(lastHref()).toBe("/wardrobe?category=shoes&category=scarf")
    navigation.until = undefined
    await act(async () => resolve())
    expect(shoes().getAttribute("aria-pressed")).toBe("true")
    expect(scarf().getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("false")
  })

  it("shows how many panel filters are active on the Filters button", () => {
    renderControls({ waterproof: true, season: ["winter", "autumn"], q: "coat", category: ["shoes"] })
    // Search and category have their own controls and are not counted.
    expect(screen.getByRole("button", { name: "Filters, 2 active" })).toBeTruthy()
  })

  it("links to the stats page", () => {
    renderControls()
    expect(screen.getByRole("link", { name: "Stats" }).getAttribute("href")).toBe("/stats")
  })
})
