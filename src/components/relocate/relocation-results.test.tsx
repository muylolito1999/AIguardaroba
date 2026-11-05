// @vitest-environment jsdom
import { Activity } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { taggedCard } from "@/components/items/test-fixtures"
import { noteShoppingListChange, shoppingListIsStale } from "@/components/shopping/shopping-changes"
import { toast } from "@/components/ui/toast"
import type { ItemCardDto } from "@/lib/items/contracts"
import { noteWardrobeChange, wardrobeChangeCount } from "@/lib/items/wardrobe-changes"
import type { PackingRowDto, RelocationItemRefDto, RelocationViewDto } from "@/lib/relocation/contracts"
import { err, ok, type Result } from "@/lib/result"

import { makeRelocationResult } from "../../../test/relocation-fixtures"
import type {
  AddGapsToShoppingListAction,
  AddPackingExtraAction,
  ApplyAiDecisionsAction,
  DeletePackingExtraAction,
  RelocationResultActions,
  SetPackingItemPackedAction,
} from "./actions"
import { notePackingChange, packingReadIsStale, RefreshPrintWhenShown } from "./packing-changes"
import { RelocationResults } from "./relocation-results"

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

const ANALYSIS_ID = "00000000-0000-4000-8000-0000000000f1"
const ITEM_IDS = [1, 2, 3, 4, 5, 6].map((n) => `00000000-0000-4000-8000-00000000010${n}`)
const [FIRST, SECOND, , , FIFTH] = ITEM_IDS as [string, string, string, string, string, string]

/** A finished run over six items: AI decisions bring, bring, leave, donate, sell, bring; the owner already chose Sell for the fifth. */
function makeView(overrides: Partial<RelocationViewDto> = {}): RelocationViewDto {
  const result = makeRelocationResult(ITEM_IDS)
  const items: Record<string, RelocationItemRefDto> = Object.fromEntries(
    ITEM_IDS.map((id, index) => [
      id,
      {
        id,
        name: `Item ${index + 1}`,
        category: "outerwear",
        thumb: null,
        currentDecision: id === FIFTH ? "sell" : "undecided",
        status: "confirmed",
        location: "bologna",
        collection: "clothing",
        exists: true,
      } satisfies RelocationItemRefDto,
    ])
  )
  let order = 0
  const packing: PackingRowDto[] = result.packing_checklist.flatMap((group) => [
    ...group.item_ids.map((itemId) => ({
      id: `00000000-0000-4000-8000-0000000002${String((order += 1)).padStart(2, "0")}`,
      group: group.group,
      label: items[itemId]?.name ?? "?",
      itemId,
      packed: false,
      sortOrder: order,
    })),
    ...group.extras.map((label) => ({
      id: `00000000-0000-4000-8000-0000000002${String((order += 1)).padStart(2, "0")}`,
      group: group.group,
      label,
      itemId: null,
      packed: false,
      sortOrder: order,
    })),
  ])
  return {
    id: ANALYSIS_ID,
    createdAt: "2026-11-03T08:00:00.000Z",
    completedAt: "2026-11-03T08:04:00.000Z",
    status: "complete",
    model: "claude-sonnet-5-5",
    effort: "medium",
    promptVersion: "reloc-v1",
    estimatedCostUsd: 0.42,
    costUsd: 0.39,
    params: {
      climateProfileId: "00000000-0000-4000-8000-0000000000e1",
      dateFrom: "2026-11-03",
      dateTo: "2027-11-02",
      constraints: "",
      purchaseBudgetEur: 600,
      includeOnlyConfirmed: true,
      acceptPlaceholder: false,
    },
    months: [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    profile: { id: "00000000-0000-4000-8000-0000000000e1", city: "Hamburg", country: "Germany", isPlaceholder: false },
    destination: "hamburg",
    result,
    items,
    packing,
    addedGapKeys: [],
    ...overrides,
  }
}

function deferred<T>() {
  let settle: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    settle = done
  })
  return { promise, settle }
}

function actions(overrides: Partial<RelocationResultActions> = {}): RelocationResultActions {
  return {
    setItemDecision: vi.fn(async ({ id, decision }) => ok({ ...taggedCard(), id, decision })),
    applyAiDecisionsToUndecided: vi.fn<ApplyAiDecisionsAction>(async () => ok({ updated: 0, itemIds: [] })),
    addGapsToShoppingList: vi.fn<AddGapsToShoppingListAction>(async ({ gapKeys }) =>
      ok({ added: gapKeys.length, alreadyThere: 0 })
    ),
    setPackingItemPacked: vi.fn<SetPackingItemPackedAction>(async () => err("INTERNAL", "Something went wrong.")),
    addPackingExtra: vi.fn<AddPackingExtraAction>(async () => err("INTERNAL", "Something went wrong.")),
    deletePackingExtra: vi.fn<DeletePackingExtraAction>(async () => ok({ deleted: true as const })),
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  })
}

function decisionGroup(name: string): HTMLElement {
  return screen.getByRole("group", { name: `Your decision for ${name}` })
}

function pressed(group: HTMLElement, label: string): string | null {
  return within(group).getByRole("button", { name: label }).getAttribute("aria-pressed")
}

function card(name: string): HTMLElement {
  const element = decisionGroup(name).closest("li")
  if (element === null) throw new Error(`No card for ${name}`)
  return element
}

/** Rows the Packing tab counts: extras, and items decided bring by the owner, or by the AI where the owner has not decided (D-181). */
function comingRows(view: RelocationViewDto): number {
  const ai = new Map(view.result.items.map((entry) => [entry.item_id, entry.decision]))
  return view.packing.filter((row) => {
    if (row.itemId === null) return true
    const own = view.items[row.itemId]?.currentDecision ?? "undecided"
    return own === "bring" || (own === "undecided" && ai.get(row.itemId) === "bring")
  }).length
}

/** The page inside the <Activity> Next keeps it in, with a way to show, hide and replace its view. */
function keptPage(first: RelocationViewDto, acts: RelocationResultActions) {
  const ui = (mode: "visible" | "hidden", view: RelocationViewDto) => (
    <Activity mode={mode}>
      <RelocationResults view={view} actions={acts} />
    </Activity>
  )
  let shown = first
  const rendered = render(ui("visible", first))
  return {
    async show(view: RelocationViewDto = shown) {
      shown = view
      rendered.rerender(ui("visible", view))
      await flush()
    },
    async hide() {
      rendered.rerender(ui("hidden", shown))
      await flush()
    },
  }
}

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
  router.refresh.mockClear()
  router.push.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("RelocationResults", () => {
  it("shows the summary, the costs and tab counts", () => {
    render(<RelocationResults view={makeView()} actions={actions()} />)

    expect(screen.getByText(/Hamburg is cool, wet and windy/)).toBeTruthy()
    expect(screen.getByText("$0.39 (estimated $0.42)")).toBeTruthy()
    expect(screen.getByText("Sonnet 5.5 · medium effort")).toBeTruthy()
    // The plan's budget is what was left to spend from the day it finished (D-231).
    expect(screen.getByText("€600 to spend from 3 Nov 2026")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Items 6" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Gaps 2" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Warnings 1" })).toBeTruthy()
    // The owner's own decision shows on the card.
    expect(within(card("Item 5")).getByText("Yours: Sell")).toBeTruthy()
    expect(within(card("Item 1")).queryByText(/^Yours:/)).toBeNull()
  })

  it("shows an override at once and keeps it when the save succeeds", async () => {
    const save = deferred<Result<ItemCardDto>>()
    const setItemDecision = vi.fn<RelocationResultActions["setItemDecision"]>(() => save.promise)
    render(<RelocationResults view={makeView()} actions={actions({ setItemDecision })} />)
    const before = wardrobeChangeCount()

    fireEvent.click(within(decisionGroup("Item 1")).getByRole("button", { name: "Leave" }))
    await flush()
    expect(pressed(decisionGroup("Item 1"), "Leave")).toBe("true")
    expect(setItemDecision).toHaveBeenCalledWith({ id: FIRST, decision: "leave" })

    await act(async () => save.settle(ok({ ...taggedCard(), id: FIRST, decision: "leave" })))
    await flush()
    expect(pressed(decisionGroup("Item 1"), "Leave")).toBe("true")
    expect(within(card("Item 1")).getByText("Yours: Leave")).toBeTruthy()
    // The wardrobe and stats pages read again (D-107).
    expect(wardrobeChangeCount()).toBe(before + 1)
  })

  it("puts the decision back and toasts when the override fails", async () => {
    const save = deferred<Result<ItemCardDto>>()
    render(<RelocationResults view={makeView()} actions={actions({ setItemDecision: () => save.promise })} />)
    const before = wardrobeChangeCount()

    fireEvent.click(within(decisionGroup("Item 2")).getByRole("button", { name: "Donate" }))
    await flush()
    expect(pressed(decisionGroup("Item 2"), "Donate")).toBe("true")

    await act(async () => save.settle(err("NOT_FOUND", "That item no longer exists.")))
    await flush()
    expect(pressed(decisionGroup("Item 2"), "Undecided")).toBe("true")
    expect(pressed(decisionGroup("Item 2"), "Donate")).toBe("false")
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Not found", type: "error" }))
    expect(wardrobeChangeCount()).toBe(before)
  })

  it("greys out items deleted or archived since the run and offers no override for them", () => {
    const view = makeView()
    view.items[SECOND] = { ...view.items[SECOND]!, exists: false, status: null, name: "Old raincoat" }
    view.items[FIRST] = { ...view.items[FIRST]!, status: "archived" }
    render(<RelocationResults view={view} actions={actions()} />)

    expect(screen.queryByRole("group", { name: "Your decision for Old raincoat" })).toBeNull()
    expect(screen.queryByRole("group", { name: "Your decision for Item 1" })).toBeNull()
    expect(screen.getByText("Deleted since this run.")).toBeTruthy()
    expect(screen.getByText("Archived since this run, so its decision cannot be changed here.")).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Old raincoat" })).toBeNull()
    // Four undecided items left that can change: 3, 4 and 6 (5 is the owner's Sell).
    expect(screen.getByRole("button", { name: "Apply AI decisions to 3 undecided items" })).toBeTruthy()
  })

  it("counts only clothing for Apply AI decisions, as the server applies them (D-249)", async () => {
    // The second item was moved to running gear before the page was read.
    const view = makeView()
    view.items[SECOND] = { ...view.items[SECOND]!, collection: "running" }
    const applyAiDecisionsToUndecided = vi.fn<ApplyAiDecisionsAction>(async () =>
      ok({ updated: 4, itemIds: ITEM_IDS.filter((id) => id !== SECOND && id !== FIFTH) })
    )
    render(<RelocationResults view={view} actions={actions({ applyAiDecisionsToUndecided })} />)

    // 1, 3, 4 and 6: not the running item, not the owner's Sell.
    fireEvent.click(screen.getByRole("button", { name: "Apply AI decisions to 4 undecided items" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
    await flush()
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Applied 4 AI decisions", type: "success" }))

    // Only the running item is undecided now, and Apply would write nothing to it.
    const done = screen.getByRole("button", { name: "No undecided items left" })
    expect(done.getAttribute("aria-disabled")).toBe("true")
    expect(pressed(decisionGroup("Item 2"), "Undecided")).toBe("true")
    // The owner can still decide it by hand.
    expect(within(decisionGroup("Item 2")).getByRole("button", { name: "Leave" })).toBeTruthy()
  })

  it("applies AI decisions to undecided items after a confirmation, leaving the owner's own alone", async () => {
    const applyAiDecisionsToUndecided = vi.fn<ApplyAiDecisionsAction>(async () =>
      ok({ updated: 5, itemIds: ITEM_IDS.filter((id) => id !== FIFTH) })
    )
    render(<RelocationResults view={makeView()} actions={actions({ applyAiDecisionsToUndecided })} />)
    const before = wardrobeChangeCount()

    const trigger = screen.getByRole("button", { name: "Apply AI decisions to 5 undecided items" })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog.textContent).toContain("Items you already decided keep your decision.")
    expect(applyAiDecisionsToUndecided).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
    await flush()
    expect(applyAiDecisionsToUndecided).toHaveBeenCalledWith({ analysisId: ANALYSIS_ID })
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    expect(wardrobeChangeCount()).toBe(before + 1)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Applied 5 AI decisions", type: "success" }))
    // Shown before the refresh lands: the AI's decision, and the owner's Sell untouched.
    expect(within(card("Item 1")).getByText("Yours: Bring")).toBeTruthy()
    expect(within(card("Item 4")).getByText("Yours: Donate")).toBeTruthy()
    expect(within(card("Item 5")).getByText("Yours: Sell")).toBeTruthy()
    const done = screen.getByRole("button", { name: "No undecided items left" })
    expect(done.getAttribute("aria-disabled")).toBe("true")
    // Focus came back to the trigger, still focusable while disabled, not <body>.
    await waitFor(() => expect(document.activeElement).toBe(done))
    // A disabled trigger opens nothing.
    fireEvent.click(done)
    await flush()
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("keeps the dialog open with the reason when applying fails", async () => {
    const applyAiDecisionsToUndecided = vi.fn<ApplyAiDecisionsAction>(async () => err("UPSTREAM", "Could not reach the server."))
    render(<RelocationResults view={makeView()} actions={actions({ applyAiDecisionsToUndecided })} />)

    fireEvent.click(screen.getByRole("button", { name: "Apply AI decisions to 5 undecided items" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
    await flush()
    expect(within(dialog).getByRole("alert").textContent).toContain("Could not reach the server.")
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("closes the confirmation and forgets its error when Next hides the page", async () => {
    const applyAiDecisionsToUndecided = vi.fn<ApplyAiDecisionsAction>(async () => err("UPSTREAM", "Could not reach the server."))
    const view = makeView()
    const ui = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <RelocationResults view={view} actions={actions({ applyAiDecisionsToUndecided })} />
      </Activity>
    )
    const rendered = render(ui("visible"))

    fireEvent.click(screen.getByRole("button", { name: "Apply AI decisions to 5 undecided items" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
    await flush()
    expect(within(dialog).getByRole("alert").textContent).toContain("Could not reach the server.")

    rendered.rerender(ui("hidden"))
    await flush()
    rendered.rerender(ui("visible"))
    await flush()
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())

    fireEvent.click(screen.getByRole("button", { name: "Apply AI decisions to 5 undecided items" }))
    const reopened = await screen.findByRole("alertdialog")
    expect(within(reopened).queryByText("Nothing was applied")).toBeNull()
  })

  it("preselects every gap, locks the ones already on the list, and adds the rest", async () => {
    const view = makeView()
    const [onList, toAdd] = view.result.gaps.map((gap) => gap.gap_key) as [string, string]
    const addGapsToShoppingList = vi.fn<AddGapsToShoppingListAction>(async () => ok({ added: 1, alreadyThere: 0 }))
    render(<RelocationResults view={{ ...view, addedGapKeys: [onList] }} actions={actions({ addGapsToShoppingList })} />)

    fireEvent.click(screen.getByRole("tab", { name: "Gaps 2" }))
    const shell = screen.getByRole("checkbox", { name: "Waterproof breathable shell jacket" })
    const boots = screen.getByRole("checkbox", { name: "Insulated waterproof boots" })
    expect(shell.getAttribute("aria-checked")).toBe("true")
    expect(shell.hasAttribute("data-disabled")).toBe(true)
    expect(screen.getByText("On your shopping list")).toBeTruthy()
    expect(boots.getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText("Priority 1 and 2 gaps cost at least €210 of your €600 budget.")).toBeTruthy()
    // A /shopping list Next keeps hidden, shown before the add.
    const shownList = {}
    expect(shoppingListIsStale(shownList)).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "Add 1 to shopping list" }))
    await flush()
    expect(addGapsToShoppingList).toHaveBeenCalledWith({ analysisId: ANALYSIS_ID, gapKeys: [toAdd] })
    // Back to it reads the list again.
    expect(shoppingListIsStale(shownList)).toBe(true)
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Added 1 item to your shopping list", type: "success" })
    )
    // The overlay shows the added gap; the page reads itself again only when shown next (D-173).
    expect(router.refresh).not.toHaveBeenCalled()
    expect(screen.getAllByText("On your shopping list")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "All gaps are on your shopping list" }).getAttribute("aria-disabled")).toBe("true")
  })

  it("reads the plan again when shown after adding gaps and then deleting one on /shopping (D-173)", async () => {
    const view = makeView()
    const ui = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <RelocationResults view={view} actions={actions()} />
      </Activity>
    )
    const rendered = render(ui("visible"))
    fireEvent.click(screen.getByRole("tab", { name: "Gaps 2" }))
    fireEvent.click(screen.getByRole("button", { name: "Add 2 to shopping list" }))
    await flush()
    expect(router.refresh).not.toHaveBeenCalled()

    // The owner opens /shopping at once and deletes one of the gaps there.
    rendered.rerender(ui("hidden"))
    await flush()
    act(() => noteShoppingListChange())
    rendered.rerender(ui("visible"))
    await flush()

    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("lets the owner deselect a gap before adding", async () => {
    const view = makeView()
    const [, boots] = view.result.gaps.map((gap) => gap.gap_key) as [string, string]
    const addGapsToShoppingList = vi.fn<AddGapsToShoppingListAction>(async () => ok({ added: 1, alreadyThere: 0 }))
    render(<RelocationResults view={view} actions={actions({ addGapsToShoppingList })} />)

    fireEvent.click(screen.getByRole("tab", { name: "Gaps 2" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Waterproof breathable shell jacket" }))
    fireEvent.click(screen.getByRole("button", { name: "Add 1 to shopping list" }))
    await flush()
    expect(addGapsToShoppingList).toHaveBeenCalledWith({ analysisId: ANALYSIS_ID, gapKeys: [boots] })
  })

  it("ticks a packing box at once and puts it back with a toast when the save fails", async () => {
    const save = deferred<Result<PackingRowDto>>()
    const setPackingItemPacked = vi.fn<SetPackingItemPackedAction>(() => save.promise)
    const view = makeView()
    render(<RelocationResults view={view} actions={actions({ setPackingItemPacked })} />)

    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    const suitcase = screen.getByRole("region", { name: /^Suitcase/ })
    const box = within(suitcase).getByRole("checkbox", { name: "Item 1" })
    fireEvent.click(box)
    await flush()
    expect(box.getAttribute("aria-checked")).toBe("true")
    const row = view.packing.find((candidate) => candidate.itemId === FIRST)
    expect(setPackingItemPacked).toHaveBeenCalledWith({ id: row?.id, packed: true })

    await act(async () => save.settle(err("NOT_FOUND", "That checklist row no longer exists.")))
    await flush()
    expect(box.getAttribute("aria-checked")).toBe("false")
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Not found", type: "error" }))
  })

  it("keeps a saved packing box ticked", async () => {
    const view = makeView()
    const setPackingItemPacked = vi.fn<SetPackingItemPackedAction>(async ({ id, packed }) => {
      const row = view.packing.find((candidate) => candidate.id === id)
      if (row === undefined) throw new Error("unknown row")
      return ok({ ...row, packed })
    })
    render(<RelocationResults view={view} actions={actions({ setPackingItemPacked })} />)

    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    const box = within(screen.getByRole("region", { name: /^Suitcase/ })).getByRole("checkbox", { name: "Item 1" })
    fireEvent.click(box)
    await flush()
    expect(box.getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText(/^1 of \d+ things packed$/)).toBeTruthy()
  })

  it("adds an extra to a group and removes it again", async () => {
    const addPackingExtra = vi.fn<AddPackingExtraAction>(async ({ group, label }) =>
      ok({ id: "00000000-0000-4000-8000-000000000399", group, label, itemId: null, packed: false, sortOrder: 99 })
    )
    const deletePackingExtra = vi.fn<DeletePackingExtraAction>(async () => ok({ deleted: true as const }))
    const view = makeView()
    render(<RelocationResults view={view} actions={actions({ addPackingExtra, deletePackingExtra })} />)
    const rows = comingRows(view)
    expect(rows).toBe(4)

    fireEvent.click(screen.getByRole("tab", { name: `Packing ${rows}` }))
    const carryOn = screen.getByRole("region", { name: /^Carry-on/ })
    fireEvent.change(within(carryOn).getByLabelText("Add to Carry-on"), { target: { value: "  Phone charger " } })
    fireEvent.click(within(carryOn).getByRole("button", { name: "Add to Carry-on" }))
    await flush()
    expect(addPackingExtra).toHaveBeenCalledWith({ analysisId: ANALYSIS_ID, group: "carry_on", label: "Phone charger" })
    expect(within(carryOn).getByRole("checkbox", { name: "Phone charger" })).toBeTruthy()
    expect((within(carryOn).getByLabelText("Add to Carry-on") as HTMLInputElement).value).toBe("")
    // The button disabled itself again (an empty field) but kept the focus a press gave it, not <body> (D-182).
    const add = within(carryOn).getByRole("button", { name: "Add to Carry-on" })
    expect(add.hasAttribute("disabled")).toBe(false)
    expect(add.getAttribute("aria-disabled")).toBe("true")
    // The tab counts the same rows the panel shows.
    expect(screen.getByRole("tab", { name: `Packing ${rows + 1}` })).toBeTruthy()
    expect(screen.getByText(`0 of ${rows + 1} things packed`)).toBeTruthy()

    // A print page read before now prints old rows until it reads again (D-173).
    const printed = {}
    expect(packingReadIsStale(printed)).toBe(false)
    const remove = within(carryOn).getByRole("button", { name: "Remove Phone charger" })
    remove.focus()
    fireEvent.click(remove)
    await flush()
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
    expect(deletePackingExtra).toHaveBeenCalledWith({ id: "00000000-0000-4000-8000-000000000399" })
    expect(within(carryOn).queryByRole("checkbox", { name: "Phone charger" })).toBeNull()
    expect(screen.getByRole("tab", { name: `Packing ${rows}` })).toBeTruthy()
    expect(packingReadIsStale(printed)).toBe(true)
    // The row and its button are gone; focus is on the count, not <body> (D-172).
    expect(remove.isConnected).toBe(false)
    expect(document.activeElement?.textContent).toBe(`0 of ${rows} things packed`)
  })

  it("keeps focus on Remove while the delete runs and when it fails", async () => {
    const addPackingExtra = vi.fn<AddPackingExtraAction>(async ({ group, label }) =>
      ok({ id: "00000000-0000-4000-8000-000000000399", group, label, itemId: null, packed: false, sortOrder: 99 })
    )
    const removal = deferred<Result<{ deleted: true }>>()
    const deletePackingExtra = vi.fn<DeletePackingExtraAction>(() => removal.promise)
    render(<RelocationResults view={makeView()} actions={actions({ addPackingExtra, deletePackingExtra })} />)
    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    const carryOn = screen.getByRole("region", { name: /^Carry-on/ })
    fireEvent.change(within(carryOn).getByLabelText("Add to Carry-on"), { target: { value: "Charger" } })
    fireEvent.click(within(carryOn).getByRole("button", { name: "Add to Carry-on" }))
    await flush()

    const remove = within(carryOn).getByRole("button", { name: "Remove Charger" })
    remove.focus()
    fireEvent.click(remove)
    await flush()
    // Busy, but not natively disabled: a browser drops focus from a disabled button.
    expect(remove.hasAttribute("disabled")).toBe(false)
    expect(remove.getAttribute("aria-disabled")).toBe("true")

    await act(async () => removal.settle(err("UPSTREAM", "Could not reach the server.")))
    await flush()
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })

    expect(document.activeElement).toBe(remove)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }))
  })

  it("notes the press of Print checklist, so the print page counts its read from then (D-184)", () => {
    render(<RelocationResults view={makeView()} actions={actions()} />)
    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    const link = screen.getByRole("link", { name: "Print checklist" })
    // jsdom cannot navigate; with no router here, Next's Link leaves the click to the browser.
    link.addEventListener("click", (event) => event.preventDefault(), { once: true })
    fireEvent.click(link)

    // A tick still saving when Print was pressed answers before the print page is first shown.
    act(() => notePackingChange())
    render(<RefreshPrintWhenShown read={{ analysisId: ANALYSIS_ID }} />)
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("notes a saved packing tick for the print page", async () => {
    const view = makeView()
    const setPackingItemPacked = vi.fn<SetPackingItemPackedAction>(async ({ id, packed }) => {
      const row = view.packing.find((candidate) => candidate.id === id)
      if (row === undefined) throw new Error("unknown row")
      return ok({ ...row, packed })
    })
    render(<RelocationResults view={view} actions={actions({ setPackingItemPacked })} />)
    const printed = {}
    expect(packingReadIsStale(printed)).toBe(false)

    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    fireEvent.click(within(screen.getByRole("region", { name: /^Suitcase/ })).getByRole("checkbox", { name: "Item 1" }))
    await flush()

    expect(packingReadIsStale(printed)).toBe(true)
  })

  it("reads the plan again when Next shows it after a shopping-list change elsewhere (D-173)", async () => {
    const view = makeView()
    const ui = (mode: "visible" | "hidden", shown = view) => (
      <Activity mode={mode}>
        <RelocationResults view={shown} actions={actions()} />
      </Activity>
    )
    const rendered = render(ui("visible"))
    await flush()
    expect(router.refresh).not.toHaveBeenCalled()

    // The owner opens /shopping and deletes a gap row there.
    rendered.rerender(ui("hidden"))
    await flush()
    act(() => noteShoppingListChange())
    rendered.rerender(ui("visible"))
    await flush()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The refreshed view counts as read from when the refresh was asked for,
    // so hiding and showing it again reads nothing more.
    const refreshed = { ...view }
    rendered.rerender(ui("visible", refreshed))
    await flush()
    rendered.rerender(ui("hidden", refreshed))
    await flush()
    rendered.rerender(ui("visible", refreshed))
    await flush()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps an override when a refresh read before it lands after it, and reads once more (D-180)", async () => {
    const save = deferred<Result<ItemCardDto>>()
    const setItemDecision = vi.fn<RelocationResultActions["setItemDecision"]>(() => save.promise)
    const first = makeView()
    const page = keptPage(first, actions({ setItemDecision }))

    // Back to the kept plan after a gap was deleted on /shopping: it asks for a read.
    await page.hide()
    act(() => noteShoppingListChange())
    await page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The owner overrides before that read lands; the save answers first.
    fireEvent.click(within(decisionGroup("Item 1")).getByRole("button", { name: "Leave" }))
    await flush()
    await act(async () => save.settle(ok({ ...taggedCard(), id: FIRST, decision: "leave" })))
    await flush()
    // The read lands: the server copy from before the save.
    await page.show(structuredClone(first))

    expect(pressed(decisionGroup("Item 1"), "Leave")).toBe("true")
    expect(within(card("Item 1")).getByText("Yours: Leave")).toBeTruthy()
    // That copy may lack the save, so the page reads once more.
    expect(router.refresh).toHaveBeenCalledTimes(2)

    // The read after the save holds it; nothing more to read.
    const read = structuredClone(first)
    read.items[FIRST] = { ...read.items[FIRST]!, currentDecision: "leave" }
    await page.show(read)
    expect(pressed(decisionGroup("Item 1"), "Leave")).toBe("true")
    expect(router.refresh).toHaveBeenCalledTimes(2)

    // A read asked for after a change elsewhere wins, even against this page's save.
    await page.hide()
    act(() => noteWardrobeChange())
    await page.show()
    expect(router.refresh).toHaveBeenCalledTimes(3)
    const later = structuredClone(first)
    later.items[FIRST] = { ...later.items[FIRST]!, currentDecision: "sell" }
    await page.show(later)
    expect(pressed(decisionGroup("Item 1"), "Sell")).toBe("true")
    expect(router.refresh).toHaveBeenCalledTimes(3)
  })

  it("keeps an override that answers after a refresh read before it landed (D-180)", async () => {
    const save = deferred<Result<ItemCardDto>>()
    const setItemDecision = vi.fn<RelocationResultActions["setItemDecision"]>(() => save.promise)
    const first = makeView()
    const page = keptPage(first, actions({ setItemDecision }))
    await page.hide()
    act(() => noteShoppingListChange())
    await page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    fireEvent.click(within(decisionGroup("Item 2")).getByRole("button", { name: "Donate" }))
    await flush()
    // The read lands while the save is still out, then the save answers.
    await page.show(structuredClone(first))
    await act(async () => save.settle(ok({ ...taggedCard(), id: SECOND, decision: "donate" })))
    await flush()

    expect(pressed(decisionGroup("Item 2"), "Donate")).toBe("true")
    expect(within(card("Item 2")).getByText("Yours: Donate")).toBeTruthy()
  })

  it("keeps a packing untick when a refresh read before it lands after it (D-180)", async () => {
    const first = makeView()
    const row = first.packing.find((candidate) => candidate.itemId === FIRST)
    if (row === undefined) throw new Error("fixture")
    first.packing = first.packing.map((candidate) => (candidate.id === row.id ? { ...candidate, packed: true } : candidate))
    const save = deferred<Result<PackingRowDto>>()
    const setPackingItemPacked = vi.fn<SetPackingItemPackedAction>(() => save.promise)
    const page = keptPage(first, actions({ setPackingItemPacked }))
    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    const total = comingRows(first)
    expect(screen.getByText(`1 of ${total} things packed`)).toBeTruthy()

    // Back to the plan after an item changed elsewhere: it asks for a read.
    await page.hide()
    act(() => noteWardrobeChange())
    await page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    const box = within(screen.getByRole("region", { name: /^Suitcase/ })).getByRole("checkbox", { name: "Item 1" })
    fireEvent.click(box)
    await flush()
    await act(async () => save.settle(ok({ ...row, packed: false })))
    await flush()
    await page.show(structuredClone(first))

    expect(box.getAttribute("aria-checked")).toBe("false")
    expect(screen.getByText(`0 of ${total} things packed`)).toBeTruthy()
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it("shows an extra once when a read asked for before it was added already holds it (D-183)", async () => {
    const extra: PackingRowDto = {
      id: "00000000-0000-4000-8000-000000000399",
      group: "carry_on",
      label: "Phone charger",
      itemId: null,
      packed: false,
      sortOrder: 99,
    }
    const addPackingExtra = vi.fn<AddPackingExtraAction>(async () => ok(extra))
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const first = makeView()
    const page = keptPage(first, actions({ addPackingExtra }))
    const total = comingRows(first)
    const carryOnTotal = comingRows({ ...first, packing: first.packing.filter((row) => row.group === "carry_on") })

    // Back to the kept plan after an item changed elsewhere: it asks for a read.
    await page.hide()
    act(() => noteWardrobeChange())
    await page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The owner adds an extra before that read reaches the server, so the read holds it.
    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    const carryOn = screen.getByRole("region", { name: /^Carry-on/ })
    fireEvent.change(within(carryOn).getByLabelText("Add to Carry-on"), { target: { value: "Phone charger" } })
    fireEvent.click(within(carryOn).getByRole("button", { name: "Add to Carry-on" }))
    await flush()
    const read = structuredClone(first)
    read.packing = [...read.packing, extra]
    await page.show(read)

    expect(within(carryOn).getAllByRole("checkbox", { name: "Phone charger" })).toHaveLength(1)
    expect(screen.getByRole("tab", { name: `Packing ${total + 1}` })).toBeTruthy()
    expect(screen.getByText(`0 of ${total + 1} things packed`)).toBeTruthy()
    expect(within(carryOn).getByRole("heading").textContent).toContain(`(0 of ${carryOnTotal + 1})`)
    expect(errors.mock.calls.some((call) => call.map(String).join(" ").includes("same key"))).toBe(false)
  })

  it("reads once when Next shows it after both an item change and a shopping-list change (D-180)", async () => {
    const first = makeView()
    const page = keptPage(first, actions())
    expect(router.refresh).not.toHaveBeenCalled()

    await page.hide()
    act(() => {
      noteWardrobeChange()
      noteShoppingListChange()
    })
    await page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The read brings a new view, current for both: nothing more, also after another show.
    await page.show(structuredClone(first))
    await page.hide()
    await page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("marks a packed item the owner no longer brings and leaves it out of the counts (D-181)", async () => {
    const view = makeView()
    render(<RelocationResults view={view} actions={actions()} />)
    const before = comingRows(view)
    fireEvent.click(screen.getByRole("tab", { name: `Packing ${before}` }))
    const suitcase = screen.getByRole("region", { name: /^Suitcase/ })
    // Item 5 is the owner's Sell from the start; the AI packed it anyway.
    expect(within(suitcase).getByText("Yours: Sell · not coming")).toBeTruthy()
    // Items 3 and 4, which the AI decided leave and donate, are marked by its decision.
    expect(screen.getByText("AI: Leave · not coming")).toBeTruthy()
    expect(screen.getByText("AI: Donate · not coming")).toBeTruthy()
    expect(within(suitcase).getByRole("heading").textContent).toContain("(0 of 2)")

    // Item 1, which the AI brings and packed in the suitcase, is now the owner's Donate.
    fireEvent.click(screen.getByRole("tab", { name: "Items 6" }))
    fireEvent.click(within(decisionGroup("Item 1")).getByRole("button", { name: "Donate" }))
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: `Packing ${before - 1}` }))

    expect(within(suitcase).getByText("Yours: Donate · not coming")).toBeTruthy()
    // Still there, so a change of mind can tick it.
    expect(within(suitcase).getByRole("checkbox", { name: "Item 1" }).getAttribute("aria-describedby")).toBeTruthy()
    expect(screen.getByText(`0 of ${before - 1} things packed`)).toBeTruthy()
    expect(within(suitcase).getByRole("heading").textContent).toContain("(0 of 1)")
  })

  it("lists bring items no packing group holds", () => {
    const view = makeView()
    const packing = view.packing.filter((row) => row.itemId !== FIRST)
    render(<RelocationResults view={{ ...view, packing }} actions={actions()} />)

    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    const unlisted = screen.getByRole("region", { name: /^Bring items not in the checklist/ })
    expect(within(unlisted).getByRole("link", { name: "Item 1" }).getAttribute("href")).toBe(`/wardrobe/${FIRST}`)
    expect(screen.getByRole("link", { name: "Print checklist" }).getAttribute("href")).toBe(`/relocate/${ANALYSIS_ID}/print`)
  })

  it("leaves out bring items already at a Bologna run's destination, not the ones in Hamburg (D-170)", () => {
    const view = makeView()
    const [, second, , , , sixth] = ITEM_IDS as [string, string, string, string, string, string]
    const packing = view.packing.filter((row) => row.itemId !== FIRST && row.itemId !== second && row.itemId !== sixth)
    const items = { ...view.items }
    const place = (id: string, location: "hamburg" | "in_transit") => {
      const item = items[id]
      if (item === undefined) throw new Error("fixture")
      items[id] = { ...item, location }
    }
    place(FIRST, "hamburg")
    place(second, "in_transit")
    // Item 6 stays in Bologna, the destination of this run.
    render(<RelocationResults view={{ ...view, packing, items, destination: "bologna" }} actions={actions()} />)

    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    const unlisted = screen.getByRole("region", { name: /^Bring items not in the checklist/ })
    expect(within(unlisted).getAllByRole("link").map((link) => link.textContent)).toEqual(["Item 1", "Item 2"])
  })

  it("leaves out bring items that are already in Hamburg or on their way", () => {
    const view = makeView()
    const [, second, , , , sixth] = ITEM_IDS as [string, string, string, string, string, string]
    const packing = view.packing.filter((row) => row.itemId !== FIRST && row.itemId !== second && row.itemId !== sixth)
    const items = { ...view.items }
    const moved = (id: string, location: "hamburg" | "in_transit") => {
      const item = items[id]
      if (item === undefined) throw new Error("fixture")
      items[id] = { ...item, location }
    }
    moved(FIRST, "hamburg")
    moved(second, "in_transit")
    render(<RelocationResults view={{ ...view, packing, items }} actions={actions()} />)

    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    const unlisted = screen.getByRole("region", { name: /^Bring items not in the checklist/ })
    expect(within(unlisted).getAllByRole("link").map((link) => link.textContent)).toEqual(["Item 6"])
  })

  it("shows warnings with their kind and a marker for the app's own checks", () => {
    const view = makeView()
    const warnings = [
      ...view.result.warnings,
      { kind: "over_budget" as const, item_ids: [], message: "The priority gaps cost more than €600.", source: "computed" as const },
    ]
    render(<RelocationResults view={{ ...view, result: { ...view.result, warnings } }} actions={actions()} />)

    fireEvent.click(screen.getByRole("tab", { name: "Warnings 2" }))
    expect(screen.getByText("Duplicates")).toBeTruthy()
    expect(screen.getByText("Over budget")).toBeTruthy()
    expect(screen.getAllByText("Checked by the app")).toHaveLength(1)
    expect(screen.getByText("Two items do the same job.")).toBeTruthy()
  })
})
