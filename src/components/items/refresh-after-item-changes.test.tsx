// @vitest-environment jsdom
import { Activity } from "react"
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { noteWardrobeChange } from "@/lib/items/wardrobe-changes"

import { NoteServerItemChanges } from "./note-server-item-changes"
import { REFRESH_INTERVAL_MS, RefreshAfterItemChanges } from "./refresh-after-item-changes"

// Next keeps a visited page in a hidden <Activity> and serves Back from its
// client cache, so a return hands the page the same props it had
// (node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md).

const router = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

beforeEach(() => router.refresh.mockClear())
afterEach(cleanup)

function renderInActivity(initial: object, refreshWhileShown?: boolean) {
  let snapshot = initial
  const ui = (mode: "visible" | "hidden") => (
    <Activity mode={mode}>
      <RefreshAfterItemChanges snapshot={snapshot} refreshWhileShown={refreshWhileShown} />
    </Activity>
  )
  const view = render(ui("visible"))
  return {
    hide: () => view.rerender(ui("hidden")),
    show: () => view.rerender(ui("visible")),
    serve: (next: object) => {
      snapshot = next
      view.rerender(ui("visible"))
    },
  }
}

describe("RefreshAfterItemChanges", () => {
  it("does not refresh a page shown again when nothing changed", () => {
    const page = renderInActivity({ all: 3 })
    page.hide()
    page.show()
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("refreshes once when an item changed while the page was hidden", () => {
    const page = renderInActivity({ all: 3 })
    page.hide()
    act(() => noteWardrobeChange())
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The refreshed data arrives as a new object: fresh, so no second refresh.
    page.serve({ all: 2 })
    page.hide()
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("does not refresh when a fresh navigation already brought newer data", () => {
    const page = renderInActivity({ all: 3 })
    page.hide()
    act(() => noteWardrobeChange())
    page.serve({ all: 2 })
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it("refreshes when a change is noted while the page is shown (a save answering after Back)", () => {
    const page = renderInActivity({ all: 3 })
    act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    // The refreshed data is fresh: no more refreshes.
    page.serve({ all: 2 })
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // While hidden it does not listen, so it never re-reads in the background;
    // it checks once shown.
    page.hide()
    act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it("only checks on show when told not to listen while shown", () => {
    const page = renderInActivity({ item: 1 }, false)
    act(() => noteWardrobeChange())
    expect(router.refresh).not.toHaveBeenCalled()
    page.hide()
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })
})

// A "Tag N waiting items" run on /add/review keeps answering after the owner
// opened another page; every answer notes a change (D-130).
describe("RefreshAfterItemChanges during a burst of changes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    router.refresh.mockReset()
  })

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  it("refreshes at once for one late save", () => {
    renderInActivity({ all: 3 })
    act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    advance(REFRESH_INTERVAL_MS * 3)
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("shares one more refresh among many changes noted before the first one's data arrives", () => {
    renderInActivity({ all: 3 })
    for (let i = 0; i < 40; i += 1) act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    advance(REFRESH_INTERVAL_MS)
    expect(router.refresh).toHaveBeenCalledTimes(2)
    advance(REFRESH_INTERVAL_MS * 3)
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it("refreshes about once per interval while changes keep coming, never once per change", () => {
    const page = renderInActivity({ all: 0 })
    let landing: ReturnType<typeof setTimeout> | null = null
    let refreshes = 0
    // Each refresh lands 0.5 s after it was asked for, with a new data object.
    router.refresh.mockImplementation(() => {
      refreshes += 1
      landing = setTimeout(() => {
        landing = null
        page.serve({ all: refreshes })
      }, 500)
    })
    // One answer every 1.5 s for a minute.
    for (let i = 0; i < 40; i += 1) {
      act(() => noteWardrobeChange())
      advance(1_500)
    }
    advance(REFRESH_INTERVAL_MS * 2)
    expect(landing).toBeNull()
    expect(router.refresh.mock.calls.length).toBeGreaterThan(1)
    expect(router.refresh.mock.calls.length).toBeLessThanOrEqual(Math.ceil(60_000 / REFRESH_INTERVAL_MS) + 1)
  })

  it("counts the data a refresh brings as read when the refresh was asked for", () => {
    const page = renderInActivity({ all: 3 })
    act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    // Another answer while the request runs; the data may have been read before it.
    act(() => noteWardrobeChange())
    page.serve({ all: 2 })
    expect(router.refresh).toHaveBeenCalledTimes(1)
    advance(REFRESH_INTERVAL_MS)
    expect(router.refresh).toHaveBeenCalledTimes(2)
    // The data that refresh brings is fresh.
    page.serve({ all: 1 })
    advance(REFRESH_INTERVAL_MS * 2)
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it("asks again after a refresh that brought nothing, once a later change comes", () => {
    renderInActivity({ all: 3 })
    act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    // The refresh was dropped (a navigation won), so no data arrives.
    advance(REFRESH_INTERVAL_MS + 1)
    act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it("drops a waiting refresh when hidden and checks once when shown", () => {
    const page = renderInActivity({ all: 3 })
    act(() => noteWardrobeChange())
    act(() => noteWardrobeChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    page.hide()
    for (let i = 0; i < 10; i += 1) act(() => noteWardrobeChange())
    advance(REFRESH_INTERVAL_MS * 2)
    expect(router.refresh).toHaveBeenCalledTimes(1)
    // Back: at once, without waiting for the interval.
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })
})

// /add/review renders its batch-results marker, then the hook with its cards
// and refreshWhileShown={false} (D-129, D-136). A refresh's server render can
// apply finished batch results; its cards were loaded after that, so they are
// not stale because of them.
describe("RefreshAfterItemChanges after the review page's batch-results marker", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    router.refresh.mockReset()
  })

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  type Poll = { processed: number; problems: string[] }

  function renderReviewMarkers() {
    let poll: Poll = { processed: 0, problems: [] }
    let cards: object = { cards: 0 }
    const ui = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        {poll.processed > 0 ? <NoteServerItemChanges render={poll} includedIn={cards} /> : null}
        <RefreshAfterItemChanges snapshot={cards} refreshWhileShown={false} />
      </Activity>
    )
    const view = render(ui("visible"))
    return {
      hide: () => view.rerender(ui("hidden")),
      show: () => view.rerender(ui("visible")),
      /** The page's next server render. */
      serve: (nextPoll: Poll, nextCards: object) => {
        poll = nextPoll
        cards = nextCards
        view.rerender(ui("visible"))
      },
    }
  }

  it("does not read the page again for the batch results its own refresh applied", () => {
    const page = renderReviewMarkers()
    page.hide()
    // An item changed on its item page; Back to /add/review.
    act(() => noteWardrobeChange())
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)

    page.serve({ processed: 3, problems: [] }, { cards: 1 })
    advance(REFRESH_INTERVAL_MS * 3)
    expect(router.refresh).toHaveBeenCalledTimes(1)
    page.hide()
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("still reads the page once more for a change noted while its refresh ran", () => {
    const page = renderReviewMarkers()
    page.hide()
    act(() => noteWardrobeChange())
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
    // One of the page's own tag answers lands while the request runs: the cards
    // it brings may have been read before it and would replace the tagged card.
    act(() => noteWardrobeChange())
    page.serve({ processed: 0, problems: [] }, { cards: 1 })
    expect(router.refresh).toHaveBeenCalledTimes(1)
    advance(REFRESH_INTERVAL_MS)
    expect(router.refresh).toHaveBeenCalledTimes(2)
    page.serve({ processed: 0, problems: [] }, { cards: 2 })
    advance(REFRESH_INTERVAL_MS * 3)
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it("also when that refresh applied batch results", () => {
    const page = renderReviewMarkers()
    page.hide()
    act(() => noteWardrobeChange())
    page.show()
    expect(router.refresh).toHaveBeenCalledTimes(1)
    act(() => noteWardrobeChange())
    page.serve({ processed: 2, problems: [] }, { cards: 1 })
    advance(REFRESH_INTERVAL_MS)
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })
})
