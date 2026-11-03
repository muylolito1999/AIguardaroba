// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MobileTabBar } from "./mobile-tab-bar"

const navigation = vi.hoisted(() => ({ pathname: "/wardrobe" }))

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}))

const TAB_NAMES = ["Wardrobe", "Add", "Relocate", "Shopping", "Settings"]

function renderTabs(pathname: string) {
  navigation.pathname = pathname
  render(<MobileTabBar />)
  return within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link")
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

  it("marks only the tab for the current section as the current page", () => {
    const links = renderTabs("/relocate/3f2a")

    const current = links.filter((link) => link.getAttribute("aria-current") === "page")
    expect(current).toEqual([screen.getByRole("link", { name: "Relocate" })])
  })

  it("marks no tab on a route outside the primary sections", () => {
    const links = renderTabs("/offline")

    expect(links.some((link) => link.hasAttribute("aria-current"))).toBe(false)
  })

  it.each(["/today", "/outfits", "/outfits/3f2a", "/outfits/new"])(
    "marks Wardrobe on %s, which has no tab of its own (D-218)",
    (pathname) => {
      const links = renderTabs(pathname)

      const current = links.filter((link) => link.getAttribute("aria-current") === "page")
      expect(current).toEqual([screen.getByRole("link", { name: "Wardrobe" })])
    }
  )

  it("gives every tab at least a 44px tap target", () => {
    const links = renderTabs("/wardrobe")

    for (const link of links) {
      expect(link.classList.contains("min-h-11")).toBe(true)
    }
  })
})
