import { describe, expect, it } from "vitest"

import { mergeServerItems } from "./review-merge"
import { pendingCard, taggedCard } from "./test-fixtures"

const NONE: ReadonlySet<string> = new Set()
const BATCH_ID = "11111111-1111-4111-8111-111111111111"

function ids(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id)
}

describe("mergeServerItems", () => {
  it("follows the server's order and adds new ids", () => {
    const a = taggedCard({ name: "A" })
    const b = taggedCard({ name: "B" })
    const fresh = pendingCard()

    const merged = mergeServerItems([a, b], [fresh, b, a], NONE, NONE)

    expect(ids(merged)).toEqual([fresh.id, b.id, a.id])
  })

  it("takes the server card for items nobody is working on", () => {
    const stale = pendingCard({ taggingBatchId: BATCH_ID })
    const applied = taggedCard({ id: stale.id, name: "Batch-tagged coat", taggingBatchId: null })

    const [merged] = mergeServerItems([stale], [applied], NONE, NONE)

    expect(merged).toBe(applied)
  })

  it("keeps the local card of a dirty or busy item", () => {
    const dirty = taggedCard({ name: "Local dirty" })
    const busy = pendingCard({ taggingError: "local" })
    const server = [taggedCard({ id: dirty.id, name: "Server" }), pendingCard({ id: busy.id })]

    const merged = mergeServerItems([dirty, busy], server, new Set([dirty.id]), new Set([busy.id]))

    expect(merged[0]).toBe(dirty)
    expect(merged[1]).toBe(busy)
  })

  it("drops items the server no longer lists, dirty ones included", () => {
    const confirmedElsewhere = taggedCard()
    const dirtyGone = taggedCard()
    const stays = taggedCard()

    const merged = mergeServerItems(
      [confirmedElsewhere, dirtyGone, stays],
      [stays],
      new Set([dirtyGone.id]),
      NONE
    )

    expect(ids(merged)).toEqual([stays.id])
  })

  it("keeps a busy item the server no longer lists, after the card it followed", () => {
    const first = taggedCard()
    const running = pendingCard()
    const last = taggedCard()
    const fresh = pendingCard()

    const merged = mergeServerItems([first, running, last], [fresh, first, last], NONE, new Set([running.id]))

    expect(ids(merged)).toEqual([fresh.id, first.id, running.id, last.id])
    expect(merged[2]).toBe(running)
  })

  it("puts a busy unlisted first item at the top", () => {
    const running = pendingCard()
    const other = taggedCard()

    const merged = mergeServerItems([running, other], [other], NONE, new Set([running.id]))

    expect(ids(merged)).toEqual([running.id, other.id])
  })

  it("keeps a dirty card a capped list no longer lists, after every server item", () => {
    const a = taggedCard()
    const b = taggedCard()
    const dirtyOld = taggedCard({ name: "Edited deep in the list" })
    const fresh = pendingCard()

    const merged = mergeServerItems([a, b, dirtyOld], [fresh, a, b], new Set([dirtyOld.id]), NONE, {
      capped: true,
    })

    expect(ids(merged)).toEqual([fresh.id, a.id, b.id, dirtyOld.id])
    expect(merged[3]).toBe(dirtyOld)
  })

  it("drops an unlisted card from a capped list when nobody is working on it", () => {
    const a = taggedCard()
    const old = taggedCard()
    const fresh = pendingCard()

    const merged = mergeServerItems([a, old], [fresh, a], NONE, NONE, { capped: true })

    expect(ids(merged)).toEqual([fresh.id, a.id])
  })

  it("fills an empty local list from the server", () => {
    const a = taggedCard()
    const b = pendingCard()

    expect(mergeServerItems([], [a, b], NONE, NONE)).toEqual([a, b])
  })
})
