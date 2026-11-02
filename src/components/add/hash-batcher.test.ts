import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CheckHashesData } from "@/lib/items/contracts"
import { err, ok, type Result } from "@/lib/result"

import { createHashBatcher } from "./hash-batcher"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function checkReturning(result: Result<CheckHashesData>) {
  return vi.fn(async (hashes: string[]) => {
    void hashes
    return result
  })
}

describe("createHashBatcher", () => {
  it("sends lookups made within the window as one request and answers each", async () => {
    const check = checkReturning(ok({ known: { b: "item-b" } }))
    const batcher = createHashBatcher(check, { windowMs: 50 })

    const a = batcher.lookup("a")
    const b = batcher.lookup("b")
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)

    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith(["a", "b"])
    await expect(a).resolves.toEqual({ ok: true, data: null })
    await expect(b).resolves.toEqual({ ok: true, data: "item-b" })
  })

  it("asks once for a hash looked up twice", async () => {
    const check = checkReturning(ok({ known: {} }))
    const batcher = createHashBatcher(check, { windowMs: 10 })

    const first = batcher.lookup("same")
    const second = batcher.lookup("same")
    await vi.advanceTimersByTimeAsync(10)

    expect(check).toHaveBeenCalledWith(["same"])
    await expect(first).resolves.toEqual({ ok: true, data: null })
    await expect(second).resolves.toEqual({ ok: true, data: null })
  })

  it("starts a new request for lookups after a flush", async () => {
    const check = checkReturning(ok({ known: {} }))
    const batcher = createHashBatcher(check, { windowMs: 10 })

    const first = batcher.lookup("a")
    await vi.advanceTimersByTimeAsync(10)
    const second = batcher.lookup("b")
    await vi.advanceTimersByTimeAsync(10)
    await Promise.all([first, second])

    expect(check.mock.calls).toEqual([[["a"]], [["b"]]])
  })

  it("splits more hashes than the route accepts into several requests", async () => {
    const check = checkReturning(ok({ known: {} }))
    const batcher = createHashBatcher(check, { windowMs: 10, maxBatch: 2 })

    const lookups = ["a", "b", "c", "d", "e"].map((hash) => batcher.lookup(hash))
    await vi.advanceTimersByTimeAsync(10)
    await Promise.all(lookups)

    expect(check.mock.calls).toEqual([[["a", "b"]], [["c", "d"]], [["e"]]])
  })

  it("passes a failed request's error to every lookup in it", async () => {
    const failure = err("UNAUTHENTICATED", "Your session has ended. Sign in again.")
    const batcher = createHashBatcher(checkReturning(failure), { windowMs: 10 })

    const lookups = [batcher.lookup("a"), batcher.lookup("b")]
    await vi.advanceTimersByTimeAsync(10)

    for (const lookup of await Promise.all(lookups)) expect(lookup).toEqual(failure)
  })

  it("settles every lookup with an error when the check throws", async () => {
    const batcher = createHashBatcher(
      vi.fn(async () => {
        throw new Error("boom")
      }),
      { windowMs: 10 },
    )

    const lookup = batcher.lookup("a")
    await vi.advanceTimersByTimeAsync(10)

    await expect(lookup).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL" } })
  })
})
