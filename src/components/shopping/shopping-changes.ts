"use client"

import { useEffect, useRef } from "react"

// Shopping list changes saved in this tab, for the pages that show the list or
// what it holds: "Add to shopping list" on /relocate/[id] and a run finishing
// in this tab (its purchase budget prefills /shopping's budget field) change
// what /shopping shows; a gap row deleted on /shopping changes which gaps the
// plan's Gaps tab shows as on the list (D-151, D-173). Next keeps these pages
// in a hidden <Activity> and serves Back from its client cache without asking
// the server again (the same gap D-107 closes for item changes). A page notes
// the change once the server confirmed it; a page that shows the list reads
// itself again when it is shown after one.
//
// The list is small and changes rarely, so this is simpler than the wardrobe's
// mechanism: no listener while shown (the page that saves is the one on
// screen) and no rate limit.

let changeCount = 0

// The count when each server list object was first shown. Data restored from
// Next's back/forward cache is the same object and keeps its count.
const firstShownAt = new WeakMap<object, number>()

/** Call after a server-confirmed change to the shopping list made outside /shopping. */
export function noteShoppingListChange(): void {
  changeCount += 1
}

/**
 * Call after a server-confirmed change made on the page that shows `list`
 * (a gap row deleted on /shopping): other pages read again, and `list` counts
 * as read after the change, since its page shows it already. Only when the
 * list was current: a change noted elsewhere before still refreshes it.
 */
export function noteShoppingListChangeShownIn(list: object): void {
  const wasCurrent = firstShownAt.get(list) === changeCount
  changeCount += 1
  if (wasCurrent) firstShownAt.set(list, changeCount)
}

/** True when a change was noted after this list was first shown. The first call records the count. */
export function shoppingListIsStale(list: object): boolean {
  const shownAt = firstShownAt.get(list)
  if (shownAt === undefined) {
    firstShownAt.set(list, changeCount)
    return false
  }
  return shownAt < changeCount
}

/**
 * Refreshes the page when the list it shows (or the result view, on a plan
 * page) was read before a change noted elsewhere. The effect runs on mount, on
 * new data and every time Next shows the page again, so Back after "Add to
 * shopping list" re-reads /shopping, and Back after deleting a gap row there
 * re-reads the plan. A refresh brings a new object, which is recorded at the
 * count when the refresh was asked for, so a change noted while it ran still
 * counts.
 */
export function useRefreshAfterShoppingChanges(list: object, refresh: () => void): void {
  const requestedAt = useRef<number | null>(null)
  useEffect(() => {
    if (requestedAt.current !== null && !firstShownAt.has(list)) {
      firstShownAt.set(list, requestedAt.current)
    }
    requestedAt.current = null
    if (shoppingListIsStale(list)) {
      requestedAt.current = changeCount
      refresh()
    }
  }, [list, refresh])
}
