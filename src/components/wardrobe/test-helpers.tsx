import { use, useLayoutEffect, useState } from "react"
import { vi } from "vitest"

import { parseItemFilters, type ItemFilters } from "@/lib/items/filters"

import { CategoryChips } from "./category-chips"
import { useWardrobeFilters } from "./use-wardrobe-filters"
import { WardrobeToolbar } from "./wardrobe-toolbar"
import type { CategoryCounts } from "@/lib/items/wardrobe"

// Test-only helpers for the wardrobe controls: a page stand-in whose "server"
// re-parses the URL the router was asked to show, and the browser APIs jsdom
// lacks. Not imported by app code.

/** What the fake server does with a replaced URL: parse it, as the page does. */
export function filtersFromHref(href: string): ItemFilters {
  return parseItemFilters(new URL(href, "http://localhost").searchParams)
}

/**
 * Stands in for the server rendering a new URL. With `until`, the render
 * suspends until that promise settles, so the router's transition stays
 * pending the way a real navigation does while the server works.
 */
export type Navigate = (filters: ItemFilters, until?: Promise<void>) => void

type HarnessProps = {
  initial: ItemFilters
  counts: CategoryCounts
  onNavigatorReady: (navigate: Navigate) => void
}

type ServerState = { filters: ItemFilters; until: Promise<void> | null }

/** The toolbar and chips wired to useWardrobeFilters, as WardrobeResults wires them. */
export function ControlsHarness({ initial, counts, onNavigatorReady }: HarnessProps) {
  const [server, setServer] = useState<ServerState>({ filters: initial, until: null })
  useLayoutEffect(() => {
    onNavigatorReady((filters, until) => setServer({ filters, until: until ?? null }))
  }, [onNavigatorReady])
  if (server.until !== null) use(server.until)
  const { filters, isPending, update } = useWardrobeFilters(server.filters)
  return (
    <>
      <WardrobeToolbar filters={filters} total={3} isPending={isPending} colorOptions={[]} onChange={update} />
      <CategoryChips filters={filters} counts={counts} onChange={update} />
    </>
  )
}

/**
 * jsdom has neither matchMedia (useIsMobile) nor ResizeObserver (Base UI
 * popups), and its scrollTo only reports "Not implemented" (the virtualizer
 * scrolls the window when measured rows differ from its estimates).
 */
export function installBrowserStubs(): void {
  Object.defineProperty(window, "scrollTo", { configurable: true, writable: true, value: vi.fn() })
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: () => false,
      }),
    })
  }
  if (typeof globalThis.ResizeObserver !== "function") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
}
