// @vitest-environment jsdom
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { taggedCard } from "@/components/items/test-fixtures"
import { toast } from "@/components/ui/toast"
import type { ItemDecision, ItemLocation } from "@/lib/db/enums"
import type { ItemCardDto } from "@/lib/items/contracts"
import { err, ok, type Result } from "@/lib/result"

import type { SetItemDecisionAction, SetItemLocationAction } from "./detail-actions"
import { PlanToggles } from "./plan-toggles"

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
  setItemDecision: SetItemDecisionAction
  setItemLocation: SetItemLocationAction
  onDecisionSaved?: (decision: ItemDecision) => void
}

/** Holds the saved values like the detail page does. */
function Harness({ setItemDecision, setItemLocation, onDecisionSaved }: HarnessProps) {
  const [decision, setDecision] = useState<ItemDecision>("undecided")
  const [location, setLocation] = useState<ItemLocation>("bologna")
  return (
    <PlanToggles
      itemId={ITEM_ID}
      decision={decision}
      location={location}
      setItemDecision={setItemDecision}
      setItemLocation={setItemLocation}
      onDecisionSaved={(next) => {
        onDecisionSaved?.(next)
        setDecision(next)
      }}
      onLocationSaved={setLocation}
    />
  )
}

function pressed(name: string): string | null {
  return screen.getByRole("button", { name }).getAttribute("aria-pressed")
}

/** A promise the test settles by hand, to look at the page while the save runs. */
function deferred() {
  let settle: (result: Result<ItemCardDto>) => void = () => undefined
  const promise = new Promise<Result<ItemCardDto>>((done) => {
    settle = done
  })
  return { promise, settle }
}

describe("PlanToggles", () => {
  it("labels both groups and shows the saved values", () => {
    render(<Harness setItemDecision={vi.fn()} setItemLocation={vi.fn()} />)

    expect(screen.getByRole("group", { name: "Plan for the move" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "Where it is now" })).toBeTruthy()
    expect(pressed("Undecided")).toBe("true")
    expect(pressed("Bologna")).toBe("true")
  })

  it("shows the new decision at once and keeps it when the save succeeds", async () => {
    const save = deferred()
    const setItemDecision = vi.fn<SetItemDecisionAction>().mockReturnValue(save.promise)
    const onDecisionSaved = vi.fn<(decision: ItemDecision) => void>()
    render(<Harness setItemDecision={setItemDecision} setItemLocation={vi.fn()} onDecisionSaved={onDecisionSaved} />)

    fireEvent.click(screen.getByRole("button", { name: "Donate" }))

    expect(pressed("Donate")).toBe("true")
    expect(pressed("Undecided")).toBe("false")
    expect(setItemDecision).toHaveBeenCalledWith({ id: ITEM_ID, decision: "donate" })

    await act(async () => save.settle(ok(taggedCard({ id: ITEM_ID, decision: "donate" }))))

    expect(onDecisionSaved).toHaveBeenCalledWith("donate")
    expect(pressed("Donate")).toBe("true")
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("goes back to the saved location and shows a toast when the save fails", async () => {
    const save = deferred()
    const setItemLocation = vi.fn<SetItemLocationAction>().mockReturnValue(save.promise)
    render(<Harness setItemDecision={vi.fn()} setItemLocation={setItemLocation} />)

    fireEvent.click(screen.getByRole("button", { name: "Hamburg" }))
    expect(pressed("Hamburg")).toBe("true")

    await act(async () => save.settle(err("NOT_FOUND", "That item no longer exists.")))

    await waitFor(() => expect(pressed("Bologna")).toBe("true"))
    expect(pressed("Hamburg")).toBe("false")
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Not found", description: "That item no longer exists." })
    )
  })

  it("treats a rejected call as a network error and reverts", async () => {
    const setItemDecision = vi.fn<SetItemDecisionAction>().mockRejectedValue(new Error("Failed to fetch"))
    render(<Harness setItemDecision={setItemDecision} setItemLocation={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: "Sell" }))

    await waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })))
    expect(pressed("Undecided")).toBe("true")
    expect(pressed("Sell")).toBe("false")
  })

  it("does not save when the pressed option is pressed again", () => {
    const setItemDecision = vi.fn<SetItemDecisionAction>()
    render(<Harness setItemDecision={setItemDecision} setItemLocation={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: "Undecided" }))

    expect(setItemDecision).not.toHaveBeenCalled()
    expect(pressed("Undecided")).toBe("true")
  })
})
