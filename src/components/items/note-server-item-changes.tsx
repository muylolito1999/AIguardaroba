"use client"

import { useEffect } from "react"

import { noteWardrobeChange, noteWardrobeChangeIn } from "@/lib/items/wardrobe-changes"

// Server render objects already noted. Next shows a kept page again with the
// same objects, and the effect below runs again each time.
const noted = new WeakSet<object>()

export type NoteServerItemChangesProps = {
  /** An object from the server render that changed items (a new one on every render). */
  render: object
  /**
   * The data the same render read after making the changes (the review page's
   * cards), which therefore already shows them. A RefreshAfterItemChanges for
   * that data rendered after this marker then does not read the page again
   * because of them (D-136).
   */
  includedIn?: object
}

/**
 * Notes item changes the server made while rendering this page, such as the
 * review page applying finished batch results, so the pages Next keeps hidden
 * (the wardrobe, an item page, /stats) read themselves again when shown
 * (D-107). Each server render is noted once. Renders nothing.
 */
export function NoteServerItemChanges({ render, includedIn }: NoteServerItemChangesProps) {
  useEffect(() => {
    if (noted.has(render)) return
    noted.add(render)
    if (includedIn === undefined) noteWardrobeChange()
    else noteWardrobeChangeIn(includedIn)
  }, [render, includedIn])
  return null
}
