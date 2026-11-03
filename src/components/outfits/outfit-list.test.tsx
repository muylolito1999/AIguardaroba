// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react"
import { Activity, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { toast } from "@/components/ui/toast"
import type { OutfitListItemDto } from "@/lib/outfits/contracts"

import type { LogWearAction, UndoWearAction } from "./outfit-actions"
import { noteOutfitChange } from "./outfit-changes"
import { OutfitList } from "./outfit-list"

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const ACTIONS = { logWear: vi.fn<LogWearAction>(), undoWear: vi.fn<UndoWearAction>() }

beforeEach(() => {
  vi.spyOn(toast, "add").mockReturnValue("toast-id")
  router.refresh.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function outfit(overrides: Partial<OutfitListItemDto> = {}): OutfitListItemDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Rainy office day",
    occasion: "Office",
    weatherMinC: -2,
    weatherMaxC: 8.5,
    rainOk: true,
    source: "ai",
    rating: 4,
    createdAt: "2026-11-01T08:00:00.000Z",
    items: [
      {
        itemId: "22222222-2222-4222-8222-222222222222",
        slot: "top",
        name: "Grey sweater",
        category: "top",
        thumbUrl: null,
        status: "confirmed",
        wearCount: 2,
        exists: true,
      },
      {
        itemId: "33333333-3333-4333-8333-333333333333",
        slot: "bottom",
        name: "Dark jeans",
        category: "bottom",
        thumbUrl: "https://blob.example/jeans.webp",
        status: "confirmed",
        wearCount: 1,
        exists: true,
      },
    ],
    lastWornOn: "2026-11-02",
    timesWorn: 3,
    ...overrides,
  }
}

describe("OutfitList", () => {
  it("shows each outfit's name, occasion, weather, rain, rating, source and wear", () => {
    render(<OutfitList outfits={[outfit()]} actions={ACTIONS} />)
    const card = screen.getByRole("article", { name: "Rainy office day" })
    expect(within(card).getByRole("link", { name: "Rainy office day" }).getAttribute("href")).toBe(
      "/outfits/11111111-1111-4111-8111-111111111111"
    )
    expect(within(card).getByText("Office")).toBeTruthy()
    expect(within(card).getByText("−2 to 8.5 °C")).toBeTruthy()
    expect(within(card).getByText("Fine in rain")).toBeTruthy()
    expect(within(card).getByText("Rated 4 of 5")).toBeTruthy()
    expect(within(card).getByText("AI")).toBeTruthy()
    expect(within(card).getByText("Worn 3 times")).toBeTruthy()
    expect(within(card).getByText("Grey sweater, Dark jeans")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Wore this today" })).toBeTruthy()
  })

  it("offers the builder when there are no outfits", () => {
    render(<OutfitList outfits={[]} actions={ACTIONS} />)
    expect(screen.getByText("No outfits yet")).toBeTruthy()
    expect(screen.getByRole("link", { name: "New outfit" }).getAttribute("href")).toBe("/outfits/new")
  })

  it("reads itself again after an outfit change, while shown and when shown again", async () => {
    // The shared refresh asks once per task (useSharedRefresh); each step below is a task of its own.
    const nextTask = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
    const first = [outfit()]
    const view = render(
      <Activity mode="visible">
        <OutfitList outfits={first} actions={ACTIONS} />
      </Activity>
    )
    expect(router.refresh).not.toHaveBeenCalled()

    act(() => noteOutfitChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)
    await nextTask()
    // A second change waits for the data the first refresh brings.
    act(() => noteOutfitChange())
    expect(router.refresh).toHaveBeenCalledTimes(1)

    // The refresh's data was asked for before the second change, so it is stale too.
    const second = [outfit({ timesWorn: 4 })]
    view.rerender(
      <Activity mode="visible">
        <OutfitList outfits={second} actions={ACTIONS} />
      </Activity>
    )
    expect(router.refresh).toHaveBeenCalledTimes(2)
    await nextTask()

    const third = [outfit({ timesWorn: 4 })]
    view.rerender(
      <Activity mode="visible">
        <OutfitList outfits={third} actions={ACTIONS} />
      </Activity>
    )
    expect(router.refresh).toHaveBeenCalledTimes(2)

    // Hidden by Next: no reads until shown again, then one.
    view.rerender(
      <Activity mode="hidden">
        <OutfitList outfits={third} actions={ACTIONS} />
      </Activity>
    )
    act(() => noteOutfitChange())
    expect(router.refresh).toHaveBeenCalledTimes(2)
    await nextTask()
    view.rerender(
      <Activity mode="visible">
        <OutfitList outfits={third} actions={ACTIONS} />
      </Activity>
    )
    expect(router.refresh).toHaveBeenCalledTimes(3)
  })
})
