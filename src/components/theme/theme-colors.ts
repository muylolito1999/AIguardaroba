// Browser and installed-app chrome colours, matching --background in globals.css.
// Kept out of the "use client" sync component so the server layout gets the values,
// not client references.
export const THEME_COLORS = {
  light: "#ffffff",
  dark: "#0a0a0a",
} as const
