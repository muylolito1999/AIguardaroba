// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { toast } from "@/components/ui/toast"
import type { ShoppingItemDto } from "@/lib/relocation/contracts"
import { err, ok } from "@/lib/result"

import { AddShoppingItemForm } from "./add-shopping-item-form"
import type { AddShoppingItemAction } from "./shopping-actions"
import { shoppingItem } from "./test-fixtures"

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function setup() {
  const add = vi.fn<AddShoppingItemAction>()
  const onAdded = vi.fn<(item: ShoppingItemDto) => void>()
  render(<AddShoppingItemForm addShoppingItem={add} onAdded={onAdded} />)
  return { add, onAdded }
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Add to list" }))
}

describe("AddShoppingItemForm", () => {
  it("asks for what to buy and sends nothing without it", () => {
    const { add } = setup()

    submit()

    expect(screen.getByText("Say what to buy.")).toBeTruthy()
    expect(screen.getByLabelText("What to buy").getAttribute("aria-invalid")).toBe("true")
    expect(document.activeElement).toBe(screen.getByLabelText("What to buy"))
    expect(add).not.toHaveBeenCalled()
  })

  it("explains a price range that is upside down, cents and a quantity out of range", () => {
    const { add } = setup()
    type("What to buy", "Rain boots")
    type("Lowest price (€)", "120")
    type("Highest price (€)", "80")
    type("Quantity", "11")

    submit()

    expect(screen.getByText("The highest price must not be below the lowest.")).toBeTruthy()
    expect(screen.getByText("Enter a whole number from 1 to 10.")).toBeTruthy()
    expect(add).not.toHaveBeenCalled()

    type("Lowest price (€)", "12.5")
    type("Highest price (€)", "")
    type("Quantity", "2")
    submit()

    expect(screen.getByText("Enter whole euros from 0 to 100,000.")).toBeTruthy()
    expect(screen.queryByText("Enter a whole number from 1 to 10.")).toBeNull()
    expect(add).not.toHaveBeenCalled()
  })

  it("sends the parsed entry, then empties the form", async () => {
    const { add, onAdded } = setup()
    const saved = shoppingItem({ itemType: "Rain boots", priority: 1 })
    add.mockResolvedValue(ok(saved))
    type("What to buy", "  Rain boots ")
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "shoes" } })
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "1" } })
    type("Quantity", "2")
    type("Lowest price (€)", "80")
    type("Highest price (€)", "120")
    fireEvent.change(screen.getByLabelText("When to buy"), { target: { value: "after_move" } })
    type("Specs", "insulated\n\n grippy sole \n")
    type("Why", "Wet, cold winters.")

    await act(async () => submit())

    expect(add).toHaveBeenCalledWith({
      itemType: "Rain boots",
      category: "shoes",
      priority: 1,
      reason: "Wet, cold winters.",
      specs: ["insulated", "grippy sole"],
      quantity: 2,
      estPriceMinEur: 80,
      estPriceMaxEur: 120,
      buyTiming: "after_move",
    })
    expect(onAdded).toHaveBeenCalledWith(saved)
    expect((screen.getByLabelText("What to buy") as HTMLInputElement).value).toBe("")
    expect((screen.getByLabelText("Quantity") as HTMLInputElement).value).toBe("1")
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Added to your list" }))
  })

  it("keeps what was typed when the server says no", async () => {
    const { add, onAdded } = setup()
    add.mockResolvedValue(err("VALIDATION", "Some fields are missing or invalid."))
    type("What to buy", "Gloves")

    await act(async () => submit())

    await waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })))
    expect(onAdded).not.toHaveBeenCalled()
    expect((screen.getByLabelText("What to buy") as HTMLInputElement).value).toBe("Gloves")
  })
})
