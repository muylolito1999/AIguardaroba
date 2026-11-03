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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

import { PRIMARY_NAV, isNavItemActive } from "./nav-items"

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
              <Suspense fallback={<NavMenu pathname={null} />}>
                <ActiveNavMenu />
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

function ActiveNavMenu() {
  return <NavMenu pathname={usePathname()} />
}

function NavMenu({ pathname }: { pathname: string | null }) {
  return (
    <SidebarMenu className="gap-1">
      {PRIMARY_NAV.map(({ href, label, icon: Icon, alsoActiveOn }) => {
        const active = isNavItemActive(pathname, href, alsoActiveOn)
        return (
          <SidebarMenuItem key={href}>
            <SidebarMenuButton
              render={<Link href={href} />}
              isActive={active}
              aria-current={active ? "page" : undefined}
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
