"use client"

import { useEffect } from "react"

/** Registers the offline-shell service worker (public/sw.js) in production builds. Renders nothing. */
export function RegisterServiceWorker(): null {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return

    if (process.env.NODE_ENV !== "production") {
      // A worker left over from a local production run would serve dev chunks
      // cache-first under the same /_next/static URLs and hide code changes.
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
        .catch(() => undefined)
      return
    }

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch((error: unknown) => {
          // The app works without the worker; it only adds the offline fallback.
          console.warn("Service worker registration failed", error)
        })
    }

    // Waiting for load keeps precaching off the critical path of the first visit.
    if (document.readyState === "complete") {
      register()
      return
    }
    window.addEventListener("load", register, { once: true })
    return () => window.removeEventListener("load", register)
  }, [])

  return null
}
