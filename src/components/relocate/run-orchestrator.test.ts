import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { RelocationPartDto, RelocationRunDto } from "@/lib/relocation/contracts"
import { err, ok, type Result } from "@/lib/result"

import {
  CONFLICT_RETRY_MS,
  STILL_RUNNING_ELSEWHERE,
  createRunOrchestrator,
  summarizeRun,
  type RunOrchestrator,
  type RunOrchestratorDeps,
} from "./run-orchestrator"

// A fake server: it keeps every part's status, records each post, and lets
// the test answer posts one by one, in any order.

const ANALYSIS_ID = "00000000-0000-4000-8000-0000000000a1"

function makeRun(chunks: number, overrides: Partial<Record<string, Partial<RelocationPartDto>>> = {}): RelocationRunDto {
  const parts: RelocationPartDto[] = [
    ...Array.from({ length: chunks }, (_, index) => ({
      id: `chunk-${index}`,
      kind: "chunk" as const,
      partIndex: index,
      status: "pending" as const,
      itemCount: 60,
      costUsd: 0,
      attempts: 0,
      error: null,
    })),
    {
      id: "synthesis",
      kind: "synthesis",
      partIndex: 0,
      status: "pending",
      itemCount: chunks * 60,
      costUsd: 0,
      attempts: 0,
      error: null,
    },
  ]
  return {
    analysisId: ANALYSIS_ID,
    status: "running",
    parts: parts.map((part) => ({ ...part, ...overrides[part.id] })),
    estimatedCostUsd: 0.55,
    costUsd: 0,
  }
}

type Post = { partId: string; answer: (result: Result<RelocationRunDto>) => Promise<void> }

function fakeServer(initial: RelocationRunDto) {
  let run = initial
  const posts: Post[] = []
  const postPart = vi.fn<RunOrchestratorDeps["postPart"]>((_analysisId, partId) => {
    return new Promise<Result<RelocationRunDto>>((resolve) => {
      posts.push({
        partId,
        answer: async (result) => {
          resolve(result)
          // Let the orchestrator handle the answer and queue what comes next.
          await flush()
        },
      })
    })
  })

  /** Marks a part complete on the server and answers its oldest open post with the run. */
  async function complete(partId: string, costUsd = 0.05): Promise<void> {
    run = {
      ...run,
      costUsd: run.costUsd + costUsd,
      parts: run.parts.map((part) => (part.id === partId ? { ...part, status: "complete", costUsd, attempts: 1 } : part)),
    }
    if (run.parts.every((part) => part.status === "complete")) run = { ...run, status: "complete" }
    await answer(partId, ok(run))
  }

  async function answer(partId: string, result: Result<RelocationRunDto>): Promise<void> {
    const index = posts.findIndex((post) => post.partId === partId)
    const post = posts[index]
    if (post === undefined) throw new Error(`No open post for ${partId}`)
    posts.splice(index, 1)
    await post.answer(result)
  }

  return {
    postPart,
    posts,
    complete,
    answer,
    current: () => run,
    open: () => posts.map((post) => post.partId),
  }
}

/** Runs queued microtasks: p-limit starts tasks a tick after they are queued. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

let orchestrators: RunOrchestrator[] = []

function start(run: RelocationRunDto, server: ReturnType<typeof fakeServer>, onAnswer = vi.fn()) {
  const orchestrator = createRunOrchestrator(run, { postPart: server.postPart, onAnswer })
  orchestrators.push(orchestrator)
  return orchestrator
}

beforeEach(() => {
  vi.useFakeTimers()
  orchestrators = []
})

afterEach(() => {
  orchestrators.forEach((orchestrator) => orchestrator.pause())
  vi.useRealTimers()
})

describe("createRunOrchestrator", () => {
  it("runs at most four chunks at once, then the synthesis once every chunk is done", async () => {
    const run = makeRun(6)
    const server = fakeServer(run)
    const onAnswer = vi.fn()
    const orchestrator = start(run, server, onAnswer)

    orchestrator.resume()
    await flush()
    expect(server.open()).toEqual(["chunk-0", "chunk-1", "chunk-2", "chunk-3"])
    expect(orchestrator.getState().parts.filter((part) => part.phase === "queued").map((part) => part.id)).toEqual([
      "chunk-4",
      "chunk-5",
    ])

    await server.complete("chunk-1")
    await flush()
    expect(server.open()).toEqual(["chunk-0", "chunk-2", "chunk-3", "chunk-4"])

    for (const id of ["chunk-0", "chunk-2", "chunk-3", "chunk-4"]) await server.complete(id)
    await flush()
    // The synthesis waits for the last chunk.
    expect(server.open()).toEqual(["chunk-5"])

    await server.complete("chunk-5")
    await flush()
    expect(server.open()).toEqual(["synthesis"])

    await server.complete("synthesis", 0.1)
    expect(orchestrator.getState().status).toBe("complete")
    expect(orchestrator.getState().costUsd).toBeCloseTo(0.4)
    expect(server.postPart).toHaveBeenCalledTimes(7)
    expect(new Set(server.postPart.mock.calls.map(([, partId]) => partId)).size).toBe(7)
    expect(onAnswer).toHaveBeenCalledTimes(7)
  })

  it("resumes a run: running parts are asked for, failed ones wait for Retry, complete ones are skipped", async () => {
    const run = makeRun(3, {
      "chunk-0": { status: "complete", costUsd: 0.05 },
      "chunk-1": { status: "running" },
      "chunk-2": { status: "failed", error: "Claude timed out." },
    })
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    expect(server.open()).toEqual(["chunk-1"])

    await server.complete("chunk-1")
    await flush()
    expect(server.open()).toEqual([])
    expect(orchestrator.getState().parts.find((part) => part.id === "chunk-2")?.error).toBe("Claude timed out.")

    orchestrator.retry("chunk-2")
    await flush()
    expect(server.open()).toEqual(["chunk-2"])
    await server.complete("chunk-2")
    await flush()
    expect(server.open()).toEqual(["synthesis"])
    // Only the owner's Retry asks the server to run a failed part again.
    expect(server.postPart.mock.calls.map(([, partId, options]) => [partId, options.retry])).toEqual([
      ["chunk-1", false],
      ["chunk-2", true],
      ["synthesis", false],
    ])
  })

  it("waits and asks again after CONFLICT, showing the part as running elsewhere", async () => {
    const run = makeRun(1)
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    await server.answer("chunk-0", err("CONFLICT", "This part is already running."))
    expect(orchestrator.getState().parts[0]?.phase).toBe("waiting")
    expect(summarizeRun(orchestrator.getState()).waitingElsewhere).toBe(1)
    expect(server.open()).toEqual([])

    await vi.advanceTimersByTimeAsync(CONFLICT_RETRY_MS - 1)
    expect(server.open()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(server.open()).toEqual(["chunk-0"])

    await server.complete("chunk-0")
    await flush()
    expect(server.open()).toEqual(["synthesis"])
  })

  it("treats an answer that leaves the part running like CONFLICT instead of asking again at once", async () => {
    const run = makeRun(1)
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    const stillRunning = { ...run, parts: run.parts.map((part) => (part.id === "chunk-0" ? { ...part, status: "running" as const } : part)) }
    await server.answer("chunk-0", ok(stillRunning))
    await flush()
    expect(server.open()).toEqual([])
    expect(orchestrator.getState().parts[0]?.phase).toBe("waiting")

    await vi.advanceTimersByTimeAsync(CONFLICT_RETRY_MS)
    await flush()
    expect(server.open()).toEqual(["chunk-0"])
  })

  it("gives up after the bounded number of CONFLICT waits and marks the part failed", async () => {
    const run = makeRun(1)
    const server = fakeServer(run)
    const orchestrator = createRunOrchestrator(run, { postPart: server.postPart, maxConflictWaits: 2 })
    orchestrators.push(orchestrator)

    orchestrator.resume()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await flush()
      await server.answer("chunk-0", err("CONFLICT", "This part is already running."))
      await vi.advanceTimersByTimeAsync(CONFLICT_RETRY_MS)
    }
    await flush()
    expect(server.postPart).toHaveBeenCalledTimes(3)
    const part = orchestrator.getState().parts[0]
    expect(part?.status).toBe("failed")
    expect(part?.error).toBe(STILL_RUNNING_ELSEWHERE)
    expect(server.open()).toEqual([])
  })

  it("stops starting parts after CONFIG, keeps applying answers already on the way, and continues on retryAll", async () => {
    const run = makeRun(6)
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    await server.answer("chunk-0", err("CONFIG", "The server is misconfigured. Check the server logs."))
    await flush()
    expect(orchestrator.getState().stopped?.code).toBe("CONFIG")
    // Not marked failed: nothing ran.
    expect(orchestrator.getState().parts[0]?.status).toBe("pending")

    await server.complete("chunk-1")
    await flush()
    expect(orchestrator.getState().parts[1]?.status).toBe("complete")
    // The queued chunks 4 and 5 never went out.
    expect(server.open()).toEqual(["chunk-2", "chunk-3"])
    expect(server.postPart).toHaveBeenCalledTimes(4)

    orchestrator.retryAll()
    await flush()
    expect(orchestrator.getState().stopped).toBeNull()
    expect(server.open()).toEqual(["chunk-2", "chunk-3", "chunk-0", "chunk-4"])
  })

  it("marks a part failed on other errors and never restarts it on its own", async () => {
    const run = makeRun(2)
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    await server.answer("chunk-0", err("AI_INVALID_OUTPUT", "Claude's answer did not match the expected shape."))
    await server.complete("chunk-1")
    await flush()
    expect(orchestrator.getState().parts[0]).toMatchObject({ status: "failed", error: "Claude's answer did not match the expected shape." })
    expect(server.open()).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.postPart).toHaveBeenCalledTimes(2)
  })

  it("starts nothing new while paused, applies answers that arrive, and continues on resume", async () => {
    const run = makeRun(6)
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    orchestrator.pause()
    for (const id of ["chunk-0", "chunk-1", "chunk-2", "chunk-3"]) await server.complete(id)
    await flush()
    expect(server.postPart).toHaveBeenCalledTimes(4)
    expect(orchestrator.getState().parts.slice(0, 4).every((part) => part.status === "complete")).toBe(true)
    expect(orchestrator.getState().parts.slice(4, 6).every((part) => part.phase === "idle")).toBe(true)

    orchestrator.resume()
    await flush()
    expect(server.open()).toEqual(["chunk-4", "chunk-5"])
  })

  it("asks for nothing twice when resumed, paused and resumed at once (StrictMode effects)", async () => {
    const run = makeRun(6)
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    orchestrator.pause()
    orchestrator.resume()
    await flush()
    expect(server.open()).toEqual(["chunk-0", "chunk-1", "chunk-2", "chunk-3"])

    orchestrator.pause()
    orchestrator.resume()
    await flush()
    expect(server.postPart).toHaveBeenCalledTimes(4)
  })

  it("drops a CONFLICT wait when paused and asks again at once when resumed", async () => {
    const run = makeRun(1)
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    await server.answer("chunk-0", err("CONFLICT", "This part is already running."))
    orchestrator.pause()
    await vi.advanceTimersByTimeAsync(CONFLICT_RETRY_MS * 2)
    expect(server.open()).toEqual([])

    orchestrator.resume()
    await flush()
    expect(server.open()).toEqual(["chunk-0"])
  })

  it("shows a part that failed elsewhere while this tab waited on it as failed, and never asks for it again", async () => {
    const run = makeRun(2)
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    await server.answer("chunk-0", err("CONFLICT", "This part is already running."))
    expect(orchestrator.getState().parts[0]?.phase).toBe("waiting")
    // chunk-1's answer reports that the other tab's run of chunk-0 failed.
    const failedElsewhere = {
      ...server.current(),
      parts: server
        .current()
        .parts.map((part) =>
          part.id === "chunk-0"
            ? { ...part, status: "failed" as const, error: "Claude took too long to answer." }
            : part.id === "chunk-1"
              ? { ...part, status: "complete" as const }
              : part
        ),
    }
    await server.answer("chunk-1", ok(failedElsewhere))
    await flush()
    expect(orchestrator.getState().parts[0]).toMatchObject({
      status: "failed",
      phase: "idle",
      error: "Claude took too long to answer.",
    })

    await vi.advanceTimersByTimeAsync(CONFLICT_RETRY_MS * 3)
    await flush()
    expect(server.postPart).toHaveBeenCalledTimes(2)
    expect(server.open()).toEqual([])

    orchestrator.retry("chunk-0")
    await flush()
    expect(server.postPart).toHaveBeenLastCalledWith(ANALYSIS_ID, "chunk-0", { retry: true })
  })

  it("takes a failure the server reports while paused, and does not ask for that part on resume", async () => {
    const run = makeRun(2, { "chunk-0": { status: "running" } })
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    orchestrator.pause()
    await server.answer("chunk-0", err("CONFLICT", "This part is already running."))
    const failed = {
      ...server.current(),
      parts: server.current().parts.map((part) => (part.id === "chunk-0" ? { ...part, status: "failed" as const } : part)),
    }
    // The page was rendered again by the server while hidden.
    orchestrator.absorb(failed)
    orchestrator.resume()
    await flush()
    expect(orchestrator.getState().parts[0]?.status).toBe("failed")
    expect(server.postPart.mock.calls.map(([, partId]) => partId)).toEqual(["chunk-0", "chunk-1"])
  })

  it("flags only the parts that failed when Try again follows a stop", async () => {
    const run = makeRun(3, { "chunk-2": { status: "failed", error: "Claude took too long to answer." } })
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    await server.answer("chunk-0", err("CONFIG", "The server is misconfigured. Check the server logs."))
    await server.complete("chunk-1")
    await flush()
    orchestrator.retryAll()
    await flush()
    expect(server.postPart.mock.calls.slice(2).map(([, partId, options]) => [partId, options.retry])).toEqual([
      ["chunk-0", false],
      ["chunk-2", true],
    ])
  })

  it("keeps a Retry that a stop answered before anything ran, so Try again still runs the part", async () => {
    const run = makeRun(1, { "chunk-0": { status: "failed", error: "Claude took too long to answer." } })
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    expect(server.open()).toEqual([])
    orchestrator.retry("chunk-0")
    await flush()
    await server.answer("chunk-0", err("CONFIG", "The server is misconfigured. Check the server logs."))
    expect(orchestrator.getState().stopped?.code).toBe("CONFIG")

    orchestrator.retryAll()
    await flush()
    expect(server.postPart.mock.calls.map(([, partId, options]) => [partId, options.retry])).toEqual([
      ["chunk-0", true],
      ["chunk-0", true],
    ])
  })

  it("never lets an older answer undo a part this tab knows is complete", async () => {
    const run = makeRun(2)
    const server = fakeServer(run)
    const orchestrator = start(run, server)

    orchestrator.resume()
    await flush()
    // chunk-1's answer was read before chunk-0 finished, but arrives after it.
    const older = server.current()
    await server.complete("chunk-0")
    await server.answer("chunk-1", ok({ ...older, parts: older.parts.map((part) => (part.id === "chunk-1" ? { ...part, status: "complete" as const } : part)) }))
    await flush()
    expect(orchestrator.getState().parts.map((part) => part.status)).toEqual(["complete", "complete", "pending"])
    expect(server.open()).toEqual(["synthesis"])
  })
})
