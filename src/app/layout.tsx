import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import { RegisterServiceWorker } from "@/components/pwa/register-sw"
import { ThemeColorSync } from "@/components/theme/theme-color-sync"
import { THEME_COLORS } from "@/components/theme/theme-colors"
import { ThemeProvider } from "@/components/theme/theme-provider"
import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"

import "./globals.css"

// globals.css maps --font-sans/--font-heading and --font-mono onto these variables.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: {
    default: "Wardrobe",
    template: "%s · Wardrobe",
  },
  description:
    "A climate-aware digital wardrobe: photograph your clothes, let AI tag them, and plan what to bring when you move.",
  applicationName: "Wardrobe",
  appleWebApp: {
    capable: true,
    title: "Wardrobe",
    // black-translucent always draws white status-bar text over the page, which is
    // invisible on the light theme; the default bar is opaque with readable text.
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the installed app use the full screen; layouts pad with the safe-area insets.
  viewportFit: "cover",
  // ThemeColorSync rewrites these once the chosen theme is known.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // next-themes sets the theme class on <html> before hydration, which React would otherwise flag.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="min-h-svh bg-background font-sans text-foreground antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ThemeColorSync />
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  )
}
