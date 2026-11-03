// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MobileTabBar } from "./mobile-tab-bar"

const navigation = vi.hoisted(() => ({ pathname: "/wardrobe" }))

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}))

const TAB_NAMES = ["Wardrobe", "Add", "Relocate", "Shopping", "Settings"]

function tabLinks() {
  return within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link")
}

function renderTabs(pathname: string) {
  navigation.pathname = pathname
  render(<MobileTabBar />)
  return tabLinks()
}

/** Every tab's visible mark (the bar above it) and its aria-current, in tab order. */
function marking(links: HTMLElement[]) {
  return links.map((link) => ({
    name: link.textContent,
    marked: link.classList.contains("before:bg-foreground"),
    current: link.getAttribute("aria-current"),
  }))
}

/** The one tab marked, as name and aria-current; the visible mark must sit on the same tab. */
function markedTab(links: HTMLElement[]) {
  const tabs = marking(links)
  const marked = tabs.filter((tab) => tab.marked)
  expect(tabs.filter((tab) => tab.current !== null)).toEqual(marked)
  return marked.map(({ name, current }) => ({ name, current }))
}

afterEach(cleanup)

describe("MobileTabBar", () => {
  it("renders the five primary tabs as links named by their visible labels", () => {
    const links = renderTabs("/wardrobe")

    expect(links).toHaveLength(5)
    TAB_NAMES.forEach((name, index) => {
      expect(screen.getByRole("link", { name })).toBe(links[index])
    })
  })

  it.each([
    ["/wardrobe", "Wardrobe"],
    ["/add", "Add"],
    ["/relocate", "Relocate"],
    ["/shopping", "Shopping"],
    ["/settings", "Settings"],
  ])("marks the tab whose own page %s is open as the current page", (pathname, name) => {
    expect(markedTab(renderTabs(pathname))).toEqual([{ name, current: "page" }])
  })

  it.each([
    ["/wardrobe/3f2a", "Wardrobe"],
    ["/stats", "Wardrobe"],
    ["/add/review", "Add"],
    ["/relocate/3f2a", "Relocate"],
    ["/settings/usage", "Settings"],
  ])("marks the section's tab on %s but not as the current page", (pathname, name) => {
    expect(markedTab(renderTabs(pathname))).toEqual([{ name, current: "true" }])
  })

  it("marks no tab on a route outside the primary sections", () => {
    const links = renderTabs("/offline")

    expect(markedTab(links)).toEqual([])
    expect(links.some((link) => link.hasAttribute("aria-current"))).toBe(false)
  })

  it.each(["/today", "/outfits", "/outfits/3f2a", "/outfits/new"])(
    "marks Wardrobe on %s, which has no tab of its own, as its section, not its page (D-230)",
    (pathname) => {
      expect(markedTab(renderTabs(pathname))).toEqual([{ name: "Wardrobe", current: "true" }])
    }
  )

  it("marks a page the same way whichever page came before it (D-218)", () => {
    const fresh = marking(renderTabs("/today"))
    cleanup()
    expect(fresh.filter((tab) => tab.marked || tab.current !== null)).toEqual([
      { name: "Wardrobe", marked: true, current: "true" },
    ])

    for (const previous of ["/settings", "/wardrobe", "/outfits/3f2a", "/add/review", "/offline"]) {
      navigation.pathname = previous
      const { rerender } = render(<MobileTabBar />)
      navigation.pathname = "/today"
      rerender(<MobileTabBar />)

      expect(marking(tabLinks())).toEqual(fresh)
      cleanup()
    }
  })

  it("gives every tab at least a 44px tap target", () => {
    const links = renderTabs("/wardrobe")

    for (const link of links) {
      expect(link.classList.contains("min-h-11")).toBe(true)
    }
  })
})
