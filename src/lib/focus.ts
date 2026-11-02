// Browser-only focus helpers for client components; server code never calls them.

/**
 * Focus has nowhere useful to stay: nothing has it, <body> has it, or the
 * element that had it left the page. Focus is moved after a request settles or
 * the content changes only then (or when it is still where the action
 * started), so it is never taken from a field the owner moved to meanwhile.
 */
export function focusWasLost(active: Element | null): boolean {
  return active === null || active === document.body || !active.isConnected
}
