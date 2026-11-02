// @vitest-environment jsdom
import { Activity } from "react"
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { shownDataIsStale } from "@/lib/items/wardrobe-changes"

import { NoteServerItemChanges } from "./note-server-item-changes"

afterEach(cleanup)

// The review page applies finished batch results while it renders on the
// server; a wardrobe list read before that must count as stale afterwards.
describe("NoteServerItemChanges", () => {
  it("notes a change once per server render, not on every return", () => {
    const listBefore = {}
    expect(shownDataIsStale(listBefore)).toBe(false)

    const poll = { processed: 2, problems: [] }
    const ui = (mode: "visible" | "hidden", render: object) => (
      <Activity mode={mode}>
        <NoteServerItemChanges render={render} />
      </Activity>
    )
    const view = render(ui("visible", poll))
    expect(shownDataIsStale(listBefore)).toBe(true)

    // A list read after it stays fresh across hide and show of the same render.
    const listAfter = {}
    expect(shownDataIsStale(listAfter)).toBe(false)
    view.rerender(ui("hidden", poll))
    view.rerender(ui("visible", poll))
    expect(shownDataIsStale(listAfter)).toBe(false)

    // A new server render that applied more results notes again.
    view.rerender(ui("visible", { processed: 1, problems: [] }))
    expect(shownDataIsStale(listAfter)).toBe(true)
  })
})
