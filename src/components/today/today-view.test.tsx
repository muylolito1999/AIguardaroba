// @vitest-environment jsdom
import { Activity, StrictMode, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"

import { toast } from "@/components/ui/toast"
import type { OutfitItemDto } from "@/lib/outfits/contracts"
import { err, ok, type Result } from "@/lib/result"
import type { WearLogResultDto } from "@/lib/wear/contracts"
import type { WeatherSnapshot } from "@/lib/weather/open-meteo"

import type { SavedSuggestionDto, SuggestedOutfitDto, TodaySuggestionDto, TodayViewData } from "./today-model"
import { TodayView, type SuggestOutfits, type TodayActions } from "./today-view"

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))

let toastAdd: MockInstance<typeof toast.add>

beforeEach(() => {
  toastAdd = vi.spyOn(toast, "add").mockReturnValue("toast-id")
  vi.spyOn(toast, "close").mockImplementation(() => undefined)
  router.refresh.mockClear()
  router.push.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const WEATHER: WeatherSnapshot = {
  date: "2026-11-03",
  timezone: "Europe/Berlin",
  currentC: 9.4,
  tminC: 5.9,
  tmaxC: 10.8,
  apparentMinC: 2.1,
  apparentMaxC: 7.6,
  precipSumMm: 3.4,
  precipProbMax: 80,
  windGustMaxKmh: 52.9,
  weatherCode: 61,
  label: "Light rain",
  fetchedAt: "2026-11-03T13:20:00.000Z",
}

const ANALYSIS_ID = "7a0c3f4e-2b1d-4c5e-8f9a-0b1c2d3e4f50"

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

function item(n: number, slot: OutfitItemDto["slot"], name: string, extra: Partial<OutfitItemDto> = {}): OutfitItemDto {
  return {
    itemId: uuid(n),
    slot,
    name,
    category: slot === "top" ? "top" : slot === "bottom" ? "bottom" : slot === "shoes" ? "shoes" : "outerwear",
    thumbUrl: null,
    status: "confirmed",
    wearCount: 2,
    exists: true,
    ...extra,
  }
}

function outfit(index: number, extra: Partial<SuggestedOutfitDto> = {}): SuggestedOutfitDto {
  return {
    index,
    title: ["Layered for drizzle", "Smart and dry", "Light and quick"][index] ?? `Outfit ${index}`,
    why: "Feels like 2 to 8 °C with an 80 % chance of rain.",
    rainOk: index === 0,
    items: [
      item(index * 10 + 1, "outerwear", "Navy waterproof shell jacket"),
      item(index * 10 + 2, "top", "Grey merino sweater"),
      item(index * 10 + 3, "bottom", "Dark blue jeans"),
      item(index * 10 + 4, "shoes", "Brown leather boots"),
    ],
    available: true,
    savedOutfitId: null,
    wornToday: false,
    ...extra,
  }
}

function suggestion(extra: Partial<TodaySuggestionDto> = {}): TodaySuggestionDto {
  return {
    analysisId: ANALYSIS_ID,
    createdAt: "2026-11-03T07:10:00.000Z",
    profileId: uuid(999),
    date: "2026-11-03",
    weather: WEATHER,
    model: "claude-sonnet-5-5",
    costUsd: 0.04,
    itemCount: 17,
    droppedCount: 0,
    outfits: [outfit(0), outfit(1), outfit(2)],
    ...extra,
  }
}

function viewData(extra: Partial<TodayViewData> = {}): TodayViewData {
  return {
    place: { profileId: uuid(999), city: "Hamburg", country: "Germany" },
    today: "2026-11-03",
    weather: WEATHER,
    quote: { model: "claude-sonnet-5-5", estimateUsd: 0.052, itemCount: 17, droppedCount: 0, canSuggest: true },
    suggestion: null,
    ...extra,
  }
}

type Fakes = {
  [K in keyof TodayActions]: ReturnType<typeof vi.fn<TodayActions[K]>>
} & { suggest: ReturnType<typeof vi.fn<SuggestOutfits>> }

function fakes(): Fakes {
  return {
    saveSuggestedOutfit: vi.fn<TodayActions["saveSuggestedOutfit"]>(),
    logWear: vi.fn<TodayActions["logWear"]>(),
    undoWear: vi.fn<TodayActions["undoWear"]>(),
    suggest: vi.fn<SuggestOutfits>(),
  }
}

function view(data: TodayViewData, f: Fakes): ReactNode {
  return (
    <TodayView
      data={data}
      actions={{ saveSuggestedOutfit: f.saveSuggestedOutfit, logWear: f.logWear, undoWear: f.undoWear }}
      suggest={f.suggest}
    />
  )
}

/** A promise the test settles by hand, to look at the page while a request runs. */
function deferred<T>() {
  let settle: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    settle = done
  })
  return { promise, settle }
}

function cards() {
  return within(screen.getByRole("list", { name: "Suggested outfits" })).getAllByRole("article")
}

function card(title: string) {
  return screen.getByRole("article", { name: title })
}

describe("the weather", () => {
  it("shows the feels-like range, rain, gusts and the Open-Meteo credit", () => {
    render(view(viewData(), fakes()))
    const weather = screen.getByRole("region", { name: "Weather in Hamburg" })
    expect(weather.textContent).toContain("Light rain, 9 °C now")
    expect(weather.textContent).toContain("2 to 8 °C")
    expect(weather.textContent).toContain("6 to 11 °C")
    expect(weather.textContent).toContain("80 % chance of rain, 3.4 mm")
    expect(weather.textContent).toContain("Up to 53 km/h")
    expect(weather.textContent).toContain("Forecast from 14:20.")
    const credit = within(weather).getByRole("link", { name: "Weather data by Open-Meteo.com" })
    expect(credit.getAttribute("href")).toBe("https://open-meteo.com/")
  })
})

describe("Suggest outfits", () => {
  it("states the model and the estimated cost in the button's description", () => {
    render(view(viewData(), fakes()))
    const button = screen.getByRole("button", { name: "Suggest outfits" })
    const description = document.getElementById(button.getAttribute("aria-describedby") ?? "")
    expect(description?.textContent).toContain("17 items in Hamburg or of unknown location")
    expect(description?.textContent).toContain("Sonnet 5.5")
    expect(description?.textContent).toContain("About $0.05 from your AI budget")
  })

  it("asks once per press, shows the running status, then the three cards", async () => {
    const f = fakes()
    const answer = deferred<Result<TodaySuggestionDto>>()
    f.suggest.mockReturnValue(answer.promise)
    render(view(viewData(), f))

    const button = screen.getByRole("button", { name: "Suggest outfits" })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(f.suggest).toHaveBeenCalledTimes(1)
    expect(f.suggest).toHaveBeenCalledWith({})
    expect(screen.getByRole("status").textContent).toContain("Choosing three outfits for today")
    expect(button.getAttribute("aria-busy")).toBe("true")

    await act(async () => answer.settle(ok(suggestion())))

    expect(cards()).toHaveLength(3)
    expect(screen.getByRole("status").textContent).toBe("Three outfits for today are ready.")
    const again = screen.getByRole("button", { name: "Suggest again" })
    f.suggest.mockResolvedValue(ok(suggestion({ analysisId: uuid(500), createdAt: "2026-11-03T08:00:00.000Z" })))
    await act(async () => fireEvent.click(again))
    expect(f.suggest).toHaveBeenLastCalledWith({ force: true })
    expect(f.suggest).toHaveBeenCalledTimes(2)
  })

  it("never asks on its own, in StrictMode or when Next hides and shows the page", async () => {
    const f = fakes()
    const answer = deferred<Result<TodaySuggestionDto>>()
    f.suggest.mockReturnValue(answer.promise)
    const shell = (mode: "visible" | "hidden") => (
      <StrictMode>
        <Activity mode={mode}>{view(viewData(), f)}</Activity>
      </StrictMode>
    )
    const { rerender } = render(shell("visible"))
    rerender(shell("hidden"))
    rerender(shell("visible"))
    expect(f.suggest).not.toHaveBeenCalled()

    // A request that answers while the page is hidden still shows when it is shown again.
    fireEvent.click(screen.getByRole("button", { name: "Suggest outfits" }))
    rerender(shell("hidden"))
    await act(async () => answer.settle(ok(suggestion())))
    rerender(shell("visible"))

    expect(cards()).toHaveLength(3)
    expect(f.suggest).toHaveBeenCalledTimes(1)
  })

  it("shows a configuration error with the server's message and a hint", async () => {
    const f = fakes()
    f.suggest.mockResolvedValue(err("CONFIG", "The server is misconfigured. Check the server logs."))
    render(view(viewData(), f))

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Suggest outfits" })))

    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("Configuration problem")
    expect(alert.textContent).toContain("The server is misconfigured. Check the server logs.")
    expect(alert.textContent).toContain("once the server's AI settings are fixed")
    expect(screen.queryByRole("list", { name: "Suggested outfits" })).toBeNull()
  })

  it("turns a request that throws into the network error", async () => {
    const f = fakes()
    f.suggest.mockRejectedValue(new TypeError("Failed to fetch"))
    render(view(viewData(), f))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Suggest outfits" })))
    expect(screen.getByRole("alert").textContent).toContain("Could not reach the server")
  })

  it("explains, and offers no call, when the items cannot make three outfits", () => {
    const f = fakes()
    render(
      view(
        viewData({
          quote: { model: "claude-sonnet-5-5", estimateUsd: 0.03, itemCount: 2, droppedCount: 0, canSuggest: false },
        }),
        f
      )
    )
    const button = screen.getByRole("button", { name: "Suggest outfits" })
    expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(true)
    fireEvent.click(button)
    expect(f.suggest).not.toHaveBeenCalled()
    const description = document.getElementById(button.getAttribute("aria-describedby") ?? "")
    expect(description?.textContent).toContain("Three different outfits need more tagged items in Hamburg")
  })

  it("shows today's stored suggestion with Suggest again", () => {
    render(view(viewData({ suggestion: suggestion() }), fakes()))
    expect(cards()).toHaveLength(3)
    expect(screen.getByRole("button", { name: "Suggest again" })).toBeTruthy()
    expect(screen.getByText(/Chosen at 08:10 from 17 items, for a day that feels like 2 to 8 °C\./)).toBeTruthy()
    const first = card("Layered for drizzle")
    expect(first.textContent).toContain("Rain-ready")
    expect(within(first).getByRole("list", { name: "Items in Layered for drizzle" }).textContent).toContain(
      "Outerwear · Worn 2 times"
    )
    expect(card("Smart and dry").textContent).toContain("Not for rain")
  })
})

describe("Save", () => {
  it("saves once per press, then links to the outfit and moves focus there", async () => {
    const f = fakes()
    const answer = deferred<Result<SavedSuggestionDto>>()
    f.saveSuggestedOutfit.mockReturnValue(answer.promise)
    render(view(viewData({ suggestion: suggestion() }), f))

    const save = within(card("Smart and dry")).getByRole("button", { name: "Save Smart and dry" })
    save.focus()
    fireEvent.click(save)
    fireEvent.click(save)
    expect(f.saveSuggestedOutfit).toHaveBeenCalledTimes(1)
    expect(f.saveSuggestedOutfit).toHaveBeenCalledWith({ analysisId: ANALYSIS_ID, index: 1 })

    await act(async () =>
      answer.settle(ok({ analysisId: ANALYSIS_ID, index: 1, outfitId: uuid(700), alreadySaved: false }))
    )

    const link = within(card("Smart and dry")).getByRole("link", { name: "Open saved outfit Smart and dry" })
    expect(link.getAttribute("href")).toBe(`/outfits/${uuid(700)}`)
    expect(document.activeElement).toBe(link)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Outfit saved", type: "success" }))
  })

  it("toasts a refusal and reads the page again when an item changed since", async () => {
    const f = fakes()
    f.saveSuggestedOutfit.mockResolvedValue(err("CONFLICT", "An item of this outfit was deleted or archived since."))
    render(view(viewData({ suggestion: suggestion() }), f))

    await act(async () =>
      fireEvent.click(within(card("Light and quick")).getByRole("button", { name: "Save Light and quick" }))
    )

    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error", title: "Changed elsewhere" }))
    expect(router.refresh).toHaveBeenCalledTimes(1)
    expect(within(card("Light and quick")).getByRole("button", { name: "Save Light and quick" })).toBeTruthy()
  })
})

describe("Wore this today", () => {
  function logged(itemIds: string[], extra: Partial<WearLogResultDto> = {}): WearLogResultDto {
    return {
      wornOn: "2026-11-03",
      logIds: itemIds.map((_, index) => uuid(800 + index)),
      items: itemIds.map((id) => ({ id, wearCount: 3, lastWornAt: "2026-11-03T11:00:00.000Z" })),
      alreadyLogged: [],
      undoUntil: "2026-11-03T13:30:00.000Z",
      ...extra,
    }
  }

  it("logs the outfit's items with today's weather, then shows Worn today", async () => {
    const f = fakes()
    const data = viewData({ suggestion: suggestion() })
    const itemIds = data.suggestion?.outfits[0]?.items.map((entry) => entry.itemId) ?? []
    f.logWear.mockResolvedValue(ok(logged(itemIds)))
    render(view(data, f))

    await act(async () =>
      fireEvent.click(
        within(card("Layered for drizzle")).getByRole("button", { name: "Wore this today (Layered for drizzle)" })
      )
    )

    expect(f.logWear).toHaveBeenCalledWith({ kind: "items", itemIds, weather: WEATHER })
    const worn = within(card("Layered for drizzle")).getByRole("button", { name: "Worn today (Layered for drizzle)" })
    expect(worn.hasAttribute("disabled") || worn.getAttribute("aria-disabled") === "true").toBe(true)
    // The server's copy is read again so the counts follow.
    expect(router.refresh).toHaveBeenCalled()
  })

  it("logs a saved outfit as that outfit, and Undo in the toast takes it back", async () => {
    const f = fakes()
    const saved = uuid(701)
    const data = viewData({ suggestion: suggestion({ outfits: [outfit(0, { savedOutfitId: saved }), outfit(1), outfit(2)] }) })
    const itemIds = data.suggestion?.outfits[0]?.items.map((entry) => entry.itemId) ?? []
    f.logWear.mockResolvedValue(ok(logged(itemIds)))
    f.undoWear.mockResolvedValue(ok({ undone: [uuid(800)], items: [] }))
    render(view(data, f))

    await act(async () =>
      fireEvent.click(
        within(card("Layered for drizzle")).getByRole("button", { name: "Wore this today (Layered for drizzle)" })
      )
    )
    expect(f.logWear).toHaveBeenCalledWith({ kind: "outfit", outfitId: saved, weather: WEATHER })

    const loggedToast = toastAdd.mock.calls.find(([options]) => options.title === "Logged as worn")?.[0]
    const undo = loggedToast?.actionProps?.onClick
    if (undo === undefined) throw new Error("no Undo")
    router.refresh.mockClear()
    await act(async () => {
      undo({} as Parameters<typeof undo>[0])
    })
    expect(f.undoWear).toHaveBeenCalledWith({ logIds: itemIds.map((_, index) => uuid(800 + index)) })
    expect(router.refresh).toHaveBeenCalled()
  })

  it("reads the page shown once when Undo answers after /today was left", async () => {
    const f = fakes()
    const data = viewData({ suggestion: suggestion() })
    const itemIds = data.suggestion?.outfits[0]?.items.map((entry) => entry.itemId) ?? []
    f.logWear.mockResolvedValue(ok(logged(itemIds)))
    f.undoWear.mockResolvedValue(ok({ undone: [uuid(800)], items: [] }))
    const shell = (mode: "visible" | "hidden") => (
      <StrictMode>
        <Activity mode={mode}>{view(data, f)}</Activity>
      </StrictMode>
    )
    const { rerender } = render(shell("visible"))
    await act(async () =>
      fireEvent.click(
        within(card("Layered for drizzle")).getByRole("button", { name: "Wore this today (Layered for drizzle)" })
      )
    )
    const loggedToast = toastAdd.mock.calls.find(([options]) => options.title === "Logged as worn")?.[0]
    const undo = loggedToast?.actionProps?.onClick
    if (undo === undefined) throw new Error("no Undo")

    rerender(shell("hidden"))
    router.refresh.mockClear()
    await act(async () => {
      undo({} as Parameters<typeof undo>[0])
    })

    expect(f.undoWear).toHaveBeenCalledTimes(1)
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it("shows Worn today for an outfit already logged today", () => {
    render(view(viewData({ suggestion: suggestion({ outfits: [outfit(0, { wornToday: true }), outfit(1), outfit(2)] }) }), fakes()))
    expect(within(card("Layered for drizzle")).getByRole("button", { name: "Worn today (Layered for drizzle)" })).toBeTruthy()
  })
})

describe("an outfit with an item gone", () => {
  it("names the item's problem and offers neither Save nor Wore this today", () => {
    const f = fakes()
    const broken = outfit(2, {
      available: false,
      items: [
        item(31, "top", "Archived blazer", { status: "archived" }),
        item(32, "bottom", "No longer in your wardrobe", { exists: false, status: null, category: null }),
      ],
    })
    render(view(viewData({ suggestion: suggestion({ outfits: [outfit(0), outfit(1), broken] }) }), f))

    const gone = card("Light and quick")
    expect(gone.textContent).toContain("Archived")
    expect(gone.textContent).toContain("Deleted")
    expect(gone.textContent).toContain("can no longer be saved or logged")
    const save = within(gone).getByRole("button", { name: "Save Light and quick" })
    const wore = within(gone).getByRole("button", { name: "Wore this today (Light and quick)" })
    fireEvent.click(save)
    fireEvent.click(wore)
    expect(f.saveSuggestedOutfit).not.toHaveBeenCalled()
    expect(f.logWear).not.toHaveBeenCalled()
  })
})

describe("a suggestion for another home city or day", () => {
  const BOLOGNA_ID = uuid(998)
  const bologna = () => viewData({ place: { profileId: BOLOGNA_ID, city: "Bologna", country: "Italy" } })
  const shell = (data: TodayViewData, f: Fakes, mode: "visible" | "hidden") => (
    <StrictMode>
      <Activity mode={mode}>{view(data, f)}</Activity>
    </StrictMode>
  )

  it("is not shown when the home city changed while it ran", async () => {
    const f = fakes()
    const answer = deferred<Result<TodaySuggestionDto>>()
    f.suggest.mockReturnValueOnce(answer.promise)
    const { rerender } = render(shell(bologna(), f, "visible"))
    fireEvent.click(screen.getByRole("button", { name: "Suggest outfits" }))

    // Settings chose Hamburg meanwhile; /today is shown again with Hamburg's copy.
    rerender(shell(bologna(), f, "hidden"))
    rerender(shell(viewData(), f, "visible"))
    await act(async () => answer.settle(ok(suggestion({ profileId: BOLOGNA_ID, itemCount: 187 }))))

    expect(screen.getByRole("region", { name: "Weather in Hamburg" })).toBeTruthy()
    expect(screen.queryByRole("list", { name: "Suggested outfits" })).toBeNull()
    expect(screen.queryByText(/from 187 items/)).toBeNull()
    expect(screen.getByRole("status").textContent).toBe("")
    // Hamburg asks for its own outfits, free when it has a stored one.
    f.suggest.mockResolvedValue(ok(suggestion()))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Suggest outfits" })))
    expect(f.suggest).toHaveBeenLastCalledWith({})
    expect(cards()).toHaveLength(3)
  })

  it("is not shown over the new city's copy after a finished run", async () => {
    const f = fakes()
    f.suggest.mockResolvedValue(ok(suggestion({ profileId: BOLOGNA_ID })))
    const { rerender } = render(shell(bologna(), f, "visible"))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Suggest outfits" })))
    expect(cards()).toHaveLength(3)

    rerender(shell(bologna(), f, "hidden"))
    rerender(shell(viewData(), f, "visible"))

    expect(screen.queryByRole("list", { name: "Suggested outfits" })).toBeNull()
    expect(screen.getByRole("button", { name: "Suggest outfits" })).toBeTruthy()
  })

  it("never replaces the new city's own suggestion", async () => {
    const f = fakes()
    const answer = deferred<Result<TodaySuggestionDto>>()
    f.suggest.mockReturnValueOnce(answer.promise)
    const { rerender } = render(shell(bologna(), f, "visible"))
    fireEvent.click(screen.getByRole("button", { name: "Suggest outfits" }))
    const hamburgOwn = suggestion({ analysisId: uuid(600), createdAt: "2026-11-03T06:00:00.000Z" })
    rerender(shell(viewData({ suggestion: hamburgOwn }), f, "visible"))
    await act(async () =>
      answer.settle(ok(suggestion({ profileId: BOLOGNA_ID, analysisId: uuid(601), createdAt: "2026-11-03T09:00:00.000Z" })))
    )

    expect(cards()).toHaveLength(3)
    expect(screen.getByText(/Chosen at 07:00 from 17 items/)).toBeTruthy()
    f.saveSuggestedOutfit.mockResolvedValue(ok({ analysisId: uuid(600), index: 1, outfitId: uuid(700), alreadySaved: false }))
    await act(async () => fireEvent.click(within(card("Smart and dry")).getByRole("button", { name: "Save Smart and dry" })))
    expect(f.saveSuggestedOutfit).toHaveBeenCalledWith({ analysisId: uuid(600), index: 1 })
  })

  it("is not shown for another day", async () => {
    const f = fakes()
    f.suggest.mockResolvedValue(ok(suggestion({ date: "2026-11-03" })))
    render(view(viewData({ today: "2026-11-04" }), f))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Suggest outfits" })))
    expect(screen.queryByRole("list", { name: "Suggested outfits" })).toBeNull()
  })
})
