// Asks before the owner leaves a page whose work would be lost. While
// active, a reload, a tab close or an address-bar navigation gets the
// browser's own prompt (beforeunload), and a click on any in-app link is held
// back and reported as `pendingHref`, which the page shows in its own dialog.
// Next's client navigation fires no beforeunload, so links need the second
// path; it listens on window in the capture phase so it runs before any
// <Link> click handler.

import type { Route } from "next"
import { useRouter } from "next/navigation"
import { useEffect, useLayoutEffect, useState } from "react"

export type LeaveGuard = {
  /** The in-app address a held-back click was going to; null when no dialog is due. */
  pendingHref: string | null
  /** Closes the dialog and stays. */
  stay(): void
  /** Closes the dialog and follows the held-back link. */
  leave(): void
}

/** The same-origin address an unmodified left click on `target` would open in this tab, if any. */
export function internalLinkTarget(event: MouseEvent, location: Location): string | null {
  if (event.defaultPrevented || event.button !== 0) return null
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null
  const element = event.target instanceof Element ? event.target.closest("a[href]") : null
  if (!(element instanceof HTMLAnchorElement)) return null
  if ((element.target !== "" && element.target !== "_self") || element.hasAttribute("download")) return null
  const url = new URL(element.href, location.href)
  // Other sites unload the page, which beforeunload already covers.
  if (url.origin !== location.origin) return null
  // A link to a spot on this page (the skip link) leaves nothing.
  if (url.pathname === location.pathname && url.search === location.search) return null
  return `${url.pathname}${url.search}${url.hash}`
}

export function useLeaveGuard(active: boolean): LeaveGuard {
  const router = useRouter()
  const [pendingHref, setPendingHref] = useState<string | null>(null)

  // With cacheComponents, Next hides a page the owner leaves in an <Activity>,
  // which keeps this state. Back or a swipe can leave while the dialog is
  // open (the guard does not intercept those), so this cleanup, which runs on
  // that hide, closes it: otherwise it would be open again on return and
  // follow the old link. The reset pattern from preserving-ui-state.md in
  // node_modules/next/dist/docs/01-app/02-guides/. Not cleared when `active`
  // turns false: the owner may still be reading the dialog once uploads end.
  useLayoutEffect(() => () => setPendingHref(null), [])

  useEffect(() => {
    if (!active) return
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
    }
    function onClick(event: MouseEvent) {
      const href = internalLinkTarget(event, window.location)
      if (href === null) return
      event.preventDefault()
      event.stopPropagation()
      setPendingHref(href)
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    window.addEventListener("click", onClick, true)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
      window.removeEventListener("click", onClick, true)
    }
  }, [active])

  return {
    pendingHref,
    stay() {
      setPendingHref(null)
    },
    leave() {
      const href = pendingHref
      setPendingHref(null)
      // The address came from a rendered link of this app.
      if (href !== null) router.push(href as Route)
    },
  }
}
