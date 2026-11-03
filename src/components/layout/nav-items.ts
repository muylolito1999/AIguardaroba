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

/**
 * The `aria-current` token of a marked link. WAI-ARIA 1.2 defines "page" as the
 * current page in a set of pages and "true" as the current item in a set: a tab
 * marked because the open page lies inside its section (/wardrobe/[id], /stats,
 * /add/review, /today on a phone) is the current item, not the current page.
 */
export type NavCurrent = "page" | "true"

/**
 * How a link is marked, from the pathname alone, so a page reads the same however
 * it was reached (D-218, D-230). "page" only when the link's own page is open; "true"
 * when the link marks the section around the open page; undefined when unmarked.
 * Either token draws the same visible mark; only assistive technology hears the difference.
 */
export function navItemCurrent(
  pathname: string | null,
  href: string,
  alsoActiveOn: readonly string[] = []
): NavCurrent | undefined {
  if (!isNavItemActive(pathname, href, alsoActiveOn)) return undefined
  return pathname === href ? "page" : "true"
}
