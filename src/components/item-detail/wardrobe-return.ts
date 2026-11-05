// Where "back to the wardrobe" should go. When the detail page was opened from
// the wardrobe list, going back in history returns to that list with its
// filters, scroll position and state (Next keeps it in <Activity>), which a
// fresh link to /wardrobe would lose.
//
// The Navigation API (navigation.entries()) is the only way to read the
// previous entry's URL from inside a single-page app; document.referrer stays
// at the first page load. TypeScript's DOM types do not include
// window.navigation yet, so a structural type stands in. Where the API is
// missing, nothing is returned and the caller keeps its plain link.
//
// The plain link, and the page shown after a delete, open the view of the
// item's own collection (D-251): a running gear item is not listed in the
// Clothes view.

import type { Route } from "next"

import { wardrobeHref } from "@/components/wardrobe/use-wardrobe-filters"
import type { ItemCollection } from "@/lib/db/enums"
import { DEFAULT_ITEM_FILTERS } from "@/lib/items/filters"

/** The pathname of the wardrobe list. */
export const WARDROBE_LIST_PATH = "/wardrobe"

/**
 * The unfiltered wardrobe list in the view of this collection (D-251): plain
 * /wardrobe for clothing, /wardrobe?collection=running for running gear.
 */
export function wardrobeListHref(collection: ItemCollection): Route {
  return wardrobeHref({ ...DEFAULT_ITEM_FILTERS, collection })
}

/** The part of the Navigation API used here. */
export type NavigationLike = {
  currentEntry: { index: number } | null
  entries(): ReadonlyArray<{ url: string | null }>
}

function isNavigationLike(value: unknown): value is NavigationLike {
  if (typeof value !== "object" || value === null) return false
  if (!("entries" in value) || typeof value.entries !== "function") return false
  if (!("currentEntry" in value)) return false
  const entry = value.currentEntry
  return entry === null || (typeof entry === "object" && "index" in entry && typeof entry.index === "number")
}

/** The browser's Navigation API, or null where it is not available. */
export function readNavigation(): NavigationLike | null {
  if (typeof window === "undefined" || !("navigation" in window)) return null
  const candidate: unknown = window.navigation
  return isNavigationLike(candidate) ? candidate : null
}

/**
 * The previous history entry's path and query when it is the wardrobe list of
 * this origin (for example "/wardrobe?category=shoes"), else null.
 */
export function previousWardrobeListHref(navigation: NavigationLike | null, origin: string): string | null {
  if (navigation === null) return null
  const index = navigation.currentEntry?.index ?? -1
  if (index <= 0) return null
  const raw = navigation.entries()[index - 1]?.url
  if (typeof raw !== "string") return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.origin !== origin || url.pathname !== WARDROBE_LIST_PATH) return null
  return `${url.pathname}${url.search}`
}
