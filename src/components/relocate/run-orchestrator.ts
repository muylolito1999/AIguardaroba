// The browser side of a relocation run (D-025): it posts each chunk part, at
// most four at a time, then the synthesis part once every chunk is complete.
// Plain TypeScript with no React, so the rules can be tested with fake
// timers; RunProgress subscribes with useSyncExternalStore.
//
// Resumable by design: the server holds every part's status, and this only
// decides what to ask for next.
// - pending parts start on their own; a part the server shows as running
//   (another tab, or a request from before a reload) is asked for as well,
//   and the server's lease answers CONFLICT while it really runs elsewhere.
//   CONFLICT waits CONFLICT_RETRY_MS and asks again, up to MAX_CONFLICT_WAITS.
// - failed parts never restart on their own: only retry() and retryAll(), whose
//   next post of that part carries retry: true. Without it the server answers
//   a failed part as it is (D-157), so a part that failed in another tab, or
//   in a request a reload cut off, is shown failed rather than paid for again.
//   A failed status the server reports for a part this tab is not posting
//   replaces what the tab showed, waiting included.
// - CONFIG, BUDGET_EXCEEDED, VALIDATION, UNAUTHENTICATED and NOT_FOUND stop the
//   run: no new parts start until retryAll().
// - pause() (Next hides the page in an <Activity>, or it unmounts) stops new
//   parts from starting. Requests already sent keep going (the tab still
//   runs) and their answers are still applied; parts queued but not sent stay
//   unsent. resume()
//   continues. A part is never asked for twice at once: queued and in-flight
//   parts are tracked here, so React StrictMode's second effect run, or a
//   resume right after a pause, adds nothing.

import pLimit from "p-limit"

import type { AnalysisStatus } from "@/lib/db/enums"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { RelocationPartDto, RelocationRunDto } from "@/lib/relocation/contracts"
import { err, type AppErrorPayload, type ErrorCode, type Result } from "@/lib/result"

export const PART_CONCURRENCY = 4
export const CONFLICT_RETRY_MS = 5_000
/** Six minutes of asking: longer than the server's five-minute lease, after which a request takes the part over. */
export const MAX_CONFLICT_WAITS = 72

/** Answers that no other part would get past either; the owner has to act first. */
export const STOP_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "CONFIG",
  "BUDGET_EXCEEDED",
  "VALIDATION",
  "UNAUTHENTICATED",
  "NOT_FOUND",
])

export const STILL_RUNNING_ELSEWHERE =
  "This part is still running in another tab or an earlier request. Try again in a few minutes."

/** What this tab is doing with a part: queued for a slot, posted, or waiting to ask again after CONFLICT. */
export type PartPhase = "idle" | "queued" | "running" | "waiting"

export type RunPartView = RelocationPartDto & { phase: PartPhase }

export type RunViewState = {
  analysisId: string
  status: AnalysisStatus
  /** Chunks in order, then the synthesis. */
  parts: readonly RunPartView[]
  estimatedCostUsd: number | null
  costUsd: number
  /** Why no new parts start (configuration, budget, input, session); null while the run may continue. */
  stopped: AppErrorPayload | null
}

export type RunOrchestratorDeps = {
  /** retry is true only on the first post of a part after the owner pressed Retry for it. */
  postPart: (analysisId: string, partId: string, options: { retry: boolean }) => Promise<Result<RelocationRunDto>>
  /**
   * Called with the run after every answer the server accepted, so pages that
   * show runs, or what a finished run feeds (/shopping), can read again.
   */
  onAnswer?: (run: RelocationRunDto) => void
  concurrency?: number
  conflictRetryMs?: number
  maxConflictWaits?: number
}

export type RunOrchestrator = {
  /** The same object until something changes (useSyncExternalStore). */
  getState(): RunViewState
  subscribe(listener: () => void): () => void
  /** The page is shown: start or continue the run. */
  resume(): void
  /** The page is hidden or gone: start nothing new. */
  pause(): void
  /** Runs one failed (or stuck) part again as an explicit Retry, and clears a stop. */
  retry(partId: string): void
  /** Runs every failed part again as an explicit Retry, and clears a stop (Try again). */
  retryAll(): void
  /** Takes in a newer server copy of the run (the page rendered again). */
  absorb(run: RelocationRunDto): void
}

function sortParts(parts: readonly RelocationPartDto[]): RelocationPartDto[] {
  return [...parts].sort((a, b) =>
    a.kind === b.kind ? a.partIndex - b.partIndex : a.kind === "chunk" ? -1 : 1
  )
}

export function createRunOrchestrator(initial: RelocationRunDto, deps: RunOrchestratorDeps): RunOrchestrator {
  const concurrency = deps.concurrency ?? PART_CONCURRENCY
  const conflictRetryMs = deps.conflictRetryMs ?? CONFLICT_RETRY_MS
  const maxConflictWaits = deps.maxConflictWaits ?? MAX_CONFLICT_WAITS
  const analysisId = initial.analysisId
  const limit = pLimit(concurrency)
  const listeners = new Set<() => void>()

  let parts = sortParts(initial.parts)
  let status = initial.status
  let costUsd = initial.costUsd
  let estimatedCostUsd = initial.estimatedCostUsd
  let stopped: AppErrorPayload | null = null
  let active = false

  // Queued for a slot or posted; never queued a second time while here.
  const claimed = new Set<string>()
  const inFlight = new Set<string>()
  // CONFLICT answers: a timer to ask again, and how often it was asked so far.
  const waiting = new Map<string, ReturnType<typeof setTimeout>>()
  const conflictCounts = new Map<string, number>()
  // Parts the owner asked to run again; the flag goes out with the next post only.
  const retrying = new Set<string>()

  function phaseOf(id: string): PartPhase {
    if (inFlight.has(id)) return "running"
    if (waiting.has(id)) return "waiting"
    if (claimed.has(id)) return "queued"
    return "idle"
  }

  function build(): RunViewState {
    return {
      analysisId,
      status,
      parts: parts.map((part) => ({ ...part, phase: phaseOf(part.id) })),
      estimatedCostUsd,
      costUsd,
      stopped,
    }
  }

  let snapshot = build()

  function emit(): void {
    snapshot = build()
    for (const listener of [...listeners]) listener()
  }

  function updatePart(id: string, patch: Partial<RelocationPartDto>): void {
    parts = parts.map((part) => (part.id === id ? { ...part, ...patch } : part))
  }

  function startable(part: RelocationPartDto): boolean {
    return (part.status === "pending" || part.status === "running") && !claimed.has(part.id) && !waiting.has(part.id)
  }

  function pump(): void {
    if (!active || stopped !== null || status === "complete") return
    const chunks = parts.filter((part) => part.kind === "chunk")
    const ready = chunks.filter(startable)
    if (chunks.every((chunk) => chunk.status === "complete")) {
      const synthesis = parts.find((part) => part.kind === "synthesis")
      if (synthesis !== undefined && startable(synthesis)) ready.push(synthesis)
    }
    if (ready.length === 0) return
    for (const part of ready) {
      claimed.add(part.id)
      void limit(() => runPart(part.id))
    }
    emit()
  }

  async function runPart(partId: string): Promise<void> {
    // Queued while shown, its slot came up after the page was hidden or the run stopped.
    if (!active || stopped !== null || status === "complete") {
      claimed.delete(partId)
      emit()
      return
    }
    inFlight.add(partId)
    emit()
    // One press of Retry starts at most one run from this tab.
    const retry = retrying.delete(partId)
    let result: Result<RelocationRunDto>
    try {
      result = await deps.postPart(analysisId, partId, { retry })
    } catch {
      result = err("UPSTREAM", NETWORK_ERROR_MESSAGE)
    }
    inFlight.delete(partId)
    claimed.delete(partId)
    handleAnswer(partId, result, retry)
    emit()
    pump()
  }

  function handleAnswer(partId: string, result: Result<RelocationRunDto>, retry: boolean): void {
    if (result.ok) {
      merge(result.data, partId)
      deps.onAnswer?.(result.data)
      const answered = parts.find((part) => part.id === partId)
      // An answer that leaves the part unfinished means it runs elsewhere:
      // asking again at once would hammer the server.
      if (answered !== undefined && (answered.status === "pending" || answered.status === "running")) {
        waitAndAskAgain(partId)
      } else {
        conflictCounts.delete(partId)
      }
      return
    }
    const error = result.error
    if (error.code === "CONFLICT") {
      waitAndAskAgain(partId)
      return
    }
    if (STOP_CODES.has(error.code)) {
      stopped ??= error
      // Nothing ran, so the owner's Retry still stands for "Try again".
      if (retry) retrying.add(partId)
      return
    }
    conflictCounts.delete(partId)
    updatePart(partId, { status: "failed", error: error.message })
  }

  function stopWaiting(partId: string): void {
    const timer = waiting.get(partId)
    if (timer !== undefined) clearTimeout(timer)
    waiting.delete(partId)
    conflictCounts.delete(partId)
  }

  function waitAndAskAgain(partId: string): void {
    const count = (conflictCounts.get(partId) ?? 0) + 1
    if (count > maxConflictWaits) {
      conflictCounts.delete(partId)
      updatePart(partId, { status: "failed", error: STILL_RUNNING_ELSEWHERE })
      return
    }
    conflictCounts.set(partId, count)
    // Hidden: resume() asks again at once.
    if (!active) return
    const timer = setTimeout(() => {
      waiting.delete(partId)
      emit()
      pump()
    }, conflictRetryMs)
    waiting.set(partId, timer)
  }

  /**
   * Answers can arrive out of order, so another part's status from an answer
   * is taken only when it says more than this tab knows: complete always
   * wins, failed replaces pending or running, and pending gives way to what
   * the server saw. The answered part itself is taken as it is. Parts this
   * tab is posting keep their own state until their own answer; a part it is
   * waiting on stops waiting when the server reports it failed.
   */
  function merge(run: RelocationRunDto, answeredId: string | null): void {
    costUsd = Math.max(costUsd, run.costUsd)
    if (run.estimatedCostUsd !== null) estimatedCostUsd = run.estimatedCostUsd
    if (status !== "complete") status = run.status
    const known = new Set(parts.map((part) => part.id))
    const byId = new Map(run.parts.map((part) => [part.id, part]))
    const merged = parts.map((prev) => {
      const next = byId.get(prev.id)
      if (next === undefined) return prev
      if (prev.status === "complete") return next.status === "complete" ? next : prev
      if (next.status === "complete" || prev.id === answeredId) return next
      if (claimed.has(prev.id)) return prev
      if (next.status === "failed" && prev.status !== "failed") {
        stopWaiting(prev.id)
        return next
      }
      if (waiting.has(prev.id)) return prev
      return prev.status === "pending" ? next : prev
    })
    parts = sortParts([...merged, ...run.parts.filter((part) => !known.has(part.id))])
    // A Retry not yet sent is void once the part shows finished or failed again.
    for (const part of parts) {
      if (part.status === "complete" || part.status === "failed") retrying.delete(part.id)
    }
  }

  return {
    getState: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    resume() {
      if (active) return
      active = true
      pump()
    },
    pause() {
      if (!active) return
      active = false
      for (const timer of waiting.values()) clearTimeout(timer)
      waiting.clear()
      emit()
    },
    retry(partId) {
      const part = parts.find((candidate) => candidate.id === partId)
      if (part === undefined || part.status === "complete" || claimed.has(partId)) return
      stopWaiting(partId)
      retrying.add(partId)
      stopped = null
      updatePart(partId, { status: "pending", error: null })
      emit()
      pump()
    },
    retryAll() {
      for (const part of parts) {
        if (part.status === "failed") {
          conflictCounts.delete(part.id)
          retrying.add(part.id)
          updatePart(part.id, { status: "pending", error: null })
        }
      }
      stopped = null
      emit()
      pump()
    },
    absorb(run) {
      if (run.analysisId !== analysisId) return
      merge(run, null)
      emit()
      pump()
    },
  }
}

/** Counts for the progress bar and the status line. */
export function summarizeRun(state: RunViewState): {
  total: number
  complete: number
  running: number
  waitingElsewhere: number
  failed: number
} {
  let complete = 0
  let running = 0
  let waitingElsewhere = 0
  let failed = 0
  for (const part of state.parts) {
    if (part.status === "complete") complete += 1
    else if (part.phase === "running") running += 1
    else if (part.phase === "waiting" || (part.phase === "idle" && part.status === "running")) waitingElsewhere += 1
    else if (part.status === "failed") failed += 1
  }
  return { total: state.parts.length, complete, running, waitingElsewhere, failed }
}
