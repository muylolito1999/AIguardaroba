// Item changes saved from this browser tab, so a page showing item data (the
// wardrobe list, the stats page) can tell when the copy it shows was read
// before one of them.
//
// With Cache Components, Next keeps visited pages mounted in a hidden
// <Activity> and serves browser back/forward from its client cache without
// asking the server again (node_modules/next/dist/docs/01-app/02-guides/
// preserving-ui-state.md; 04-glossary.md "Client Cache"). After the owner
// changes an item on its detail page and goes back, the list would still show
// the item as it was. Every client call site that saves an item change notes
// it here; the page compares the count with the one it saw when its data
// first arrived and refreshes itself when it is behind (D-107).
//
// Browser-only state: it lives as long as the tab's JavaScript, which is
// exactly as long as Next's client cache. Server code never imports this.

let changeCount = 0

// The count when each server data object was first shown. Keyed by the object
// the server sent, so data restored from Next's back/forward cache, which is
// the same object, keeps the count it was first shown with.
const firstShownAt = new WeakMap<object, number>()

// Changes a server data object already holds because the same server render
// made them before reading it (the review page applies finished batch results,
// then loads its cards). A refresh's data is recorded at the count when it was
// asked for; without this, those changes would make it stale at once.
const changesIncluded = new WeakMap<object, number>()

// Pages on screen that check again when a change is noted. A save can answer
// after the owner went Back: Next resolves the action anyway but does not
// refresh the page now shown, which had already checked the count on show.
const listeners = new Set<() => void>()

/**
 * Call once the server has confirmed a change to an item (tags, plan, status,
 * photos, a new or deleted item), from an event handler or an async callback,
 * never during render: listeners may start a router refresh.
 */
export function noteWardrobeChange(): void {
  changeCount += 1
  for (const listener of [...listeners]) listener()
}

/**
 * Notes a change the server made while rendering `data` and already read into
 * it, so that data does not count as stale because of it (D-136): pages that
 * show other data still see the change. Same rules as noteWardrobeChange.
 */
export function noteWardrobeChangeIn(data: object): void {
  changesIncluded.set(data, (changesIncluded.get(data) ?? 0) + 1)
  noteWardrobeChange()
}

/**
 * Calls `listener` after every noted change until the returned function is
 * called. Subscribe from an effect, so a page Next hides in an <Activity>
 * stops listening (the effect is cleaned up) and checks again when shown.
 */
export function subscribeWardrobeChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Notes a change when the result is a success, and passes the result through. */
export function noteWardrobeChangeIfOk<T extends { ok: boolean }>(result: T): T {
  if (result.ok) noteWardrobeChange()
  return result
}

/** How many item changes this tab has noted so far. */
export function wardrobeChangeCount(): number {
  return changeCount
}

/**
 * Records that this server data object was read once `count` changes had been
 * noted, plus the changes noted as already in it (noteWardrobeChangeIn), if
 * nothing was recorded for it yet. A page that asked for a refresh at that
 * count calls it for the data the refresh brings: other changes noted while
 * the request ran may not be in that data, so they still make it stale.
 */
export function noteDataReadAt(data: object, count: number): void {
  if (!firstShownAt.has(data)) firstShownAt.set(data, count + (changesIncluded.get(data) ?? 0))
}

/**
 * True when an item change was noted after this server data object (the
 * wardrobe list, the stats totals) was first shown, so it was read before the
 * change. The first call for an object records the current count and answers
 * false.
 */
export function shownDataIsStale(data: object): boolean {
  const shownAt = firstShownAt.get(data)
  if (shownAt === undefined) {
    firstShownAt.set(data, changeCount)
    return false
  }
  return shownAt < changeCount
}
