import { describe, expect, it, vi } from "vitest"

import type { FetchLike } from "@/lib/images/blob-upload-client"

import { postSuggestOutfits, SUGGEST_OUTFITS_URL } from "./suggest-api"
import type { TodaySuggestionDto } from "./today-model"

const SUGGESTION: TodaySuggestionDto = {
  analysisId: "7a0c3f4e-2b1d-4c5e-8f9a-0b1c2d3e4f50",
  createdAt: "2026-11-03T07:10:00.000Z",
  profileId: "00000000-0000-4000-8000-000000000999",
  date: "2026-11-03",
  weather: {
    date: "2026-11-03",
    timezone: "Europe/Berlin",
    currentC: null,
    tminC: 5.9,
    tmaxC: 10.8,
    apparentMinC: 2.1,
    apparentMaxC: 7.6,
    precipSumMm: 3.4,
    precipProbMax: null,
    windGustMaxKmh: 52.9,
    weatherCode: 61,
    label: "Light rain",
    fetchedAt: "2026-11-03T06:00:00.000Z",
  },
  model: "claude-sonnet-5-5",
  costUsd: 0.04,
  itemCount: 17,
  droppedCount: 0,
  outfits: [
    {
      index: 0,
      title: "Layered for drizzle",
      why: "Feels like 2 to 8 °C.",
      rainOk: true,
      items: [
        {
          itemId: "00000000-0000-4000-8000-000000000001",
          slot: "top",
          name: "Sweater",
          category: "top",
          thumbUrl: null,
          status: "confirmed",
          wearCount: 0,
          exists: true,
        },
      ],
      available: true,
      savedOutfitId: null,
      wornToday: false,
    },
  ],
}

function answering(status: number, body: unknown) {
  return vi.fn<FetchLike>().mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

describe("postSuggestOutfits", () => {
  it("posts {} or { force: true } as JSON to the route", async () => {
    const fetchImpl = answering(200, { ok: true, data: SUGGESTION })
    await postSuggestOutfits({}, fetchImpl)
    await postSuggestOutfits({ force: true }, fetchImpl)

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [SUGGEST_OUTFITS_URL, "POST", "{}"],
      [SUGGEST_OUTFITS_URL, "POST", JSON.stringify({ force: true })],
    ])
  })

  it("answers the checked suggestion", async () => {
    const result = await postSuggestOutfits({}, answering(200, { ok: true, data: SUGGESTION }))
    expect(result).toEqual({ ok: true, data: SUGGESTION })
  })

  it("passes the server's error on", async () => {
    const error = { code: "BUDGET_EXCEEDED", message: "The monthly AI budget of $20.00 is used up." }
    expect(await postSuggestOutfits({}, answering(402, { ok: false, error }))).toEqual({ ok: false, error })
  })

  it("turns an answer of another shape into UPSTREAM", async () => {
    const result = await postSuggestOutfits({}, answering(200, { ok: true, data: { outfits: "none" } }))
    expect(result).toMatchObject({ ok: false, error: { code: "UPSTREAM", message: expect.stringContaining("HTTP 200") } })
  })

  it("turns a page that is not JSON (a platform timeout) into UPSTREAM", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(new Response("<html>504</html>", { status: 504 }))
    expect(await postSuggestOutfits({}, fetchImpl)).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM", message: expect.stringContaining("HTTP 504") },
    })
  })

  it("turns a network failure into the network error", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new TypeError("Failed to fetch"))
    expect(await postSuggestOutfits({}, fetchImpl)).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM", message: "Could not reach the server. Check your connection." },
    })
  })
})
