// @vitest-environment jsdom
import { Activity } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { toast } from "@/components/ui/toast"
import { noteWardrobeChange } from "@/lib/items/wardrobe-changes"
import type { ShoppingItemDto, ShoppingListDto } from "@/lib/relocation/contracts"
import { err, ok, type Result } from "@/lib/result"

import type {
  AddShoppingItemAction,
  DeleteShoppingItemAction,
  SearchLinkableItemsAction,
  ShoppingActions,
  UpdateShoppingItemAction,
} from "./shopping-actions"
import { noteShoppingListChange, shoppingListIsStale } from "./shopping-changes"
import { ShoppingListView } from "./shopping-list"
import { shoppingItem } from "./test-fixtures"

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}))

beforeEach(() => {
  vi.spyOn(toast, "add").mockReturnValue("toast-id")
  router.refresh.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const COAT = {
  id: "00000000-0000-4000-8000-0000000000c0",
  name: "Navy wool coat",
  category: "outerwear" as const,
  thumb: { url: "https://example.invalid/coat.webp", width: 200, height: 200 },
}

function makeActions(): ShoppingActions & {
  addShoppingItem: ReturnType<typeof vi.fn<AddShoppingItemAction>>
  updateShoppingItem: ReturnType<typeof vi.fn<UpdateShoppingItemAction>>
  deleteShoppingItem: ReturnType<typeof vi.fn<DeleteShoppingItemAction>>
  searchLinkableItems: ReturnType<typeof vi.fn<SearchLinkableItemsAction>>
} {
  return {
    addShoppingItem: vi.fn<AddShoppingItemAction>(),
    updateShoppingItem: vi.fn<UpdateShoppingItemAction>(),
    deleteShoppingItem: vi.fn<DeleteShoppingItemAction>(),
    searchLinkableItems: vi.fn<SearchLinkableItemsAction>().mockResolvedValue(ok([COAT])),
  }
}

function list(overrides: Partial<ShoppingListDto> = {}): ShoppingListDto {
  return {
    items: [
      shoppingItem({ itemType: "Rain shell", priority: 1, estPriceMinEur: 150, estPriceMaxEur: 250 }),
      shoppingItem({ itemType: "Merino base layer", priority: 2, quantity: 2, estPriceMinEur: 40, estPriceMaxEur: 70 }),
      shoppingItem({ itemType: "Beanie", priority: 3, status: "bought", estPriceMinEur: 20, estPriceMaxEur: 30 }),
    ],
    latestBudgetEur: 400,
    latestAnalysisId: null,
    ...overrides,
  }
}

function row(name: string): HTMLElement {
  return screen.getByRole("listitem", { name })
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  })
}

/** Waits for an animation frame too, so a focus move scheduled in one has happened. */
async function settled(): Promise<void> {
  await flush()
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  })
}

function deferred<T>() {
  let settle: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    settle = done
  })
  return { promise, settle }
}

/** /shopping inside the <Activity> Next keeps it in, with a way to show, hide and replace its list. */
function keptList(first: ShoppingListDto, actions: ShoppingActions) {
  const ui = (mode: "visible" | "hidden", shown: ShoppingListDto) => (
    <Activity mode={mode}>
      <ShoppingListView list={shown} actions={actions} />
    </Activity>
  )
  let shown = first
  const rendered = render(ui("visible", first))
  return {
    async show(next: ShoppingListDto = shown) {
      shown = next
      rendered.rerender(ui("visible", next))
      await flush()
    },
    async hide() {
      rendered.rerender(ui("hidden", shown))
      await flush()
    },
  }
}

/** Back to the kept list after "Add to shopping list" on a plan: it asks for a read. */
async function askForARead(page: ReturnType<typeof keptList>): Promise<void> {
  await page.hide()
  act(() => noteShoppingListChange())
  await page.show()
  expect(router.refresh).toHaveBeenCalledTimes(1)
}

function pressedStatus(name: string): string | undefined {
  return within(screen.getByRole("group", { name: `Status of ${name}` }))
    .getAllByRole("button")
    .find((button) => button.getAttribute("aria-pressed") === "true")?.textContent ?? undefined
}

describe("ShoppingListView", () => {
  it("groups the rows by priority and points an empty list to the relocation plan", () => {
    const { unmount } = render(<ShoppingListView list={list()} actions={makeActions()} />)

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Budget",
      "Must have (1)",
      "Should have (1)",
      "Nice to have (1)",
    ])
    unmount()

    render(<ShoppingListView list={list({ items: [], latestBudgetEur: null })} actions={makeActions()} />)
    expect(screen.getByText("Nothing on your list yet")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Plan the move" }).getAttribute("href")).toBe("/relocate")
  })

  it("prefills the budget from the latest run and compares the To buy rows with it", () => {
    render(<ShoppingListView list={list()} actions={makeActions()} />)

    const budget = screen.getByLabelText("Budget for new purchases (€)") as HTMLInputElement
    expect(budget.value).toBe("400")
    expect(screen.getByText(/To buy: 2 items \(3 pieces\)/).closest("p")?.textContent).toBe(
      "To buy: 2 items (3 pieces), €230–€390 in all."
    )
    expect(screen.getByText("Within budget, with €10 left even at the high end.")).toBeTruthy()

    fireEvent.change(budget, { target: { value: "300" } })
    expect(screen.getByText("Could go over: the high end is €90 over budget.")).toBeTruthy()

    fireEvent.change(budget, { target: { value: "200" } })
    expect(screen.getByText("Over budget by €30, even at the low end.")).toBeTruthy()
    expect(screen.getByText(/changes are not saved/)).toBeTruthy()
  })

  it("links an owned item found by search, and unlinks it", async () => {
    const actions = makeActions()
    const original = list().items[0]
    if (original === undefined) throw new Error("fixture")
    const view = list({ items: [original] })
    actions.updateShoppingItem.mockImplementation(async (input) =>
      ok({ ...original, linkedItem: input.linkedItemId ? { id: COAT.id, name: COAT.name, thumb: COAT.thumb } : null })
    )
    render(<ShoppingListView list={view} actions={actions} />)

    fireEvent.click(within(row("Rain shell")).getByRole("button", { name: "Link to an item I own" }))
    const dialog = await screen.findByRole("dialog")
    await waitFor(() => expect(actions.searchLinkableItems).toHaveBeenCalledWith({ q: "" }))

    fireEvent.change(within(dialog).getByLabelText("Search your items"), { target: { value: " coat " } })
    await waitFor(() => expect(actions.searchLinkableItems).toHaveBeenLastCalledWith({ q: "coat" }))
    fireEvent.click(await within(dialog).findByRole("button", { name: /Navy wool coat/ }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(actions.updateShoppingItem).toHaveBeenCalledWith({ id: original.id, linkedItemId: COAT.id })
    expect(within(row("Rain shell")).getByRole("link", { name: "Navy wool coat" }).getAttribute("href")).toBe(
      `/wardrobe/${COAT.id}`
    )

    await act(async () => {
      fireEvent.click(within(row("Rain shell")).getByRole("button", { name: "Unlink Navy wool coat from Rain shell" }))
    })
    expect(actions.updateShoppingItem).toHaveBeenLastCalledWith({ id: original.id, linkedItemId: null })
    expect(within(row("Rain shell")).queryByRole("link")).toBeNull()
  })

  it("puts focus on Unlink after linking, not on <body> or another row", async () => {
    const actions = makeActions()
    const view = list()
    const original = view.items[0]
    if (original === undefined) throw new Error("fixture")
    actions.updateShoppingItem.mockImplementation(async () =>
      ok({ ...original, linkedItem: { id: COAT.id, name: COAT.name, thumb: COAT.thumb } })
    )
    render(<ShoppingListView list={view} actions={actions} />)

    // Another row's Delete dialog, opened and cancelled first, is the focus
    // history a dialog with nowhere to return falls back to.
    fireEvent.click(screen.getByRole("button", { name: "Delete Beanie" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())

    const linkButton = within(row("Rain shell")).getByRole("button", { name: "Link to an item I own" })
    linkButton.focus()
    fireEvent.click(linkButton)
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(await within(dialog).findByRole("button", { name: /Navy wool coat/ }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    const unlink = within(row("Rain shell")).getByRole("button", { name: "Unlink Navy wool coat from Rain shell" })
    await waitFor(() => expect(document.activeElement).toBe(unlink))
  })

  it("deletes a row after asking", async () => {
    const actions = makeActions()
    actions.deleteShoppingItem.mockResolvedValue(ok({ deleted: true }))
    const view = list()
    render(<ShoppingListView list={view} actions={actions} />)

    fireEvent.click(screen.getByRole("button", { name: "Delete Rain shell" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Delete Rain shell?")).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    })

    expect(actions.deleteShoppingItem).toHaveBeenCalledWith({ id: view.items[0]?.id })
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Rain shell" })).toBeNull())
    expect(screen.queryByRole("heading", { name: /Must have/ })).toBeNull()
  })

  it("tells a kept plan page that a gap row is gone, without reading /shopping itself again (D-173)", async () => {
    const actions = makeActions()
    actions.deleteShoppingItem.mockResolvedValue(ok({ deleted: true }))
    const gap = shoppingItem({ itemType: "Rain shell", priority: 1, gapKey: "g1-outerwear-rain-shell", analysisId: "a" })
    const byHand = shoppingItem({ itemType: "Umbrella", priority: 2 })
    const view = list({ items: [gap, byHand] })
    const ui = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <ShoppingListView list={view} actions={actions} />
      </Activity>
    )
    const rendered = render(ui("visible"))
    // A plan page shown before, now kept hidden by Next.
    const planView = {}
    expect(shoppingListIsStale(planView)).toBe(false)

    async function remove(name: string) {
      fireEvent.click(screen.getByRole("button", { name: `Delete ${name}` }))
      const dialog = await screen.findByRole("alertdialog")
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
      })
      await waitFor(() => expect(screen.queryByRole("listitem", { name })).toBeNull())
    }

    // A row added by hand is on no plan: nothing to tell.
    await remove("Umbrella")
    expect(shoppingListIsStale(planView)).toBe(false)

    await remove("Rain shell")
    expect(shoppingListIsStale(planView)).toBe(true)

    // This page already shows the deletion: hidden and shown again, it does not read itself.
    rendered.rerender(ui("hidden"))
    rendered.rerender(ui("visible"))
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("adds a row from the form in the list's order", async () => {
    const actions = makeActions()
    actions.addShoppingItem.mockResolvedValue(ok(shoppingItem({ itemType: "Gloves", priority: 1, createdAt: "2026-11-03T10:00:00.000Z" })))
    render(<ShoppingListView list={list()} actions={actions} />)

    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    expect(document.activeElement).toBe(screen.getByLabelText("What to buy"))
    fireEvent.change(screen.getByLabelText("What to buy"), { target: { value: "Gloves" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to list" }))
    })

    const mustHave = screen.getByRole("heading", { name: "Must have (2)" }).closest("section")
    if (mustHave === null) throw new Error("no section")
    expect(within(mustHave).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Rain shell",
      "Gloves",
    ])
  })

  it("keeps a status saved after a read was asked for when that read lands, and reads once more (D-180)", async () => {
    const actions = makeActions()
    const first = list()
    const shell = first.items[0]
    if (shell === undefined) throw new Error("fixture")
    actions.updateShoppingItem.mockResolvedValue(ok({ ...shell, status: "bought" }))
    const page = keptList(first, actions)
    await askForARead(page)

    // Bought is saved before the read lands; the read is from before it.
    fireEvent.click(within(screen.getByRole("group", { name: "Status of Rain shell" })).getByRole("button", { name: "Bought" }))
    await flush()
    await page.show(structuredClone(first))

    expect(pressedStatus("Rain shell")).toBe("Bought")
    expect(screen.getByText("3 entries on your list, 1 still to buy.")).toBeTruthy()
    expect(router.refresh).toHaveBeenCalledTimes(2)

    // The read after the save holds it: nothing more to read.
    await page.show({ ...first, items: first.items.map((item) => (item.id === shell.id ? { ...item, status: "bought" as const } : item)) })
    expect(pressedStatus("Rain shell")).toBe("Bought")
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it("keeps a status saved before a copy no refresh of the page asked for, and reads once more (D-183)", async () => {
    const actions = makeActions()
    const first = list()
    const shell = first.items[0]
    if (shell === undefined) throw new Error("fixture")
    actions.updateShoppingItem.mockResolvedValue(ok({ ...shell, status: "bought" }))
    const page = keptList(first, actions)

    // The Shopping link pressed on /shopping reads the list while the page stays
    // usable; Bought is saved before that copy lands, and the copy is from before it.
    fireEvent.click(within(screen.getByRole("group", { name: "Status of Rain shell" })).getByRole("button", { name: "Bought" }))
    await flush()
    await page.show(structuredClone(first))

    expect(pressedStatus("Rain shell")).toBe("Bought")
    expect(screen.getByText("3 entries on your list, 1 still to buy.")).toBeTruthy()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The read after the save holds it: nothing more to read.
    await page.show({ ...first, items: first.items.map((item) => (item.id === shell.id ? { ...item, status: "bought" as const } : item)) })
    expect(pressedStatus("Rain shell")).toBe("Bought")
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps a row deleted, and one added, after a read was asked for when that read lands (D-180)", async () => {
    const actions = makeActions()
    actions.deleteShoppingItem.mockResolvedValue(ok({ deleted: true }))
    const added = shoppingItem({ itemType: "Gloves", priority: 1, createdAt: "2026-11-03T10:00:00.000Z" })
    actions.addShoppingItem.mockResolvedValue(ok(added))
    const first = list()
    const page = keptList(first, actions)
    await askForARead(page)

    fireEvent.click(screen.getByRole("button", { name: "Delete Beanie" }))
    const dialog = await screen.findByRole("alertdialog")
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    })
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Beanie" })).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    fireEvent.change(screen.getByLabelText("What to buy"), { target: { value: "Gloves" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to list" }))
    })
    await page.show(structuredClone(first))

    expect(screen.queryByRole("listitem", { name: "Beanie" })).toBeNull()
    expect(screen.getByRole("listitem", { name: "Gloves" })).toBeTruthy()
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it("reads once when Next shows it after both an item change and a shopping-list change (D-180)", async () => {
    const first = list()
    const page = keptList(first, makeActions())
    expect(router.refresh).not.toHaveBeenCalled()

    await page.hide()
    act(() => {
      noteWardrobeChange()
      noteShoppingListChange()
    })
    await page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    await page.show(structuredClone(first))
    await page.hide()
    await page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("moves focus after Unlink only when it was lost, never from a field the owner moved to (D-182)", async () => {
    const actions = makeActions()
    const linked: ShoppingItemDto = {
      ...shoppingItem({ itemType: "Rain shell", priority: 1 }),
      linkedItem: { id: COAT.id, name: COAT.name, thumb: COAT.thumb },
    }
    const answers: ReturnType<typeof deferred<Result<ShoppingItemDto>>>[] = []
    actions.updateShoppingItem.mockImplementation(() => {
      const answer = deferred<Result<ShoppingItemDto>>()
      answers.push(answer)
      return answer.promise
    })
    const first = list({ items: [linked] })
    const page = keptList(first, actions)
    const unlinkName = "Unlink Navy wool coat from Rain shell"
    // The row linked again: a copy read after the unlink, which Back after a
    // change elsewhere asks for (a copy nobody asked for keeps the unlink, D-183).
    async function linkedAgain() {
      await page.hide()
      act(() => noteShoppingListChange())
      await page.show()
      await page.show(structuredClone(first))
    }

    // 1. The owner presses Unlink, then moves to the add form and types.
    fireEvent.click(screen.getByRole("button", { name: unlinkName }))
    fireEvent.click(screen.getByRole("button", { name: "Add item" }))
    const field = screen.getByLabelText("What to buy")
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: "Wool so" } })
    await act(async () => answers[0]?.settle(ok({ ...linked, linkedItem: null })))
    await settled()
    expect(document.activeElement).toBe(field)

    // 2. Focus stays on Unlink until it answers: the link button that replaces it takes it.
    await linkedAgain()
    const unlink = screen.getByRole("button", { name: unlinkName })
    unlink.focus()
    fireEvent.click(unlink)
    await act(async () => answers[1]?.settle(ok({ ...linked, linkedItem: null })))
    await settled()
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Link to an item I own" }))

    // 3. An answer that comes while Next hides the page moves nothing on return.
    await linkedAgain()
    const again = screen.getByRole("button", { name: unlinkName })
    again.focus()
    fireEvent.click(again)
    await page.hide()
    await act(async () => answers[2]?.settle(ok({ ...linked, linkedItem: null })))
    await settled()
    act(() => document.body.focus())
    await page.show()
    await settled()
    expect(document.activeElement).toBe(document.body)

    // 4. A failed Unlink leaves focus on it.
    await linkedAgain()
    const failing = screen.getByRole("button", { name: unlinkName })
    failing.focus()
    fireEvent.click(failing)
    await act(async () => answers[3]?.settle(err("UPSTREAM", "Could not reach the server.")))
    await settled()
    expect(document.activeElement).toBe(failing)
  })

  it("reads itself again when shown after the list changed on another page", () => {
    const view = list()
    const actions = makeActions()
    const { rerender } = render(
      <Activity mode="visible">
        <ShoppingListView list={view} actions={actions} />
      </Activity>
    )
    expect(router.refresh).not.toHaveBeenCalled()

    rerender(
      <Activity mode="hidden">
        <ShoppingListView list={view} actions={actions} />
      </Activity>
    )
    act(() => noteShoppingListChange())
    rerender(
      <Activity mode="visible">
        <ShoppingListView list={view} actions={actions} />
      </Activity>
    )
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The refreshed list counts as read from when the refresh was asked for.
    rerender(
      <Activity mode="visible">
        <ShoppingListView list={{ ...view }} actions={actions} />
      </Activity>
    )
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })
})
