"use client"

import pLimit from "p-limit"
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { CircleAlert, Layers, Loader2, Sparkles } from "lucide-react"
import Link from "next/link"

import {
  estimateBatchRun,
  estimateForCount,
  formatResetDate,
  formatUsd,
  formatUsdEstimate,
  type TaggingSetup,
} from "@/components/add/cost-quote"
import { requestTaggingSetup } from "@/components/add/tagging-setup-request"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import {
  dryRunItemIdFrom,
  TAGGING_LIMITS,
  taggedItemIdFrom,
  type ItemCardDto,
  type StartTaggingBatchData,
} from "@/lib/items/contracts"
import { err, type AppErrorPayload, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"

import type { StartTaggingBatchAction } from "./review-actions"
import type { requestTagging } from "./tag-request"

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function budgetBlockFor(setup: TaggingSetup): AppErrorPayload | null {
  if (setup.budget.remainingUsd > 0) return null
  return {
    code: "BUDGET_EXCEEDED",
    message: `This month's AI budget of ${formatUsd(setup.budget.budgetUsd)} is used up. It resets on ${formatResetDate(setup.budget.resetsAt)}.`,
  }
}

export type ReviewTaggingProps = {
  /** Pending items in no batch, newest first: what the bulk run and the batch would send. */
  waiting: ItemCardDto[]
  /** Items a tagging request is running for; left out of a new run. */
  busyIds: ReadonlySet<string>
  /** The model, rates and budget, or why they could not be read (a CONFIG problem). */
  setup: Result<TaggingSetup>
  tagRequest: typeof requestTagging
  /** Injected by tests; GETs /api/ai/tagging-setup otherwise. */
  setupRequest?: typeof requestTaggingSetup
  startTaggingBatch: StartTaggingBatchAction
  /** Replaces a card with a fresh server version of the item. */
  onItemChange: (item: ItemCardDto) => void
  /** Changes some fields of the list's current card, leaving newer state (a finished cut-out) alone. */
  onItemPatch: (itemId: string, patch: Partial<ItemCardDto>) => void
  onBusyChange: (itemIds: readonly string[], busy: boolean) => void
  /** Takes focus when the section goes away while it holds it (a run tagged every waiting item, a batch started). */
  returnFocusTo: RefObject<HTMLElement | null>
}

type TaggingSectionProps = {
  returnFocusTo: RefObject<HTMLElement | null>
  children: ReactNode
}

/**
 * The section around the tagging controls. Its own component, because
 * ReviewTagging stays mounted when it renders nothing, so only this one's
 * effect cleanup runs when the section leaves the page.
 */
function TaggingSection({ returnFocusTo, children }: TaggingSectionProps) {
  const ref = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const section = ref.current
    // The list's summary heading renders before this section, so it is already attached.
    const fallback = returnFocusTo.current
    // Runs before the section leaves the document, while it still holds focus.
    return () => {
      if (section !== null && section.contains(document.activeElement)) fallback?.focus()
    }
  }, [returnFocusTo])

  return (
    <section ref={ref} aria-label="Tagging" className="flex flex-col gap-3 rounded-xl border p-4">
      {children}
    </section>
  )
}

/**
 * "Tag N waiting items ≈ $X" for everything the review list holds that still
 * needs tags: items left over from an earlier visit, a budget block that has
 * lifted, or a batch whose results expired. Four calls at a time, stopping at
 * the budget like the add page, and the batch offer above 20 items (D-024).
 * After each run the budget is read again on its own, not by refreshing the
 * whole page: a refresh would re-run the batch poll and every list read, and
 * a failed read would swap the page for the error screen and lose unsaved
 * edits in open cards.
 */
export function ReviewTagging({
  waiting,
  busyIds,
  setup: pageSetup,
  tagRequest,
  setupRequest = requestTaggingSetup,
  startTaggingBatch,
  onItemChange,
  onItemPatch,
  onBusyChange,
  returnFocusTo,
}: ReviewTaggingProps) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // The size of the batch being started. Its items are busy meanwhile, so the
  // offer keeps this size and stays up (focused, aria-busy) until it answers.
  const [batchSize, setBatchSize] = useState<number | null>(null)
  const batchPending = batchSize !== null
  const [setup, setSetup] = useState(pageSetup)
  const [budgetBlock, setBudgetBlock] = useState<AppErrorPayload | null>(() =>
    pageSetup.ok ? budgetBlockFor(pageSetup.data) : null,
  )
  const [shownPageSetup, setShownPageSetup] = useState(pageSetup)
  const setupReadRef = useRef(0)

  // The page sends a newer setup when it renders again (a revisit kept in a
  // hidden Activity, a new month, a changed budget); it replaces the local one.
  if (pageSetup !== shownPageSetup) {
    setShownPageSetup(pageSetup)
    setSetup(pageSetup)
    setBudgetBlock(pageSetup.ok ? budgetBlockFor(pageSetup.data) : null)
  }

  const candidates = waiting.filter((item) => !busyIds.has(item.id))
  const running = progress !== null || batchPending
  if (candidates.length === 0 && !running && budgetBlock === null) return null

  if (!setup.ok) {
    return (
      <Alert>
        <CircleAlert aria-hidden />
        <AlertTitle>Tagging several items at once is unavailable</AlertTitle>
        <AlertDescription>
          {setup.error.message} Each card&apos;s own button reports the same problem.
        </AlertDescription>
      </Alert>
    )
  }

  const { model, costQuote, budget } = setup.data
  const count = candidates.length
  const estimateUsd = estimateForCount(costQuote.standard, count)
  const batchCount = batchSize ?? count
  // The running items are busy and drop out of `count`; while a run or a batch
  // start is going, the button keeps the size it started with, not "Tag 0 items".
  const buttonCount = progress?.total ?? batchCount
  const batchEstimateUsd = estimateBatchRun(costQuote, batchCount)
  const offerBatch = batchCount >= TAGGING_LIMITS.batchMinItems && batchCount <= TAGGING_LIMITS.batchMaxItems
  const overBudget = estimateUsd > budget.remainingUsd
  const blocked = budgetBlock !== null

  /** The card of an item the server has tagged already; reading it costs nothing. */
  async function showTagged(itemId: string): Promise<void> {
    const result = await tagRequest(itemId)
    if (result.ok) onItemChange(result.data.item)
  }

  /**
   * Reads the month's spend again after a run for "left this month". A budget
   * stop from the run itself stays shown. When the read fails, the last setup
   * stays: it is only a quote, and the server checks the budget on every call.
   */
  async function rereadSetup(stop: AppErrorPayload | null): Promise<void> {
    if (stop !== null) setBudgetBlock(stop)
    setupReadRef.current += 1
    const read = setupReadRef.current
    const fresh = await setupRequest()
    // A later run's read wins over an earlier, slower one.
    if (read !== setupReadRef.current || !fresh.ok) return
    setSetup(fresh)
    setBudgetBlock(stop ?? budgetBlockFor(fresh.data))
  }

  async function tagAll(): Promise<void> {
    const items = candidates
    const ids = items.map((item) => item.id)
    const limit = pLimit(TAGGING_LIMITS.concurrency)
    // Mutated by the parallel calls; an object, so the checks after the run see the writes.
    const outcome: { stop: AppErrorPayload | null; tagged: number; failed: number } = {
      stop: null,
      tagged: 0,
      failed: 0,
    }
    onBusyChange(ids, true)
    setProgress({ done: 0, total: ids.length })
    await Promise.all(
      items.map((item) =>
        limit(async () => {
          // Calls not started when the budget ran out never start.
          if (outcome.stop === null) {
            const result = await tagRequest(item.id)
            if (result.ok) {
              outcome.tagged += 1
              onItemChange(result.data.item)
            } else if (result.error.code === "BUDGET_EXCEEDED") {
              outcome.stop = result.error
            } else {
              outcome.failed += 1
              // A patch, not this run's copy of the card: a cut-out may have finished meanwhile.
              onItemPatch(item.id, { taggingError: result.error.message })
            }
          }
          onBusyChange([item.id], false)
          setProgress((previous) => (previous === null ? null : { ...previous, done: previous.done + 1 }))
        }),
      ),
    )
    setProgress(null)
    void rereadSetup(outcome.stop)
    if (outcome.failed > 0) {
      toast.add({
        title: `${plural(outcome.failed, "item", "items")} could not be tagged`,
        description: "Each card shows why and offers Retry.",
        type: "error",
        priority: "high",
      })
    } else if (outcome.tagged > 0) {
      toast.add({ title: `Tagged ${plural(outcome.tagged, "item", "items")}`, type: "success" })
    }
  }

  async function startBatch(): Promise<void> {
    const items = candidates
    const ids = items.map((item) => item.id)
    setBatchSize(ids.length)
    onBusyChange(ids, true)
    let result: Result<StartTaggingBatchData>
    try {
      result = await startTaggingBatch({ itemIds: ids })
    } catch {
      // A rejected action call means the request itself failed.
      result = err("UPSTREAM", NETWORK_ERROR_MESSAGE)
    }
    onBusyChange(ids, false)
    if (result.ok) {
      const { batchId, dryRunItemId } = result.data
      for (const item of items) {
        if (item.id !== dryRunItemId) onItemPatch(item.id, { taggingBatchId: batchId, taggingError: null })
      }
      await showTagged(dryRunItemId)
      setBatchSize(null)
      toast.add({
        title: "Batch started",
        description: `1 item was tagged right away; ${plural(ids.length - 1, "item is", "items are")} in the batch, usually done within an hour.`,
        type: "success",
      })
      void rereadSetup(null)
      return
    }
    const { error } = result
    const taggedId = taggedItemIdFrom(error.details)
    if (taggedId !== null) await showTagged(taggedId)
    // The dry run's item failed and the server stored why on it; show that on its
    // card. A budget stop stores nothing (D-066), so it marks no card.
    const dryRunId = dryRunItemIdFrom(error.details)
    if (dryRunId !== null && error.code !== "BUDGET_EXCEEDED") onItemPatch(dryRunId, { taggingError: error.message })
    setBatchSize(null)
    // The dry run may have been paid for even though no batch started.
    const stop = error.code === "BUDGET_EXCEEDED" ? error : null
    void rereadSetup(stop)
    if (stop === null) toastError(error)
  }

  return (
    <TaggingSection returnFocusTo={returnFocusTo}>
      {progress !== null ? (
        <p role="status" className="text-sm font-medium">
          Tagging… {progress.done} of {plural(progress.total, "item", "items")} done
        </p>
      ) : batchPending ? (
        <p role="status" className="text-sm font-medium">
          Starting the batch…
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 text-sm">
          <p className="font-medium text-pretty">
            Tag {plural(count, "waiting item", "waiting items")} ≈ {formatUsdEstimate(estimateUsd)} ({model.label})
          </p>
          <p className={overBudget ? "text-destructive" : "text-muted-foreground"}>
            {formatUsd(budget.remainingUsd)} left this month{overBudget ? ", less than this estimate" : ""}
          </p>
        </div>
      )}
      {blocked ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>AI budget reached</AlertTitle>
          <AlertDescription>
            <p>{budgetBlock.message}</p>
            <p>
              No new tagging starts until then. <Link href="/settings/usage">See AI usage</Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="touch"
          onClick={() => void tagAll()}
          disabled={count === 0 || running || blocked}
          focusableWhenDisabled
          aria-busy={progress !== null || undefined}
        >
          {progress !== null ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
          Tag {plural(buttonCount, "item", "items")}
        </Button>
        {offerBatch ? (
          <Button
            type="button"
            variant="secondary"
            size="touch"
            onClick={() => void startBatch()}
            disabled={running || blocked}
            focusableWhenDisabled
            aria-busy={batchPending || undefined}
          >
            {batchPending ? <Loader2 aria-hidden className="animate-spin" /> : <Layers aria-hidden />}
            Tag as a batch (≈ {formatUsdEstimate(batchEstimateUsd)})
          </Button>
        ) : null}
      </div>
      {offerBatch ? (
        <p className="text-sm text-muted-foreground">
          A batch costs about half as much; results usually arrive within an hour.
        </p>
      ) : null}
    </TaggingSection>
  )
}
