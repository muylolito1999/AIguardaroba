import { describe, expect, it } from "vitest"

import { previousWardrobeListHref, wardrobeListHref, type NavigationLike } from "./wardrobe-return"

const ORIGIN = "https://wardrobe.example"

/** A history of URLs with the current entry at `index`. */
function history(urls: Array<string | null>, index: number): NavigationLike {
  return { currentEntry: { index }, entries: () => urls.map((url) => ({ url })) }
}

describe("previousWardrobeListHref", () => {
  it("returns the previous entry's path and query when it is the wardrobe list", () => {
    const nav = history([`${ORIGIN}/add`, `${ORIGIN}/wardrobe?category=shoes&sort=wear_desc`, `${ORIGIN}/wardrobe/abc`], 2)
    expect(previousWardrobeListHref(nav, ORIGIN)).toBe("/wardrobe?category=shoes&sort=wear_desc")
    expect(previousWardrobeListHref(history([`${ORIGIN}/wardrobe`, `${ORIGIN}/wardrobe/abc`], 1), ORIGIN)).toBe(
      "/wardrobe"
    )
  })

  it("returns null for any other previous entry", () => {
    // Another item, another page, another origin, and a path that only starts like the list.
    for (const previous of [`${ORIGIN}/wardrobe/other`, `${ORIGIN}/stats`, "https://elsewhere.example/wardrobe", `${ORIGIN}/wardrobes`]) {
      expect(previousWardrobeListHref(history([previous, `${ORIGIN}/wardrobe/abc`], 1), ORIGIN)).toBeNull()
    }
  })

  it("returns null without a previous entry or the Navigation API", () => {
    expect(previousWardrobeListHref(history([`${ORIGIN}/wardrobe/abc`], 0), ORIGIN)).toBeNull()
    expect(previousWardrobeListHref({ currentEntry: null, entries: () => [] }, ORIGIN)).toBeNull()
    expect(previousWardrobeListHref(history([null, `${ORIGIN}/wardrobe/abc`], 1), ORIGIN)).toBeNull()
    expect(previousWardrobeListHref(null, ORIGIN)).toBeNull()
  })
})

describe("wardrobeListHref", () => {
  it("opens the view of the item's collection (D-251)", () => {
    expect(wardrobeListHref("clothing")).toBe("/wardrobe")
    expect(wardrobeListHref("running")).toBe("/wardrobe?collection=running")
  })
})
