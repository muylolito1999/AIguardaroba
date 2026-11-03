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

function renderSidebar(pathname: string) {
  navigation.pathname = pathname
  render(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  )
  return {
    primary: within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link"),
    secondary: within(screen.getByRole("navigation", { name: "Get dressed" })).getAllByRole("link"),
  }
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

  it("marks only the secondary page itself, not Wardrobe, on an outfit page", () => {
    const { primary, secondary } = renderSidebar("/outfits/3f2a")

    const current = [...primary, ...secondary].filter((link) => link.getAttribute("aria-current") === "page")
    expect(current.map((link) => link.textContent)).toEqual(["Outfits"])
  })

  it("gives every row a 44px tap target", () => {
    const { primary, secondary } = renderSidebar("/today")

    for (const link of [...primary, ...secondary]) expect(link.classList.contains("h-11")).toBe(true)
  })
})
