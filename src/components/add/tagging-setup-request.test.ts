import { describe, expect, it, vi } from "vitest"

import { CONFIG_ERROR_MESSAGE } from "@/lib/result"

import { NETWORK_ERROR_MESSAGE } from "./add-api"
import type { TaggingSetup } from "./cost-quote"
import { TAGGING_SETUP_API, requestTaggingSetup } from "./tagging-setup-request"

const SETUP: TaggingSetup = {
  model: { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  costQuote: {
    standard: { firstItemUsd: 0.002, nextItemUsd: 0.001 },
    batch: { firstItemUsd: 0.001, nextItemUsd: 0.0005 },
    dryRunUsd: 0.0025,
  },
  budget: { budgetUsd: 20, remainingUsd: 11.75, resetsAt: "2026-12-01T00:00:00.000Z" },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

describe("requestTaggingSetup", () => {
  it("GETs the setup route and returns the parsed setup", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, data: SETUP }))

    expect(await requestTaggingSetup({ fetchImpl })).toEqual({ ok: true, data: SETUP })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(TAGGING_SETUP_API)
    expect(init).toMatchObject({ method: "GET", cache: "no-store" })
  })

  it("passes the route's own error through, such as CONFIG", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } }, 500))

    expect(await requestTaggingSetup({ fetchImpl })).toEqual({
      ok: false,
      error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE },
    })
  })

  it("reports a network failure without throwing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"))

    expect(await requestTaggingSetup({ fetchImpl })).toEqual({
      ok: false,
      error: { code: "UPSTREAM", message: NETWORK_ERROR_MESSAGE },
    })
  })

  it("reports an answer that is not JSON, or not a setup, with its status", async () => {
    const html = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>Gateway Timeout</html>", { status: 504 }))
    expect(await requestTaggingSetup({ fetchImpl: html })).toEqual({
      ok: false,
      error: { code: "UPSTREAM", message: "The server answered with an unexpected response (HTTP 504). Try again." },
    })

    const wrongShape = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: { ...SETUP, budget: { remainingUsd: "lots" } } }))
    expect(await requestTaggingSetup({ fetchImpl: wrongShape })).toEqual({
      ok: false,
      error: { code: "UPSTREAM", message: "The server answered with an unexpected response (HTTP 200). Try again." },
    })
  })
})
