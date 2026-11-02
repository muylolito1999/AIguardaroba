"use client"

import type { Route } from "next"
import { useRouter } from "next/navigation"
import { useCallback, useLayoutEffect, useOptimistic, useRef, useTransition } from "react"

import { itemFiltersKey, parseItemFilters, serializeItemFilters, type ItemFilters } from "@/lib/items/filters"

export const WARDROBE_PATH = "/wardrobe"

/** The wardrobe URL for these filters; defaults are left out, so the plain page is just /wardrobe. */
export function wardrobeHref(filters: ItemFilters): Route {
  const query = itemFiltersKey(filters)
  return query === "" ? WARDROBE_PATH : `${WARDROBE_PATH}?${query}`
}

/** A partial change merged into the current filters, or a function from the current filters to the next. */
export type FiltersChange = Partial<ItemFilters> | ((current: ItemFilters) => ItemFilters)

export type WardrobeFiltersState = {
  /** What the controls show: the latest requested filters while a request runs, else the server's. */
  filters: ItemFilters
  /** True while a filter change or a refresh is waiting for the server's new list. */
  isPending: boolean
  update: (change: FiltersChange) => void
  /** Reads the current URL's list again (router.refresh) in the same transition, so isPending covers it. */
  refresh: () => void
}

/**
 * The URL is the only filter state (D-041 pages read searchParams on the
 * server). A change replaces the URL in a transition; while the server renders
 * the new list, useOptimistic shows the requested filters, so a second quick
 * change builds on the first instead of on the stale props. When the
 * transition ends the optimistic value is dropped and the server's parsed
 * filters take over again, so nothing on the client can disagree with the URL
 * for longer than one request. router.replace, not push: a filter tweak is not
 * a page the back button should step through; leaving the page and coming back
 * (or Back from an item) restores the URL, and the page renders from it.
 */
export function useWardrobeFilters(serverFilters: ItemFilters): WardrobeFiltersState {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [filters, setOptimisticFilters] = useOptimistic(serverFilters)
  // The filters of the latest commit. Callbacks read it instead of closing over
  // a render, so a debounced search started before a chip click keeps the chip.
  const latestRef = useRef(filters)
  useLayoutEffect(() => {
    latestRef.current = filters
  })

  const update = useCallback(
    (change: FiltersChange) => {
      const current = latestRef.current
      const merged = typeof change === "function" ? change(current) : { ...current, ...change }
      // Canonical form (sorted, deduplicated, defaults filled in), so the
      // optimistic value equals what the server will parse from the URL.
      const next = parseItemFilters(serializeItemFilters(merged))
      if (itemFiltersKey(next) === itemFiltersKey(current)) return
      // A second change before the next render builds on this one.
      latestRef.current = next
      startTransition(() => {
        setOptimisticFilters(next)
        // scroll: false keeps the toolbar and the typed search where they are.
        router.replace(wardrobeHref(next), { scroll: false })
      })
    },
    [router, setOptimisticFilters],
  )

  const refresh = useCallback(() => {
    startTransition(() => {
      router.refresh()
    })
  }, [router])

  return { filters, isPending, update, refresh }
}
