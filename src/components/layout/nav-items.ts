import type { Route } from "next"
import { Luggage, Plus, Settings, Shirt, ShoppingBag, type LucideIcon } from "lucide-react"

export type NavItem = {
  href: Route
  label: string
  icon: LucideIcon
  /** Other sections that belong to this tab, so the tab stays marked there (/stats is reached from the wardrobe). */
  alsoActiveOn?: readonly Route[]
}

/** Single source for the desktop sidebar and the mobile tab bar; the order is the tab order. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/wardrobe", label: "Wardrobe", icon: Shirt, alsoActiveOn: ["/stats"] },
  { href: "/add", label: "Add", icon: Plus },
  { href: "/relocate", label: "Relocate", icon: Luggage },
  { href: "/shopping", label: "Shopping", icon: ShoppingBag },
  { href: "/settings", label: "Settings", icon: Settings },
]

/**
 * Prefix match on whole segments, so /add/review keeps Add active but /addresses would not.
 * `alsoActiveOn` adds more sections that count as this tab.
 */
export function isNavItemActive(pathname: string | null, href: string, alsoActiveOn: readonly string[] = []): boolean {
  if (!pathname) return false
  return [href, ...alsoActiveOn].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
