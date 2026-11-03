// @vitest-environment jsdom
import { Activity } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { pendingCard, taggedCard } from "@/components/items/test-fixtures"
import { toast } from "@/components/ui/toast"
import type { ItemCardDto, TagData } from "@/lib/items/contracts"
import type { ItemDetailDto } from "@/lib/items/wardrobe"
import { noteWardrobeChange } from "@/lib/items/wardrobe-changes"
import { err, ok, type Result } from "@/lib/result"

import type { ItemDetailActions } from "./detail-actions"
import { ItemDetail } from "./item-detail"

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}))

// Background removal loads a wasm model; it has its own tests.
vi.mock("@/components/items/remove-background-button", () => ({
  RemoveBackgroundButton: () => <button type="button">Remove background</button>,
}))

beforeEach(() => {
  vi.spyOn(toast, "add").mockReturnValue("toast-id")
  router.refresh.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function detailOf(card: ItemCardDto, extra: Partial<ItemDetailDto> = {}): ItemDetailDto {
  return {
    ...card,
    updatedAt: "2026-11-02T15:30:00.000Z",
    wearCount: 0,
    lastWornAt: null,
    original: { url: "https://blob.example/items/a/original.jpg", width: 4032, height: 3024, bytes: 2_400_000 },
    ...extra,
  }
}

function fakeActions(): { [K in keyof ItemDetailActions]: ReturnType<typeof vi.fn<ItemDetailActions[K]>> } {
  return {
    updateItemTags: vi.fn<ItemDetailActions["updateItemTags"]>(),
    confirmItem: vi.fn<ItemDetailActions["confirmItem"]>(),
    tagItemByHand: vi.fn<ItemDetailActions["tagItemByHand"]>(),
    setItemDecision: vi.fn<ItemDetailActions["setItemDecision"]>(),
    setItemLocation: vi.fn<ItemDetailActions["setItemLocation"]>(),
    archiveItem: vi.fn<ItemDetailActions["archiveItem"]>(),
    unarchiveItem: vi.fn<ItemDetailActions["unarchiveItem"]>(),
    deleteItem: vi.fn<ItemDetailActions["deleteItem"]>(),
    logWear: vi.fn<ItemDetailActions["logWear"]>(),
    undoWear: vi.fn<ItemDetailActions["undoWear"]>(),
  }
}

describe("ItemDetail", () => {
  it("shows a confirmed item with its photos, toggles, tags, details and archive or delete", () => {
    const item = detailOf(taggedCard({ status: "confirmed", decision: "bring", location: "hamburg" }), {
      wearCount: 3,
      lastWornAt: "2026-10-20T08:30:00.000Z",
    })
    render(<ItemDetail item={item} actions={fakeActions()} />)

    expect(screen.getByRole("heading", { level: 1, name: "Navy wool coat" })).toBeTruthy()
    expect(screen.getByText("Confirmed")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Back to wardrobe" }).getAttribute("href")).toBe("/wardrobe")
    expect(screen.getByRole("img", { name: "Photo of Navy wool coat" })).toBeTruthy()
    const original = screen.getByRole("link", { name: "Open original (opens in a new tab)" })
    expect(original.getAttribute("target")).toBe("_blank")
    expect(screen.getByText(/4032 × 3024 px, 2.4 MB/)).toBeTruthy()

    const plan = screen.getByRole("group", { name: "Plan for the move" })
    expect(within(plan).getByRole("button", { name: "Bring" }).getAttribute("aria-pressed")).toBe("true")
    const place = screen.getByRole("group", { name: "Where it is now" })
    expect(within(place).getByRole("button", { name: "Hamburg" }).getAttribute("aria-pressed")).toBe("true")

    // The detail form: Save and Re-tag, no Confirm for a confirmed item.
    const form = screen.getByRole("form", { name: "Tags for Navy wool coat" })
    expect(within(form).queryByRole("button", { name: /Confirm/ })).toBeNull()
    expect(within(form).getByRole("button", { name: "Save" })).toBeTruthy()

    expect(screen.getByText("3 times")).toBeTruthy()
    expect(screen.getByText("20 Oct 2026")).toBeTruthy()
    expect(screen.getByText("claude-haiku-5-5")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Delete item" })).toBeTruthy()
  })

  it("offers Tag now and Fill in by hand for a pending item, then shows the form and moves focus to it", async () => {
    const pending = detailOf(pendingCard(), { original: null })
    const tagRequest = vi.fn<(id: string) => Promise<Result<TagData>>>()
    let settle: (result: Result<TagData>) => void = () => undefined
    tagRequest.mockReturnValue(new Promise((done) => (settle = done)))
    render(<ItemDetail item={pending} actions={fakeActions()} tagRequest={tagRequest} />)

    expect(screen.getByRole("heading", { level: 1, name: "Untagged item" })).toBeTruthy()
    expect(screen.getByText("Waiting for tags")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Fill in by hand" })).toBeTruthy()
    const tagNow = screen.getByRole("button", { name: "Tag now" })
    tagNow.focus()
    fireEvent.click(tagNow)
    expect(tagRequest).toHaveBeenCalledWith(pending.id)

    const tagged = taggedCard({ id: pending.id, name: "Grey wool scarf", category: "scarf" })
    await act(async () => settle(ok({ cached: false, item: tagged })))

    await waitFor(() => expect(screen.getByRole("form", { name: "Tags for Grey wool scarf" })).toBeTruthy())
    expect(screen.getByRole("heading", { level: 1, name: "Grey wool scarf" })).toBeTruthy()
    // A tagged (not yet confirmed) item can be confirmed from here.
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Tags" }))
  })

  it("shows a failed tagging attempt with Retry", async () => {
    const pending = detailOf(pendingCard(), { original: null })
    const tagRequest = vi.fn<(id: string) => Promise<Result<TagData>>>()
    tagRequest.mockResolvedValue(err("CONFIG", "The server is misconfigured. Check the server logs."))
    render(<ItemDetail item={pending} actions={fakeActions()} tagRequest={tagRequest} />)

    fireEvent.click(screen.getByRole("button", { name: "Tag now" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Tagging failed")
    expect(screen.getByRole("button", { name: "Retry tagging" })).toBeTruthy()
  })

  it("points an item waiting in a batch to the review page", () => {
    const batched = detailOf(pendingCard({ taggingBatchId: "00000000-0000-4000-8000-00000000b001" }))
    render(<ItemDetail item={batched} actions={fakeActions()} />)

    expect(screen.getByRole("link", { name: "Open the review page" }).getAttribute("href")).toBe("/add/review")
    expect(screen.queryByRole("button", { name: "Tag now" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Fill in by hand" })).toBeNull()
  })

  it("shows an archived item without a form, with Unarchive", () => {
    const archived = detailOf(taggedCard({ status: "archived" }))
    render(<ItemDetail item={archived} actions={fakeActions()} />)

    expect(screen.getByText("Archived")).toBeTruthy()
    expect(screen.getByText(/Archived items cannot be edited/)).toBeTruthy()
    expect(screen.queryByRole("form")).toBeNull()
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeTruthy()
  })

  it("takes a newer server item when the page is shown again", () => {
    const first = detailOf(taggedCard({ status: "confirmed", decision: "undecided" }))
    const actions = fakeActions()
    const { rerender } = render(<ItemDetail item={first} actions={actions} />)

    rerender(<ItemDetail item={{ ...first, decision: "sell", name: "Old navy coat" }} actions={actions} />)

    expect(screen.getByRole("heading", { level: 1, name: "Old navy coat" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Sell" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("keeps a saved decision when a later save returns the tags", async () => {
    const item = detailOf(taggedCard({ status: "confirmed" }))
    const actions = fakeActions()
    actions.setItemDecision.mockResolvedValue(ok({ ...item, decision: "donate" }))
    render(<ItemDetail item={item} actions={actions} />)

    fireEvent.click(screen.getByRole("button", { name: "Donate" }))
    await waitFor(() => expect(actions.setItemDecision).toHaveBeenCalledWith({ id: item.id, decision: "donate" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Donate" }).getAttribute("aria-pressed")).toBe("true"))

    // The form's Save never sends the decision, and its answer carries the saved one.
    actions.updateItemTags.mockResolvedValue(ok({ ...item, decision: "donate", brand: "Barbour" }))
    fireEvent.change(screen.getByLabelText("Brand"), { target: { value: "Barbour" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(actions.updateItemTags).toHaveBeenCalledWith({ id: item.id, patch: { brand: "Barbour" } }))
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."))
    expect(screen.getByRole("button", { name: "Donate" }).getAttribute("aria-pressed")).toBe("true")
  })
})

// Next keeps the item page in a hidden <Activity> and serves Back and Forward
// from its client cache with the same item object (node_modules/next/dist/
// docs/01-app/02-guides/preserving-ui-state.md).
describe("ItemDetail after a return", () => {
  function renderInActivity(initial: ItemDetailDto, actions: ItemDetailActions) {
    let item = initial
    const ui = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <ItemDetail item={item} actions={actions} />
      </Activity>
    )
    const view = render(ui("visible"))
    return {
      hide: () => view.rerender(ui("hidden")),
      show: () => view.rerender(ui("visible")),
      serve: (next: ItemDetailDto) => {
        item = next
        view.rerender(ui("visible"))
      },
    }
  }

  it("reads itself again when the item was changed elsewhere in the tab, then shows the new item", () => {
    const first = detailOf(taggedCard({ status: "tagged" }))
    const page = renderInActivity(first, fakeActions())
    expect(screen.getByRole("button", { name: /Confirm/ })).toBeTruthy()
    page.hide()
    page.show()
    expect(router.refresh).not.toHaveBeenCalled()

    // The review page confirmed it meanwhile; then Back to this page.
    page.hide()
    act(() => noteWardrobeChange())
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    page.serve({ ...first, status: "confirmed" })
    expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull()
    page.hide()
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("does not read itself again for its own saves while shown", async () => {
    const item = detailOf(taggedCard({ status: "confirmed" }))
    const actions = fakeActions()
    actions.setItemDecision.mockResolvedValue(ok({ ...item, decision: "donate" }))
    renderInActivity(item, actions)
    fireEvent.click(screen.getByRole("button", { name: "Donate" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Donate" }).getAttribute("aria-pressed")).toBe("true"))
    expect(router.refresh).not.toHaveBeenCalled()
  })
})

// The page re-read itself (D-107) while the form held unsaved edits: the
// fields the owner did not touch must follow the newer item, or Save would
// send their old values and undo the change made on the other page.
describe("ItemDetail re-read with unsaved edits", () => {
  const NAME_ELSEWHERE = "Barbour waxed jacket"

  async function reReadWith(
    draft: () => void,
    changedElsewhere: (first: ItemDetailDto) => ItemDetailDto
  ) {
    const first = detailOf(taggedCard({ status: "confirmed", name: "Navy wool coat" }))
    const actions = fakeActions()
    let item = first
    const ui = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <ItemDetail item={item} actions={actions} />
      </Activity>
    )
    const view = render(ui("visible"))
    draft()
    // The owner leaves without saving; the item changes on another page; Back.
    view.rerender(ui("hidden"))
    act(() => noteWardrobeChange())
    view.rerender(ui("visible"))
    expect(router.refresh).toHaveBeenCalledTimes(1)
    const second = changedElsewhere(first)
    item = second
    view.rerender(ui("visible"))
    actions.updateItemTags.mockImplementation(async ({ patch }) => ok({ ...second, ...patch } as ItemCardDto))
    return { actions, second }
  }

  function field(label: string): HTMLInputElement | HTMLTextAreaElement {
    const element = screen.getByLabelText(label)
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error(label)
    return element
  }

  async function savedPatch(actions: ReturnType<typeof fakeActions>) {
    const save = screen.getByRole("button", { name: "Save" })
    expect(save.getAttribute("aria-disabled")).not.toBe("true")
    fireEvent.click(save)
    await waitFor(() => expect(actions.updateItemTags).toHaveBeenCalledTimes(1))
    return actions.updateItemTags.mock.calls[0]?.[0].patch
  }

  it("shows the newer values in untouched fields and saves only the edited one", async () => {
    const { actions } = await reReadWith(
      () => fireEvent.change(field("Notes"), { target: { value: "Needs dry cleaning" } }),
      (first) => ({ ...first, name: NAME_ELSEWHERE, seasons: ["winter"], updatedAt: "2026-11-02T16:00:00.000Z" })
    )

    expect(screen.getByRole("heading", { level: 1, name: NAME_ELSEWHERE })).toBeTruthy()
    expect(field("Name").value).toBe(NAME_ELSEWHERE)
    expect(field("Notes").value).toBe("Needs dry cleaning")
    expect(await savedPatch(actions)).toEqual({ notes: "Needs dry cleaning" })
  })

  it("keeps the draft of a field the owner edited and sends only that field", async () => {
    const { actions } = await reReadWith(
      () => fireEvent.change(field("Name"), { target: { value: "My coat" } }),
      (first) => ({ ...first, name: NAME_ELSEWHERE, brand: "Barbour" })
    )

    expect(field("Name").value).toBe("My coat")
    expect(field("Brand").value).toBe("Barbour")
    expect(await savedPatch(actions)).toEqual({ name: "My coat" })
  })

  it("does not send Claude's newer tags back as the owner's edits after a re-tag elsewhere", async () => {
    const { actions, second } = await reReadWith(
      () => fireEvent.change(field("Notes"), { target: { value: "Needs dry cleaning" } }),
      (first) => ({
        ...first,
        status: "tagged",
        name: "Waxed field jacket",
        subcategory: "field jacket",
        warmthLevel: 3,
        aiModel: "claude-haiku-5-5",
      })
    )

    expect(field("Name").value).toBe(second.name)
    expect(await savedPatch(actions)).toEqual({ notes: "Needs dry cleaning" })
  })

  it("takes the newer item in a form without edits, with nothing to save", async () => {
    await reReadWith(
      () => undefined,
      (first) => ({ ...first, name: NAME_ELSEWHERE })
    )

    expect(field("Name").value).toBe(NAME_ELSEWHERE)
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true")
  })
})

// A newer item reaches the form while a field still shows the error from the
// last Save (D-132, D-137): fixing the field must clear the error, as it does
// without the newer item, or a screen reader keeps reporting it as invalid.
describe("ItemDetail field error across a newer item", () => {
  const PRICE_ERROR = "Enter an amount such as 49.90."

  function input(label: string): HTMLInputElement {
    const element = screen.getByLabelText(label)
    if (!(element instanceof HTMLInputElement)) throw new Error(label)
    return element
  }

  function renderWithPriceError() {
    const item = detailOf(taggedCard({ status: "confirmed" }))
    const actions = fakeActions()
    actions.setItemDecision.mockImplementation(async ({ decision }) => ok({ ...item, decision }))
    const view = render(<ItemDetail item={item} actions={actions} />)
    return { item, actions, view }
  }

  async function showPriceError() {
    fireEvent.change(input("Price"), { target: { value: "abc" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.getByText(PRICE_ERROR)).toBeTruthy())
    expect(input("Price").getAttribute("aria-invalid")).toBe("true")
  }

  async function savedPatch(actions: ReturnType<typeof fakeActions>) {
    const save = screen.getByRole("button", { name: "Save" })
    expect(save.getAttribute("aria-disabled")).not.toBe("true")
    fireEvent.click(save)
    await waitFor(() => expect(actions.updateItemTags).toHaveBeenCalledTimes(1))
    return actions.updateItemTags.mock.calls[0]?.[0].patch
  }

  it("clears the error once the owner fixes the field after a plan toggle saved", async () => {
    const { item, actions } = renderWithPriceError()
    actions.updateItemTags.mockImplementation(async ({ patch }) => ok({ ...item, decision: "donate", ...patch }))
    await showPriceError()

    fireEvent.click(screen.getByRole("button", { name: "Donate" }))
    // The toggle's answer is in, so the form has taken the item it returned.
    await waitFor(() => expect(actions.setItemDecision).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Plan for the move" }).closest("[aria-busy]")).toBeNull()
    )
    // The draft and its error survive the new item.
    expect(input("Price").value).toBe("abc")
    expect(screen.getByText(PRICE_ERROR)).toBeTruthy()

    fireEvent.change(input("Price"), { target: { value: "49.90" } })
    await waitFor(() => expect(screen.queryByText(PRICE_ERROR)).toBeNull())
    expect(input("Price").getAttribute("aria-invalid")).not.toBe("true")
    expect(await savedPatch(actions)).toEqual({ purchase_price: 49.9 })
  })

  it("clears the error when a newer item arrives while the fixed field is being checked", async () => {
    const { item, actions, view } = renderWithPriceError()
    actions.updateItemTags.mockImplementation(async ({ patch }) => ok({ ...item, brand: "Barbour", ...patch }))
    await showPriceError()

    // The owner fixes the price, and in the same moment a re-read brings the
    // item with a brand added elsewhere, before the check of the price ends.
    act(() => {
      fireEvent.change(input("Price"), { target: { value: "49.90" } })
      view.rerender(<ItemDetail item={{ ...item, brand: "Barbour" }} actions={actions} />)
    })

    await waitFor(() => expect(screen.queryByText(PRICE_ERROR)).toBeNull())
    expect(input("Price").getAttribute("aria-invalid")).not.toBe("true")
    // The newer item is still taken once the check ended.
    await waitFor(() => expect(input("Brand").value).toBe("Barbour"))
    expect(input("Price").value).toBe("49.90")
    expect(await savedPatch(actions)).toEqual({ purchase_price: 49.9 })
  })
})
