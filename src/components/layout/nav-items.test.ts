import { Layers, Luggage, Plus, Settings, Shirt, ShoppingBag, Sun } from "lucide-react"
import { describe, expect, it } from "vitest"

import { PRIMARY_NAV, SECONDARY_NAV, SECONDARY_NAV_TAB, isNavItemActive, tabActiveOn } from "./nav-items"

describe("PRIMARY_NAV", () => {
  it("lists exactly the five primary destinations in tab order", () => {
    expect(PRIMARY_NAV.map(({ href, label }) => ({ href, label }))).toEqual([
      { href: "/wardrobe", label: "Wardrobe" },
      { href: "/add", label: "Add" },
      { href: "/relocate", label: "Relocate" },
      { href: "/shopping", label: "Shopping" },
      { href: "/settings", label: "Settings" },
    ])
  })

  it("pairs each destination with its icon", () => {
    expect(PRIMARY_NAV.map((item) => item.icon)).toEqual([
      Shirt,
      Plus,
      Luggage,
      ShoppingBag,
      Settings,
    ])
  })
})

describe("SECONDARY_NAV (D-218)", () => {
  it("lists Today and Outfits with their icons", () => {
    expect(SECONDARY_NAV.map(({ href, label, icon }) => ({ href, label, icon }))).toEqual([
      { href: "/today", label: "Today", icon: Sun },
      { href: "/outfits", label: "Outfits", icon: Layers },
    ])
  })

  it("adds no tab: the phone keeps five", () => {
    const primary = PRIMARY_NAV.map((item) => item.href)
    for (const item of SECONDARY_NAV) expect(primary).not.toContain(item.href)
    expect(PRIMARY_NAV).toHaveLength(5)
  })

  it("marks the Wardrobe tab, whose header links to them, on the secondary pages", () => {
    expect(SECONDARY_NAV_TAB).toBe("/wardrobe")
    const wardrobe = PRIMARY_NAV.find((item) => item.href === "/wardrobe")
    expect(wardrobe && tabActiveOn(wardrobe)).toEqual(["/stats", "/today", "/outfits"])
    // Its sidebar row keeps only its own sections; the sidebar lists the secondary pages itself.
    expect(wardrobe?.alsoActiveOn).toEqual(["/stats"])
    for (const item of PRIMARY_NAV.filter((entry) => entry.href !== "/wardrobe")) {
      expect(tabActiveOn(item)).toEqual(item.alsoActiveOn ?? [])
    }
  })
})

describe("isNavItemActive", () => {
  it("matches the route itself and nested routes", () => {
    expect(isNavItemActive("/add", "/add")).toBe(true)
    expect(isNavItemActive("/add/review", "/add")).toBe(true)
    expect(isNavItemActive("/relocate/0f8c", "/relocate")).toBe(true)
  })

  it("does not match a sibling that only shares a text prefix", () => {
    expect(isNavItemActive("/settingsx", "/settings")).toBe(false)
    expect(isNavItemActive("/wardrobe", "/add")).toBe(false)
  })

  it("matches the extra sections a tab owns", () => {
    expect(isNavItemActive("/stats", "/wardrobe", ["/stats"])).toBe(true)
    expect(isNavItemActive("/stats", "/wardrobe")).toBe(false)
    expect(isNavItemActive("/statsx", "/wardrobe", ["/stats"])).toBe(false)
    const wardrobe = PRIMARY_NAV.find((item) => item.href === "/wardrobe")
    expect(wardrobe?.alsoActiveOn).toEqual(["/stats"])
  })

  it("matches nothing while the pathname is unknown", () => {
    expect(isNavItemActive(null, "/wardrobe")).toBe(false)
  })
})
