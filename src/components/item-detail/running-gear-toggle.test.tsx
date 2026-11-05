// @vitest-environment jsdom
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { taggedCard } from "@/components/items/test-fixtures"
import { toast } from "@/components/ui/toast"
import type { ItemCollection } from "@/lib/db/enums"
import type { ItemCardDto } from "@/lib/items/contracts"
import { err, ok, type Result } from "@/lib/result"

import type { SetItemCollectionAction } from "./detail-actions"
import { RunningGearToggle } from "./running-gear-toggle"

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ITEM_ID = "00000000-0000-4000-8000-0000000000aa"

type HarnessProps = {
  initial?: ItemCollection
  setItemCollection: SetItemCollectionAction
  onSaved?: (item: ItemCardDto) => void
}

/** Holds the saved collection like the detail page does. */
function Harness({ initial = "clothing", setItemCollection, onSaved }: HarnessProps) {
  const [collection, setCollection] = useState<ItemCollection>(initial)
  return (
    <RunningGearToggle
      itemId={ITEM_ID}
      collection={collection}
      setItemCollection={setItemCollection}
      onSaved={(item) => {
        onSaved?.(item)
        setCollection(item.collection)
      }}
    />
  )
}

function runningSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "Running gear" })
}

function checked(): string | null {
  return runningSwitch().getAttribute("aria-checked")
}

/** A promise the test settles by hand, to look at the page while the save runs. */
function deferred() {
  let settle: (result: Result<ItemCardDto>) => void = () => undefined
  const promise = new Promise<Result<ItemCardDto>>((done) => {
    settle = done
  })
  return { promise, settle }
}

describe("RunningGearToggle", () => {
  it("is a labelled switch, described, and off for clothing", () => {
    render(<Harness setItemCollection={vi.fn()} />)

    expect(checked()).toBe("false")
    const describedBy = runningSwitch().getAttribute("aria-describedby") ?? ""
    expect(document.getElementById(describedBy)?.textContent).toMatch(
      /out of outfits, Today's suggestions, the stats breakdowns and relocation/
    )
  })

  it("is on for running gear", () => {
    render(<Harness initial="running" setItemCollection={vi.fn()} />)
    expect(checked()).toBe("true")
  })

  it("switches on at once, announces the save, and keeps the new value when the save succeeds", async () => {
    const save = deferred()
    const setItemCollection = vi.fn<SetItemCollectionAction>().mockReturnValue(save.promise)
    const onSaved = vi.fn<(item: ItemCardDto) => void>()
    render(<Harness setItemCollection={setItemCollection} onSaved={onSaved} />)

    fireEvent.click(runningSwitch())

    expect(checked()).toBe("true")
    expect(setItemCollection).toHaveBeenCalledWith({ id: ITEM_ID, collection: "running" })
    expect(screen.getByText("Saving running gear…")).toBeTruthy()

    const saved = taggedCard({ id: ITEM_ID, collection: "running" })
    await act(async () => save.settle(ok(saved)))

    expect(onSaved).toHaveBeenCalledWith(saved)
    expect(checked()).toBe("true")
    expect(screen.queryByText("Saving running gear…")).toBeNull()
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("switches running gear off as clothing", async () => {
    const setItemCollection = vi
      .fn<SetItemCollectionAction>()
      .mockResolvedValue(ok(taggedCard({ id: ITEM_ID, collection: "clothing" })))
    const onSaved = vi.fn<(item: ItemCardDto) => void>()
    render(<Harness initial="running" setItemCollection={setItemCollection} onSaved={onSaved} />)

    fireEvent.click(runningSwitch())

    expect(setItemCollection).toHaveBeenCalledWith({ id: ITEM_ID, collection: "clothing" })
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(checked()).toBe("false")
  })

  it("goes back to the saved value and shows a toast when the save fails", async () => {
    const save = deferred()
    const setItemCollection = vi.fn<SetItemCollectionAction>().mockReturnValue(save.promise)
    const onSaved = vi.fn<(item: ItemCardDto) => void>()
    render(<Harness setItemCollection={setItemCollection} onSaved={onSaved} />)

    fireEvent.click(runningSwitch())
    expect(checked()).toBe("true")

    await act(async () => save.settle(err("NOT_FOUND", "That item no longer exists.")))

    await waitFor(() => expect(checked()).toBe("false"))
    expect(onSaved).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Not found", description: "That item no longer exists." })
    )
  })

  it("treats a rejected call as a network error and reverts", async () => {
    const setItemCollection = vi.fn<SetItemCollectionAction>().mockRejectedValue(new Error("Failed to fetch"))
    render(<Harness initial="running" setItemCollection={setItemCollection} />)

    fireEvent.click(runningSwitch())

    await waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })))
    expect(checked()).toBe("true")
  })
})
