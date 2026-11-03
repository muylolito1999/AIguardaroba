"use client"

// Home city changes saved in this tab, for /today. Next keeps /today in a
// hidden <Activity> and serves Back from its client cache without asking the
// server again (the gap D-107 closes for item changes), so Back from Settings
// after choosing another home city would still show the old city's weather
// and suggestion. Settings notes the change once the server confirmed it;
// /today reads itself again when it is shown after one. Browser-only state
// that lives as long as the tab's JavaScript, like Next's client cache.

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"

let changeCount = 0

// The count when each server data object was first shown. Data restored from
// Next's back/forward cache is the same object and keeps its count.
const firstShownAt = new WeakMap<object, number>()

/** Call after the server confirmed a new home city; from a handler or callback, never during render. */
export function noteHomeCityChange(): void {
  changeCount += 1
}

/** True when the home city changed after this data was first shown. The first call records the count. */
export function homeCityDataIsStale(data: object): boolean {
  const shownAt = firstShownAt.get(data)
  if (shownAt === undefined) {
    firstShownAt.set(data, changeCount)
    return false
  }
  return shownAt < changeCount
}

/**
 * Calls `refresh` when the page is shown with data read before a home city
 * change. The effect runs on mount, for new data and every time Next shows
 * the kept page again. A refresh's data counts as read when the refresh was
 * asked for, so a change noted while it ran still counts.
 */
export function useRefreshAfterHomeCityChange(data: object, refresh: () => void): void {
  const requestedAt = useRef<number | null>(null)
  useEffect(() => {
    if (requestedAt.current !== null && !firstShownAt.has(data)) firstShownAt.set(data, requestedAt.current)
    requestedAt.current = null
    if (homeCityDataIsStale(data)) {
      requestedAt.current = changeCount
      refresh()
    }
  }, [data, refresh])
}

/**
 * The same check for /today's states without the view (no home city, no
 * weather), which hold no saves of their own: a plain router refresh.
 * `snapshot` is an object from the server render. Renders nothing.
 */
export function RefreshTodayWhenShown({ snapshot }: { snapshot: object }) {
  const router = useRouter()
  const refresh = useCallback(() => router.refresh(), [router])
  useRefreshAfterHomeCityChange(snapshot, refresh)
  return null
}
