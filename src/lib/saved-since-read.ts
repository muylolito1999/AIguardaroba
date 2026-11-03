"use client"

// What a page saved after the server copy it shows was read (D-180).
//
// The relocation plan and /shopping show what this tab saved on top of the
// server's copy: an override, a packing tick, gaps added, a row's status. A
// newer copy usually holds those saves, but not always: a Server Action does
// not wait for a refresh the page asked for earlier (router.refresh() leaves
// Next's action queue at once), so a refresh read before a save can land
// after it and would show the state from before the save. So every save the
// server confirmed gets a number, every refresh the page asks for records the
// number reached when it was asked, and a new copy keeps showing the saves
// numbered after that. When it keeps any, the page reads once more.
//
// Overlapping refreshes bring one copy, the newest: React renders the
// router's queued transition updates together. That copy is counted from the
// oldest refresh still waiting, the safe side (at worst one more read). A copy
// no refresh of this page asked for came with a navigation, which may have
// read before saves confirmed since: a link to the page already shown (the
// Shopping link on /shopping) reads it while the page stays usable, and a
// save pressed meanwhile answers before the copy lands. So that copy counts
// as read when the previous copy was, the safe side again: the saves made
// since stay, and the page reads once more (D-183).

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

/** The read time of the first copy: saves are numbered from 1, so it holds none of this page's. */
const BEFORE_ANY_SAVE = 0

/**
 * router.refresh(), at most once per effect flush: when Next shows a kept page
 * again, its checks (one for item changes, one for shopping-list changes, one
 * for kept saves) run in the same flush and share one read instead of reading
 * the whole page once each (D-180). Calls from later tasks (a timer, a save's
 * answer) each read. `onRead` runs when a read is actually asked for; pass a
 * stable function.
 */
export function useSharedRefresh(onRead?: () => void): () => void {
  const router = useRouter()
  const asked = useRef(false)
  return useCallback(() => {
    if (asked.current) return
    asked.current = true
    // Effects of one commit run in one task; the microtask after it ends the flush.
    queueMicrotask(() => {
      asked.current = false
    })
    onRead?.()
    router.refresh()
  }, [router, onRead])
}

export type ServerCopy = {
  /** The server copy this render shows. */
  readonly data: object
  /** The saves numbered up to this are in `data`. */
  readonly readAt: number
  /** Numbers a save the server confirmed. Call from a handler or callback, never during render. */
  readonly confirmSave: () => number
  /** Reads the page again (shared per effect flush), recording which saves the read will hold. */
  readonly refresh: () => void
  /** Reads once more because `data` may lack saves shown over it; once per copy and show. */
  readonly rereadFor: (data: object) => void
}

type CopyState = {
  data: object
  readAt: number
  /** The save number when the oldest refresh not answered yet was asked for. */
  requestedAt: number | null
}

/**
 * Tracks the server copy a page shows (a new object from every server read)
 * and when it was read, for the overlays useSavedOverlay keeps over it.
 */
export function useServerCopy(data: object): ServerCopy {
  const saves = useRef(0)
  const rereadAsked = useRef<object | null>(null)
  const [state, setState] = useState<CopyState>(() => ({ data, readAt: BEFORE_ANY_SAVE, requestedAt: null }))

  // A new copy holds the saves numbered up to the oldest refresh still
  // waiting; one this page did not ask for, only those the previous copy held
  // (see above). Adjusted during render, so the overlays never show the new
  // copy without the saves it lacks; functional, so an update queued meanwhile
  // keeps its place.
  let current = state
  if (state.data !== data) {
    const arrive = (previous: CopyState): CopyState =>
      previous.data === data ? previous : { data, readAt: previous.requestedAt ?? previous.readAt, requestedAt: null }
    current = arrive(state)
    setState(arrive)
  }

  const recordRead = useCallback(() => {
    // Read now: the updater may run later, after more saves were numbered.
    const at = saves.current
    setState((previous) => (previous.requestedAt === null ? { ...previous, requestedAt: at } : previous))
  }, [])
  const refresh = useSharedRefresh(recordRead)

  const confirmSave = useCallback(() => {
    saves.current += 1
    return saves.current
  }, [])

  const rereadFor = useCallback(
    (copy: object) => {
      if (rereadAsked.current === copy) return
      rereadAsked.current = copy
      refresh()
    },
    [refresh]
  )
  // Next hiding the page forgets the mark: a read that a navigation discarded
  // brings no new copy, and showing the page again asks once more.
  useEffect(
    () => () => {
      rereadAsked.current = null
    },
    []
  )

  return useMemo(
    () => ({ data: current.data, readAt: current.readAt, confirmSave, refresh, rereadFor }),
    [current.data, current.readAt, confirmSave, refresh, rereadFor]
  )
}

type Saved<V> = { readonly value: V; readonly save: number }

type OverlayState<V> = {
  data: object
  saved: ReadonlyMap<string, Saved<V>>
  values: ReadonlyMap<string, V>
  /** A copy that came while saves it may lack were kept: the page reads once more. */
  keptFor: object | null
}

function valuesOf<V>(saved: ReadonlyMap<string, Saved<V>>): ReadonlyMap<string, V> {
  return new Map([...saved].map(([key, entry]) => [key, entry.value]))
}

/** The overlay over a new copy: the saves it holds go, the newer ones stay. */
function overNewCopy<V>(previous: OverlayState<V>, data: object, readAt: number): OverlayState<V> {
  const kept = [...previous.saved].filter(([, entry]) => entry.save > readAt)
  const keptFor = kept.length > 0 ? data : null
  // Unchanged maps keep their identity, so memoised panels that show them skip the render (D-174).
  if (kept.length === previous.saved.size) return { ...previous, data, keptFor }
  const saved = new Map(kept)
  return { data, saved, values: valuesOf(saved), keptFor }
}

/**
 * Values this page saved, keyed by row or item id, shown over the server copy
 * until a copy read after their save arrives (D-180). The setter is stable
 * and does not depend on the copy, so a save that answers after a new copy
 * arrived still shows.
 */
export function useSavedOverlay<V>(copy: ServerCopy): [ReadonlyMap<string, V>, (key: string, value: V) => void] {
  const [state, setState] = useState<OverlayState<V>>(() => ({
    data: copy.data,
    saved: new Map(),
    values: new Map(),
    keptFor: null,
  }))

  let current = state
  if (state.data !== copy.data) {
    const { data, readAt } = copy
    const arrive = (previous: OverlayState<V>): OverlayState<V> =>
      previous.data === data ? previous : overNewCopy(previous, data, readAt)
    current = arrive(state)
    setState(arrive)
  }

  // From an effect, so it runs only while the page is shown (Next hides kept
  // pages in an <Activity>, which cleans effects up) and never in render.
  const { rereadFor, confirmSave } = copy
  const keptFor = current.keptFor
  useEffect(() => {
    if (keptFor !== null) rereadFor(keptFor)
  }, [keptFor, rereadFor])

  const set = useCallback(
    (key: string, value: V) => {
      const save = confirmSave()
      setState((previous) => {
        const saved = new Map(previous.saved)
        saved.set(key, { value, save })
        return { ...previous, saved, values: valuesOf(saved) }
      })
    },
    [confirmSave]
  )
  return [current.values, set]
}
