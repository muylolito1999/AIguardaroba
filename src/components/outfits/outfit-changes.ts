"use client"

import { useEffect, useRef } from "react"

// Outfit changes saved in this tab (an outfit saved, deleted or logged as
// worn), for the pages that show outfits: /outfits and /outfits/[id]. Next
// keeps visited pages in a hidden <Activity> and serves Back from its client
// cache without asking the server again (the same gap D-107 closes for item
// changes), so a kept list would still show a deleted outfit or the old
// "Worn N times". A page notes the change once the server confirmed it; a
// page that shows outfits reads itself again when it is shown after one, and
// also while it is shown, because an Undo in a toast can answer on any page.
//
// Separate from the item change count on purpose: an outfit save changes no
// item, and the wardrobe list need not read up to 2,000 rows for it.
// Browser-only state that lives as long as the tab's JavaScript, like Next's
// client cache.

let changeCount = 0

// The count when each server data object was first shown. Data restored from
// Next's back/forward cache is the same object and keeps its count.
const firstShownAt = new WeakMap<object, number>()

const listeners = new Set<() => void>()

/** Call after the server confirmed an outfit change; from a handler or callback, never during render. */
export function noteOutfitChange(): void {
  changeCount += 1
  for (const listener of [...listeners]) listener()
}

/** True when a change was noted after this data was first shown. The first call records the count. */
export function outfitDataIsStale(data: object): boolean {
  const shownAt = firstShownAt.get(data)
  if (shownAt === undefined) {
    firstShownAt.set(data, changeCount)
    return false
  }
  return shownAt < changeCount
}

/**
 * Calls `refresh` when the outfit data a page shows was read before an outfit
 * change noted in this tab: when the page is shown again (the effect runs
 * whenever Next shows a kept page) and when a change is noted while it is
 * shown. A refresh's data counts as read when the refresh was asked for, so a
 * change noted while it ran still makes it stale. One refresh per data object
 * and show: a burst of changes waits for the data it asked for.
 */
export function useRefreshAfterOutfitChanges(data: object, refresh: () => void): void {
  const requestedAt = useRef<number | null>(null)
  const askedFor = useRef<object | null>(null)
  useEffect(() => {
    // New data from the refresh this page asked for counts from when it was asked.
    if (requestedAt.current !== null && !firstShownAt.has(data)) firstShownAt.set(data, requestedAt.current)
    requestedAt.current = null
    // A new show of the same data may ask again: a request made before Next hid the page may have been dropped.
    askedFor.current = null
    const check = () => {
      if (askedFor.current === data || !outfitDataIsStale(data)) return
      askedFor.current = data
      requestedAt.current = changeCount
      refresh()
    }
    check()
    listeners.add(check)
    return () => {
      listeners.delete(check)
    }
  }, [data, refresh])
}
