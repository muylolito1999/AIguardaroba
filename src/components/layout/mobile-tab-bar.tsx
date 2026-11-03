"use client"

import { Suspense } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

import { PRIMARY_NAV, isNavItemActive, tabActiveOn } from "./nav-items"

/** Bottom navigation below the md breakpoint; the desktop sidebar takes over above it. */
export function MobileTabBar() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-safe backdrop-blur md:hidden print:hidden"
    >
      {/* Under Cache Components usePathname suspends on routes with unknown dynamic
          params, so the prerendered shell shows the tabs without an active state. */}
      <Suspense fallback={<TabList pathname={null} />}>
        <ActiveTabList />
      </Suspense>
    </nav>
  )
}

function ActiveTabList() {
  return <TabList pathname={usePathname()} />
}

function TabList({ pathname }: { pathname: string | null }) {
  return (
    <ul className="grid grid-cols-5">
      {PRIMARY_NAV.map((item) => {
        const { href, label, icon: Icon } = item
        // Five tabs only: the daily pages mark the tab whose header links to them (D-218).
        const active = isNavItemActive(pathname, href, tabActiveOn(item))
        return (
          <li key={href} className="flex">
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-xs font-medium text-muted-foreground transition-colors outline-none",
                "hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-inset",
                active &&
                  "font-semibold text-foreground before:absolute before:inset-x-4 before:top-0 before:h-0.5 before:rounded-full before:bg-foreground"
              )}
            >
              <Icon className="size-5" />
              <span className="max-w-full truncate">{label}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
