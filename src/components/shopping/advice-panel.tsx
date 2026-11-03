"use client"

import { useId, useRef, useState } from "react"
import { Loader2, ShoppingCart, Sparkles } from "lucide-react"

import { CATEGORY_LABELS } from "@/components/items/tag-options"
import { settle, type AddGapsToShoppingListAction } from "@/components/relocate/actions"
import { formatDay, formatUsd, formatUsdEstimate, modelLabel } from "@/components/relocate/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import type { AppErrorPayload } from "@/lib/result"
import { useSavedOverlay, useServerCopy } from "@/lib/saved-since-read"
import { toastError } from "@/lib/toast-result"

import { postShoppingAdvice, type RequestShoppingAdvice } from "./advice-api"
import {
  budgetSummary,
  candidatePrice,
  estimatedOutfits,
  formatAdviceEur,
  OUTFIT_COUNT_NOTE,
  REMAINING_BUDGET_NOTE,
  remainingBudgetHeadline,
  scenarioCaption,
  type AdviceBudgetDto,
  type AdviceCandidateDto,
  type AdviceRecommendationDto,
  type AdviceScenarioDto,
  type ShoppingAdviceReadyDto,
  type StoredAdviceDto,
} from "./advice-model"
import { noteShoppingListChange } from "./shopping-changes"

/** The overlay key of a ranking this panel ran; there is only ever one. */
const RUN_KEY = "run"

function gapKeyOf(candidate: AdviceCandidateDto): string {
  return `${candidate.relocationAnalysisId ?? ""}:${candidate.key}`
}

const ROW_STATUS_BADGES = { todo: "On your list", bought: "Bought", skipped: "Skipped" } as const

/** What the badge says about where a ranked purchase stands on the list now. */
function listBadge(recommendation: AdviceRecommendationDto, addedHere: boolean): string {
  const { candidate, onList, rowStatus } = recommendation
  if (addedHere && !onList) return ROW_STATUS_BADGES.todo
  if (onList && rowStatus !== null) return ROW_STATUS_BADGES[rowStatus]
  return candidate.source === "gap" ? "Gap from your plan" : "Removed from your list"
}

/** The ranking button's text. */
function runLabel(running: boolean, current: boolean, count: number): string {
  if (running) return "Ranking…"
  if (current) return "Run again"
  return `Rank ${count} ${count === 1 ? "purchase" : "purchases"}`
}

function UnlockList({
  candidate,
  scenarios,
}: Readonly<{ candidate: AdviceCandidateDto; scenarios: readonly AdviceScenarioDto[] }>) {
  if (!candidate.counted) {
    return (
      <p className="text-sm text-muted-foreground">
        Not part of the outfit count: layers, hats, gloves, scarves, bags and accessories are judged from the climate.
      </p>
    )
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Estimated new outfits per season">
      {scenarios.map((scenario) => {
        const count = candidate.unlocks[scenario.key] ?? 0
        return (
          <li key={scenario.key} className={count === 0 ? "text-muted-foreground" : undefined}>
            {scenario.label}:{" "}
            <span className={count > 0 ? "font-medium" : undefined}>{estimatedOutfits(count, "new")}</span>
          </li>
        )
      })}
    </ul>
  )
}

function RecommendationCard({
  recommendation,
  scenarios,
  addedHere,
  adding,
  onAdd,
}: Readonly<{
  recommendation: AdviceRecommendationDto
  scenarios: readonly AdviceScenarioDto[]
  addedHere: boolean
  adding: boolean
  onAdd: () => void
}>) {
  const titleId = useId()
  const { candidate } = recommendation
  const badge = listBadge(recommendation, addedHere)
  const price = candidatePrice(candidate)
  const canAdd = candidate.source === "gap" && !recommendation.onList && !addedHere && candidate.relocationAnalysisId !== null
  return (
    <li aria-labelledby={titleId} className="flex gap-3 rounded-xl border bg-card p-4 text-card-foreground">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
      >
        {recommendation.rank}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id={titleId} className="min-w-0 font-medium break-words text-pretty">
            {/* The space outside the span, so the name reads "Rank 1: …" in every name computation. */}
            <span className="sr-only">Rank {recommendation.rank}:</span> {candidate.itemType}
          </h4>
          {candidate.category !== null ? <Badge variant="secondary">{CATEGORY_LABELS[candidate.category]}</Badge> : null}
          <Badge variant="outline">{badge}</Badge>
        </div>
        <p className="text-sm text-pretty">{recommendation.why}</p>
        <p className="text-sm">
          <span className="font-medium">Set aside {formatAdviceEur(recommendation.budgetEur)}</span>
          {price !== null ? <span className="text-muted-foreground"> · estimate {price}</span> : null}
        </p>
        <UnlockList candidate={candidate} scenarios={scenarios} />
        {canAdd ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="self-start"
            onClick={onAdd}
            disabled={adding}
            focusableWhenDisabled
            aria-busy={adding || undefined}
          >
            {adding ? <Loader2 aria-hidden className="animate-spin" /> : <ShoppingCart aria-hidden />}
            {adding ? "Adding…" : "Add to shopping list"}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The budget the ranking must stay within. With a plan budget, its figure is
 * named an estimate and the note says why (D-219, D-231); without one, only
 * where a budget would come from.
 */
function BudgetLines({ budget }: Readonly<{ budget: AdviceBudgetDto }>) {
  const headline = remainingBudgetHeadline(budget)
  if (headline === null) return <p className="text-sm text-pretty">{budgetSummary(budget)}</p>
  return (
    <div className="flex flex-col gap-1 text-sm text-pretty">
      <p className="font-medium">{headline}</p>
      <p>{budgetSummary(budget)}</p>
      <p className="text-muted-foreground">{REMAINING_BUDGET_NOTE}</p>
    </div>
  )
}

function CandidateList({ state }: Readonly<{ state: ShoppingAdviceReadyDto }>) {
  if (state.candidates.length === 0) return null
  return (
    <details className="group rounded-xl border bg-card text-card-foreground">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium">
        See the {state.candidates.length} {state.candidates.length === 1 ? "candidate" : "candidates"} and their estimated
        outfit counts
      </summary>
      <ul className="flex flex-col gap-3 border-t p-4">
        {state.candidates.map((candidate) => (
          <li key={`${candidate.source}:${candidate.key}`} className="flex flex-col gap-1">
            <p className="text-sm font-medium break-words">
              {candidate.itemType}{" "}
              <span className="font-normal text-muted-foreground">
                ({candidate.source === "gap" ? "gap from your plan" : "on your list"})
              </span>
            </p>
            <UnlockList candidate={candidate} scenarios={state.scenarios} />
          </li>
        ))}
      </ul>
      {state.omittedCandidates > 0 ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          {state.omittedCandidates} less important {state.omittedCandidates === 1 ? "entry is" : "entries are"} left out of the
          ranking.
        </p>
      ) : null}
    </details>
  )
}

function LatestRanking({
  latest,
  addedHere,
  addingKey,
  onAdd,
}: Readonly<{
  latest: StoredAdviceDto
  addedHere: ReadonlyMap<string, true>
  addingKey: string | null
  onAdd: (candidate: AdviceCandidateDto) => void
}>) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-base font-semibold">Ranked on {formatDay(latest.completedAt)}</h3>
        <p className="text-sm text-muted-foreground">
          {modelLabel(latest.model)} · cost {formatUsd(latest.costUsd)}
          {latest.remainingBudgetEur === null ? "" : ` · estimated ${formatAdviceEur(latest.remainingBudgetEur)} left then`}
        </p>
        {latest.stale ? (
          <p className="text-sm text-pretty">
            Your list, the budget or your wardrobe changed since this ranking. Rank again to take that into account.
          </p>
        ) : null}
      </div>
      <ol className="flex flex-col gap-3">
        {latest.recommendations.map((recommendation) => {
          const key = gapKeyOf(recommendation.candidate)
          return (
            <RecommendationCard
              key={`${recommendation.candidate.source}:${recommendation.candidate.key}`}
              recommendation={recommendation}
              scenarios={latest.scenarios}
              addedHere={recommendation.candidate.source === "gap" && addedHere.has(key)}
              adding={addingKey === key}
              onAdd={() => onAdd(recommendation.candidate)}
            />
          )
        })}
      </ol>
    </div>
  )
}

export type AdvicePanelProps = {
  state: ShoppingAdviceReadyDto
  /** The relocation action that adds gaps to the list (idempotent on the gap key). */
  addGapsToShoppingList: AddGapsToShoppingListAction
  /** The route call; tests pass a fake. */
  requestAdvice?: RequestShoppingAdvice
}

/**
 * "What to buy next" (D-040): the outfit counts, the budget, the ranking
 * button and the newest ranking. The counts come from the server, worked out
 * in TypeScript; Claude only orders the purchases and explains the order.
 * A ranking run here, and gaps added here, show over the page's server copy
 * until a read made after them arrives (D-180).
 */
export function AdvicePanel({
  state: serverState,
  addGapsToShoppingList,
  requestAdvice = postShoppingAdvice,
}: Readonly<AdvicePanelProps>) {
  const headingId = useId()
  const copy = useServerCopy(serverState)
  const [ranHere, saveRun] = useSavedOverlay<ShoppingAdviceReadyDto>(copy)
  const [addedHere, markAdded] = useSavedOverlay<true>(copy)
  const state = ranHere.get(RUN_KEY) ?? serverState
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<AppErrorPayload | null>(null)
  const [status, setStatus] = useState("")
  const [addingKey, setAddingKey] = useState<string | null>(null)
  // Separate guards: a gap can be added while a ranking runs.
  const runBusy = useRef(false)
  const addBusy = useRef(false)

  const latest = state.latest
  const current = latest !== null && !latest.stale
  const count = state.candidates.length

  async function run() {
    if (runBusy.current || state.blocker !== null) return
    runBusy.current = true
    setRunning(true)
    setError(null)
    setStatus("Ranking your purchases. This can take up to a minute.")
    const result = await requestAdvice({ force: current })
    runBusy.current = false
    setRunning(false)
    if (!result.ok) {
      setStatus("")
      setError(result.error)
      return
    }
    saveRun(RUN_KEY, result.data.state)
    setStatus(
      result.data.outcome === "reused"
        ? "Nothing changed since the last ranking, so it is shown again at no cost."
        : "Ranking ready."
    )
  }

  async function add(candidate: AdviceCandidateDto) {
    const analysisId = candidate.relocationAnalysisId
    if (addBusy.current || analysisId === null) return
    addBusy.current = true
    setAddingKey(gapKeyOf(candidate))
    const result = await settle(() => addGapsToShoppingList({ analysisId, gapKeys: [candidate.key] }))
    addBusy.current = false
    setAddingKey(null)
    if (!result.ok) {
      toastError(result.error)
      return
    }
    markAdded(gapKeyOf(candidate), true)
    // A plan kept by Next shows this gap as not on the list until it reads
    // again (D-173); the list above reads with this page.
    noteShoppingListChange()
    copy.refresh()
    toast.add({
      title: result.data.added > 0 ? "Added to your shopping list" : "Already on your shopping list",
      type: "success",
    })
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="font-heading text-lg font-semibold">
          What to buy next
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">
          Claude ranks your open shopping list and the gaps of your latest relocation plan. The app estimates the outfits
          each purchase would add{state.climate !== null ? ` in ${state.climate.city}` : ""}; Claude only orders them and
          explains why.
        </p>
        <p className="text-sm text-pretty text-muted-foreground">{OUTFIT_COUNT_NOTE}</p>
      </div>

      {state.scenarios.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Outfits your wardrobe makes now</h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {state.scenarios.map((scenario) => (
              <li key={scenario.key}>
                {scenarioCaption(scenario)}:{" "}
                <span className="text-foreground">{estimatedOutfits(scenario.outfitsNow, "total")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <BudgetLines budget={state.budget} />

      {state.blocker !== null ? (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-pretty">{state.blocker}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            type="button"
            size="touch"
            onClick={() => void run()}
            disabled={running}
            focusableWhenDisabled
            aria-busy={running || undefined}
          >
            {running ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
            {runLabel(running, current, count)}
          </Button>
          {state.estimateUsd !== null ? (
            <p className="text-sm text-muted-foreground">
              About {formatUsdEstimate(state.estimateUsd)} with {modelLabel(state.model)}.
            </p>
          ) : null}
        </div>
      )}

      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {status}
      </p>

      {error !== null ? (
        <Alert variant="destructive">
          <AlertTitle>The ranking did not finish</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      {latest !== null ? (
        <LatestRanking
          latest={latest}
          addedHere={addedHere}
          addingKey={addingKey}
          onAdd={(candidate) => void add(candidate)}
        />
      ) : null}

      <CandidateList state={state} />
    </section>
  )
}
