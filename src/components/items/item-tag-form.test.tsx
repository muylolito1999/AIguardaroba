// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ItemCardDto, TagData } from "@/lib/items/contracts"
import { err, ok, type Result } from "@/lib/result"

import { ItemTagForm } from "./item-tag-form"
import type { ConfirmItemAction, TagItemByHandAction, UpdateItemTagsAction } from "./review-actions"
import { hasTags, type TaggedItemCard } from "./tag-form-model"
import type { requestTagging } from "./tag-request"
import { pendingCard, taggedCard } from "./test-fixtures"

afterEach(cleanup)

function setup(overrides: Partial<ItemCardDto> = {}) {
  const item = taggedCard(overrides)
  if (!hasTags(item)) throw new Error("fixture is not tagged")
  const updateItemTags = vi.fn<UpdateItemTagsAction>()
  const confirmItem = vi.fn<ConfirmItemAction>()
  const tagRequest = vi.fn<typeof requestTagging>()
  const onItemChange = vi.fn<(item: ItemCardDto) => void>()
  const onConfirmed = vi.fn<(item: ItemCardDto) => void>()
  const onDirtyChange = vi.fn<(itemId: string, dirty: boolean) => void>()
  render(
    <ItemTagForm
      item={item}
      updateItemTags={updateItemTags}
      confirmItem={confirmItem}
      onItemChange={onItemChange}
      onConfirmed={onConfirmed}
      onDirtyChange={onDirtyChange}
      tagRequest={tagRequest}
    />
  )
  return { item, updateItemTags, confirmItem, tagRequest, onItemChange, onConfirmed, onDirtyChange }
}

function typeInto(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } })
}

function describedByText(element: HTMLElement): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
}

describe("ItemTagForm", () => {
  it("marks low-confidence fields with visible text and links it to the control", () => {
    setup()

    const hints = screen.getAllByText(/Check this: Claude was \d+% sure/)
    expect(hints.map((hint) => hint.textContent)).toEqual([
      "Check this: Claude was 45% sure",
      "Check this: Claude was 20% sure",
    ])
    expect(describedByText(screen.getByLabelText("Brand"))).toContain("Claude was 20% sure")
    expect(describedByText(screen.getByLabelText("Category"))).not.toContain("Check this")
  })

  it("hides a hint for a field the owner already edited, and marks it as edited", () => {
    setup({ userEditedFields: ["brand"] })

    expect(screen.getAllByText(/Check this/)).toHaveLength(1)
    expect(screen.getByText("Edited")).toBeTruthy()
  })

  it("confirms with only the fields that changed", async () => {
    const { item, confirmItem, onConfirmed } = setup()
    const confirmed = { ...item, status: "confirmed" as const }
    confirmItem.mockResolvedValue(ok(confirmed))

    typeInto(screen.getByLabelText("Name"), "Navy overcoat")
    fireEvent.click(screen.getByRole("button", { name: "Spring" }))
    fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))

    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(confirmed))
    expect(confirmItem).toHaveBeenCalledWith({
      id: item.id,
      patch: { name: "Navy overcoat", seasons: ["winter", "spring", "autumn"] },
    })
  })

  it("confirms an unchanged item without a patch", async () => {
    const { item, confirmItem } = setup()
    confirmItem.mockResolvedValue(ok({ ...item, status: "confirmed" }))

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))

    await waitFor(() => expect(confirmItem).toHaveBeenCalledWith({ id: item.id }))
  })

  it("saves edits, adopts the server's item and keeps focus on Save", async () => {
    const { item, updateItemTags, onItemChange, onDirtyChange } = setup()
    const saved = { ...item, brand: "Barbour", userEditedFields: ["brand"] }
    updateItemTags.mockResolvedValue(ok(saved))
    const save = screen.getByRole("button", { name: "Save" })
    expect(save.getAttribute("aria-disabled")).toBe("true")

    typeInto(screen.getByLabelText("Brand"), "Barbour")
    // Editing a low-confidence field counts as checking it.
    expect(screen.getAllByText(/Check this/)).toHaveLength(1)
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(item.id, true))

    save.focus()
    fireEvent.click(save)

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."))
    expect(updateItemTags).toHaveBeenCalledWith({ id: item.id, patch: { brand: "Barbour" } })
    expect(onItemChange).toHaveBeenCalledWith(saved)
    expect(document.activeElement).toBe(save)
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(item.id, false))
  })

  it("blocks invalid input before calling the server", async () => {
    const { confirmItem } = setup()

    const name = screen.getByLabelText("Name")
    typeInto(name, "   ")
    fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))

    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"))
    expect(describedByText(name)).toContain("Required.")
    expect(confirmItem).not.toHaveBeenCalled()
  })

  it("shows a server validation issue on its field", async () => {
    const { confirmItem } = setup()
    confirmItem.mockResolvedValue(
      err("VALIDATION", "Some fields are missing or invalid.", {
        issues: [{ path: "patch.color_hex", message: "Give one hex colour for each colour name." }],
      })
    )

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))

    expect(await screen.findByText("Give one hex colour for each colour name.")).toBeTruthy()
  })

  it("toggles a switch into the patch", async () => {
    const { item, confirmItem } = setup()
    confirmItem.mockResolvedValue(ok({ ...item, status: "confirmed" }))

    fireEvent.click(screen.getByRole("switch", { name: "Waterproof" }))
    fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))

    await waitFor(() => expect(confirmItem).toHaveBeenCalledWith({ id: item.id, patch: { waterproof: true } }))
  })

  it("reads warmth in the rubric's words and changes it from the keyboard", async () => {
    const { item, confirmItem } = setup()
    confirmItem.mockResolvedValue(ok({ ...item, status: "confirmed" }))

    // Base UI hides an edge-aligned thumb until it has measured the track, and
    // jsdom has no layout, so the query includes hidden elements and the name
    // is checked through aria-labelledby.
    const slider = screen.getByRole("slider", { hidden: true })
    const label = document.getElementById(slider.getAttribute("aria-labelledby") ?? "")
    expect(label?.textContent).toBe("Warmth")
    expect(slider.getAttribute("aria-valuetext")).toBe("4 · Warm (wool coat, fleece-lined, insulated boots)")
    fireEvent.keyDown(slider, { key: "ArrowRight" })
    await waitFor(() => expect(slider.getAttribute("aria-valuetext")).toMatch(/^5 · Heavy winter/))
    fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))

    await waitFor(() => expect(confirmItem).toHaveBeenCalledWith({ id: item.id, patch: { warmth_level: 5 } }))
  })

  it("adds and removes colour chips as name and swatch pairs", async () => {
    const { item, confirmItem } = setup()
    confirmItem.mockResolvedValue(ok({ ...item, status: "confirmed" }))
    const colours = screen.getByRole("list", { name: "Colours" })
    const newColour = screen.getByLabelText("New colour name")

    fireEvent.click(within(colours).getByRole("button", { name: "Remove black" }))
    expect(document.activeElement).toBe(newColour)
    typeInto(newColour, "Navy")
    fireEvent.click(screen.getByRole("button", { name: "Add colour" }))
    expect(screen.getByRole("alert").textContent).toBe("“Navy” is already listed.")

    typeInto(newColour, "olive")
    fireEvent.keyDown(newColour, { key: "Enter" })
    fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))

    await waitFor(() =>
      expect(confirmItem).toHaveBeenCalledWith({
        id: item.id,
        patch: { colors: ["navy", "olive"], color_hex: ["#1f2a44", "#808080"] },
      })
    )
  })

  it("re-tags only after confirming, and shows Claude's new tags", async () => {
    const { item, tagRequest, onItemChange } = setup()
    const retagged = { ...item, name: "Waxed field jacket" }
    let resolve: (result: Result<TagData>) => void = () => {}
    tagRequest.mockReturnValue(new Promise((done) => (resolve = done)))

    fireEvent.click(screen.getByRole("button", { name: "Re-tag" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog.textContent).toContain("Fields you edited keep your values")
    expect(tagRequest).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Re-tag" }))

    await waitFor(() => expect(tagRequest).toHaveBeenCalledWith(item.id, { force: true }))
    await act(async () => resolve(ok({ cached: false, item: retagged })))

    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Waxed field jacket"))
    expect(onItemChange).toHaveBeenCalledWith(retagged)
    expect(screen.getByRole("status").textContent).toContain("Fields you had edited kept your values")
  })
})

function tagged(overrides: Partial<ItemCardDto> = {}): TaggedItemCard {
  const item = taggedCard(overrides)
  if (!hasTags(item)) throw new Error("fixture is not tagged")
  return item
}

/** Opens a Base UI select by its label and picks an option. */
async function choose(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label))
  const choice = await screen.findByRole("option", { name: option })
  // Base UI ignores a click on an option the pointer did not press first.
  fireEvent.pointerDown(choice)
  fireEvent.click(choice)
  await waitFor(() => expect(screen.getByLabelText(label).textContent).toContain(option))
}

describe("ItemTagForm when a request cannot be sent", () => {
  it("enables the form again after a rejected confirm and keeps the edits", async () => {
    const { confirmItem, onConfirmed } = setup()
    confirmItem.mockRejectedValue(new TypeError("Failed to fetch"))

    typeInto(screen.getByLabelText("Name"), "Navy overcoat")
    fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Not confirmed: Could not reach the server. Check your connection."
      )
    )
    const confirm = screen.getByRole("button", { name: "Save and confirm" })
    expect(confirm.getAttribute("aria-disabled")).not.toBe("true")
    expect(confirm.getAttribute("aria-busy")).toBeNull()
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).not.toBe("true")
    expect(screen.getByRole("button", { name: "Re-tag" }).getAttribute("aria-disabled")).not.toBe("true")
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Navy overcoat")
    expect(onConfirmed).not.toHaveBeenCalled()
  })

  it("enables the form again after a rejected save and keeps the edits", async () => {
    const { updateItemTags, onItemChange } = setup()
    updateItemTags.mockRejectedValue(new Error("An unexpected response was received from the server."))

    typeInto(screen.getByLabelText("Brand"), "Barbour")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Not saved: Could not reach the server. Check your connection."
      )
    )
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).not.toBe("true")
    expect(screen.getByRole("button", { name: "Save and confirm" }).getAttribute("aria-disabled")).not.toBe("true")
    expect((screen.getByLabelText("Brand") as HTMLInputElement).value).toBe("Barbour")
    expect(onItemChange).not.toHaveBeenCalled()
  })
})

describe("ItemTagForm when the list hands it a newer card", () => {
  function renderForm(item: TaggedItemCard) {
    const props = {
      updateItemTags: vi.fn<UpdateItemTagsAction>(),
      confirmItem: vi.fn<ConfirmItemAction>(),
      onItemChange: vi.fn<(item: ItemCardDto) => void>(),
      onConfirmed: vi.fn<(item: ItemCardDto) => void>(),
    }
    const view = render(<ItemTagForm item={item} {...props} />)
    return { rerender: (next: TaggedItemCard) => view.rerender(<ItemTagForm item={next} {...props} />) }
  }

  it("shows the newer card while nothing is unsaved", async () => {
    const item = tagged({ name: "Navy wool coat" })
    const { rerender } = renderForm(item)

    rerender({ ...item, name: "Navy overcoat", userEditedFields: ["name"] })

    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Navy overcoat"))
  })

  it("keeps unsaved edits when a newer card arrives", async () => {
    const item = tagged({ name: "Navy wool coat" })
    const { rerender } = renderForm(item)

    typeInto(screen.getByLabelText("Brand"), "Barbour")
    rerender({ ...item, name: "Navy overcoat" })

    await act(async () => {})
    expect((screen.getByLabelText("Brand") as HTMLInputElement).value).toBe("Barbour")
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Navy wool coat")
  })
})

describe("ItemTagForm filled in by hand", () => {
  function setupManual(overrides: Partial<ItemCardDto> = {}) {
    const item = pendingCard(overrides)
    const tagItemByHand = vi.fn<TagItemByHandAction>()
    const onItemChange = vi.fn<(item: ItemCardDto) => void>()
    const onConfirmed = vi.fn<(item: ItemCardDto) => void>()
    const onCancel = vi.fn<() => void>()
    const onDirtyChange = vi.fn<(itemId: string, dirty: boolean) => void>()
    render(
      <ItemTagForm
        mode="manual"
        item={item}
        tagItemByHand={tagItemByHand}
        onItemChange={onItemChange}
        onConfirmed={onConfirmed}
        onCancel={onCancel}
        onDirtyChange={onDirtyChange}
      />
    )
    return { item, tagItemByHand, onItemChange, onConfirmed, onCancel, onDirtyChange }
  }

  /** Every required field and a season, through the controls. */
  async function fillRequired() {
    typeInto(screen.getByLabelText("Name"), "Olive fleece")
    await choose("Category", "Top")
    typeInto(screen.getByLabelText("New colour name"), "olive")
    fireEvent.click(screen.getByRole("button", { name: "Add colour" }))
    fireEvent.click(screen.getByRole("button", { name: "Autumn" }))
    await choose("Formality", "Casual")
    await choose("Condition", "Good")
  }

  it("starts without hints or Re-tag, with the required choices unset and focus on the name", async () => {
    setupManual()

    expect(screen.getByRole("form", { name: "Tags for Untagged item" })).toBeTruthy()
    expect(screen.queryByText(/Check this/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Re-tag" })).toBeNull()
    expect(screen.getByLabelText("Category").textContent).toContain("Choose…")
    expect(screen.getByLabelText("Formality").textContent).toContain("Choose…")
    expect(screen.getByLabelText("Condition").textContent).toContain("Choose…")
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).not.toBe("true")
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")))
  })

  it("blocks Save with messages until the required fields and a season are set, then sends every field", async () => {
    const { item, tagItemByHand, onItemChange, onConfirmed } = setupManual()
    const saved = taggedCard({ id: item.id, name: "Olive fleece" })
    tagItemByHand.mockResolvedValue(ok(saved))

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true"))
    expect(describedByText(screen.getByLabelText("Name"))).toContain("Required.")
    expect(describedByText(screen.getByLabelText("Category"))).toContain("Choose one of the options.")
    expect(describedByText(screen.getByLabelText("Formality"))).toContain("Choose one of the options.")
    expect(describedByText(screen.getByLabelText("Condition"))).toContain("Choose one of the options.")
    expect(screen.getByText("Add at least one colour.")).toBeTruthy()
    expect(screen.getByText("Pick at least one season.")).toBeTruthy()
    expect(tagItemByHand).not.toHaveBeenCalled()

    await fillRequired()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onItemChange).toHaveBeenCalledWith(saved))
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(tagItemByHand).toHaveBeenCalledWith({
      id: item.id,
      confirm: false,
      patch: {
        name: "Olive fleece",
        category: "top",
        subcategory: "",
        colors: ["olive"],
        color_hex: ["#808080"],
        material_guess: "",
        materials: [],
        warmth_level: 3,
        waterproof: false,
        windproof: false,
        insulated: false,
        breathable: null,
        seasons: ["autumn"],
        formality: "casual",
        pattern: "",
        fit: null,
        condition: "good",
        brand: null,
        description: "",
        size: null,
        notes: "",
        purchase_price: null,
        currency: "EUR",
        purchase_date: null,
        location: "bologna",
        decision: "undecided",
      },
    })
  })

  it("saves and confirms in one step", async () => {
    const { item, tagItemByHand, onConfirmed, onItemChange } = setupManual()
    const confirmed = taggedCard({ id: item.id, status: "confirmed", name: "Olive fleece" })
    tagItemByHand.mockResolvedValue(ok(confirmed))

    await fillRequired()
    fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))

    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(confirmed))
    expect(tagItemByHand).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, confirm: true }))
    expect(onItemChange).not.toHaveBeenCalled()
  })

  it("shows a conflict and keeps the values", async () => {
    const { tagItemByHand, onItemChange } = setupManual()
    tagItemByHand.mockResolvedValue(
      err("CONFLICT", "This item is waiting in a tagging batch. Wait for its result, or tag it now from its card.")
    )

    await fillRequired()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Not saved: This item is waiting in a tagging batch. Wait for its result, or tag it now from its card."
      )
    )
    expect(onItemChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Olive fleece")
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).not.toBe("true")
  })

  it("puts the fields the server still misses on their controls", async () => {
    const { tagItemByHand } = setupManual()
    tagItemByHand.mockResolvedValue(err("VALIDATION", "Fill in category first.", { missing: ["category"] }))

    await fillRequired()
    fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Not confirmed: Fill in category first.")
    )
    expect(describedByText(screen.getByLabelText("Category"))).toContain("Required.")
  })

  it("enables the form again after a rejected call", async () => {
    const { tagItemByHand, onConfirmed } = setupManual()
    tagItemByHand.mockRejectedValue(new TypeError("Failed to fetch"))

    await fillRequired()
    fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Not confirmed: Could not reach the server. Check your connection."
      )
    )
    expect(screen.getByRole("button", { name: "Save and confirm" }).getAttribute("aria-disabled")).not.toBe("true")
    expect(onConfirmed).not.toHaveBeenCalled()
  })

  it("reports unsaved values and goes back on Cancel without sending anything", async () => {
    const { item, tagItemByHand, onCancel, onDirtyChange } = setupManual()

    typeInto(screen.getByLabelText("Name"), "Olive fleece")
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(item.id, true))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(tagItemByHand).not.toHaveBeenCalled()
  })
})
