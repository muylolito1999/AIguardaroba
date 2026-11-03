import type { Route } from "next"
import { Layers, Luggage, Plus, Settings, Shirt, ShoppingBag, Sun, type LucideIcon } from "lucide-react"

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

/** The heading of the secondary pages wherever they are listed. */
export const SECONDARY_NAV_LABEL = "Get dressed"

/**
 * The daily pages (D-218). On desktop they are a second sidebar group. A phone
 * keeps five tabs, so there they are links in the wardrobe header and in
 * Settings, and the Wardrobe tab stays marked on them (tabActiveOn).
 */
export const SECONDARY_NAV: readonly NavItem[] = [
  { href: "/today", label: "Today", icon: Sun },
  { href: "/outfits", label: "Outfits", icon: Layers },
]

/** The tab that leads to the secondary pages on a phone: its header links to them. */
export const SECONDARY_NAV_TAB: Route = "/wardrobe"

/**
 * The sections a mobile tab is marked on: its own extra sections, plus the
 * secondary pages for the tab whose header links to them. The sidebar, which
 * lists the secondary pages itself, uses only `alsoActiveOn`.
 */
export function tabActiveOn(item: NavItem): readonly Route[] {
  const own = item.alsoActiveOn ?? []
  return item.href === SECONDARY_NAV_TAB ? [...own, ...SECONDARY_NAV.map((secondary) => secondary.href)] : own
}

/**
 * Prefix match on whole segments, so /add/review keeps Add active but /addresses would not.
 * `alsoActiveOn` adds more sections that count as this tab.
 */
export function isNavItemActive(pathname: string | null, href: string, alsoActiveOn: readonly string[] = []): boolean {
  if (!pathname) return false
  return [href, ...alsoActiveOn].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
