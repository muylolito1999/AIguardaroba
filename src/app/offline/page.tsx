import type { Metadata } from "next"
import { WifiOff } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"

export const metadata: Metadata = {
  title: "Offline",
}

// public/sw.js precaches this page and serves it when a navigation fails, so it
// stays fully static and outside the (app) group: no session, no data, no chrome.
export default function OfflinePage() {
  return (
    <main className="flex min-h-svh flex-1 flex-col items-center justify-center gap-6 px-6 py-12 text-center">
      <WifiOff className="size-12 text-muted-foreground" />
      <div className="flex max-w-sm flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">You are offline</h1>
        <p className="text-muted-foreground">
          Your wardrobe is stored online, so it needs a connection to load. Check your Wi-Fi or
          mobile data, then try again.
        </p>
      </div>
      {/* A plain anchor forces a full page load through the network instead of the client router. */}
      <a href="/wardrobe" className={buttonVariants({ size: "touch" })}>
        Try again
      </a>
    </main>
  )
}
