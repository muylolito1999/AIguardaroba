import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function getSnapshot() {
  return window.matchMedia(MOBILE_QUERY).matches
}

// The server has no viewport; report "not mobile" there and on the first
// client render, exactly like the original hook did.
function getServerSnapshot() {
  return false
}

/**
 * True below the `md` breakpoint. Do not use this to decide whether layout
 * chrome renders (it is false during SSR); use CSS `md:hidden` for that.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
