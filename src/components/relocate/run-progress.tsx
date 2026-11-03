"use client"

import { useRouter } from "next/navigation"
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { CircleAlert, CircleCheck, Clock, Loader2, RotateCcw, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { focusWasLost } from "@/lib/focus"
import type { RelocationRunDto } from "@/lib/relocation/contracts"
import { errorToast, type AppErrorPayload, type ErrorCode } from "@/lib/result"

import { noteShoppingListChange } from "@/components/shopping/shopping-changes"

import { formatUsdEstimate, plural } from "./format"
import { postRelocationPart } from "./run-api"
import { noteRelocationRunChange } from "./run-changes"
import { createRunOrchestrator, summarizeRun, type RunPartView, type RunViewState } from "./run-orchestrator"

export type RunProgressProps = {
  /** The run as the server rendered it; the page keys this component by the analysis id. */
  run: RelocationRunDto
}

/** What the owner can do about a stop, after the server's own message. */
const STOP_HINTS: Partial<Record<ErrorCode, string>> = {
  CONFIG: "No part can run until the server's AI settings are fixed. Finished parts are kept; press Try again afterwards.",
  BUDGET_EXCEEDED: "Finished parts are kept. The rest can run when the monthly AI budget allows it again.",
  VALIDATION: "The server refused this run. Start a new analysis from the Relocate page if it happens again.",
  UNAUTHENTICATED: "Sign in again, then come back to this page to continue.",
  NOT_FOUND: "This analysis no longer exists. Start a new one from the Relocate page.",
}

function partTitle(part: RunPartView, chunkCount: number): string {
  return part.kind === "synthesis" ? "Summary, gaps and packing list" : `Part ${part.partIndex + 1} of ${chunkCount}`
}

function partStatus(part: RunPartView, state: RunViewState): { text: string; icon: "done" | "busy" | "wait" | "failed" } {
  if (part.status === "complete") return { text: `Done · ${formatUsdEstimate(part.costUsd)}`, icon: "done" }
  if (part.phase === "running") return { text: "Working…", icon: "busy" }
  if (part.phase === "waiting" || (part.phase === "idle" && part.status === "running")) {
    return { text: "Running elsewhere…", icon: "busy" }
  }
  if (part.status === "failed") return { text: "Failed", icon: "failed" }
  if (part.phase === "queued") return { text: "Queued", icon: "wait" }
  if (state.stopped !== null) return { text: "Not started", icon: "wait" }
  return { text: part.kind === "synthesis" ? "Starts when the other parts are done" : "Waiting", icon: "wait" }
}

function statusLine(state: RunViewState): string {
  const summary = summarizeRun(state)
  if (state.status === "complete") return "Analysis complete. Loading the results…"
  if (state.stopped !== null) return `Stopped: ${errorToast(state.stopped).title}.`
  const busy = summary.running + summary.waitingElsewhere
  if (summary.failed > 0 && busy === 0) {
    return `${plural(summary.failed, "part", "parts")} failed. Retry to finish the analysis.`
  }
  return `${summary.complete} of ${summary.total} parts done${busy > 0 ? `, ${busy} running` : ""}.`
}

function StopAlert({ error, onRetry }: { error: AppErrorPayload; onRetry: () => void }) {
  const hint = STOP_HINTS[error.code]
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertTitle>{errorToast(error).title}</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {hint ? <p>{hint}</p> : null}
        <Button type="button" variant="outline" size="touch" className="mt-2" onClick={onRetry}>
          <RotateCcw aria-hidden />
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  )
}

function PartRow({
  part,
  state,
  chunkCount,
  onRetry,
}: {
  part: RunPartView
  state: RunViewState
  chunkCount: number
  onRetry: (partId: string) => void
}) {
  const status = partStatus(part, state)
  const title = partTitle(part, chunkCount)
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col">
          <span className="font-medium">{title}</span>
          <span className="text-sm text-muted-foreground">{plural(part.itemCount, "item", "items")}</span>
        </div>
        <span className="flex items-center gap-2 text-sm">
          {status.icon === "done" ? <CircleCheck aria-hidden className="size-4" /> : null}
          {status.icon === "busy" ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
          {status.icon === "wait" ? <Clock aria-hidden className="size-4 text-muted-foreground" /> : null}
          {status.icon === "failed" ? <TriangleAlert aria-hidden className="size-4 text-destructive" /> : null}
          {status.text}
        </span>
      </div>
      {part.status === "failed" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-sm text-pretty text-destructive">{part.error ?? "This part failed."}</p>
          <Button type="button" variant="outline" size="touch" onClick={() => onRetry(part.id)}>
            <RotateCcw aria-hidden />
            Retry <span className="sr-only">{title.toLowerCase()}</span>
          </Button>
        </div>
      ) : null}
    </li>
  )
}

/**
 * Runs a relocation analysis from the browser and shows its parts (D-025):
 * chunks four at a time, then the synthesis, then the results (a router
 * refresh renders them). Opening another page of the app is safe: requests
 * already sent keep going, and coming back continues where the run stands.
 * Closing or reloading the tab does not stop a part already running: the
 * route lets it finish and store its result or failure, and the page shows it
 * when it is opened again (D-167). Next keeps this page in a hidden <Activity>
 * when the owner navigates away; the effect below pauses the run then and
 * resumes it when the page is shown.
 */
export function RunProgress({ run }: RunProgressProps) {
  const router = useRouter()
  const [orchestrator] = useState(() =>
    createRunOrchestrator(run, {
      postPart: (analysisId, partId, options) => postRelocationPart(analysisId, partId, options),
      // Called from the answer, not from an effect: a run can finish while Next
      // keeps this page hidden, and Back may then go straight to a kept
      // /shopping, which reads its budget prefill from the newest finished run.
      onAnswer: (answered) => {
        noteRelocationRunChange()
        if (answered.status === "complete") noteShoppingListChange()
      },
    })
  )
  const state = useSyncExternalStore(orchestrator.subscribe, orchestrator.getState, orchestrator.getState)
  // The server copy the orchestrator started from or took in last.
  const absorbed = useRef(run)

  useEffect(() => {
    orchestrator.resume()
    return () => orchestrator.pause()
  }, [orchestrator])

  useEffect(() => {
    if (absorbed.current === run) return
    absorbed.current = run
    orchestrator.absorb(run)
  }, [orchestrator, run])

  // Runs again when Next shows the page again, so a run that finished while
  // the page was hidden shows its results on the way back.
  const complete = state.status === "complete"
  useEffect(() => {
    if (complete) router.refresh()
  }, [complete, router])

  // Retry, Try again and Retry failed parts vanish with the state they change,
  // and focus would fall to <body>: it moves to the status line, which says
  // what happens next. A layout effect consumes the request once, so showing
  // the page again (Activity re-runs layout effects) never takes focus, and
  // focus is only moved when it was lost.
  const statusRef = useRef<HTMLParagraphElement>(null)
  const focusStatusNext = useRef(false)
  useLayoutEffect(() => {
    if (!focusStatusNext.current) return
    focusStatusNext.current = false
    if (focusWasLost(document.activeElement)) statusRef.current?.focus()
  }, [state])

  function restart(action: () => void) {
    const before = orchestrator.getState()
    focusStatusNext.current = true
    action()
    if (orchestrator.getState() === before) focusStatusNext.current = false
  }
  const retry = (partId: string) => restart(() => orchestrator.retry(partId))
  const retryAll = () => restart(orchestrator.retryAll)

  const summary = summarizeRun(state)
  const chunkCount = state.parts.filter((part) => part.kind === "chunk").length
  const busy = summary.running + summary.waitingElsewhere

  return (
    <section aria-labelledby="run-progress-heading" className="flex max-w-2xl flex-col gap-5">
      <h2 id="run-progress-heading" className="sr-only">
        Progress
      </h2>
      <Progress
        value={summary.complete}
        max={Math.max(1, summary.total)}
        getAriaValueText={() => `${summary.complete} of ${summary.total} parts done`}
      >
        <ProgressLabel>Parts done</ProgressLabel>
        <ProgressValue>{() => `${summary.complete} of ${summary.total}`}</ProgressValue>
      </Progress>
      <div className="flex flex-col gap-1">
        <p
          ref={statusRef}
          role="status"
          tabIndex={-1}
          className="font-medium outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {statusLine(state)}
        </p>
        <p className="text-sm text-muted-foreground">
          Spent so far {formatUsdEstimate(state.costUsd)}
          {state.estimatedCostUsd === null ? "" : ` of an estimated ${formatUsdEstimate(state.estimatedCostUsd)}`}.
        </p>
        {busy > 0 ? (
          // The parts route does not pass the request's abort signal on (D-167):
          // a running part finishes on the server whatever happens to this tab.
          <p className="text-sm text-muted-foreground">
            You can open other pages meanwhile: running parts finish, and the rest start when you come back.
            Closing or reloading this tab does not stop parts already running; they finish on the server and show
            here when you come back.
          </p>
        ) : null}
      </div>

      {state.stopped !== null ? <StopAlert error={state.stopped} onRetry={retryAll} /> : null}

      {complete ? (
        <Button type="button" size="touch" className="self-start" onClick={() => router.refresh()}>
          Show results
        </Button>
      ) : null}

      {state.stopped === null && summary.failed > 1 ? (
        <Button type="button" variant="outline" size="touch" className="self-start" onClick={retryAll}>
          <RotateCcw aria-hidden />
          Retry failed parts
        </Button>
      ) : null}

      <ol aria-label="Parts" className="flex flex-col divide-y rounded-xl border">
        {state.parts.map((part) => (
          <PartRow key={part.id} part={part} state={state} chunkCount={chunkCount} onRetry={retry} />
        ))}
      </ol>
    </section>
  )
}
