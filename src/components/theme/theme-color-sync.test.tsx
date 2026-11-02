// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ThemeProvider, useTheme } from "next-themes"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ThemeColorSync } from "./theme-color-sync"
import { THEME_COLORS } from "./theme-colors"

function ChooseLight() {
  const { setTheme } = useTheme()
  return (
    <button type="button" onClick={() => setTheme("light")}>
      Light
    </button>
  )
}

function themeColorTags() {
  return [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => ({
    content: meta.content,
    media: meta.getAttribute("media"),
  }))
}

beforeEach(() => {
  // jsdom has no matchMedia; next-themes subscribes to the OS scheme through it. The OS reports light.
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
  window.localStorage.clear()
  document.head.innerHTML = `
    <meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)">`
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ThemeColorSync", () => {
  it("points every theme-color tag at the chosen theme, overriding the OS scheme", () => {
    render(
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        <ThemeColorSync />
        <ChooseLight />
      </ThemeProvider>
    )
    expect(themeColorTags()).toEqual([
      { content: THEME_COLORS.dark, media: null },
      { content: THEME_COLORS.dark, media: null },
    ])

    fireEvent.click(screen.getByRole("button", { name: "Light" }))
    expect(themeColorTags()).toEqual([
      { content: THEME_COLORS.light, media: null },
      { content: THEME_COLORS.light, media: null },
    ])
  })

  it("follows the OS scheme when the theme is system", () => {
    render(
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <ThemeColorSync />
      </ThemeProvider>
    )
    expect(themeColorTags().map((tag) => tag.content)).toEqual([THEME_COLORS.light, THEME_COLORS.light])
  })
})
