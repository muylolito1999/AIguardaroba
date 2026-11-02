import { describe, expect, it, vi } from "vitest"

import { requestTagging } from "./tag-request"
import { taggedCard } from "./test-fixtures"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

describe("requestTagging", () => {
  it("POSTs force to the item's tag route and returns the parsed result", async () => {
    const item = taggedCard()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: { cached: false, item } }))

    const result = await requestTagging(item.id, { force: true, fetchImpl })

    expect(result).toEqual({ ok: true, data: { cached: false, item } })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(`/api/items/${item.id}/tag`)
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({ force: true })
  })

  it("defaults force to false", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: { cached: true, item: taggedCard() } }))
    await requestTagging("id", { fetchImpl })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ force: false })
  })

  it("sends the batch the card shows only when one is given", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true, data: { cached: true, item: taggedCard() } }))
    const batchId = "11111111-1111-4111-8111-111111111111"

    await requestTagging("id", { force: true, batchId, fetchImpl })
    await requestTagging("id", { force: true, batchId: undefined, fetchImpl })

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ force: true, batchId })
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({ force: true })
  })

  it("passes a route's error through", async () => {
    const error = { code: "BUDGET_EXCEEDED", message: "The monthly AI budget of $20.00 is used up." }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: false, error }, 402))

    expect(await requestTagging("id", { fetchImpl })).toEqual({ ok: false, error })
  })

  it("reports a network failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"))

    const result = await requestTagging("id", { fetchImpl })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM", message: expect.stringContaining("connection") },
    })
  })

  it("reports a response that is not a Result", async () => {
    const html = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("<html>Gateway timeout</html>", { status: 504 }))
    const wrongShape = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ hello: "world" }))

    expect(await requestTagging("id", { fetchImpl: html })).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM", message: expect.stringContaining("HTTP 504") },
    })
    expect(await requestTagging("id", { fetchImpl: wrongShape })).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM" },
    })
  })
})
