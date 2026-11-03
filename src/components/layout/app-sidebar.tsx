"use client"

import { Suspense } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Shirt } from "lucide-react"

import { LogoutButton } from "@/components/auth/logout-button"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

import { PRIMARY_NAV, SECONDARY_NAV, SECONDARY_NAV_LABEL, navItemCurrent, type NavItem } from "./nav-items"

const SECONDARY_LABEL_ID = "sidebar-secondary-nav"

/** Desktop navigation from the md breakpoint up; the mobile tab bar covers smaller screens. */
export function AppSidebar() {
  return (
    <Sidebar
      collapsible="none"
      // Insets keep the content clear of the status bar and a landscape notch in the installed iOS app.
      className="sticky top-0 hidden h-svh shrink-0 border-r pt-safe pl-[env(safe-area-inset-left)] md:flex print:hidden"
    >
      <SidebarHeader>
        <div className="flex h-11 items-center gap-2 px-2">
          <Shirt className="size-5" />
          <span className="font-heading text-base font-semibold tracking-tight">Wardrobe</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label="Primary">
              {/* usePathname suspends on routes with unknown dynamic params under
                  Cache Components; the shell then shows the menu without an active item. */}
              <Suspense fallback={<NavMenu items={PRIMARY_NAV} pathname={null} />}>
                <ActiveNavMenu items={PRIMARY_NAV} />
              </Suspense>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
        {/* The daily pages, a group of their own so the five primary rows match the
            phone's tab bar (D-218). Full-strength text: the dimmed default label
            would fall short of 4.5:1 at this size. */}
        <SidebarGroup>
          <SidebarGroupLabel id={SECONDARY_LABEL_ID} className="text-sidebar-foreground">
            {SECONDARY_NAV_LABEL}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-labelledby={SECONDARY_LABEL_ID}>
              <Suspense fallback={<NavMenu items={SECONDARY_NAV} pathname={null} />}>
                <ActiveNavMenu items={SECONDARY_NAV} />
              </Suspense>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <ThemeToggle className="w-full" />
        {/* Ghost keeps it quieter than the theme switch above; touch height matches the nav rows. */}
        <LogoutButton variant="ghost" className="w-full" />
      </SidebarFooter>
    </Sidebar>
  )
}

function ActiveNavMenu({ items }: { items: readonly NavItem[] }) {
  return <NavMenu items={items} pathname={usePathname()} />
}

function NavMenu({ items, pathname }: { items: readonly NavItem[]; pathname: string | null }) {
  return (
    <SidebarMenu className="gap-1">
      {items.map(({ href, label, icon: Icon, alsoActiveOn }) => {
        // Same mark on a row's own page and inside its section (/stats, /outfits/[id]);
        // aria-current says "page" only on the former.
        const current = navItemCurrent(pathname, href, alsoActiveOn)
        return (
          <SidebarMenuItem key={href}>
            <SidebarMenuButton
              render={<Link href={href} />}
              isActive={current !== undefined}
              aria-current={current}
              // 44px rows suit touch tablets at this width; the inset bar marks the
              // active item with real contrast, which the accent tint alone lacks.
              className="h-11 gap-3 focus-visible:ring-sidebar-foreground data-active:shadow-[inset_3px_0_0_var(--sidebar-foreground)]"
            >
              <Icon />
              <span>{label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}
