"use client"

// Packing checklist changes saved from this tab: a box ticked or unticked, an
// extra added or removed on a result page. The print page is a server render
// that Next keeps in a hidden <Activity> and shows again on Back or Forward
// without asking the server, so it would print the earlier ticks; it reads
// itself again when shown after a change noted here (D-173), or after an item
// change, since it prints the items' decisions (D-181). A save pressed on the
// plan just before "Print checklist" can answer after the print page's read:
// before that page is first shown, or while it is shown. So a read counts from
// the press that asked for it, and a shown page listens (D-184). Browser-only
// state that lives as long as the tab's JavaScript, like Next's client cache.

import { useEffect } from "react"

import { useRefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import { noteDataReadAt, wardrobeChangeCount } from "@/lib/items/wardrobe-changes"
import { useSharedRefresh } from "@/lib/saved-since-read"

let changeCount = 0
// The count when each server read was first shown, keyed by an object of that
// read's payload, so a page restored from the back/forward cache keeps its count.
const firstShownAt = new WeakMap<object, number>()
// Print pages on screen, which check again when a change is noted.
const listeners = new Set<() => void>()
// Both counts when "Print checklist" was last pressed, until a print read is
// first shown. React commits that navigation only once a save still running on
// the plan has answered (the router's transition waits for the save's), so the
// save is noted after the print read was taken but before the page is shown.
let printAskedAt: { packing: number; items: number } | null = null

/** Call after the server confirmed a packing change; never during render (a listener may start a refresh). */
export function notePackingChange(): void {
  changeCount += 1
  for (const listener of [...listeners]) listener()
}

/** Call when the owner presses "Print checklist", from its click handler. */
export function notePrintAsked(): void {
  printAskedAt = { packing: changeCount, items: wardrobeChangeCount() }
}

/** True when a packing change was noted after this read was first shown; the first call records the count. */
export function packingReadIsStale(read: object): boolean {
  const shownAt = firstShownAt.get(read)
  if (shownAt === undefined) {
    firstShownAt.set(read, changeCount)
    return false
  }
  return shownAt < changeCount
}

/**
 * Reads the page again when it is shown with a checklist read before a
 * packing change or an item change in this tab (both at once read once,
 * D-180), and when such a change is noted while it is shown (D-184). `read`
 * is any object of the server render (a fresh read brings a new one); the
 * first read shown after "Print checklist" was pressed counts from the press.
 * Effects run again whenever Next shows a kept page, so Forward to the print
 * page after unticking a box or changing a decision on the plan refreshes it
 * once; a hidden page does not listen, since its refresh would read the page
 * on screen. Renders nothing.
 */
export function RefreshPrintWhenShown({ read }: { read: object }) {
  const refresh = useSharedRefresh()
  // Before the checks below, which record a new read at the counts of its first show.
  useEffect(() => {
    if (printAskedAt === null || firstShownAt.has(read)) return
    firstShownAt.set(read, Math.min(printAskedAt.packing, changeCount))
    noteDataReadAt(read, printAskedAt.items)
    printAskedAt = null
  }, [read])
  // A decision saved on the plan can answer while this page is shown.
  useRefreshAfterItemChanges(read, refresh)
  useEffect(() => {
    if (packingReadIsStale(read)) refresh()
    const check = () => {
      if (packingReadIsStale(read)) refresh()
    }
    listeners.add(check)
    return () => {
      listeners.delete(check)
    }
  }, [read, refresh])
  return null
}
