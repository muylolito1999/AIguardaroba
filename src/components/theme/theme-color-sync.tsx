"use client"

import { useEffect } from "react"
import { useTheme } from "next-themes"

import { THEME_COLORS } from "./theme-colors"

/**
 * The viewport theme-color tags follow the OS scheme through media queries, but the
 * theme toggle can override that scheme. Pointing every tag at the resolved theme
 * keeps the browser bar and the installed app's title bar the same colour as the page.
 * Renders nothing.
 */
export function ThemeColorSync(): null {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = THEME_COLORS[resolvedTheme]
      // Without the media query the browser takes the first tag, so both carry the same colour.
      meta.removeAttribute("media")
    }
  }, [resolvedTheme])

  return null
}
