// @vitest-environment jsdom
import { Activity, StrictMode } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { RefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import type { LogWearAction, UndoWearAction } from "@/components/outfits/outfit-actions"
import { toast } from "@/components/ui/toast"
import { wardrobeChangeCount } from "@/lib/items/wardrobe-changes"
import { err, ok } from "@/lib/result"
import { WEAR_UNDO_WINDOW_MS, type WearLogResultDto } from "@/lib/wear/contracts"

import { WornToday } from "./worn-today"

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

const ITEM_ID = "11111111-1111-4111-8111-111111111111"
const LOG_ID = "22222222-2222-4222-8222-222222222222"

type ToastOptions = Parameters<typeof toast.add>[0]

let added: ToastOptions[]

beforeEach(() => {
  added = []
  vi.spyOn(toast, "add").mockImplementation((options) => {
    added.push(options)
    return `toast-${added.length}`
  })
  vi.spyOn(toast, "close").mockImplementation(() => undefined)
  router.refresh.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function logged(overrides: Partial<WearLogResultDto> = {}): WearLogResultDto {
  return {
    wornOn: "2026-11-03",
    logIds: [LOG_ID],
    items: [{ id: ITEM_ID, wearCount: 4, lastWornAt: "2026-11-03T11:00:00.000Z" }],
    alreadyLogged: [],
    undoUntil: "2026-11-03T13:30:00.000Z",
    ...overrides,
  }
}

function setup(status: "confirmed" | "archived" = "confirmed") {
  const logWear = vi.fn<LogWearAction>()
  const undoWear = vi.fn<UndoWearAction>()
  const onCountsChange = vi.fn()
  render(
    <WornToday
      item={{ id: ITEM_ID, status }}
      name="Navy wool coat"
      logWear={logWear}
      undoWear={undoWear}
      onCountsChange={onCountsChange}
    />
  )
  return { logWear, undoWear, onCountsChange }
}

describe("WornToday", () => {
  it("logs a wear, shows the new count and offers Undo for the whole window", async () => {
    const { logWear, undoWear, onCountsChange } = setup()
    logWear.mockResolvedValue(ok(logged()))
    undoWear.mockResolvedValue(
      ok({ undone: [LOG_ID], items: [{ id: ITEM_ID, wearCount: 3, lastWornAt: "2026-10-30T11:00:00.000Z" }] })
    )
    const changesBefore = wardrobeChangeCount()

    fireEvent.click(screen.getByRole("button", { name: "+1 worn today" }))

    await waitFor(() => expect(onCountsChange).toHaveBeenCalledWith({ wearCount: 4, lastWornAt: "2026-11-03T11:00:00.000Z" }))
    expect(logWear).toHaveBeenCalledWith({ kind: "items", itemIds: [ITEM_ID] })
    expect(wardrobeChangeCount()).toBe(changesBefore + 1)
    const confirmation = added[0]
    expect(confirmation).toMatchObject({ title: "Logged as worn", type: "success", timeout: WEAR_UNDO_WINDOW_MS })
    expect(confirmation?.actionProps?.children).toBe("Undo")

    confirmation?.actionProps?.onClick?.({} as never)
    await waitFor(() => expect(onCountsChange).toHaveBeenLastCalledWith({ wearCount: 3, lastWornAt: "2026-10-30T11:00:00.000Z" }))
    expect(undoWear).toHaveBeenCalledWith({ logIds: [LOG_ID] })
    expect(toast.close).toHaveBeenCalledWith("toast-1")
    expect(wardrobeChangeCount()).toBe(changesBefore + 2)
    expect(added[1]).toMatchObject({ title: "Wear undone" })
  })

  it("says so when today's wear is already logged, without Undo", async () => {
    const { logWear, onCountsChange } = setup()
    logWear.mockResolvedValue(ok(logged({ logIds: [], alreadyLogged: [ITEM_ID] })))
    const changesBefore = wardrobeChangeCount()

    fireEvent.click(screen.getByRole("button", { name: "+1 worn today" }))

    await waitFor(() => expect(added[0]).toMatchObject({ title: "Already logged", type: "info" }))
    expect(added[0]?.actionProps).toBeUndefined()
    expect(onCountsChange).not.toHaveBeenCalled()
    expect(wardrobeChangeCount()).toBe(changesBefore)
  })

  it("toasts an error and an Undo the server refuses", async () => {
    const { logWear, undoWear, onCountsChange } = setup()
    logWear.mockResolvedValueOnce(err("VALIDATION", "Choose your home city in Settings first."))
    fireEvent.click(screen.getByRole("button", { name: "+1 worn today" }))
    await waitFor(() => expect(added[0]).toMatchObject({ type: "error", description: "Choose your home city in Settings first." }))

    logWear.mockResolvedValueOnce(ok(logged()))
    undoWear.mockResolvedValue(err("VALIDATION", "A wear can only be undone within 10 minutes of logging it."))
    fireEvent.click(screen.getByRole("button", { name: "+1 worn today" }))
    await waitFor(() => expect(added[1]).toMatchObject({ title: "Logged as worn" }))
    added[1]?.actionProps?.onClick?.({} as never)
    await waitFor(() => expect(added[2]).toMatchObject({ type: "error" }))
    expect(onCountsChange).toHaveBeenCalledTimes(1)
  })

  it("is busy while the request runs and sends one request per press", async () => {
    const { logWear } = setup()
    let answer: (value: Awaited<ReturnType<LogWearAction>>) => void = () => undefined
    logWear.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const button = screen.getByRole("button", { name: "+1 worn today" })
    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"))
    fireEvent.click(button)
    expect(logWear).toHaveBeenCalledTimes(1)
    answer(ok(logged()))
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull())
  })

  it("is not offered for an archived item", () => {
    setup("archived")
    expect(screen.queryByRole("button", { name: "+1 worn today" })).toBeNull()
  })
})

describe("an Undo that answers while another page is shown", () => {
  const SHOWN_PAGE_DATA = {}

  /** The item page (hidden or shown) next to another page that, like /today, does not re-read while shown. */
  function pages(itemPage: "visible" | "hidden", logWear: LogWearAction, undoWear: UndoWearAction, onCountsChange = vi.fn()) {
    return (
      <StrictMode>
        <Activity mode={itemPage}>
          <WornToday
            item={{ id: ITEM_ID, status: "confirmed" }}
            name="Navy wool coat"
            logWear={logWear}
            undoWear={undoWear}
            onCountsChange={onCountsChange}
          />
        </Activity>
        <Activity mode={itemPage === "visible" ? "hidden" : "visible"}>
          <RefreshAfterItemChanges snapshot={SHOWN_PAGE_DATA} refreshWhileShown={false} />
        </Activity>
      </StrictMode>
    )
  }

  it("reads the shown page again, once", async () => {
    const logWear = vi.fn<LogWearAction>().mockResolvedValue(ok(logged()))
    const undoWear = vi
      .fn<UndoWearAction>()
      .mockResolvedValue(ok({ undone: [LOG_ID], items: [{ id: ITEM_ID, wearCount: 3, lastWornAt: null }] }))
    const { rerender } = render(pages("visible", logWear, undoWear))
    fireEvent.click(screen.getByRole("button", { name: "+1 worn today" }))
    await waitFor(() => expect(added[0]).toMatchObject({ title: "Logged as worn" }))

    // The owner went to another page; the toast's Undo answers there.
    rerender(pages("hidden", logWear, undoWear))
    router.refresh.mockClear()
    await act(async () => {
      added[0]?.actionProps?.onClick?.({} as never)
    })

    await waitFor(() => expect(added[1]).toMatchObject({ title: "Wear undone" }))
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("leaves the reading to the button's own page while it is shown", async () => {
    const logWear = vi.fn<LogWearAction>().mockResolvedValue(ok(logged()))
    const undoWear = vi
      .fn<UndoWearAction>()
      .mockResolvedValue(ok({ undone: [LOG_ID], items: [{ id: ITEM_ID, wearCount: 3, lastWornAt: null }] }))
    const onCountsChange = vi.fn()
    render(pages("visible", logWear, undoWear, onCountsChange))
    fireEvent.click(screen.getByRole("button", { name: "+1 worn today" }))
    await waitFor(() => expect(added[0]).toMatchObject({ title: "Logged as worn" }))
    await act(async () => {
      added[0]?.actionProps?.onClick?.({} as never)
    })

    await waitFor(() => expect(onCountsChange).toHaveBeenLastCalledWith({ wearCount: 3, lastWornAt: null }))
    expect(router.refresh).not.toHaveBeenCalled()
  })
})
