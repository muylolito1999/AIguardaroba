import type { Route } from "next"
import { Luggage, Plus, Settings, Shirt, ShoppingBag, type LucideIcon } from "lucide-react"

export type NavItem = {
  href: Route
  label: string
  icon: LucideIcon
}

/** Single source for the desktop sidebar and the mobile tab bar; the order is the tab order. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/wardrobe", label: "Wardrobe", icon: Shirt },
  { href: "/add", label: "Add", icon: Plus },
  { href: "/relocate", label: "Relocate", icon: Luggage },
  { href: "/shopping", label: "Shopping", icon: ShoppingBag },
  { href: "/settings", label: "Settings", icon: Settings },
]

/** Prefix match on whole segments, so /add/review keeps Add active but /addresses would not. */
export function isNavItemActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false
  return pathname === href || pathname.startsWith(`${href}/`)
}
