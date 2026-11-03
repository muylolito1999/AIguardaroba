// @vitest-environment jsdom
import { Activity } from "react"
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { noteWardrobeChange } from "@/lib/items/wardrobe-changes"

import { notePackingChange, notePrintAsked, RefreshPrintWhenShown } from "./packing-changes"

const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

beforeEach(() => {
  router.refresh.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("RefreshPrintWhenShown (D-173)", () => {
  it("reads the print page again when Next shows it after a packing change, and only then", () => {
    const read = { analysisId: "a" }
    const ui = (mode: "visible" | "hidden", shown: object = read) => (
      <Activity mode={mode}>
        <RefreshPrintWhenShown read={shown} />
      </Activity>
    )
    const rendered = render(ui("visible"))
    rendered.rerender(ui("hidden"))
    rendered.rerender(ui("visible"))
    expect(router.refresh).not.toHaveBeenCalled()

    // Back to the plan, a box unticked there, then Forward to the kept print page.
    rendered.rerender(ui("hidden"))
    act(() => notePackingChange())
    rendered.rerender(ui("visible"))
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The refresh brings a new read, which is current.
    rendered.rerender(ui("visible", { analysisId: "a" }))
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("reads it again after a decision changed elsewhere, since it prints them, once for both kinds of change (D-181)", async () => {
    const read = { analysisId: "b" }
    const ui = (mode: "visible" | "hidden", shown: object = read) => (
      <Activity mode={mode}>
        <RefreshPrintWhenShown read={shown} />
      </Activity>
    )
    const rendered = render(ui("visible"))
    rendered.rerender(ui("hidden"))
    // An override on the plan or the item page.
    act(() => noteWardrobeChange())
    rendered.rerender(ui("visible"))
    expect(router.refresh).toHaveBeenCalledTimes(1)
    // A later show is a later task.
    await act(async () => {
      await Promise.resolve()
    })

    const refreshed = { analysisId: "b" }
    rendered.rerender(ui("visible", refreshed))
    rendered.rerender(ui("hidden", refreshed))
    act(() => {
      noteWardrobeChange()
      notePackingChange()
    })
    rendered.rerender(ui("visible", refreshed))
    // Both changes, one read.
    await act(async () => {
      await Promise.resolve()
    })
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it("reads it again when a save from the plan answers while it is shown, and only listens while shown (D-184)", async () => {
    const read = { analysisId: "c" }
    const ui = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <RefreshPrintWhenShown read={read} />
      </Activity>
    )
    const rendered = render(ui("visible"))
    expect(router.refresh).not.toHaveBeenCalled()

    // A tick pressed on the plan just before "Print checklist" answers now.
    act(() => notePackingChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    await act(async () => {
      await Promise.resolve()
    })
    // So does a decision pressed there before it.
    act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(2)
    await act(async () => {
      await Promise.resolve()
    })

    // Hidden by Next, it does not listen (a refresh would read the page on screen); shown, it checks once.
    rendered.rerender(ui("hidden"))
    act(() => notePackingChange())
    expect(router.refresh).toHaveBeenCalledTimes(2)
    rendered.rerender(ui("visible"))
    expect(router.refresh).toHaveBeenCalledTimes(3)
  })

  it("counts a read from the press of Print checklist, so a save that answers before the page is first shown reads it again (D-184)", async () => {
    // A tick still saving when Print is pressed: React commits the print page only once it answered.
    act(() => notePrintAsked())
    act(() => notePackingChange())
    const ticked = render(<RefreshPrintWhenShown read={{ analysisId: "d" }} />)
    expect(router.refresh).toHaveBeenCalledTimes(1)
    ticked.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    // A decision still saving, the same way.
    act(() => notePrintAsked())
    act(() => noteWardrobeChange())
    const decided = render(<RefreshPrintWhenShown read={{ analysisId: "d" }} />)
    expect(router.refresh).toHaveBeenCalledTimes(2)
    decided.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    // Nothing saving: no read. The press counts for one read only; a later one counts from its own show.
    act(() => notePrintAsked())
    render(<RefreshPrintWhenShown read={{ analysisId: "d" }} />).unmount()
    act(() => notePackingChange())
    render(<RefreshPrintWhenShown read={{ analysisId: "d" }} />)
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })
})
