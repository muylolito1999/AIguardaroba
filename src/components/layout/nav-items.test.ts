import { Luggage, Plus, Settings, Shirt, ShoppingBag } from "lucide-react"
import { describe, expect, it } from "vitest"

import { PRIMARY_NAV, isNavItemActive } from "./nav-items"

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

  it("matches nothing while the pathname is unknown", () => {
    expect(isNavItemActive(null, "/wardrobe")).toBe(false)
  })
})
