// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AddGapsToShoppingListAction } from "@/components/relocate/actions"
import { toast } from "@/components/ui/toast"
import { err, ok, type Result } from "@/lib/result"

import type { RequestShoppingAdvice } from "./advice-api"
import type {
  AdviceCandidateDto,
  AdviceRecommendationDto,
  ShoppingAdviceReadyDto,
  ShoppingAdviceRunDto,
  StoredAdviceDto,
} from "./advice-model"
import { AdvicePanel } from "./advice-panel"
import { shoppingListIsStale } from "./shopping-changes"

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

const RELOCATION_ID = "00000000-0000-4000-8000-0000000000a1"
const ROW_ID = "00000000-0000-4000-8000-0000000000b1"

const SCENARIOS = [
  { key: "jan", label: "January", tmeanC: 2.1, rainy: true, outfitsNow: 2 },
  { key: "apr", label: "April", tmeanC: 9.1, rainy: false, outfitsNow: 6 },
  { key: "jul", label: "July", tmeanC: 18.3, rainy: true, outfitsNow: 1 },
  { key: "oct", label: "October", tmeanC: 10, rainy: true, outfitsNow: 4 },
]

function candidate(overrides: Partial<AdviceCandidateDto> = {}): AdviceCandidateDto {
  return {
    key: "g2-shoes-waterproof-leather-boots",
    source: "gap",
    itemType: "Waterproof leather boots",
    category: "shoes",
    counted: true,
    priority: 1,
    quantity: 1,
    estPriceMinEur: 100,
    estPriceMaxEur: 160,
    relocationAnalysisId: RELOCATION_ID,
    unlocks: { jan: 3, apr: 0, jul: 1, oct: 2 },
    ...overrides,
  }
}

const BOOTS = candidate()
const SHELL = candidate({
  key: ROW_ID,
  source: "list",
  itemType: "Waterproof rain shell",
  category: "outerwear",
  estPriceMinEur: 120,
  estPriceMaxEur: 200,
  unlocks: { jan: 0, apr: 2, jul: 0, oct: 5 },
})
const SCARF = candidate({
  key: "00000000-0000-4000-8000-0000000000b2",
  source: "list",
  itemType: "Wool scarf",
  category: "scarf",
  counted: false,
  priority: 2,
  estPriceMinEur: null,
  estPriceMaxEur: null,
  relocationAnalysisId: null,
  unlocks: { jan: 0, apr: 0, jul: 0, oct: 0 },
})

function recommendation(entry: AdviceCandidateDto, overrides: Partial<AdviceRecommendationDto> = {}): AdviceRecommendationDto {
  return {
    rank: 1,
    why: `Why ${entry.itemType}.`,
    budgetEur: 150,
    candidate: entry,
    onList: entry.source === "list",
    rowStatus: entry.source === "list" ? "todo" : null,
    ...overrides,
  }
}

function stored(overrides: Partial<StoredAdviceDto> = {}): StoredAdviceDto {
  return {
    analysisId: "00000000-0000-4000-8000-0000000000c1",
    completedAt: "2026-11-03T09:30:00.000Z",
    model: "claude-sonnet-5-5",
    costUsd: 0.0312,
    remainingBudgetEur: 495,
    scenarios: SCENARIOS,
    recommendations: [
      recommendation(BOOTS, { rank: 1, why: "Unlocks 3 outfits in January, where the wardrobe makes only 2." }),
      recommendation(SHELL, { rank: 2, budgetEur: 160 }),
      recommendation(SCARF, { rank: 3, budgetEur: 30 }),
    ],
    stale: false,
    ...overrides,
  }
}

function state(overrides: Partial<ShoppingAdviceReadyDto> = {}): ShoppingAdviceReadyDto {
  return {
    enabled: true,
    blocker: null,
    climate: { city: "Hamburg", country: "Germany" },
    scenarios: SCENARIOS,
    candidates: [SHELL, BOOTS, SCARF],
    omittedCandidates: 0,
    budget: { purchaseBudgetEur: 600, boughtMinimumEur: 105, unpricedBought: 1, remainingEur: 495, relocationAnalysisId: RELOCATION_ID },
    model: "claude-sonnet-5-5",
    estimateUsd: 0.031,
    latest: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function setup(initial: ShoppingAdviceReadyDto) {
  const requestAdvice = vi.fn<RequestShoppingAdvice>()
  const addGapsToShoppingList = vi.fn<AddGapsToShoppingListAction>()
  const view = render(
    <AdvicePanel state={initial} addGapsToShoppingList={addGapsToShoppingList} requestAdvice={requestAdvice} />
  )
  return { requestAdvice, addGapsToShoppingList, view }
}

function rankedItem(name: string): HTMLElement {
  return screen.getByRole("listitem", { name: new RegExp(name) })
}

describe("AdvicePanel", () => {
  it("shows the outfits per month, the budget, the estimate and the candidates before any ranking", () => {
    setup(state())

    expect(screen.getByRole("heading", { level: 2, name: "What to buy next" })).toBeTruthy()
    expect(screen.getByText(/The app estimates the outfits each purchase would add in Hamburg; Claude only orders them/)).toBeTruthy()
    expect(
      screen.getByText(
        "The outfit counts are estimates from tags and descriptions: combinations that suit the month, not a measure of what a purchase is worth."
      )
    ).toBeTruthy()
    expect(screen.getByText("January, 2.1 °C, rainy:").textContent).toBe("January, 2.1 °C, rainy: about 2 outfits")
    expect(screen.getByText("Estimated remaining budget: €495")).toBeTruthy()
    expect(screen.getByText(/Purchase budget €600 from your latest relocation plan/).textContent).toBe(
      "Purchase budget €600 from your latest relocation plan, minus at least €105 for items bought under it. 1 bought item has no price and is not counted."
    )
    // An older plan's gap added to the list later is not counted, so the note
    // names only rows added by hand (D-233).
    expect(
      screen.getByText(
        "It is an estimate: each bought item counts at its lowest estimated price, and only if it came from that plan or you added it by hand since."
      )
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Rank 3 purchases" })).toBeTruthy()
    expect(screen.getByText("About $0.03 with Sonnet 5.5.")).toBeTruthy()
    expect(screen.getByText("See the 3 candidates and their estimated outfit counts")).toBeTruthy()
    expect(screen.queryByRole("heading", { name: /^Ranked on/ })).toBeNull()
  })

  it("runs the ranking and shows rank, why, budget and the outfits unlocked per month", async () => {
    const { requestAdvice } = setup(state())
    const answer = deferred<Result<ShoppingAdviceRunDto>>()
    requestAdvice.mockReturnValue(answer.promise)

    fireEvent.click(screen.getByRole("button", { name: "Rank 3 purchases" }))

    expect(requestAdvice).toHaveBeenCalledWith({ force: false })
    expect(screen.getByRole("button", { name: "Ranking…" }).getAttribute("aria-disabled")).toBe("true")
    expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("up to a minute"))).toBe(true)

    await act(async () => answer.resolve(ok({ outcome: "ran", state: state({ latest: stored() }) })))

    expect(screen.getByRole("heading", { name: "Ranked on 3 Nov 2026" })).toBeTruthy()
    expect(screen.getByText("Sonnet 5.5 · cost $0.03 · estimated €495 left then")).toBeTruthy()
    const boots = rankedItem("Rank 1: Waterproof leather boots")
    expect(within(boots).getByText("Unlocks 3 outfits in January, where the wardrobe makes only 2.")).toBeTruthy()
    expect(within(boots).getByText("Set aside €150")).toBeTruthy()
    expect(within(boots).getByText("· estimate €100–€160")).toBeTruthy()
    // Every count reads as the estimate it is (D-231), a zero too.
    const unlocks = within(boots).getByRole("list", { name: "Estimated new outfits per season" })
    expect(within(unlocks).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "January: about 3 new outfits",
      "April: likely none",
      "July: about 1 new outfit",
      "October: about 2 new outfits",
    ])
    expect(within(boots).getByText("Gap from your plan")).toBeTruthy()
    expect(within(rankedItem("Rank 2: Waterproof rain shell")).getByText("On your list")).toBeTruthy()
    expect(within(rankedItem("Rank 3: Wool scarf")).getByText(/Not part of the outfit count/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy()
    expect(screen.getAllByRole("status").some((node) => node.textContent === "Ranking ready.")).toBe(true)
  })

  it("forces a new run once the shown ranking is current, and says when the server reused it", async () => {
    const { requestAdvice } = setup(state({ latest: stored() }))
    requestAdvice.mockResolvedValue(ok({ outcome: "reused", state: state({ latest: stored() }) }))

    fireEvent.click(screen.getByRole("button", { name: "Run again" }))

    expect(requestAdvice).toHaveBeenCalledWith({ force: true })
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((node) => node.textContent?.includes("shown again at no cost"))
      ).toBe(true)
    )
  })

  it("asks for a fresh ranking without force when the shown one is stale", () => {
    const { requestAdvice } = setup(state({ latest: stored({ stale: true }) }))
    requestAdvice.mockResolvedValue(err("UPSTREAM", "unused"))

    expect(screen.getByText(/changed since this ranking/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Rank 3 purchases" }))
    expect(requestAdvice).toHaveBeenCalledWith({ force: false })
  })

  it("shows why a ranking failed and keeps the button usable", async () => {
    const { requestAdvice } = setup(state())
    requestAdvice.mockResolvedValue(
      err("BUDGET_EXCEEDED", "This needs about $0.03, but only $0.01 of the monthly AI budget of $20.00 is left.")
    )

    fireEvent.click(screen.getByRole("button", { name: "Rank 3 purchases" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("The ranking did not finish")
    expect(alert.textContent).toContain("only $0.01 of the monthly AI budget")
    expect(screen.getByRole("button", { name: "Rank 3 purchases" }).getAttribute("aria-disabled")).not.toBe("true")
  })

  it("adds a ranked gap to the shopping list, then shows it as on the list and reads the page again", async () => {
    const { addGapsToShoppingList } = setup(state({ latest: stored() }))
    addGapsToShoppingList.mockResolvedValue(ok({ added: 1, alreadyThere: 0 }))
    const otherList = {}
    expect(shoppingListIsStale(otherList)).toBe(false)

    const boots = rankedItem("Rank 1: Waterproof leather boots")
    // Only the gap that is not on the list offers the button.
    expect(screen.getAllByRole("button", { name: "Add to shopping list" })).toHaveLength(1)
    fireEvent.click(within(boots).getByRole("button", { name: "Add to shopping list" }))

    await waitFor(() => expect(within(boots).getByText("On your list")).toBeTruthy())
    expect(addGapsToShoppingList).toHaveBeenCalledWith({
      analysisId: RELOCATION_ID,
      gapKeys: ["g2-shoes-waterproof-leather-boots"],
    })
    expect(within(boots).queryByRole("button", { name: "Add to shopping list" })).toBeNull()
    expect(router.refresh).toHaveBeenCalledTimes(1)
    // A list shown elsewhere in the tab (a kept plan page) reads again when shown.
    expect(shoppingListIsStale(otherList)).toBe(true)
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: "Added to your shopping list", type: "success" }))
  })

  it("keeps the button when adding fails, and toasts the error", async () => {
    const { addGapsToShoppingList } = setup(state({ latest: stored() }))
    addGapsToShoppingList.mockResolvedValue(err("NOT_FOUND", "That analysis no longer exists."))

    fireEvent.click(screen.getByRole("button", { name: "Add to shopping list" }))

    await waitFor(() =>
      expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ description: "That analysis no longer exists." }))
    )
    expect(screen.getByRole("button", { name: "Add to shopping list" })).toBeTruthy()
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("shows what blocks a run instead of the button", () => {
    setup(
      state({
        blocker: "Nothing to rank: your shopping list has nothing left to buy and the latest relocation plan has no other gaps.",
        candidates: [],
        estimateUsd: null,
      })
    )

    expect(screen.getByText(/^Nothing to rank/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Rank|Run again/ })).toBeNull()
    expect(screen.queryByText(/candidates and their estimated outfit counts/)).toBeNull()
  })

  it("shows large counts as rounded estimates and a month with none as likely none", () => {
    setup(
      state({
        scenarios: [
          { key: "jan", label: "January", tmeanC: 2.1, rainy: true, outfitsNow: 0 },
          { key: "apr", label: "April", tmeanC: 9.1, rainy: false, outfitsNow: 4763 },
        ],
        candidates: [candidate({ unlocks: { jan: 1, apr: 3640 } })],
      })
    )
    expect(screen.getByText("January, 2.1 °C, rainy:").textContent).toBe("January, 2.1 °C, rainy: likely none")
    expect(screen.getByText("April, 9.1 °C:").textContent).toBe("April, 9.1 °C: about 4,763 outfits")
    const unlocks = screen.getByRole("list", { name: "Estimated new outfits per season" })
    expect(within(unlocks).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "January: about 1 new outfit",
      "April: about 3,640 new outfits",
    ])
  })

  it("calls the advice's budget an estimate only when a plan sets one, and never says nothing was bought when unpriced items were", () => {
    const budget = { purchaseBudgetEur: 600, boughtMinimumEur: 0, unpricedBought: 0, remainingEur: 600, relocationAnalysisId: RELOCATION_ID }
    setup(state({ budget }))
    expect(screen.getByText("Estimated remaining budget: €600")).toBeTruthy()
    expect(
      screen.getByText("Purchase budget €600 from your latest relocation plan; nothing is bought under it yet.")
    ).toBeTruthy()
    expect(screen.getByText(/^It is an estimate: each bought item counts at its lowest estimated price/)).toBeTruthy()
    cleanup()

    setup(state({ budget: { ...budget, unpricedBought: 2 } }))
    expect(screen.getByText("Estimated remaining budget: €600")).toBeTruthy()
    expect(
      screen.getByText(
        "Purchase budget €600 from your latest relocation plan. 2 bought items have no price and are not counted."
      )
    ).toBeTruthy()
    expect(screen.queryByText(/nothing is bought/)).toBeNull()
    cleanup()

    setup(
      state({ budget: { purchaseBudgetEur: null, boughtMinimumEur: 0, unpricedBought: 0, remainingEur: null, relocationAnalysisId: null } })
    )
    expect(screen.queryByText(/Estimated remaining budget/)).toBeNull()
    expect(screen.queryByText(/^It is an estimate/)).toBeNull()
  })

  it("explains a missing purchase budget, where it would come from, and that the list's budget box is not used", () => {
    const noBudget = { purchaseBudgetEur: null, boughtMinimumEur: 0, unpricedBought: 0, remainingEur: null }
    setup(state({ budget: { ...noBudget, relocationAnalysisId: null } }))
    const line = screen.getByText(/^No relocation plan sets a purchase budget, so only what the climate makes necessary/)
    expect(line.textContent).toContain(
      `The "Budget for new purchases" box on this page only compares the list's prices and is not used here.`
    )
    cleanup()

    setup(state({ budget: { ...noBudget, relocationAnalysisId: "0b9c6f0e-1d2a-4e3b-8c4d-5e6f7a8b9c0d" } }))
    expect(screen.getByText(/^Your latest relocation plan sets no purchase budget/).textContent).toContain("box on this page")
  })

  it("shows rows bought or removed since the ranking for what they are", () => {
    setup(
      state({
        latest: stored({
          recommendations: [
            recommendation(SHELL, { rank: 1, rowStatus: "bought" }),
            recommendation(SCARF, { rank: 2, onList: false, rowStatus: null }),
          ],
        }),
      })
    )
    expect(within(rankedItem("Rank 1: Waterproof rain shell")).getByText("Bought")).toBeTruthy()
    expect(within(rankedItem("Rank 2: Wool scarf")).getByText("Removed from your list")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Add to shopping list" })).toBeNull()
  })
})
