// @vitest-environment jsdom
import { Activity } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TaggingSetup } from "@/components/add/cost-quote"
import type { requestTaggingSetup } from "@/components/add/tagging-setup-request"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { ItemCardDto, StartTaggingBatchData, TagData } from "@/lib/items/contracts"
import { CONFIG_ERROR_MESSAGE, err, ok, type Result } from "@/lib/result"

import { reviewHeadingId } from "./review-card"
import { REVIEW_PAGE_SIZE, ReviewList } from "./review-list"
import type { requestTagging } from "./tag-request"
import { fakeReviewActions, pendingCard, taggedCard } from "./test-fixtures"

// The cut-out itself is tested in remove-background-button.test.tsx; here a
// stand-in hands the list the server's item with a background-removed photo.
vi.mock("./remove-background-button", () => ({
  RemoveBackgroundButton: ({ item, onDone }: { item: ItemCardDto; onDone: (item: ItemCardDto) => void }) => (
    <button
      type="button"
      onClick={() =>
        onDone({
          ...item,
          images: { ...item.images, nobg: { url: "https://blob.example/items/a/nobg.png", width: 1024, height: 768 } },
        })
      }
    >
      {item.images.nobg === null ? "Remove background" : "Background removed"}
    </button>
  ),
}))

afterEach(cleanup)

function taggingSetup(remainingUsd: number): Result<TaggingSetup> {
  return ok({
    model: { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    costQuote: {
      standard: { firstItemUsd: 0.02, nextItemUsd: 0.01 },
      batch: { firstItemUsd: 0.01, nextItemUsd: 0.005 },
      dryRunUsd: 0.025,
    },
    budget: { budgetUsd: 20, remainingUsd, resetsAt: "2026-12-01T00:00:00.000Z" },
  })
}

const TAGGING = taggingSetup(12.5)

const BATCH_ID = "11111111-1111-4111-8111-111111111111"

function setup(items: ItemCardDto[], totalCount = items.length, tagging: Result<TaggingSetup> = TAGGING) {
  const actions = fakeReviewActions()
  const tagRequest = vi.fn<typeof requestTagging>()
  const setupRequest = vi.fn<typeof requestTaggingSetup>().mockResolvedValue(TAGGING)
  const props = { actions, totalCount, tagging, tagRequest, setupRequest }
  const view = render(<ReviewList items={items} {...props} />)
  return {
    actions,
    tagRequest,
    setupRequest,
    /** A new server render of the page with these items. */
    rerender: (next: ItemCardDto[]) => view.rerender(<ReviewList items={next} {...props} />),
  }
}

/**
 * The list inside an <Activity>, the way Next keeps /add/review mounted but
 * hidden after the owner navigates away (Cache Components). A totalCount
 * above the list's length stands for a page that capped the list.
 */
function setupInActivity(items: ItemCardDto[], totalCount = items.length) {
  const actions = fakeReviewActions()
  const tagRequest = vi.fn<typeof requestTagging>()
  const setupRequest = vi.fn<typeof requestTaggingSetup>().mockResolvedValue(TAGGING)
  const page = (list: ItemCardDto[], total: number, mode: "visible" | "hidden") => (
    <Activity mode={mode}>
      <ReviewList
        items={list}
        actions={actions}
        totalCount={total}
        tagging={TAGGING}
        tagRequest={tagRequest}
        setupRequest={setupRequest}
      />
    </Activity>
  )
  const view = render(page(items, totalCount, "visible"))
  let shown = { list: items, total: totalCount }
  return {
    actions,
    /** Navigating away, then back: the page is hidden, rendered again with new items, and shown. */
    revisit: (next: ItemCardDto[], nextTotal = next.length) => {
      view.rerender(page(shown.list, shown.total, "hidden"))
      view.rerender(page(next, nextTotal, "hidden"))
      view.rerender(page(next, nextTotal, "visible"))
      shown = { list: next, total: nextTotal }
    },
  }
}

/** A promise the test settles by hand, for a request that is still running. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function nameValue(scope: HTMLElement): string {
  return (within(scope).getByLabelText("Name") as HTMLInputElement).value
}

function taggingRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Tagging" })
}

function card(name: string): HTMLElement {
  return screen.getByRole("article", { name })
}

/** A card found by its item id, which stays stable while its title and buttons change. */
function cardById(itemId: string): HTMLElement {
  const article = document.getElementById(reviewHeadingId(itemId))?.closest("article")
  if (!article) throw new Error(`no card for ${itemId}`)
  return article
}

/** Opens a Base UI select inside a card and picks an option. */
async function choose(scope: HTMLElement, label: string, option: string) {
  fireEvent.click(within(scope).getByLabelText(label))
  const choice = await screen.findByRole("option", { name: option })
  // Base UI ignores a click on an option the pointer did not press first.
  fireEvent.pointerDown(choice)
  fireEvent.click(choice)
  await waitFor(() => expect(within(scope).getByLabelText(label).textContent).toContain(option))
}

/** Fills in every field the hand-tagging form requires. */
async function fillInByHand(scope: HTMLElement, name: string) {
  fireEvent.change(within(scope).getByLabelText("Name"), { target: { value: name } })
  await choose(scope, "Category", "Top")
  fireEvent.change(within(scope).getByLabelText("New colour name"), { target: { value: "olive" } })
  fireEvent.click(within(scope).getByRole("button", { name: "Add colour" }))
  fireEvent.click(within(scope).getByRole("button", { name: "Autumn" }))
  await choose(scope, "Formality", "Casual")
  await choose(scope, "Condition", "Good")
}

describe("ReviewList", () => {
  it("summarises the queue and shows each item's badges", () => {
    setup([
      taggedCard({ name: "Rain shell", multipleItemsDetected: true }),
      pendingCard({ taggingBatchId: "11111111-1111-4111-8111-111111111111" }),
    ])

    expect(screen.getByRole("heading", { level: 2, name: "2 items to review" })).toBeTruthy()
    expect(screen.getByText("1 tagged · 1 waiting for tags")).toBeTruthy()
    expect(within(card("Rain shell")).getByText("Several items in photo")).toBeTruthy()
    const pending = card("Untagged item")
    expect(within(pending).getByText("In batch")).toBeTruthy()
    // A batch item waits for the batch; tagging it now is a confirmed choice, not the default.
    expect(within(pending).queryByRole("button", { name: /^(Tag now|Retry tagging)$/ })).toBeNull()
    expect(within(pending).getByRole("button", { name: "Tag now instead" })).toBeTruthy()
    // Nothing waits outside a batch, so there is no bulk tagging offer.
    expect(screen.queryByRole("region", { name: "Tagging" })).toBeNull()
  })

  it("keeps a pending item pending when tagging fails, with the reason and a retry", async () => {
    const item = pendingCard()
    const { tagRequest } = setup([item])
    tagRequest.mockResolvedValue(err("CONFIG", "The server is misconfigured. Check the server logs."))

    fireEvent.click(screen.getByRole("button", { name: "Tag now" }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Tagging failed")
    expect(alert.textContent).toContain("The server is misconfigured.")
    expect(tagRequest).toHaveBeenCalledWith(item.id)
    expect(screen.getByRole("button", { name: "Retry tagging" })).toBeTruthy()
    expect(screen.queryByRole("form")).toBeNull()
  })

  it("shows the stored tagging error and offers Retry for it", () => {
    setup([pendingCard({ taggingError: "Claude declined to describe this photo." })])

    expect(screen.getByText("Claude declined to describe this photo.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Retry tagging" })).toBeTruthy()
  })

  it("swaps in the form once tagging succeeds and focuses the item heading", async () => {
    const item = pendingCard()
    const { tagRequest } = setup([item])
    const tagged = taggedCard({ id: item.id, name: "Merino base layer" })
    tagRequest.mockResolvedValue(ok({ cached: false, item: tagged }))

    fireEvent.click(screen.getByRole("button", { name: "Tag now" }))

    const heading = await screen.findByRole("heading", { name: "Merino base layer" })
    expect(screen.getByRole("form", { name: "Tags for Merino base layer" })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it("removes a confirmed item and moves focus to the next one", async () => {
    const first = taggedCard({ name: "First coat" })
    const second = taggedCard({ name: "Second coat" })
    const { actions } = setup([first, second])
    actions.confirmItem.mockResolvedValue(ok({ ...first, status: "confirmed" }))

    fireEvent.click(within(card("First coat")).getByRole("button", { name: "Confirm" }))

    await waitFor(() => expect(screen.queryByRole("article", { name: "First coat" })).toBeNull())
    await waitFor(() => expect(document.activeElement?.id).toBe(reviewHeadingId(second.id)))
    expect(screen.getByText("First coat confirmed and moved to your wardrobe.")).toBeTruthy()
    expect(screen.getByText(/1 confirmed just now/)).toBeTruthy()
  })

  it("shows the all-done state after the last item is confirmed", async () => {
    const only = taggedCard({ name: "Only coat" })
    const { actions } = setup([only])
    actions.confirmItem.mockResolvedValue(ok({ ...only, status: "confirmed" }))

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))

    const done = await screen.findByRole("heading", { name: "All caught up" })
    await waitFor(() => expect(document.activeElement).toBe(done))
  })

  it("bulk-confirms only tagged items nobody has touched", async () => {
    const untouched = taggedCard({ name: "Untouched coat" })
    const edited = taggedCard({ name: "Edited coat", userEditedFields: ["name"] })
    const dirty = taggedCard({ name: "Dirty coat" })
    const pending = pendingCard()
    const { actions } = setup([untouched, edited, dirty, pending])
    actions.confirmItems.mockResolvedValue(ok({ confirmed: 1 }))

    expect(screen.getByRole("button", { name: "Confirm all untouched (2)" })).toBeTruthy()
    fireEvent.change(within(card("Dirty coat")).getByLabelText("Name"), { target: { value: "Dirty overcoat" } })
    const bulk = await screen.findByRole("button", { name: "Confirm all untouched (1)" })

    fireEvent.click(bulk)
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog.textContent).toContain("Items you edited, items with unsaved changes")
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm 1" }))

    await waitFor(() => expect(actions.confirmItems).toHaveBeenCalledWith({ ids: [untouched.id] }))
    await waitFor(() => expect(screen.queryByRole("article", { name: "Untouched coat" })).toBeNull())
    expect(screen.getByRole("article", { name: "Edited coat" })).toBeTruthy()
    expect(screen.getByRole("article", { name: "Dirty coat" })).toBeTruthy()
  })

  it("keeps the items and explains when the server confirmed fewer than asked", async () => {
    const a = taggedCard({ name: "Coat A" })
    const b = taggedCard({ name: "Coat B" })
    const { actions } = setup([a, b])
    actions.confirmItems.mockResolvedValue(ok({ confirmed: 1 }))

    fireEvent.click(screen.getByRole("button", { name: "Confirm all untouched (2)" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Confirm 2" }))

    expect((await screen.findByText(/Confirmed 1 of 2 items/)).getAttribute("role")).toBe("alert")
    expect(screen.getByRole("article", { name: "Coat A" })).toBeTruthy()
  })

  it("frees the bulk button and says why when the bulk confirm request fails", async () => {
    const a = taggedCard({ name: "Coat A" })
    const b = taggedCard({ name: "Coat B" })
    const { actions } = setup([a, b])
    actions.confirmItems.mockRejectedValue(new TypeError("Failed to fetch"))

    fireEvent.click(screen.getByRole("button", { name: "Confirm all untouched (2)" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Confirm 2" }))

    expect((await screen.findByText(NETWORK_ERROR_MESSAGE)).getAttribute("role")).toBe("alert")
    const bulk = screen.getByRole("button", { name: "Confirm all untouched (2)" })
    expect(bulk.getAttribute("aria-disabled")).not.toBe("true")
    expect(bulk.getAttribute("aria-busy")).toBeNull()
    expect(screen.getAllByRole("article")).toHaveLength(2)
  })

  it("renders long queues in pages and notes a capped list", () => {
    const items = Array.from({ length: REVIEW_PAGE_SIZE + 2 }, (_, index) =>
      taggedCard({ name: `Item ${index + 1}` })
    )
    setup(items, 250)

    expect(screen.getAllByRole("article")).toHaveLength(REVIEW_PAGE_SIZE)
    expect(screen.getByText(`Showing the newest ${items.length} of 250.`, { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more (2 not shown)" }))
    expect(screen.getAllByRole("article")).toHaveLength(items.length)
  })
})

describe("the review list after the page renders again", () => {
  it("shows new items after a revisit and keeps a card's unsaved edit", async () => {
    const dirty = taggedCard({ name: "Dirty coat" })
    const other = taggedCard({ name: "Other coat" })
    const { revisit } = setupInActivity([dirty, other])
    fireEvent.change(within(card("Dirty coat")).getByLabelText("Name"), { target: { value: "Dirty overcoat" } })
    await screen.findByRole("button", { name: "Confirm all untouched (1)" })

    const added = pendingCard()
    revisit([
      added,
      taggedCard({ id: dirty.id, name: "Dirty coat from the server" }),
      taggedCard({ id: other.id, name: "Other coat renamed" }),
    ])

    expect(await screen.findByRole("heading", { level: 2, name: "3 items to review" })).toBeTruthy()
    expect(within(cardById(added.id)).getByRole("button", { name: "Tag now" })).toBeTruthy()
    // The card with unsaved edits keeps them; the untouched one shows the server's version.
    expect((within(card("Dirty coat")).getByLabelText("Name") as HTMLInputElement).value).toBe("Dirty overcoat")
    await waitFor(() =>
      expect((within(card("Other coat renamed")).getByLabelText("Name") as HTMLInputElement).value).toBe(
        "Other coat renamed"
      )
    )
  })

  it("does not hide new items behind the all-done state", async () => {
    const only = taggedCard({ name: "Only coat" })
    const { actions, revisit } = setupInActivity([only])
    actions.confirmItem.mockResolvedValue(ok({ ...only, status: "confirmed" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
    await screen.findByRole("heading", { name: "All caught up" })

    revisit([pendingCard(), taggedCard({ name: "New coat" })])

    expect(await screen.findByRole("heading", { level: 2, name: "2 items to review" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "All caught up" })).toBeNull()
    expect(screen.queryByText(/confirmed just now/)).toBeNull()
    expect(card("New coat")).toBeTruthy()
  })

  it("lifts a budget block when the page sends a newer budget", async () => {
    const items = [pendingCard(), pendingCard()]
    const props = {
      items,
      actions: fakeReviewActions(),
      totalCount: items.length,
      tagRequest: vi.fn<typeof requestTagging>(),
      setupRequest: vi.fn<typeof requestTaggingSetup>(),
    }
    const view = render(<ReviewList {...props} tagging={taggingSetup(0)} />)
    expect(screen.getByText("AI budget reached")).toBeTruthy()

    view.rerender(<ReviewList {...props} tagging={taggingSetup(5)} />)

    expect(await within(taggingRegion()).findByText("$5.00 left this month")).toBeTruthy()
    expect(screen.queryByText("AI budget reached")).toBeNull()
    expect(within(taggingRegion()).getByRole("button", { name: "Tag 2 items" }).getAttribute("aria-disabled")).not.toBe(
      "true"
    )
  })

  it("replaces a stale In batch card with the applied batch result", async () => {
    const waiting = pendingCard({ taggingBatchId: BATCH_ID })
    const { rerender } = setup([waiting])
    expect(screen.getByRole("button", { name: "Tag now instead" })).toBeTruthy()

    rerender([taggedCard({ id: waiting.id, name: "Batch coat", taggingBatchId: null })])

    expect(await screen.findByRole("form", { name: "Tags for Batch coat" })).toBeTruthy()
    expect(screen.queryByText("In batch")).toBeNull()
    expect(screen.queryByRole("button", { name: "Tag now instead" })).toBeNull()
  })

  it("keeps a card with unsaved edits on screen when new items push it past the page", async () => {
    const items = Array.from({ length: REVIEW_PAGE_SIZE }, (_, index) => taggedCard({ name: `Item ${index + 1}` }))
    const last = items[REVIEW_PAGE_SIZE - 1]
    if (last === undefined) throw new Error("no items")
    const { revisit } = setupInActivity(items)
    fireEvent.change(within(cardById(last.id)).getByLabelText("Name"), { target: { value: "My unsaved name" } })
    await screen.findByRole("button", { name: `Confirm all untouched (${REVIEW_PAGE_SIZE - 1})` })

    revisit([pendingCard(), ...items])

    // Still shown without "Show more", with the edit.
    expect(screen.getAllByRole("article")).toHaveLength(REVIEW_PAGE_SIZE + 1)
    expect(screen.queryByRole("button", { name: /^Show \d+ more/ })).toBeNull()
    expect(nameValue(cardById(last.id))).toBe("My unsaved name")
  })

  it("keeps an open hand-tagging form on screen when new items push it past the page", async () => {
    const items = Array.from({ length: REVIEW_PAGE_SIZE }, () => pendingCard())
    const last = items[REVIEW_PAGE_SIZE - 1]
    if (last === undefined) throw new Error("no items")
    const { revisit } = setupInActivity(items)
    fireEvent.click(within(cardById(last.id)).getByRole("button", { name: "Fill in by hand" }))
    await within(taggingRegion()).findByRole("button", { name: `Tag ${REVIEW_PAGE_SIZE - 1} items` })

    revisit([pendingCard(), ...items])

    expect(within(cardById(last.id)).getByRole("form", { name: "Tags for Untagged item" })).toBeTruthy()
    fireEvent.click(within(cardById(last.id)).getByRole("button", { name: "Cancel" }))
    // Cancel releases the item: its own buttons and the bulk run take it again.
    const fillIn = await within(cardById(last.id)).findByRole("button", { name: "Fill in by hand" })
    expect(fillIn.getAttribute("aria-disabled")).not.toBe("true")
    expect(
      await within(taggingRegion()).findByRole("button", { name: `Tag ${REVIEW_PAGE_SIZE + 1} items` })
    ).toBeTruthy()
  })

  it("keeps a card with unsaved edits that newer uploads pushed out of a capped list", async () => {
    // 12 stands in for the page's limit: it lists the newest 12 of the waiting items.
    const cap = 12
    const all = Array.from({ length: 15 }, (_, index) => taggedCard({ name: `Item ${index + 1}` }))
    const firstPage = all.slice(0, cap)
    const target = firstPage[cap - 1]
    if (target === undefined) throw new Error("no items")
    const { revisit } = setupInActivity(firstPage, all.length)
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more (2 not shown)" }))
    fireEvent.change(within(cardById(target.id)).getByLabelText("Name"), { target: { value: "My unsaved name" } })
    await screen.findByRole("button", { name: `Confirm all untouched (${cap - 1})` })

    // Two uploads on /add: the page now lists them first and no longer lists the edited item.
    const fresh = [taggedCard({ name: "New 1" }), taggedCard({ name: "New 2" })]
    revisit([...fresh, ...all].slice(0, cap), all.length + fresh.length)

    const articles = screen.getAllByRole("article")
    // The edited card, older than every listed one, stays after them; the untouched item 11 left.
    expect(articles).toHaveLength(cap + 1)
    expect(articles.at(-1)).toBe(cardById(target.id))
    expect(nameValue(cardById(target.id))).toBe("My unsaved name")
    expect(document.getElementById(reviewHeadingId(all[cap - 2]?.id ?? ""))).toBeNull()
  })
})

describe("confirming while other changes arrive", () => {
  it("keeps both cards out when two confirms are in flight", async () => {
    const coat = taggedCard({ name: "Coat" })
    const scarf = taggedCard({ name: "Scarf" })
    const hat = taggedCard({ name: "Hat" })
    const { actions } = setup([coat, scarf, hat])
    const finishers = new Map<string, (result: Result<ItemCardDto>) => void>()
    actions.confirmItem.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          finishers.set(input.id, resolve)
        })
    )

    fireEvent.click(within(card("Coat")).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(finishers.has(coat.id)).toBe(true))
    fireEvent.click(within(card("Scarf")).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(finishers.has(scarf.id)).toBe(true))

    await act(async () => finishers.get(coat.id)?.(ok({ ...coat, status: "confirmed" })))
    await act(async () => finishers.get(scarf.id)?.(ok({ ...scarf, status: "confirmed" })))

    expect(document.getElementById(reviewHeadingId(coat.id))).toBeNull()
    expect(document.getElementById(reviewHeadingId(scarf.id))).toBeNull()
    expect(screen.getByRole("heading", { level: 2, name: "1 item to review" })).toBeTruthy()
  })

  it("keeps a bulk tagging result that arrived during a confirm", async () => {
    const fleece = pendingCard()
    const other = pendingCard()
    const coat = taggedCard({ name: "Coat" })
    const { actions, tagRequest } = setup([fleece, other, coat])
    const tags = new Map<string, ReturnType<typeof deferred<Result<TagData>>>>()
    tagRequest.mockImplementation((id) => {
      const tag = deferred<Result<TagData>>()
      tags.set(id, tag)
      return tag.promise
    })
    const confirm = deferred<Result<ItemCardDto>>()
    actions.confirmItem.mockReturnValue(confirm.promise)

    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag 2 items" }))
    await waitFor(() => expect(tagRequest).toHaveBeenCalledTimes(2))
    fireEvent.click(within(card("Coat")).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(actions.confirmItem).toHaveBeenCalled())
    await act(async () =>
      tags.get(fleece.id)?.resolve(ok({ cached: false, item: taggedCard({ id: fleece.id, name: "Fleece" }) }))
    )
    expect(within(cardById(fleece.id)).getByRole("form", { name: "Tags for Fleece" })).toBeTruthy()

    await act(async () => confirm.resolve(ok({ ...coat, status: "confirmed" })))

    await waitFor(() => expect(document.getElementById(reviewHeadingId(coat.id))).toBeNull())
    expect(within(cardById(fleece.id)).getByRole("form", { name: "Tags for Fleece" })).toBeTruthy()
    await act(async () =>
      tags.get(other.id)?.resolve(ok({ cached: false, item: taggedCard({ id: other.id, name: "Beanie" }) }))
    )
  })

  it("keeps a batch start's In batch marks when a confirm settles later", async () => {
    const coat = taggedCard({ name: "Coat" })
    const waiting = Array.from({ length: 21 }, () => pendingCard())
    const [dryRun] = waiting
    if (dryRun === undefined) throw new Error("no items")
    const { actions, tagRequest } = setup([coat, ...waiting])
    const confirm = deferred<Result<ItemCardDto>>()
    actions.confirmItem.mockReturnValue(confirm.promise)
    actions.startTaggingBatch.mockImplementation(async ({ itemIds }) =>
      ok({ batchId: BATCH_ID, count: itemIds.length, estimateUsd: 0.13, dryRunItemId: dryRun.id })
    )
    tagRequest.mockImplementation(async (id) => ok({ cached: true, item: taggedCard({ id, name: "Dry-run coat" }) }))

    fireEvent.click(within(card("Coat")).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(actions.confirmItem).toHaveBeenCalled())
    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag as a batch (≈ $0.13)" }))
    await screen.findByRole("heading", { name: "Dry-run coat" })

    await act(async () => confirm.resolve(ok({ ...coat, status: "confirmed" })))

    await waitFor(() => expect(document.getElementById(reviewHeadingId(coat.id))).toBeNull())
    expect(screen.getByRole("heading", { name: "Dry-run coat" })).toBeTruthy()
    // The shown page: the dry-run card and nine cards in the batch.
    expect(screen.getAllByText("In batch")).toHaveLength(REVIEW_PAGE_SIZE - 1)
    expect(screen.queryByRole("button", { name: "Fill in by hand" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Tag now" })).toBeNull()
  })

  it("keeps an item a revisit added when a confirm settles afterwards", async () => {
    const coat = taggedCard({ name: "Coat" })
    const scarf = taggedCard({ name: "Scarf" })
    const { actions, revisit } = setupInActivity([coat, scarf])
    const confirm = deferred<Result<ItemCardDto>>()
    actions.confirmItem.mockReturnValue(confirm.promise)
    fireEvent.click(within(card("Coat")).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(actions.confirmItem).toHaveBeenCalled())

    const added = pendingCard()
    revisit([added, coat, scarf])
    expect(cardById(added.id)).toBeTruthy()

    await act(async () => confirm.resolve(ok({ ...coat, status: "confirmed" })))

    await waitFor(() => expect(document.getElementById(reviewHeadingId(coat.id))).toBeNull())
    expect(cardById(added.id)).toBeTruthy()
    expect(screen.getByRole("heading", { level: 2, name: "2 items to review" })).toBeTruthy()
  })
})

describe("focus after a request settles", () => {
  it("stays in another card's field when Tag now finishes", async () => {
    const pending = pendingCard()
    const coat = taggedCard({ name: "Coat" })
    const { tagRequest } = setup([pending, coat])
    const tag = deferred<Result<TagData>>()
    tagRequest.mockReturnValue(tag.promise)
    fireEvent.click(within(cardById(pending.id)).getByRole("button", { name: "Tag now" }))
    await waitFor(() => expect(tagRequest).toHaveBeenCalled())
    const name = within(card("Coat")).getByLabelText("Name")
    act(() => name.focus())

    await act(async () => tag.resolve(ok({ cached: false, item: taggedCard({ id: pending.id, name: "Fleece" }) })))

    expect(await within(cardById(pending.id)).findByRole("form", { name: "Tags for Fleece" })).toBeTruthy()
    expect(document.activeElement).toBe(name)
  })

  it("stays in another card's field when a confirm finishes", async () => {
    const first = taggedCard({ name: "First" })
    const second = taggedCard({ name: "Second" })
    const third = taggedCard({ name: "Third" })
    const { actions } = setup([first, second, third])
    const confirm = deferred<Result<ItemCardDto>>()
    actions.confirmItem.mockReturnValue(confirm.promise)
    fireEvent.click(within(card("First")).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(actions.confirmItem).toHaveBeenCalled())
    const notes = within(card("Third")).getByLabelText("Notes")
    act(() => notes.focus())

    await act(async () => confirm.resolve(ok({ ...first, status: "confirmed" })))

    await waitFor(() => expect(document.getElementById(reviewHeadingId(first.id))).toBeNull())
    expect(document.activeElement).toBe(notes)
  })

  it("moves focus from Show more to the first newly shown card", async () => {
    const items = Array.from({ length: 2 * REVIEW_PAGE_SIZE + 1 }, () => pendingCard())
    const firstNew = items[REVIEW_PAGE_SIZE]
    if (firstNew === undefined) throw new Error("no items")
    setup(items)
    const more = screen.getByRole("button", {
      name: `Show ${REVIEW_PAGE_SIZE} more (${REVIEW_PAGE_SIZE + 1} not shown)`,
    })
    act(() => more.focus())

    fireEvent.click(more)

    await waitFor(() => expect(document.activeElement?.id).toBe(reviewHeadingId(firstNew.id)))
  })

  it("moves focus to the summary when a run tags every waiting item", async () => {
    const { tagRequest } = setup([pendingCard(), pendingCard(), taggedCard()])
    tagRequest.mockImplementation(async (id) => ok({ cached: false, item: taggedCard({ id }) }))
    const button = within(taggingRegion()).getByRole("button", { name: "Tag 2 items" })
    act(() => button.focus())

    fireEvent.click(button)

    await waitFor(() => expect(screen.queryByRole("region", { name: "Tagging" })).toBeNull())
    expect(document.activeElement?.id).toBe("review-summary")
  })

  it("moves focus to the summary when a batch takes every waiting item", async () => {
    const waiting = Array.from({ length: 21 }, () => pendingCard())
    const [dryRun] = waiting
    if (dryRun === undefined) throw new Error("no items")
    const { actions, tagRequest } = setup(waiting)
    actions.startTaggingBatch.mockImplementation(async ({ itemIds }) =>
      ok({ batchId: BATCH_ID, count: itemIds.length, estimateUsd: 0.13, dryRunItemId: dryRun.id })
    )
    tagRequest.mockImplementation(async (id) => ok({ cached: true, item: taggedCard({ id, name: "Dry-run coat" }) }))
    const button = within(taggingRegion()).getByRole("button", { name: "Tag as a batch (≈ $0.13)" })
    act(() => button.focus())

    fireEvent.click(button)

    await waitFor(() => expect(screen.queryByRole("region", { name: "Tagging" })).toBeNull())
    expect(document.activeElement?.id).toBe("review-summary")
  })
})

describe("tagging from the review page", () => {
  it("quotes every waiting item and tags them, leaving batch items alone", async () => {
    const waiting = [pendingCard(), pendingCard(), pendingCard({ taggingError: "The batch expired. Tag it again." })]
    const inBatch = pendingCard({ taggingBatchId: BATCH_ID })
    const { tagRequest, setupRequest } = setup([...waiting, inBatch, taggedCard()])
    tagRequest.mockImplementation(async (id) =>
      ok({ cached: false, item: taggedCard({ id, name: `Tagged ${id.slice(-4)}` }) }),
    )

    const region = taggingRegion()
    expect(within(region).getByText("Tag 3 waiting items ≈ $0.04 (Haiku 5.5)")).toBeTruthy()
    expect(within(region).getByText("$12.50 left this month")).toBeTruthy()
    expect(within(region).queryByRole("button", { name: /Tag as a batch/ })).toBeNull()

    fireEvent.click(within(region).getByRole("button", { name: "Tag 3 items" }))

    await waitFor(() => expect(screen.queryByRole("region", { name: "Tagging" })).toBeNull())
    expect(tagRequest.mock.calls.map(([id]) => id).sort()).toEqual(waiting.map((item) => item.id).sort())
    for (const item of waiting) {
      expect(screen.getByRole("form", { name: `Tags for Tagged ${item.id.slice(-4)}` })).toBeTruthy()
    }
    expect(within(card("Untagged item")).getByText("In batch")).toBeTruthy()
    await waitFor(() => expect(setupRequest).toHaveBeenCalledTimes(1))
  })

  it("reads the budget again after a run, once, and shows what is left", async () => {
    const waiting = [pendingCard(), pendingCard()]
    const { tagRequest, setupRequest } = setup(waiting)
    setupRequest.mockResolvedValue(taggingSetup(12.47))
    tagRequest.mockImplementation(async (id) =>
      id === waiting[0]?.id
        ? ok({ cached: false, item: taggedCard({ id, name: "Tagged coat" }) })
        : err("AI_TIMEOUT", "Claude did not answer in time."),
    )

    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag 2 items" }))

    expect(await within(taggingRegion()).findByText("$12.47 left this month")).toBeTruthy()
    expect(setupRequest).toHaveBeenCalledTimes(1)
    expect(within(taggingRegion()).getByText("Tag 1 waiting item ≈ $0.02 (Haiku 5.5)")).toBeTruthy()
  })

  it("keeps the last budget when reading it again fails", async () => {
    const waiting = [pendingCard(), pendingCard()]
    const { tagRequest, setupRequest } = setup(waiting)
    setupRequest.mockResolvedValue(err("UPSTREAM", NETWORK_ERROR_MESSAGE))
    tagRequest.mockResolvedValue(err("AI_TIMEOUT", "Claude did not answer in time."))

    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag 2 items" }))

    await waitFor(() => expect(setupRequest).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getAllByText("Claude did not answer in time.")).toHaveLength(2))
    expect(within(taggingRegion()).getByText("$12.50 left this month")).toBeTruthy()
    expect(screen.queryByText("AI budget reached")).toBeNull()
  })

  it("blocks tagging when the budget read after a run is used up", async () => {
    const waiting = [pendingCard(), pendingCard()]
    const { tagRequest, setupRequest } = setup(waiting)
    setupRequest.mockResolvedValue(taggingSetup(0))
    tagRequest.mockResolvedValue(err("AI_TIMEOUT", "Claude did not answer in time."))

    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag 2 items" }))

    expect(await screen.findByText("AI budget reached")).toBeTruthy()
    expect(within(taggingRegion()).getByRole("button", { name: "Tag 2 items" }).getAttribute("aria-disabled")).toBe(
      "true",
    )
  })

  it("stops starting calls when the budget runs out and shows why on the failed cards", async () => {
    const waiting = Array.from({ length: 6 }, () => pendingCard())
    const { tagRequest } = setup(waiting)
    const pending: Array<() => void> = []
    tagRequest.mockImplementationOnce(async () => err("BUDGET_EXCEEDED", "Monthly AI budget reached."))
    tagRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(err("AI_TIMEOUT", "Claude did not answer in time.")))
        }),
    )

    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag 6 items" }))

    // Four started together; the two waiting never start once the budget is out.
    await waitFor(() => expect(pending).toHaveLength(3))
    for (const resolve of pending) resolve()
    const alert = await screen.findByText("Monthly AI budget reached.")
    expect(alert.closest("[role=alert]")).toBeTruthy()
    expect(tagRequest).toHaveBeenCalledTimes(4)
    await waitFor(() => expect(screen.getAllByText("Claude did not answer in time.")).toHaveLength(3))
    // focusableWhenDisabled keeps the button in the tab order and marks it with aria-disabled.
    expect(within(taggingRegion()).getByRole("button", { name: /^Tag \d+ items$/ }).getAttribute("aria-disabled")).toBe(
      "true",
    )
  })

  it("offers a batch above 20 waiting items and shows the dry-run item as tagged", async () => {
    const waiting = Array.from({ length: 21 }, () => pendingCard())
    const { actions, tagRequest, setupRequest } = setup(waiting)
    const [first] = waiting
    if (first === undefined) throw new Error("no items")
    actions.startTaggingBatch.mockImplementation(async ({ itemIds }) =>
      ok({ batchId: BATCH_ID, count: itemIds.length, estimateUsd: 0.13, dryRunItemId: first.id }),
    )
    tagRequest.mockImplementation(async (id) => ok({ cached: true, item: taggedCard({ id, name: "Dry-run coat" }) }))

    // The dry run at standard rates (0.025), then 20 items at batch rates (0.01 + 19 x 0.005).
    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag as a batch (≈ $0.13)" }))

    await screen.findByRole("heading", { name: "Dry-run coat" })
    expect(actions.startTaggingBatch).toHaveBeenCalledWith({ itemIds: waiting.map((item) => item.id) })
    // Only the dry-run card is read back, and without force: the server answers from its stored tags.
    expect(tagRequest).toHaveBeenCalledTimes(1)
    expect(tagRequest).toHaveBeenCalledWith(first.id)
    expect(screen.getAllByText("In batch")).toHaveLength(9)
    expect(screen.queryByRole("region", { name: "Tagging" })).toBeNull()
    await waitFor(() => expect(setupRequest).toHaveBeenCalledTimes(1))
  })

  it("keeps a cut-out that finished while the batch was starting", async () => {
    const waiting = Array.from({ length: 21 }, () => pendingCard())
    const { actions, tagRequest } = setup(waiting)
    const [first, second] = waiting
    if (first === undefined || second === undefined) throw new Error("no items")
    let finishStart: (result: Result<StartTaggingBatchData>) => void = () => {}
    actions.startTaggingBatch.mockReturnValue(new Promise((resolve) => (finishStart = resolve)))
    tagRequest.mockImplementation(async (id) => ok({ cached: true, item: taggedCard({ id, name: "Dry-run coat" }) }))

    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag as a batch (≈ $0.13)" }))
    await screen.findByText("Starting the batch…")
    fireEvent.click(within(cardById(second.id)).getByRole("button", { name: "Remove background" }))
    expect(within(cardById(second.id)).getByRole("button", { name: "Background removed" })).toBeTruthy()

    finishStart(ok({ batchId: BATCH_ID, count: 21, estimateUsd: 0.13, dryRunItemId: first.id }))

    await screen.findByRole("heading", { name: "Dry-run coat" })
    const cutOut = cardById(second.id)
    expect(within(cutOut).getByText("In batch")).toBeTruthy()
    expect(within(cutOut).getByRole("button", { name: "Background removed" })).toBeTruthy()
  })

  it("keeps the size it started with on the Tag button while a run or a batch start is going", async () => {
    const waiting = Array.from({ length: 21 }, () => pendingCard())
    const { actions, tagRequest } = setup(waiting)
    let finishStart: (result: Result<StartTaggingBatchData>) => void = () => {}
    actions.startTaggingBatch.mockReturnValue(new Promise((resolve) => (finishStart = resolve)))

    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag as a batch (≈ $0.13)" }))
    await screen.findByText("Starting the batch…")

    // Every waiting item is busy, so the waiting count is 0; the buttons keep 21.
    const tagButton = within(taggingRegion()).getByRole("button", { name: "Tag 21 items" })
    expect(tagButton.getAttribute("aria-disabled")).toBe("true")
    expect(within(taggingRegion()).queryByRole("button", { name: "Tag 0 items" })).toBeNull()

    finishStart(err("CONFIG", "The server is misconfigured. Check the server logs."))
    expect(await within(taggingRegion()).findByText(/^Tag 21 waiting items ≈/)).toBeTruthy()

    const pending: Array<() => void> = []
    tagRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(err("AI_TIMEOUT", "Claude did not answer in time.")))
        }),
    )
    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag 21 items" }))
    await screen.findByText("Tagging… 0 of 21 items done")

    const running = within(taggingRegion()).getByRole("button", { name: "Tag 21 items" })
    expect(running.getAttribute("aria-busy")).toBe("true")
    expect(within(taggingRegion()).queryByRole("button", { name: "Tag 0 items" })).toBeNull()

    // Settle every call, the ones queued behind the four-at-a-time limit too.
    await waitFor(() => {
      for (const resolve of pending.splice(0)) resolve()
      expect(screen.queryByText(/^Tagging…/)).toBeNull()
    })
  })

  it("shows a failed dry run on its item's card", async () => {
    const waiting = Array.from({ length: 21 }, () => pendingCard())
    const { actions, setupRequest } = setup(waiting)
    const [first] = waiting
    if (first === undefined) throw new Error("no items")
    const message = "No batch was created: tagging the first item as a test failed. Claude declined to describe this photo."
    actions.startTaggingBatch.mockResolvedValue(err("AI_REFUSAL", message, { dryRunItemId: first.id }))

    fireEvent.click(within(taggingRegion()).getByRole("button", { name: "Tag as a batch (≈ $0.13)" }))

    const failed = cardById(first.id)
    await waitFor(() => expect(within(failed).getByRole("alert").textContent).toContain(message))
    expect(within(failed).getByRole("button", { name: "Retry tagging" })).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "Retry tagging" })).toHaveLength(1)
    expect(screen.queryByText("In batch")).toBeNull()
    await waitFor(() => expect(setupRequest).toHaveBeenCalledTimes(1))
  })

  it("tags an item in a batch at once only after the owner confirms, with force and the batch", async () => {
    const item = pendingCard({ taggingBatchId: BATCH_ID })
    const { tagRequest } = setup([item])
    tagRequest.mockResolvedValue(ok({ cached: false, item: taggedCard({ id: item.id, name: "Rain shell" }) }))

    fireEvent.click(screen.getByRole("button", { name: "Tag now instead" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog.textContent).toContain("billed at the batch price but not used")
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep waiting" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(tagRequest).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Tag now instead" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Tag now" }))

    await screen.findByRole("heading", { name: "Rain shell" })
    // The batch id lets the server answer with the batch's tags if it was applied meanwhile.
    expect(tagRequest).toHaveBeenCalledWith(item.id, { force: true, batchId: BATCH_ID })
  })

  it("explains why bulk tagging is unavailable when the settings are invalid", () => {
    setup([pendingCard(), pendingCard()], 2, { ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } })

    expect(screen.getByText("Tagging several items at once is unavailable")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /^Tag \d+ items$/ })).toBeNull()
    expect(screen.getAllByRole("button", { name: "Tag now" })).toHaveLength(2)
  })
})

describe("filling in tags by hand", () => {
  it("is offered for waiting items in no batch only", () => {
    const waiting = pendingCard({ taggingError: "Claude declined to describe this photo." })
    const inBatch = pendingCard({ taggingBatchId: BATCH_ID })
    const tagged = taggedCard({ name: "Tagged coat" })
    setup([waiting, inBatch, tagged])

    expect(within(cardById(waiting.id)).getByRole("button", { name: "Fill in by hand" })).toBeTruthy()
    expect(within(cardById(inBatch.id)).queryByRole("button", { name: "Fill in by hand" })).toBeNull()
    expect(within(card("Tagged coat")).queryByRole("button", { name: "Fill in by hand" })).toBeNull()
  })

  it("keeps the open form's item out of bulk tagging, and Cancel brings the buttons back", async () => {
    const [first, second] = [pendingCard(), pendingCard()]
    if (first === undefined || second === undefined) throw new Error("no items")
    setup([first, second])
    expect(within(taggingRegion()).getByRole("button", { name: "Tag 2 items" })).toBeTruthy()

    fireEvent.click(within(cardById(first.id)).getByRole("button", { name: "Fill in by hand" }))

    expect(within(cardById(first.id)).getByRole("form", { name: "Tags for Untagged item" })).toBeTruthy()
    expect(await within(taggingRegion()).findByRole("button", { name: "Tag 1 item" })).toBeTruthy()

    fireEvent.click(within(cardById(first.id)).getByRole("button", { name: "Cancel" }))

    const fillIn = await within(cardById(first.id)).findByRole("button", { name: "Fill in by hand" })
    await waitFor(() => expect(document.activeElement).toBe(fillIn))
    expect(within(taggingRegion()).getByRole("button", { name: "Tag 2 items" })).toBeTruthy()
  })

  it("moves an item confirmed by hand out of the list", async () => {
    const item = pendingCard()
    const other = taggedCard({ name: "Other coat" })
    const { actions, tagRequest } = setup([item, other])
    actions.tagItemByHand.mockImplementation(async ({ id }) =>
      ok(taggedCard({ id, status: "confirmed", name: "Olive fleece", aiConfidence: null, aiModel: null })),
    )

    fireEvent.click(within(cardById(item.id)).getByRole("button", { name: "Fill in by hand" }))
    await fillInByHand(cardById(item.id), "Olive fleece")
    fireEvent.click(within(cardById(item.id)).getByRole("button", { name: "Save and confirm" }))

    await waitFor(() => expect(document.getElementById(reviewHeadingId(item.id))).toBeNull())
    expect(actions.tagItemByHand).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, confirm: true }))
    expect(screen.getByText("Olive fleece confirmed and moved to your wardrobe.")).toBeTruthy()
    expect(screen.getByRole("heading", { level: 2, name: "1 item to review" })).toBeTruthy()
    expect(tagRequest).not.toHaveBeenCalled()
  })

  it("turns an item saved by hand into a tagged card", async () => {
    const item = pendingCard()
    const { actions } = setup([item])
    actions.tagItemByHand.mockImplementation(async ({ id }) =>
      ok(taggedCard({ id, name: "Olive fleece", aiConfidence: null, aiModel: null })),
    )

    fireEvent.click(screen.getByRole("button", { name: "Fill in by hand" }))
    await fillInByHand(cardById(item.id), "Olive fleece")
    fireEvent.click(within(cardById(item.id)).getByRole("button", { name: "Save" }))

    const heading = await screen.findByRole("heading", { name: "Olive fleece" })
    expect(actions.tagItemByHand).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, confirm: false }))
    expect(screen.getByRole("form", { name: "Tags for Olive fleece" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Re-tag" })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })
})
