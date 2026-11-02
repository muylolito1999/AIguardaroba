// @vitest-environment jsdom
import { Activity } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TaggingSetup } from "@/components/add/cost-quote"
import type { requestTaggingSetup } from "@/components/add/tagging-setup-request"
import type { ItemCardDto } from "@/lib/items/contracts"
import { noteWardrobeChange } from "@/lib/items/wardrobe-changes"
import { ok, type Result } from "@/lib/result"

import { RefreshAfterItemChanges } from "./refresh-after-item-changes"
import { ReviewList } from "./review-list"
import type { requestTagging } from "./tag-request"
import { fakeReviewActions, taggedCard } from "./test-fixtures"

// /add/review the way the page renders it (D-123, D-129): the list plus
// RefreshAfterItemChanges with its server cards, inside the <Activity> Next
// keeps it in. Back after an item on it was archived, confirmed or deleted on
// its item page must read the page again; its own saves must not.

const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("./remove-background-button", () => ({
  RemoveBackgroundButton: () => <button type="button">Remove background</button>,
}))

beforeEach(() => router.refresh.mockClear())
afterEach(cleanup)

const TAGGING: Result<TaggingSetup> = ok({
  model: { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  costQuote: {
    standard: { firstItemUsd: 0.02, nextItemUsd: 0.01 },
    batch: { firstItemUsd: 0.01, nextItemUsd: 0.005 },
    dryRunUsd: 0.025,
  },
  budget: { budgetUsd: 20, remainingUsd: 12.5, resetsAt: "2026-12-01T00:00:00.000Z" },
})

function renderReviewPage(initial: ItemCardDto[]) {
  const props = {
    actions: fakeReviewActions(),
    tagging: TAGGING,
    tagRequest: vi.fn<typeof requestTagging>(),
    setupRequest: vi.fn<typeof requestTaggingSetup>().mockResolvedValue(TAGGING),
  }
  let cards = initial
  const ui = (mode: "visible" | "hidden") => (
    <Activity mode={mode}>
      <ReviewList items={cards} totalCount={cards.length} {...props} />
      <RefreshAfterItemChanges snapshot={cards} refreshWhileShown={false} />
    </Activity>
  )
  const view = render(ui("visible"))
  return {
    hide: () => view.rerender(ui("hidden")),
    show: () => view.rerender(ui("visible")),
    /** The page's next server render. */
    serve: (next: ItemCardDto[]) => {
      cards = next
      view.rerender(ui("visible"))
    },
  }
}

describe("/add/review after a return", () => {
  it("reads itself again when shown after a change elsewhere, and drops a card that left the queue", async () => {
    const coat = taggedCard({ name: "Navy wool coat" })
    const scarf = taggedCard({ name: "Grey scarf" })
    const page = renderReviewPage([coat, scarf])

    // A change noted while the page is shown is one of its own saves: no read.
    act(() => noteWardrobeChange())
    expect(router.refresh).not.toHaveBeenCalled()

    // The owner opens the coat from the wardrobe, archives it, and comes Back.
    page.hide()
    act(() => noteWardrobeChange())
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    page.serve([scarf])
    await waitFor(() => expect(screen.queryByRole("form", { name: "Tags for Navy wool coat" })).toBeNull())
    expect(screen.getByRole("form", { name: "Tags for Grey scarf" })).toBeTruthy()
    // The new list is fresh: showing the page again reads nothing more.
    page.hide()
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps the unsaved edits of a card the new list still has", async () => {
    const coat = taggedCard({ name: "Navy wool coat" })
    const scarf = taggedCard({ name: "Grey scarf" })
    const page = renderReviewPage([coat, scarf])
    const coatForm = screen.getByRole("form", { name: "Tags for Navy wool coat" })
    fireEvent.change(within(coatForm).getByLabelText("Notes"), { target: { value: "Check the lining" } })

    page.hide()
    act(() => noteWardrobeChange())
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
    // The scarf was confirmed elsewhere; the coat is still waiting.
    page.serve([{ ...coat, brand: "Barbour" }])

    await waitFor(() => expect(screen.queryByRole("form", { name: "Tags for Grey scarf" })).toBeNull())
    const kept = screen.getByRole("form", { name: "Tags for Navy wool coat" })
    expect(within(kept).getByLabelText<HTMLTextAreaElement>("Notes").value).toBe("Check the lining")
  })
})
