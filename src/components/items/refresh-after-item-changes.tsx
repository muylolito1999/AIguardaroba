"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"

import {
  noteDataReadAt,
  shownDataIsStale,
  subscribeWardrobeChanges,
  wardrobeChangeCount,
} from "@/lib/items/wardrobe-changes"

/**
 * Least time between two refreshes asked for while the page stays on screen
 * (D-130). A "Tag N waiting items" run on /add/review keeps answering after
 * the owner opened the wardrobe, about one answer a second, and each answer is
 * a noted change; without a limit the list would read all its items again for
 * every one of them. Showing the page again still checks at once.
 */
export const REFRESH_INTERVAL_MS = 5_000

export type RefreshAfterItemChangesOptions = {
  /**
   * Also check when a change is noted while the page is shown, such as a save
   * on an item page that answers after the owner went Back (default true).
   * The item and review pages turn it off: their own saves already show there.
   * Off, a change noted while one of the page's own refreshes runs still
   * brings one more refresh after the interval (D-136): the refreshed data may
   * have been read before that change, and the page takes the server's copy
   * of anything not being edited.
   */
  refreshWhileShown?: boolean
}

/**
 * Refreshes a page whose server data was read before the last item change
 * noted in this tab (D-107). Next keeps visited pages in a hidden <Activity>
 * and serves Back from its client cache, so the page would otherwise show the
 * data as it was.
 *
 * - Showing the page again (the same data object) checks at once, so Back
 *   never waits.
 * - While the page is shown it also listens for changes (D-123). The first
 *   change refreshes at once; later ones within REFRESH_INTERVAL_MS of the last
 *   refresh wait for the interval to pass and then share one refresh, so a
 *   burst of changes costs a few reads, not one each (D-130).
 * - The data a refresh brings counts as read when the refresh was asked for,
 *   so a change noted while the request ran still makes it stale: it may have
 *   been read before that change. Changes the same server render made before
 *   reading the data (noteWardrobeChangeIn) do not (D-136). New data that is
 *   stale waits for the interval like a noted change.
 * - A hidden page does not listen (Activity cleans the effects up, which also
 *   drops a waiting check), so it never re-reads in the background; it checks
 *   once it is shown. A fresh navigation brings a new data object, which
 *   counts as fresh.
 */
export function useRefreshAfterItemChanges(
  data: object,
  refresh: () => void,
  { refreshWhileShown = true }: RefreshAfterItemChangesOptions = {}
): void {
  // What a check that a timer runs later must use.
  const latest = useRef({ data, refresh })
  // The data object the last effect run saw; the same one again means Next showed the page again.
  const seenData = useRef<object | null>(null)
  // The change count when this page last asked for a refresh, until new data arrives.
  const requestedAt = useRef<number | null>(null)
  // When this page last asked for a refresh, and a check waiting for the interval to pass.
  const lastRefreshAt = useRef(Number.NEGATIVE_INFINITY)
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Hiding the page or unmounting it drops a waiting check; the next show checks at once.
  useEffect(
    () => () => {
      if (waiting.current !== null) clearTimeout(waiting.current)
      waiting.current = null
    },
    []
  )

  useEffect(() => {
    latest.current = { data, refresh }
    const arrived = seenData.current !== data
    seenData.current = data
    if (arrived && requestedAt.current !== null) {
      noteDataReadAt(data, requestedAt.current)
      requestedAt.current = null
    }

    const refreshIfStale = () => {
      const current = latest.current
      if (!shownDataIsStale(current.data)) return
      requestedAt.current = wardrobeChangeCount()
      lastRefreshAt.current = Date.now()
      current.refresh()
    }
    // A timer left waiting by an earlier run keeps going and checks the latest data.
    const refreshSoon = () => {
      if (waiting.current !== null || !shownDataIsStale(latest.current.data)) return
      const wait = lastRefreshAt.current + REFRESH_INTERVAL_MS - Date.now()
      if (wait <= 0) {
        refreshIfStale()
        return
      }
      waiting.current = setTimeout(() => {
        waiting.current = null
        refreshIfStale()
      }, wait)
    }

    // Called at once for every data object, so new data records the count it was shown at.
    if (shownDataIsStale(data)) {
      if (arrived) refreshSoon()
      else refreshIfStale()
    }
    return refreshWhileShown ? subscribeWardrobeChanges(refreshSoon) : undefined
  }, [data, refresh, refreshWhileShown])
}

export type RefreshAfterItemChangesProps = RefreshAfterItemChangesOptions & {
  /** An object from the server render (a new one on every render), standing for the data the page shows. */
  snapshot: object
}

/**
 * useRefreshAfterItemChanges with router.refresh(), for a server-rendered page
 * that shows item data: /stats (after an item opened from the checklist
 * changed, Back would show the old figures), the item page, /add/review and
 * /settings/export (its photo parts). Renders nothing.
 */
export function RefreshAfterItemChanges({ snapshot, refreshWhileShown }: RefreshAfterItemChangesProps) {
  const router = useRouter()
  const refresh = useCallback(() => router.refresh(), [router])
  useRefreshAfterItemChanges(snapshot, refresh, { refreshWhileShown })
  return null
}
