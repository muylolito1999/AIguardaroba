// @vitest-environment jsdom
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { toast } from "@/components/ui/toast"
import type { ShoppingStatus } from "@/lib/db/enums"
import type { ShoppingItemDto } from "@/lib/relocation/contracts"
import { err, ok, type Result } from "@/lib/result"

import type { UpdateShoppingItemAction } from "./shopping-actions"
import { StatusControl } from "./status-control"
import { shoppingItem } from "./test-fixtures"

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ROW = shoppingItem({ itemType: "Rain shell" })

/** Holds the saved status like the list does. */
function Harness({ update, onSaved }: { update: UpdateShoppingItemAction; onSaved?: (item: ShoppingItemDto) => void }) {
  const [status, setStatus] = useState<ShoppingStatus>("todo")
  return (
    <StatusControl
      id={ROW.id}
      itemType={ROW.itemType}
      status={status}
      updateShoppingItem={update}
      onSaved={(item) => {
        onSaved?.(item)
        setStatus(item.status)
      }}
    />
  )
}

function pressed(name: string): string | null {
  return screen.getByRole("button", { name }).getAttribute("aria-pressed")
}

/** A promise the test settles by hand, to look at the control while the save runs. */
function deferred() {
  let settle: (result: Result<ShoppingItemDto>) => void = () => undefined
  const promise = new Promise<Result<ShoppingItemDto>>((done) => {
    settle = done
  })
  return { promise, settle }
}

describe("StatusControl", () => {
  it("names the group after the row and shows the saved status", () => {
    render(<Harness update={vi.fn()} />)

    expect(screen.getByRole("group", { name: "Status of Rain shell" })).toBeTruthy()
    expect(pressed("To buy")).toBe("true")
    expect(pressed("Bought")).toBe("false")
    expect(pressed("Skipped")).toBe("false")
  })

  it("shows the new status at once and keeps it when the save succeeds", async () => {
    const save = deferred()
    const update = vi.fn<UpdateShoppingItemAction>().mockReturnValue(save.promise)
    const onSaved = vi.fn<(item: ShoppingItemDto) => void>()
    render(<Harness update={update} onSaved={onSaved} />)

    fireEvent.click(screen.getByRole("button", { name: "Bought" }))

    expect(pressed("Bought")).toBe("true")
    expect(pressed("To buy")).toBe("false")
    expect(update).toHaveBeenCalledWith({ id: ROW.id, status: "bought" })

    await act(async () => save.settle(ok({ ...ROW, status: "bought" })))

    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: ROW.id, status: "bought" }))
    expect(pressed("Bought")).toBe("true")
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("goes back to the saved status and shows a toast when the save fails", async () => {
    const save = deferred()
    const update = vi.fn<UpdateShoppingItemAction>().mockReturnValue(save.promise)
    render(<Harness update={update} />)

    fireEvent.click(screen.getByRole("button", { name: "Skipped" }))
    expect(pressed("Skipped")).toBe("true")

    await act(async () => save.settle(err("NOT_FOUND", "That shopping list entry no longer exists.")))

    await waitFor(() => expect(pressed("To buy")).toBe("true"))
    expect(pressed("Skipped")).toBe("false")
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Not found", description: "That shopping list entry no longer exists." })
    )
  })

  it("treats a rejected call as a network error and reverts", async () => {
    const update = vi.fn<UpdateShoppingItemAction>().mockRejectedValue(new Error("Failed to fetch"))
    render(<Harness update={update} />)

    fireEvent.click(screen.getByRole("button", { name: "Bought" }))

    await waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })))
    expect(pressed("To buy")).toBe("true")
    expect(pressed("Bought")).toBe("false")
  })

  it("does not save when the pressed status is pressed again", () => {
    const update = vi.fn<UpdateShoppingItemAction>()
    render(<Harness update={update} />)

    fireEvent.click(screen.getByRole("button", { name: "To buy" }))

    expect(update).not.toHaveBeenCalled()
    expect(pressed("To buy")).toBe("true")
  })
})
