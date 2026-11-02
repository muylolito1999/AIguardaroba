import { describe, expect, it, vi } from "vitest"

import {
  noteDataReadAt,
  noteWardrobeChange,
  noteWardrobeChangeIfOk,
  noteWardrobeChangeIn,
  shownDataIsStale,
  subscribeWardrobeChanges,
  wardrobeChangeCount,
} from "./wardrobe-changes"

describe("shownDataIsStale", () => {
  it("records a new list as fresh", () => {
    const list = {}
    expect(shownDataIsStale(list)).toBe(false)
    expect(shownDataIsStale(list)).toBe(false)
  })

  it("calls a list stale once a change is noted after it was first shown", () => {
    const list = {}
    expect(shownDataIsStale(list)).toBe(false)
    noteWardrobeChange()
    expect(shownDataIsStale(list)).toBe(true)
    // It stays stale until a newer list replaces it.
    expect(shownDataIsStale(list)).toBe(true)

    // The list read after the change is fresh.
    const refreshed = {}
    expect(shownDataIsStale(refreshed)).toBe(false)
  })

  it("notes a change only for a successful result", () => {
    const list = {}
    expect(shownDataIsStale(list)).toBe(false)

    const failure = { ok: false as const, error: "nope" }
    expect(noteWardrobeChangeIfOk(failure)).toBe(failure)
    expect(shownDataIsStale(list)).toBe(false)

    const success = { ok: true as const, data: 1 }
    expect(noteWardrobeChangeIfOk(success)).toBe(success)
    expect(shownDataIsStale(list)).toBe(true)
  })
})

describe("subscribeWardrobeChanges", () => {
  it("calls the listener after each noted change until it unsubscribes", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeWardrobeChanges(listener)

    noteWardrobeChange()
    expect(listener).toHaveBeenCalledTimes(1)
    noteWardrobeChangeIfOk({ ok: false as const, error: "nope" })
    expect(listener).toHaveBeenCalledTimes(1)
    noteWardrobeChangeIfOk({ ok: true as const, data: 1 })
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    noteWardrobeChange()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("sees the new count from inside the listener", () => {
    const list = {}
    expect(shownDataIsStale(list)).toBe(false)
    const seen: boolean[] = []
    const unsubscribe = subscribeWardrobeChanges(() => seen.push(shownDataIsStale(list)))
    noteWardrobeChange()
    unsubscribe()
    expect(seen).toEqual([true])
  })
})

describe("noteDataReadAt", () => {
  it("counts a change noted while a refresh ran as possibly missing from its data", () => {
    const askedAt = wardrobeChangeCount()
    noteWardrobeChange()
    const refreshed = {}
    noteDataReadAt(refreshed, askedAt)
    expect(shownDataIsStale(refreshed)).toBe(true)
  })

  it("does not count a change the same server render made before reading the data (D-136)", () => {
    const listElsewhere = {}
    expect(shownDataIsStale(listElsewhere)).toBe(false)
    const askedAt = wardrobeChangeCount()
    const cards = {}
    noteWardrobeChangeIn(cards)
    noteDataReadAt(cards, askedAt)
    expect(shownDataIsStale(cards)).toBe(false)
    // Other pages still see the change.
    expect(shownDataIsStale(listElsewhere)).toBe(true)
    // A later change still makes the data stale.
    noteWardrobeChange()
    expect(shownDataIsStale(cards)).toBe(true)
  })

  it("keeps the first count recorded for the data", () => {
    const list = {}
    expect(shownDataIsStale(list)).toBe(false)
    noteDataReadAt(list, wardrobeChangeCount() - 1)
    expect(shownDataIsStale(list)).toBe(false)
  })
})
