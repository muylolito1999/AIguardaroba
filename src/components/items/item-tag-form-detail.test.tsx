// @vitest-environment jsdom
import { useState } from "react"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ItemCardDto } from "@/lib/items/contracts"
import { ok } from "@/lib/result"

import { ItemTagForm } from "./item-tag-form"
import type { ConfirmItemAction, TagItemByHandAction, UpdateItemTagsAction } from "./review-actions"
import { hasTags } from "./tag-form-model"
import type { requestTagging } from "./tag-request"
import { pendingCard, taggedCard } from "./test-fixtures"

// The detail page's mode of the tag form (/wardrobe/[id]). The review and
// manual modes keep their own tests in item-tag-form.test.tsx.

afterEach(cleanup)

type HarnessProps = {
  initial: ItemCardDto
  updateItemTags: UpdateItemTagsAction
  confirmItem: ConfirmItemAction
  tagRequest: typeof requestTagging
  onItemChange: (item: ItemCardDto) => void
}

/** Holds the item like the detail page does, so adopted items flow back into the form. */
function Harness({ initial, updateItemTags, confirmItem, tagRequest, onItemChange }: HarnessProps) {
  const [item, setItem] = useState(initial)
  if (!hasTags(item)) return <p>Not tagged</p>
  return (
    <ItemTagForm
      mode="detail"
      item={item}
      updateItemTags={updateItemTags}
      confirmItem={confirmItem}
      tagRequest={tagRequest}
      onItemChange={(next) => {
        onItemChange(next)
        setItem(next)
      }}
    />
  )
}

function setup(overrides: Partial<ItemCardDto> = {}) {
  const item = taggedCard(overrides)
  const updateItemTags = vi.fn<UpdateItemTagsAction>()
  const confirmItem = vi.fn<ConfirmItemAction>()
  const tagRequest = vi.fn<typeof requestTagging>()
  const onItemChange = vi.fn<(item: ItemCardDto) => void>()
  const view = render(
    <Harness
      initial={item}
      updateItemTags={updateItemTags}
      confirmItem={confirmItem}
      tagRequest={tagRequest}
      onItemChange={onItemChange}
    />
  )
  return { item, updateItemTags, confirmItem, tagRequest, onItemChange, view }
}

describe("ItemTagForm in detail mode", () => {
  it("offers Save and Re-tag but no Confirm for a confirmed item", () => {
    setup({ status: "confirmed" })

    expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull()
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Re-tag" })).toBeTruthy()
  })

  it("leaves decision and location to the page's quick toggles", () => {
    setup({ status: "confirmed" })

    expect(screen.queryByText("Where it is now")).toBeNull()
    expect(screen.queryByText("Plan for the move")).toBeNull()
    expect(screen.getByText("Purchase and notes")).toBeTruthy()
    expect(screen.getByLabelText("Notes")).toBeTruthy()
  })

  it("saves only the fields that changed and adopts the server's item", async () => {
    const { item, updateItemTags, onItemChange } = setup({ status: "confirmed" })
    const saved = { ...item, name: "Navy overcoat", userEditedFields: ["name"] }
    updateItemTags.mockResolvedValue(ok(saved))

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Navy overcoat" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."))
    expect(updateItemTags).toHaveBeenCalledWith({ id: item.id, patch: { name: "Navy overcoat" } })
    expect(onItemChange).toHaveBeenCalledWith(saved)
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true")
  })

  it("never sends back a decision or location that a quick toggle changed meanwhile", async () => {
    const item = taggedCard({ status: "confirmed" })
    const updateItemTags = vi.fn<UpdateItemTagsAction>()
    const confirmItem = vi.fn<ConfirmItemAction>()
    const props = { mode: "detail" as const, updateItemTags, confirmItem, onItemChange: vi.fn() }
    if (!hasTags(item)) throw new Error("fixture is not tagged")
    const { rerender } = render(<ItemTagForm {...props} item={item} />)

    fireEvent.change(screen.getByLabelText("Brand"), { target: { value: "Barbour" } })
    // The page's toggles saved new values while the form holds an unsaved edit.
    const toggled = { ...item, decision: "donate" as const, location: "hamburg" as const }
    rerender(<ItemTagForm {...props} item={toggled} />)
    updateItemTags.mockResolvedValue(ok({ ...toggled, brand: "Barbour" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(updateItemTags).toHaveBeenCalled())
    expect(updateItemTags).toHaveBeenCalledWith({ id: item.id, patch: { brand: "Barbour" } })
  })

  it("offers Confirm for a tagged item and keeps the confirmed item on screen", async () => {
    const { item, confirmItem, onItemChange } = setup({ status: "tagged" })
    const confirmed = { ...item, status: "confirmed" as const }
    confirmItem.mockResolvedValue(ok(confirmed))

    const confirm = screen.getByRole("button", { name: "Confirm" })
    confirm.focus()
    fireEvent.click(confirm)

    await waitFor(() => expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull())
    expect(confirmItem).toHaveBeenCalledWith({ id: item.id })
    expect(onItemChange).toHaveBeenCalledWith(confirmed)
    expect(screen.getByRole("status").textContent).toBe("Confirmed.")
    // Confirm left with focus on it; Save takes over.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }))
  })

  it("re-tags and adopts the new tags", async () => {
    const { item, tagRequest, onItemChange } = setup({ status: "confirmed", userEditedFields: ["name"] })
    const retagged = { ...item, materials: ["wool", "cashmere"] }
    tagRequest.mockResolvedValue(ok({ cached: false, item: retagged }))

    fireEvent.click(screen.getByRole("button", { name: "Re-tag" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Re-tag" }))

    await waitFor(() => expect(onItemChange).toHaveBeenCalledWith(retagged))
    expect(tagRequest).toHaveBeenCalledWith(item.id, { force: true })
    expect(screen.getByRole("status").textContent).toBe(
      "Claude re-tagged this item. Fields you had edited kept your values."
    )
  })
})

describe("ItemTagForm in manual mode without plans (the detail page)", () => {
  it("neither shows nor sends decision and location", async () => {
    // Prefilled enough to be valid at once: the selects start with the card's values.
    const item = pendingCard({
      name: "Grey wool scarf",
      category: "scarf",
      colors: ["grey"],
      colorHex: ["#808080"],
      seasons: ["winter"],
      formality: "casual",
      condition: "good",
      decision: "donate",
      location: "hamburg",
    })
    const tagItemByHand = vi.fn<TagItemByHandAction>().mockResolvedValue(ok(taggedCard({ id: item.id })))
    render(
      <ItemTagForm
        mode="manual"
        item={item}
        tagItemByHand={tagItemByHand}
        onItemChange={vi.fn()}
        onConfirmed={vi.fn()}
        onCancel={vi.fn()}
        showPlans={false}
      />
    )

    expect(screen.queryByText("Plan for the move")).toBeNull()
    expect(screen.queryByText("Where it is now")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(tagItemByHand).toHaveBeenCalled())
    const patch = tagItemByHand.mock.calls[0]?.[0].patch
    expect(patch).toMatchObject({ name: "Grey wool scarf", category: "scarf", formality: "casual" })
    expect(patch).not.toHaveProperty("decision")
    expect(patch).not.toHaveProperty("location")
  })
})
