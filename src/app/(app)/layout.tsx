import { AppSidebar } from "@/components/layout/app-sidebar"
import { MobileTabBar } from "@/components/layout/mobile-tab-bar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

// SidebarInset already renders <main>, so it is the #main landmark itself; nesting
// a second <main> inside it would be invalid HTML and an axe violation.
// Top/side padding adds the safe-area insets because viewport-fit=cover lets the
// installed app draw under a landscape notch (the top inset is 0 under the opaque
// iOS status bar); the bottom padding clears the fixed mobile tab bar plus the
// home indicator.
const MAIN_CLASSES =
  "min-w-0 flex-1 px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(4.5rem+env(safe-area-inset-bottom))] outline-none md:pt-[calc(1.5rem+env(safe-area-inset-top))] md:pr-[max(2rem,env(safe-area-inset-right))] md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] md:pl-8"

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <a
        href="#main"
        // Padding sits under focus: because not-sr-only resets padding to 0 with focus specificity.
        className="sr-only rounded-md bg-background text-sm font-medium text-foreground shadow-lg ring-2 ring-foreground focus:not-sr-only focus:fixed focus:top-[calc(0.5rem+env(safe-area-inset-top))] focus:left-2 focus:z-50 focus:px-4 focus:py-2.5"
      >
        Skip to content
      </a>
      <SidebarProvider>
        <AppSidebar />
        {/* tabIndex lets the skip link move keyboard focus, not just the scroll position. */}
        <SidebarInset id="main" tabIndex={-1} className={MAIN_CLASSES}>
          {children}
        </SidebarInset>
        <MobileTabBar />
      </SidebarProvider>
    </>
  )
}
