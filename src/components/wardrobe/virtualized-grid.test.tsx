// @vitest-environment jsdom
import { Activity } from "react"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { STATUS_LABELS } from "@/components/items/tag-options"
import { ITEM_STATUSES } from "@/lib/db/enums"
import type { WardrobeItemDto } from "@/lib/items/wardrobe"

import { VirtualizedGrid } from "./virtualized-grid"

// jsdom has no layout: the container's width is stubbed, row heights read as
// 0 (so every row is in range), and ResizeObserver is a recording fake.

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observed = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(target: Element) {
    this.observed.add(target)
  }
  unobserve(target: Element) {
    this.observed.delete(target)
  }
  disconnect() {
    this.observed.clear()
  }
  static watching(): number {
    return FakeResizeObserver.instances.reduce((sum, observer) => sum + observer.observed.size, 0)
  }
}

/** Window listeners currently attached, by event type. */
const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
let containerWidth = 800

beforeEach(() => {
  FakeResizeObserver.instances = []
  listeners.clear()
  containerWidth = 800
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  // jsdom's scrollTo only reports "Not implemented"; the virtualizer scrolls
  // the window when measured rows differ from its estimates.
  vi.stubGlobal("scrollTo", vi.fn())
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => containerWidth)
  const add = window.addEventListener.bind(window)
  const remove = window.removeEventListener.bind(window)
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (listener !== null) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    }
    add(type, listener, options)
  })
  vi.spyOn(window, "removeEventListener").mockImplementation((type, listener, options) => {
    if (listener !== null) listeners.get(type)?.delete(listener)
    remove(type, listener, options)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function attached(type: string): number {
  return listeners.get(type)?.size ?? 0
}

function tile(index: number, overrides: Partial<WardrobeItemDto> = {}): WardrobeItemDto {
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
    thumb: { url: `https://store.example/${index}.webp`, width: 400, height: 400 },
    ...overrides,
  }
}

const TEN = Array.from({ length: 10 }, (_, index) => tile(index))

describe("VirtualizedGrid", () => {
  it("shows placeholders until the container has a width", () => {
    containerWidth = 0
    const { container } = render(<VirtualizedGrid items={TEN} />)
    expect(screen.queryAllByRole("link")).toHaveLength(0)
    expect(container.querySelector("[data-columns]")).toBeNull()
  })

  it("lays the items out in rows of the computed column count, in order", () => {
    const { container } = render(<VirtualizedGrid items={TEN} />)
    expect(container.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe("4")
    const list = screen.getByRole("list", { name: "Items" })
    const items = within(list).getAllByRole("listitem")
    expect(items).toHaveLength(10)
    expect(items[0]?.getAttribute("aria-posinset")).toBe("1")
    expect(items[9]?.getAttribute("aria-setsize")).toBe("10")
    const links = within(list).getAllByRole("link")
    expect(links.map((link) => link.getAttribute("href"))).toEqual(TEN.map((item) => `/wardrobe/${item.id}`))
    // Three rows: 4 + 4 + 2.
    expect(container.querySelectorAll("[data-index]")).toHaveLength(3)
  })

  it("names each card by its display name and category, with the badges as its description", () => {
    render(
      <VirtualizedGrid
        items={[
          tile(1, { name: "Rain shell", waterproof: true, decision: "bring", wearCount: 2 }),
          tile(2, { name: null, category: null, status: "pending_tagging", warmthLevel: null }),
        ]}
      />
    )
    const shell = screen.getByRole("link", { name: "Rain shell Outerwear" })
    const description = shell.getAttribute("aria-describedby") ?? ""
    expect(document.getElementById(description)?.textContent).toContain("Waterproof")
    expect(document.getElementById(description)?.textContent).toContain("Bring")
    expect(document.getElementById(description)?.textContent).toContain("Worn 2 times")
    const untagged = screen.getByRole("link", { name: "Untagged item" })
    expect(document.getElementById(untagged.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Waiting for tags"
    )
    // The photo's alt is empty: the name is already the link text.
    expect(shell.querySelector("img")?.getAttribute("alt")).toBe("")
  })

  it("words the status badge like the Status filter and the item page, with none when confirmed", () => {
    render(
      <VirtualizedGrid
        items={ITEM_STATUSES.map((status, index) => tile(index, { name: `Status ${status}`, status, warmthLevel: null }))}
      />
    )
    for (const status of ["pending_tagging", "tagged", "archived"] as const) {
      const link = screen.getByRole("link", { name: `Status ${status} Outerwear` })
      expect(document.getElementById(link.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
        STATUS_LABELS[status]
      )
    }
    const confirmed = screen.getByRole("link", { name: "Status confirmed Outerwear" })
    expect(confirmed.getAttribute("aria-describedby")).toBeNull()
  })

  it("puts the window back where the grid was when the page is shown again", () => {
    let scrollY = 0
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY)
    const scrollTo = vi.fn()
    vi.stubGlobal("scrollTo", scrollTo)
    // jsdom has no layout: the grid has boxes while shown and none once hidden.
    let displayed = true
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      () => ({ length: displayed ? 1 : 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList
    )
    const view = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <VirtualizedGrid items={TEN} />
      </Activity>
    )
    const { rerender } = render(view("visible"))

    // The owner scrolls down the list, then opens an item.
    scrollY = 1600
    window.dispatchEvent(new Event("scroll"))
    // Hiding the grid moves the window before the listener is gone; that is not the owner's scroll.
    displayed = false
    scrollY = 484
    window.dispatchEvent(new Event("scroll"))
    rerender(view("hidden"))
    // Back: the window is still where the item page left it.
    scrollY = 0
    window.dispatchEvent(new Event("scroll"))
    scrollTo.mockClear()
    displayed = true
    rerender(view("visible"))
    expect(scrollTo).toHaveBeenCalledWith(0, 1600)
  })

  it("stops every listener while the page is hidden and starts them again when shown", () => {
    const view = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <VirtualizedGrid items={TEN} />
      </Activity>
    )
    const { rerender } = render(view("visible"))
    expect(attached("resize")).toBeGreaterThan(0)
    expect(attached("scroll")).toBeGreaterThan(0)
    expect(FakeResizeObserver.watching()).toBeGreaterThan(0)

    rerender(view("hidden"))
    expect(attached("resize")).toBe(0)
    expect(attached("scroll")).toBe(0)
    expect(FakeResizeObserver.watching()).toBe(0)

    // Resized while hidden: shown again, the grid measures afresh.
    containerWidth = 1400
    rerender(view("visible"))
    expect(attached("resize")).toBeGreaterThan(0)
    expect(attached("scroll")).toBeGreaterThan(0)
    expect(FakeResizeObserver.watching()).toBeGreaterThan(0)
    expect(document.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe("6")
    expect(screen.getAllByRole("link")).toHaveLength(10)
  })
})
