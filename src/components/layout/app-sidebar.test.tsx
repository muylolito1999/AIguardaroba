// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { SidebarProvider } from "@/components/ui/sidebar"

import { AppSidebar } from "./app-sidebar"

const navigation = vi.hoisted(() => ({ pathname: "/wardrobe" }))

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}))

// The theme switch and logout button in the footer are not under test here.
vi.mock("@/components/theme/theme-toggle", () => ({ ThemeToggle: () => null }))
vi.mock("@/components/auth/logout-button", () => ({ LogoutButton: () => null }))

beforeAll(() => {
  // jsdom has no matchMedia; the sidebar's mobile check only needs an answer.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  })
})

afterEach(cleanup)

function sidebarLinks() {
  return {
    primary: within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link"),
    secondary: within(screen.getByRole("navigation", { name: "Get dressed" })).getAllByRole("link"),
  }
}

function sidebar() {
  return (
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  )
}

function renderSidebar(pathname: string) {
  navigation.pathname = pathname
  render(sidebar())
  return sidebarLinks()
}

/** Every row's visible mark (data-active, which draws the inset bar) and its aria-current, group by group. */
function marking({ primary, secondary }: { primary: HTMLElement[]; secondary: HTMLElement[] }) {
  return [...primary, ...secondary].map((link) => ({
    name: link.textContent,
    marked: link.hasAttribute("data-active"),
    current: link.getAttribute("aria-current"),
  }))
}

/** The rows marked, as name and aria-current; the visible mark must sit on the same rows. */
function markedRows(links: { primary: HTMLElement[]; secondary: HTMLElement[] }) {
  const rows = marking(links)
  const marked = rows.filter((row) => row.marked)
  expect(rows.filter((row) => row.current !== null)).toEqual(marked)
  return marked.map(({ name, current }) => ({ name, current }))
}

describe("AppSidebar (D-218)", () => {
  it("lists the five primary sections, then Today and Outfits in a group of their own", () => {
    const { primary, secondary } = renderSidebar("/wardrobe")

    expect(primary.map((link) => link.textContent)).toEqual(["Wardrobe", "Add", "Relocate", "Shopping", "Settings"])
    expect(secondary.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Today", "/today"],
      ["Outfits", "/outfits"],
    ])
  })

  it.each([
    ["/wardrobe", "Wardrobe"],
    ["/add", "Add"],
    ["/relocate", "Relocate"],
    ["/shopping", "Shopping"],
    ["/settings", "Settings"],
    ["/today", "Today"],
    ["/outfits", "Outfits"],
  ])("marks the row whose own page %s is open as the current page, and no other", (pathname, name) => {
    expect(markedRows(renderSidebar(pathname))).toEqual([{ name, current: "page" }])
  })

  it.each([
    ["/wardrobe/3f2a", "Wardrobe"],
    ["/stats", "Wardrobe"],
    ["/add/review", "Add"],
    ["/relocate/3f2a", "Relocate"],
    ["/settings/climate", "Settings"],
    ["/outfits/3f2a", "Outfits"],
    ["/outfits/new", "Outfits"],
  ])("marks the section's row on %s but not as the current page", (pathname, name) => {
    expect(markedRows(renderSidebar(pathname))).toEqual([{ name, current: "true" }])
  })

  it("marks a page the same way whichever page came before it", () => {
    const fresh = marking(renderSidebar("/outfits/3f2a"))
    cleanup()
    expect(fresh.filter((row) => row.marked || row.current !== null)).toEqual([
      { name: "Outfits", marked: true, current: "true" },
    ])

    for (const previous of ["/settings", "/today", "/outfits", "/wardrobe/3f2a"]) {
      navigation.pathname = previous
      const { rerender } = render(sidebar())
      navigation.pathname = "/outfits/3f2a"
      rerender(sidebar())

      expect(marking(sidebarLinks())).toEqual(fresh)
      cleanup()
    }
  })

  it("gives every row a 44px tap target", () => {
    const { primary, secondary } = renderSidebar("/today")

    for (const link of [...primary, ...secondary]) expect(link.classList.contains("h-11")).toBe(true)
  })
})
