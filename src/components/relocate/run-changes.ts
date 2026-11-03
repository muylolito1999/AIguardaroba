"use client"

// Relocation runs started or advanced, and climate profiles saved, from this
// browser tab, so /relocate, which Next keeps in a hidden <Activity> and
// serves from its client cache on Back, can tell that what it shows (its list
// of earlier runs, and the profiles in the form with their placeholder marks)
// was read before one of them changed (the same idea as D-107 for item data).
// Browser-only state that lives as long as the tab's JavaScript, like Next's
// client cache.

import { useRouter } from "next/navigation"
import { useEffect } from "react"

let changeCount = 0
// The count when each server list object was first shown, keyed by the object
// itself, so a list restored from the back/forward cache keeps its count.
const firstShownAt = new WeakMap<object, number>()

/** Call after the server confirmed a new run or a part's answer; never during render. */
export function noteRelocationRunChange(): void {
  changeCount += 1
}

/**
 * Call after the server saved a climate profile (its values or the default
 * flag); never during render. The relocation form lists the profiles, so
 * Back from /settings/climate reads /relocate again.
 */
export function noteClimateProfileChange(): void {
  changeCount += 1
}

/** True when a run changed after this list was first shown; the first call records the count. */
export function runListIsStale(list: object): boolean {
  const shownAt = firstShownAt.get(list)
  if (shownAt === undefined) {
    firstShownAt.set(list, changeCount)
    return false
  }
  return shownAt < changeCount
}

/**
 * Reads the page again when it is shown with a list of runs read before a run
 * or a climate profile changed in this tab. Effects run again whenever Next shows a kept page, so
 * Back from a run page refreshes the list once; a fresh navigation brings a
 * new list object, which counts as fresh. Renders nothing.
 */
export function RefreshRunsWhenShown({ list }: { list: object }) {
  const router = useRouter()
  useEffect(() => {
    if (runListIsStale(list)) router.refresh()
  }, [list, router])
  return null
}
