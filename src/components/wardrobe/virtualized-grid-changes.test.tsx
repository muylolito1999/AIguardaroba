// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WardrobeItemDto } from "@/lib/items/wardrobe"

import { VirtualizedGrid } from "./virtualized-grid"

// VirtualizedGrid when its items or columns change under it: a D-107 refresh
// (a new array with the same items), a filter change, and a resize, zoom or
// rotation while a card has keyboard focus. jsdom has no layout, so sizes and
// the window are stubbed.

function idOf(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
}

function tile(index: number, overrides: Partial<WardrobeItemDto> = {}): WardrobeItemDto {
  return {
    id: idOf(index),
    name: `Item ${index}`,
    category: "outerwear",
    subcategory: null,
    status: "confirmed",
    decision: "undecided",
    location: "bologna",
    warmthLevel: 3,
    waterproof: index % 3 === 0,
    windproof: index % 3 === 0,
    insulated: false,
    colors: ["navy"],
    colorHex: ["#1f2a44"],
    wearCount: 0,
    multipleItemsDetected: false,
    thumb: { url: `https://store.example/${index}.webp`, width: 400, height: 400 },
    ...overrides,
  }
}

const ITEMS = Array.from({ length: 200 }, (_, index) => tile(index))
const GAP = 16

let scrollY = 0

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("measured row heights across new results", () => {
  // At 390 px: 2 columns of 171 px tiles, estimate 247 px. A card whose badges
  // fit on one line makes a 245 px row; every third item has two more badges,
  // which wrap, and its row is 269 px.
  const ONE_LINE = 245
  const WRAPPED = 269

  /** Real height of a rendered row: its tallest card. */
  function heightOf(element: Element): number {
    if (!(element instanceof HTMLElement) || element.dataset.index === undefined) return 0
    const indexes = [...element.querySelectorAll("[data-item-id]")].map((card) =>
      Number(card.getAttribute("data-item-id")?.slice(-12))
    )
    return Math.max(0, ...indexes.map((index) => (index % 3 === 0 ? WRAPPED : ONE_LINE)))
  }

  /** Reports a size on observe and again only when an observed element's size changes, as a browser does. */
  class ReportingResizeObserver {
    static instances: ReportingResizeObserver[] = []
    readonly reported = new Map<Element, number>()
    constructor(readonly callback: ResizeObserverCallback) {
      ReportingResizeObserver.instances.push(this)
    }
    private report(target: Element) {
      const blockSize = heightOf(target)
      this.reported.set(target, blockSize)
      const entry = { target, borderBoxSize: [{ blockSize, inlineSize: 358 }] } as unknown as ResizeObserverEntry
      this.callback([entry], this as unknown as ResizeObserver)
    }
    observe(target: Element) {
      this.reported.set(target, -1)
      queueMicrotask(() => {
        if (this.reported.has(target)) this.report(target)
      })
    }
    unobserve(target: Element) {
      this.reported.delete(target)
    }
    disconnect() {
      this.reported.clear()
    }
    /** What a browser does after layout. */
    static flush() {
      for (const observer of ReportingResizeObserver.instances) {
        for (const [target, last] of [...observer.reported]) {
          if (last !== -1 && target.isConnected && heightOf(target) !== last) observer.report(target)
        }
      }
    }
  }

  beforeEach(() => {
    scrollY = 0
    ReportingResizeObserver.instances = []
    vi.stubGlobal("ResizeObserver", ReportingResizeObserver)
    vi.stubGlobal("scrollTo", (a: ScrollToOptions | number, b?: number) => {
      scrollY = typeof a === "number" ? (b ?? 0) : (a.top ?? scrollY)
    })
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 358)
    vi.spyOn(window, "innerHeight", "get").mockImplementation(() => 844)
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY)
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return heightOf(this)
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top: -scrollY, left: 0, right: 0, bottom: 0, width: 358, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect
    )
  })

  type Row = { index: number; top: number; height: number }

  function rows(container: HTMLElement): Row[] {
    return [...container.querySelectorAll<HTMLElement>("[data-index]")].map((row) => ({
      index: Number(row.dataset.index),
      top: Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]),
      height: heightOf(row),
    }))
  }

  /** Adjacent rendered rows whose spacing is not their real height plus the gap. */
  function misplaced(container: HTMLElement): string[] {
    const list = rows(container).sort((a, b) => a.index - b.index)
    const out: string[] = []
    for (let i = 0; i + 1 < list.length; i += 1) {
      const a = list[i]
      const b = list[i + 1]
      if (a === undefined || b === undefined || b.index !== a.index + 1) continue
      if (a.top + a.height + GAP !== b.top) out.push(`${a.index}->${b.index}: pitch ${b.top - a.top}, real ${a.height + GAP}`)
    }
    return out
  }

  async function settle() {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        ReportingResizeObserver.flush()
        await Promise.resolve()
      })
    }
    // The virtualizer's scroll-end fallback (150 ms).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    await act(async () => {
      ReportingResizeObserver.flush()
    })
  }

  /** Scrolls about 30 rows down, renders `next(ITEMS)` as a new list, and reports where the rows ended up. */
  async function rerenderDeepInTheList(next: (items: readonly WardrobeItemDto[]) => readonly WardrobeItemDto[]) {
    const { container, rerender } = render(<VirtualizedGrid items={ITEMS} />)
    await settle()
    for (let y = 0; y <= 30 * 270; y += 300) {
      scrollY = y
      await act(async () => {
        window.dispatchEvent(new Event("scroll"))
      })
      await act(async () => {
        ReportingResizeObserver.flush()
      })
    }
    await settle()
    const anchor = rows(container).find((row) => row.top - scrollY >= 0)
    if (anchor === undefined) throw new Error("no row on screen")
    const before = anchor.top - scrollY
    const scrollBefore = scrollY
    expect(misplaced(container)).toEqual([])

    await act(async () => {
      rerender(<VirtualizedGrid items={next(ITEMS)} />)
    })
    await settle()
    const after = rows(container).find((row) => row.index === anchor.index)
    return {
      before,
      after: after === undefined ? undefined : after.top - scrollY,
      scrollMoved: scrollY - scrollBefore,
      misplaced: misplaced(container),
    }
  }

  it("keeps every measured height when a refresh brings the same items", async () => {
    const result = await rerenderDeepInTheList((items) => [...items])
    expect(result.scrollMoved).toBe(0)
    expect(result.after).toBe(result.before)
    expect(result.misplaced).toEqual([])
  })

  it("keeps the rows still when a refresh brings a changed plan on screen", async () => {
    const result = await rerenderDeepInTheList((items) =>
      items.map((item, index) => (index === 61 ? { ...item, decision: "donate" as const } : item))
    )
    expect(result.after).toBe(result.before)
    expect(result.misplaced).toEqual([])
  })

  it("measures the rows whose tiles changed after a filter change", async () => {
    const result = await rerenderDeepInTheList((items) => items.filter((_, index) => index !== 62))
    expect(result.after).toBe(result.before)
    expect(result.misplaced).toEqual([])
  })

  // The same results read again with an item more or less ABOVE the screen
  // (newest first, Back from /add; a batch or a late save removing one): every
  // row from there on gets new tiles and a new key, and the rows above the
  // rendered ones are estimates again (D-131).
  describe("when the results change above the screen", () => {
    beforeEach(() => {
      // As in a browser, a scroll the page makes is reported by a scroll event.
      vi.stubGlobal("scrollTo", (a: ScrollToOptions | number, b?: number) => {
        scrollY = typeof a === "number" ? (b ?? 0) : (a.top ?? scrollY)
        queueMicrotask(() => window.dispatchEvent(new Event("scroll")))
      })
      // jsdom has no layout; the grid has boxes, so it counts as displayed.
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
        () => ({ length: 1, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList
      )
    })

    /** Screen top (translateY - scrollY) of the row holding item `id`. */
    function screenTopOf(container: HTMLElement, id: string): number | undefined {
      const row = container.querySelector(`[data-item-id="${id}"]`)?.closest<HTMLElement>("[data-index]")
      if (!row) return undefined
      return Number(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1]) - scrollY
    }

    /** Scrolls to `toY`, then renders `next(ITEMS)` as the same results read again. */
    async function rereadAt(toY: number, next: (items: readonly WardrobeItemDto[]) => readonly WardrobeItemDto[]) {
      const { container, rerender } = render(<VirtualizedGrid items={ITEMS} resultsKey="sort=created_desc" />)
      await settle()
      for (let y = 0; y <= toY; y += 300) {
        scrollY = Math.min(y, toY)
        await act(async () => {
          window.dispatchEvent(new Event("scroll"))
        })
        await act(async () => {
          ReportingResizeObserver.flush()
        })
      }
      scrollY = toY
      await act(async () => {
        window.dispatchEvent(new Event("scroll"))
      })
      await settle()
      // The first card whose row starts on screen.
      const anchor = [...container.querySelectorAll<HTMLElement>("[data-item-id]")]
        .map((card) => card.dataset.itemId ?? "")
        .find((id) => (screenTopOf(container, id) ?? -1) >= 0)
      if (anchor === undefined) throw new Error("no card on screen")
      const before = screenTopOf(container, anchor)
      await act(async () => {
        rerender(<VirtualizedGrid items={next(ITEMS)} resultsKey="sort=created_desc" />)
      })
      await settle()
      return { container, anchor, before, after: screenTopOf(container, anchor), misplaced: misplaced(container) }
    }

    it("keeps the card on screen in place when a new item arrives at the top", async () => {
      const result = await rereadAt(30 * 270, (items) => [tile(1000), ...items])
      expect(result.after).toBeDefined()
      expect(Math.abs((result.after ?? 0) - (result.before ?? 0))).toBeLessThanOrEqual(1)
      expect(result.misplaced).toEqual([])
    })

    it("keeps the card on screen in place when an item above it is gone", async () => {
      const result = await rereadAt(30 * 270, (items) => items.filter((_, index) => index !== 4))
      expect(result.after).toBeDefined()
      expect(Math.abs((result.after ?? 0) - (result.before ?? 0))).toBeLessThanOrEqual(1)
      expect(result.misplaced).toEqual([])
    })

    it("moves nothing when the same items come back or one is added at the end", async () => {
      const same = await rereadAt(30 * 270, (items) => [...items])
      expect(same.after).toBe(same.before)
      cleanup()
      const appended = await rereadAt(30 * 270, (items) => [...items, tile(1000)])
      expect(appended.after).toBe(appended.before)
    })

    it("shows a new item at the top when the owner is at the top of the list", async () => {
      const result = await rereadAt(0, (items) => [tile(1000), ...items])
      expect(scrollY).toBe(0)
      expect(result.container.querySelector('[data-index="0"] [data-item-id]')?.getAttribute("data-item-id")).toBe(
        idOf(1000)
      )
    })
  })
})

describe("keyboard focus across a column change", () => {
  // Rows read as 250 px; the ResizeObserver never reports.
  class SilentResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  let containerWidth = 358

  beforeEach(() => {
    containerWidth = 358
    scrollY = 0
    vi.stubGlobal("ResizeObserver", SilentResizeObserver)
    vi.stubGlobal("scrollTo", vi.fn())
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => containerWidth)
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY)
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.index === undefined ? 0 : 250
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.dataset.index === undefined ? 0 : 250
      return {
        top: -scrollY,
        left: 0,
        right: 0,
        bottom: height,
        width: containerWidth,
        height,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect
    })
  })

  function linkOf(container: HTMLElement, index: number): HTMLAnchorElement | null {
    return container.querySelector<HTMLAnchorElement>(`a[href="/wardrobe/${idOf(index)}"]`)
  }

  /** Renders at `fromWidth`, scrolls to `scrollRow`, focuses item `index`, then resizes to `toWidth`. */
  async function focusThenResize(index: number, scrollRow: number, fromWidth: number, toWidth: number) {
    containerWidth = fromWidth
    const { container } = render(<VirtualizedGrid items={ITEMS} />)
    scrollY = scrollRow * (250 + GAP)
    await act(async () => {
      window.dispatchEvent(new Event("scroll"))
    })
    const before = linkOf(container, index)
    if (before === null) throw new Error(`item ${index} is not rendered`)
    await act(async () => {
      before.focus()
    })
    expect(document.activeElement).toBe(before)
    containerWidth = toWidth
    await act(async () => {
      window.dispatchEvent(new Event("resize"))
    })
    return { container, after: linkOf(container, index) }
  }

  it("keeps focus on the card far down the list when the columns grow", async () => {
    const { container, after } = await focusThenResize(40, 20, 358, 812)
    expect(container.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe("4")
    expect(after).not.toBeNull()
    expect(document.activeElement).toBe(after)
  })

  it("keeps focus when the columns shrink (zooming in)", async () => {
    const { after } = await focusThenResize(40, 10, 812, 358)
    expect(after).not.toBeNull()
    expect(document.activeElement).toBe(after)
  })

  it("keeps focus near the top, where the card moves to a row already on screen", async () => {
    const { after } = await focusThenResize(2, 0, 358, 812)
    expect(document.activeElement).toBe(after)
  })

  it("leaves focus alone when no card had it", async () => {
    const { container } = render(<VirtualizedGrid items={ITEMS} />)
    containerWidth = 812
    await act(async () => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(container.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe("4")
    expect(document.activeElement).toBe(document.body)
  })
})
