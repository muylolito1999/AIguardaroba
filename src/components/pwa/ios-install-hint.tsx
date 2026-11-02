"use client"

import { useSyncExternalStore, type JSX } from "react"
import { Share } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

type IosDevice = "iPhone" | "iPad"

const STANDALONE_QUERY = "(display-mode: standalone)"

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(STANDALONE_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

/** The iOS device to address, or null when the hint does not apply (other platforms, or already installed). */
function getSnapshot(): IosDevice | null {
  const nav: Navigator & { standalone?: boolean } = window.navigator
  if (nav.standalone === true || window.matchMedia(STANDALONE_QUERY).matches) return null
  const ua = nav.userAgent
  if (/iPhone|iPod/.test(ua)) return "iPhone"
  // iPadOS 13+ presents itself as desktop Safari ("MacIntel"); multi-touch gives it away.
  if (/iPad/.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)) return "iPad"
  return null
}

// The server cannot know the device, so it renders nothing and the client fills in after hydration.
function getServerSnapshot(): null {
  return null
}

/**
 * iOS never fires beforeinstallprompt, so installing is a manual Share-sheet step
 * the user has to be told about. Every iOS browser is WebKit and, since iOS 16.4,
 * offers Add to Home Screen from its share sheet, so the hint keys off the device.
 */
export function IosInstallHint({ className }: { className?: string }): JSX.Element | null {
  const device = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (!device) return null

  return (
    // role="note" overrides Alert's role="alert": a standing tip should not interrupt a screen reader.
    <Alert role="note" className={className}>
      <Share />
      <AlertTitle>Install on {device}</AlertTitle>
      <AlertDescription>Tap Share, then Add to Home Screen.</AlertDescription>
    </Alert>
  )
}
