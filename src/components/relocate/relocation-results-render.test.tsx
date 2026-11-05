// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { taggedCard } from "@/components/items/test-fixtures"
import type { Checkbox as CheckboxComponent } from "@/components/ui/checkbox"
import { toast } from "@/components/ui/toast"
import type { PackingRowDto, RelocationItemRefDto, RelocationViewDto } from "@/lib/relocation/contracts"
import { ok } from "@/lib/result"

import { makeRelocationResult } from "../../../test/relocation-fixtures"
import type { RelocationResultActions } from "./actions"
import type { ItemThumb as ItemThumbComponent } from "./item-ref"
import { RelocationResults } from "./relocation-results"

// How much one change re-renders on the result page (D-174): with every card
// and row re-rendered on each override or tick, a 2,000-item wardrobe froze
// the page for seconds. The decision cards' thumbnails and the packing rows'
// checkboxes count the renders.

const renders = vi.hoisted(() => ({ thumbs: 0, boxes: 0 }))

vi.mock("./item-ref", async (importOriginal) => {
  const actual = await importOriginal<{ ItemThumb: typeof ItemThumbComponent }>()
  return {
    ...actual,
    ItemThumb: (props: Parameters<typeof ItemThumbComponent>[0]) => {
      renders.thumbs += 1
      return actual.ItemThumb(props)
    },
  }
})

vi.mock("@/components/ui/checkbox", async (importOriginal) => {
  const actual = await importOriginal<{ Checkbox: typeof CheckboxComponent }>()
  return {
    ...actual,
    Checkbox: (props: Parameters<typeof CheckboxComponent>[0]) => {
      renders.boxes += 1
      return actual.Checkbox(props)
    },
  }
})

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

const COUNT = 60
const ITEM_IDS = Array.from({ length: COUNT }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`)

function makeView(): RelocationViewDto {
  const result = makeRelocationResult(ITEM_IDS)
  const items: Record<string, RelocationItemRefDto> = Object.fromEntries(
    ITEM_IDS.map((id, index) => [
      id,
      {
        id,
        name: `Item ${index + 1}`,
        category: "outerwear",
        thumb: null,
        currentDecision: "undecided",
        status: "confirmed",
        location: "bologna",
        collection: "clothing",
        exists: true,
      } satisfies RelocationItemRefDto,
    ])
  )
  let order = 0
  const packing: PackingRowDto[] = result.packing_checklist.flatMap((group) =>
    group.item_ids.map((itemId) => ({
      id: `00000000-0000-4000-9000-${String((order += 1)).padStart(12, "0")}`,
      group: group.group,
      label: items[itemId]?.name ?? "?",
      itemId,
      packed: false,
      sortOrder: order,
    }))
  )
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    createdAt: "2026-11-03T08:00:00.000Z",
    completedAt: "2026-11-03T08:04:00.000Z",
    status: "complete",
    model: "claude-sonnet-5-5",
    effort: "medium",
    promptVersion: "reloc-v3",
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
    months: [11, 12, 1],
    profile: { id: "00000000-0000-4000-8000-0000000000e1", city: "Hamburg", country: "Germany", isPlaceholder: false },
    destination: "hamburg",
    result,
    items,
    packing,
    addedGapKeys: [],
  }
}

function actions(view: RelocationViewDto): RelocationResultActions {
  return {
    setItemDecision: vi.fn(async ({ id, decision }) => ok({ ...taggedCard(), id, decision })),
    applyAiDecisionsToUndecided: vi.fn(async () => ok({ updated: 0, itemIds: [] })),
    addGapsToShoppingList: vi.fn(async ({ gapKeys }) => ok({ added: gapKeys.length, alreadyThere: 0 })),
    setPackingItemPacked: vi.fn(async ({ id, packed }) => {
      const row = view.packing.find((candidate) => candidate.id === id)
      if (row === undefined) throw new Error("unknown row")
      return ok({ ...row, packed })
    }),
    addPackingExtra: vi.fn(async ({ group, label }) =>
      ok({ id: "00000000-0000-4000-8000-000000000399", group, label, itemId: null, packed: false, sortOrder: 99 })
    ),
    deletePackingExtra: vi.fn(async () => ok({ deleted: true as const })),
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  vi.spyOn(toast, "add").mockReturnValue("toast-id")
  renders.thumbs = 0
  renders.boxes = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("RelocationResults render cost (D-174)", () => {
  it("re-renders one decision card for one override, not every card", async () => {
    const view = makeView()
    const acts = actions(view)
    render(<RelocationResults view={view} actions={acts} />)
    expect(renders.thumbs).toBe(COUNT)

    renders.thumbs = 0
    const group = screen.getByRole("group", { name: "Your decision for Item 1" })
    fireEvent.click(within(group).getByRole("button", { name: "Leave" }))
    await flush()

    expect(acts.setItemDecision).toHaveBeenCalledTimes(1)
    expect(within(group).getByRole("button", { name: "Leave" }).getAttribute("aria-pressed")).toBe("true")
    // The pressed card renders for its optimistic and its saved state; the other cards not at all.
    expect(renders.thumbs).toBeGreaterThan(0)
    expect(renders.thumbs).toBeLessThanOrEqual(3)
  })

  it("re-renders one packing row for one tick, not every row", async () => {
    const view = makeView()
    render(<RelocationResults view={view} actions={actions(view)} />)
    fireEvent.click(screen.getByRole("tab", { name: /^Packing/ }))
    // Rows whose item the AI did not decide bring are marked and not counted (D-181).
    const bring = new Set(view.result.items.filter((entry) => entry.decision === "bring").map((entry) => entry.item_id))
    const rows = view.packing.filter((row) => row.itemId !== null && bring.has(row.itemId)).length
    expect(rows).toBeGreaterThan(20)

    renders.boxes = 0
    fireEvent.click(within(screen.getByRole("region", { name: /^Suitcase/ })).getByRole("checkbox", { name: "Item 1" }))
    await flush()

    expect(screen.getByText(`1 of ${rows} things packed`)).toBeTruthy()
    expect(renders.boxes).toBeGreaterThan(0)
    expect(renders.boxes).toBeLessThanOrEqual(4)
  })
})
