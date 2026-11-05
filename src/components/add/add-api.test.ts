import { describe, expect, it, vi } from "vitest"

import { CONFIG_ERROR_MESSAGE } from "@/lib/result"

import { NETWORK_ERROR_MESSAGE, createAddApi, type FetchLike, type PutBlobLike } from "./add-api"
import { cardFor, fakeHash } from "./test-fixtures"

const ITEM_ID = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b"
const SOURCE_HASH = fakeHash("photo")
const BLOB_URL = `https://store.public.blob.vercel-storage.com/items/${ITEM_ID}/original-x1y2z3.jpg`

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function setup(responses: Array<Response | Error>, put?: PutBlobLike) {
  const fetch = vi.fn<FetchLike>(async () => {
    const next = responses.shift()
    if (next === undefined) throw new Error("unexpected fetch")
    if (next instanceof Error) throw next
    return next
  })
  const putBlob = vi.fn<PutBlobLike>(
    put ?? (async () => ({ url: BLOB_URL, pathname: `items/${ITEM_ID}/original-x1y2z3.jpg` })),
  )
  return { fetch, putBlob, api: createAddApi({ fetch, putBlob }) }
}

function requestBody(fetch: ReturnType<typeof setup>["fetch"], call = 0): unknown {
  const init = fetch.mock.calls[call]?.[1]
  return JSON.parse(String(init?.body))
}

describe("route calls", () => {
  it("posts the hashes as JSON and parses the Result", async () => {
    const { fetch, api } = setup([json({ ok: true, data: { known: { [SOURCE_HASH]: ITEM_ID } } })])

    const result = await api.checkHashes([SOURCE_HASH])

    expect(result).toEqual({ ok: true, data: { known: { [SOURCE_HASH]: ITEM_ID } } })
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/items/check-hashes")
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } })
    expect(requestBody(fetch)).toEqual({ sourceHashes: [SOURCE_HASH] })
  })

  it("passes a route's error Result through", async () => {
    const { api } = setup([json({ ok: false, error: { code: "UNAUTHENTICATED", message: "Signed out." } }, 401)])
    expect(await api.checkHashes([SOURCE_HASH])).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Signed out." },
    })
  })

  it("reports a network failure", async () => {
    const { api } = setup([new TypeError("Failed to fetch")])
    expect(await api.register(registerBody())).toEqual({
      ok: false,
      error: { code: "UPSTREAM", message: NETWORK_ERROR_MESSAGE },
    })
  })

  it("reports a response that is not JSON or not a Result", async () => {
    const { api } = setup([
      new Response("<html>Gateway Timeout</html>", { status: 504 }),
      json({ unexpected: true }),
    ])
    expect(await api.tagItem(ITEM_ID, { force: false })).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM", message: expect.stringContaining("HTTP 504") },
    })
    expect(await api.tagItem(ITEM_ID, { force: false })).toMatchObject({ ok: false, error: { code: "UPSTREAM" } })
  })

  it("posts register and tag to their routes and parses their data", async () => {
    const item = cardFor(ITEM_ID)
    const { fetch, api } = setup([
      json({ ok: true, data: { duplicate: false, item } }),
      json({ ok: true, data: { cached: true, item } }),
    ])

    expect(await api.register(registerBody())).toEqual({ ok: true, data: { duplicate: false, item } })
    expect(await api.tagItem(ITEM_ID, { force: false })).toEqual({ ok: true, data: { cached: true, item } })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/items/register", `/api/items/${ITEM_ID}/tag`])
    expect(requestBody(fetch, 1)).toEqual({ force: false })
  })

  it("reads the tagging setup again through the injected fetch", async () => {
    const taggingSetup = {
      model: { id: "claude-haiku-5-5", label: "Haiku 5.5" },
      costQuote: {
        standard: { firstItemUsd: 0.002, nextItemUsd: 0.001 },
        batch: { firstItemUsd: 0.001, nextItemUsd: 0.0005 },
        dryRunUsd: 0.0025,
      },
      budget: { budgetUsd: 20, remainingUsd: 9.5, resetsAt: "2026-12-01T00:00:00.000Z" },
    }
    const { fetch, api } = setup([json({ ok: true, data: taggingSetup })])

    expect(await api.taggingSetup()).toEqual({ ok: true, data: taggingSetup })
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/ai/tagging-setup")
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" })
  })
})

function registerBody() {
  return {
    itemId: ITEM_ID,
    url: BLOB_URL,
    pathname: `items/${ITEM_ID}/original-x1y2z3.jpg`,
    sourceHash: SOURCE_HASH,
    originalFilename: "IMG_0001.HEIC",
    collection: "clothing" as const,
  }
}

describe("uploadOriginal", () => {
  const blob = new Blob(["jpeg bytes"], { type: "image/jpeg" })

  it("asks the upload route for a token with the contract's pathname and payload, then puts the blob", async () => {
    const progress: number[] = []
    const { fetch, putBlob, api } = setup(
      [json({ type: "blob.generate-client-token", clientToken: "vercel_blob_client_fake" })],
      async (_pathname, _body, options) => {
        options.onUploadProgress?.({ loaded: 1, total: 3, percentage: 33.4 })
        options.onUploadProgress?.({ loaded: 3, total: 3, percentage: 100 })
        return { url: BLOB_URL, pathname: `items/${ITEM_ID}/original-x1y2z3.jpg` }
      },
    )

    const result = await api.uploadOriginal({
      itemId: ITEM_ID,
      sourceHash: SOURCE_HASH,
      blob,
      onProgress: (percent) => progress.push(percent),
    })

    expect(result).toEqual({ ok: true, data: { url: BLOB_URL, pathname: `items/${ITEM_ID}/original-x1y2z3.jpg` } })
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/blob/upload")
    expect(requestBody(fetch)).toEqual({
      type: "blob.generate-client-token",
      payload: {
        pathname: `items/${ITEM_ID}/original.jpg`,
        clientPayload: JSON.stringify({ kind: "original", itemId: ITEM_ID, sourceHash: SOURCE_HASH }),
        multipart: false,
      },
    })
    expect(putBlob).toHaveBeenCalledWith(
      `items/${ITEM_ID}/original.jpg`,
      blob,
      expect.objectContaining({ access: "public", token: "vercel_blob_client_fake", contentType: "image/jpeg" }),
    )
    expect(progress).toEqual([33, 100])
  })

  it("drops a progress event that arrives after the upload finished", async () => {
    const progress: number[] = []
    let late = () => {}
    const { api } = setup(
      [json({ type: "blob.generate-client-token", clientToken: "vercel_blob_client_fake" })],
      async (_pathname, _body, options) => {
        options.onUploadProgress?.({ loaded: 3, total: 3, percentage: 100 })
        // put() throttles progress and delivers its trailing call later.
        late = () => options.onUploadProgress?.({ loaded: 3, total: 3, percentage: 100 })
        return { url: BLOB_URL, pathname: `items/${ITEM_ID}/original-x1y2z3.jpg` }
      },
    )

    await api.uploadOriginal({ itemId: ITEM_ID, sourceHash: SOURCE_HASH, blob, onProgress: (p) => progress.push(p) })
    late()

    expect(progress).toEqual([100])
  })

  it("returns the route's error, such as CONFIG without a Blob token, and uploads nothing", async () => {
    const { putBlob, api } = setup([json({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } }, 500)])

    const result = await api.uploadOriginal({ itemId: ITEM_ID, sourceHash: SOURCE_HASH, blob })

    expect(result).toEqual({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } })
    expect(putBlob).not.toHaveBeenCalled()
  })

  it("keeps the details of a DUPLICATE refusal", async () => {
    const { api } = setup([
      json(
        {
          ok: false,
          error: { code: "DUPLICATE", message: "Already there.", details: { existingItemId: "item-1" } },
        },
        409,
      ),
    ])
    expect(await api.uploadOriginal({ itemId: ITEM_ID, sourceHash: SOURCE_HASH, blob })).toEqual({
      ok: false,
      error: { code: "DUPLICATE", message: "Already there.", details: { existingItemId: "item-1" } },
    })
  })

  it("rejects a success answer without a client token", async () => {
    const { putBlob, api } = setup([json({ type: "blob.generate-client-token" })])
    expect(await api.uploadOriginal({ itemId: ITEM_ID, sourceHash: SOURCE_HASH, blob })).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM" },
    })
    expect(putBlob).not.toHaveBeenCalled()
  })

  it("reports a failed put without the SDK's prefix", async () => {
    const { api } = setup([json({ type: "blob.generate-client-token", clientToken: "vercel_blob_client_fake" })], async () => {
      throw new Error("Vercel Blob: File is too large.")
    })
    expect(await api.uploadOriginal({ itemId: ITEM_ID, sourceHash: SOURCE_HASH, blob })).toEqual({
      ok: false,
      error: { code: "UPSTREAM", message: "Upload to storage failed: File is too large." },
    })
  })
})
