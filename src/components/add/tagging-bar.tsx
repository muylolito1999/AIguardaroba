"use client"

import { Layers, Sparkles } from "lucide-react"
import Link from "next/link"
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import {
  estimateBatchRun,
  estimateForCount,
  formatUsd,
  formatUsdEstimate,
  type TaggingSetup,
} from "./cost-quote"
import { BATCH_MIN_ITEMS } from "./use-add-flow"
import type { QueueCounts } from "./upload-queue"

/**
 * The CSS variable the toast viewport keeps its bottom edge above
 * (src/components/ui/toast.tsx): the distance from the viewport's bottom edge
 * to the bar's top edge, plus a gap.
 */
export const TOAST_BAR_TOP_VAR = "--toast-bar-top"
/** Gap kept between the bar's top edge and the lowest toast. */
const TOAST_GAP_PX = 16
/** Focus styles for the elements that only receive focus from code. */
const FOCUS_TARGET = "outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"

/**
 * Keeps toasts above the bar while it is in view. Both sit near the bottom
 * edge, and an error toast would otherwise cover "Start tagging" and the
 * batch button for as long as it is shown. The bar sticks to the bottom only
 * when the page is longer than the window; on a short page it sits higher up.
 * So its position is measured, not just its height: again when it resizes,
 * when the content above it grows or shrinks, and on scroll and window resize.
 */
function useToastClearance(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const bar = ref.current
    if (bar === null) return
    const root = document.documentElement

    function place(element: HTMLElement): void {
      const rect = element.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      if (rect.bottom <= 0 || rect.top >= viewportHeight) {
        // Out of view: the toasts keep their own place at the bottom edge.
        root.style.removeProperty(TOAST_BAR_TOP_VAR)
        return
      }
      root.style.setProperty(TOAST_BAR_TOP_VAR, `${Math.ceil(Math.max(0, viewportHeight - rect.top)) + TOAST_GAP_PX}px`)
    }
    const update = () => place(bar)

    update()
    const observer = new ResizeObserver(update)
    observer.observe(bar)
    // The queue above the bar moves it when rows are added, removed or grow.
    if (bar.parentElement !== null) observer.observe(bar.parentElement)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update)
      root.style.removeProperty(TOAST_BAR_TOP_VAR)
    }
  }, [ref])
}

type TaggingBarProps = {
  counts: QueueCounts
  /** The model, rates and budget; null while tagging is unavailable, which leaves only the Review link. */
  setup: TaggingSetup | null
  taggingBlocked: boolean
  batchPending: boolean
  onStartTagging: () => void
  onStartBatch: () => void
}

function items(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`
}

function summary(counts: QueueCounts, estimate: string, modelLabel: string): string {
  if (counts.untagged > 0) return `Tag ${items(counts.untagged)} ≈ ${estimate} (${modelLabel})`
  if (counts.tagging > 0) return `Tagging ${items(counts.tagging)}…`
  if (counts.tagged === counts.ready) return `All ${items(counts.ready)} tagged`
  return `${counts.tagged} of ${items(counts.ready)} tagged`
}

type BatchOfferProps = {
  estimateUsd: number
  disabled: boolean
  pending: boolean
  onStart: () => void
  /** Takes focus when the offer goes away while it holds it (the batch has started). */
  returnFocusTo: RefObject<HTMLElement | null>
}

function BatchOffer({ estimateUsd, disabled, pending, onStart, returnFocusTo }: BatchOfferProps) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const offer = ref.current
    // Rendered before the offer, so already attached.
    const fallback = returnFocusTo.current
    // Runs before the offer leaves the document, while it still holds focus.
    return () => {
      if (offer !== null && offer.contains(document.activeElement)) fallback?.focus()
    }
  }, [returnFocusTo])

  return (
    <div ref={ref} className="mt-3 flex flex-col gap-2 border-t pt-3 md:flex-row md:items-center md:justify-between">
      <p className="text-sm text-muted-foreground">
        Batch tagging costs half as much; results usually arrive within an hour.
      </p>
      <Button
        variant="secondary"
        size="touch"
        disabled={disabled}
        focusableWhenDisabled
        aria-busy={pending || undefined}
        onClick={onStart}
      >
        <Layers aria-hidden="true" />
        {pending ? "Starting batch…" : `Tag as a batch (≈ ${formatUsdEstimate(estimateUsd)})`}
      </Button>
    </div>
  )
}

function ReviewLink({ count }: { count: number }) {
  return (
    <Link href="/add/review" className={cn(buttonVariants({ variant: "outline", size: "touch" }), "flex-1 md:flex-none")}>
      Review {items(count)}
    </Link>
  )
}

/**
 * Sticky at the bottom of the content. Below md it sits above the fixed tab bar
 * (the same offset the (app) layout pads with); toasts move up above it.
 */
export function TaggingBar({
  counts,
  setup,
  taggingBlocked,
  batchPending,
  onStartTagging,
  onStartBatch,
}: TaggingBarProps) {
  const ref = useRef<HTMLElement>(null)
  const summaryRef = useRef<HTMLParagraphElement>(null)
  useToastClearance(ref)

  let content: ReactNode
  if (setup === null) {
    // Tagging is unavailable (the page's alert says why); reviewing still works.
    content = (
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <p ref={summaryRef} tabIndex={-1} className={cn("text-sm font-medium text-pretty", FOCUS_TARGET)}>
          {items(counts.ready)} uploaded; tagging is unavailable
        </p>
        <div className="flex flex-wrap gap-2">
          <ReviewLink count={counts.ready} />
        </div>
      </div>
    )
  } else {
    const { model, costQuote, budget } = setup
    const estimateUsd = estimateForCount(costQuote.standard, counts.untagged)
    // What startTaggingBatch checks against the budget: the dry run, then the rest at batch rates.
    const batchEstimateUsd = estimateBatchRun(costQuote, counts.untagged)
    const offerBatch = counts.untagged >= BATCH_MIN_ITEMS
    const overBudget = estimateUsd > budget.remainingUsd

    content = (
      <>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5 text-sm">
            <p ref={summaryRef} tabIndex={-1} className={cn("font-medium text-pretty", FOCUS_TARGET)}>
              {summary(counts, formatUsdEstimate(estimateUsd), model.label)}
            </p>
            <p className={cn("text-muted-foreground", overBudget && counts.untagged > 0 && "text-destructive")}>
              {formatUsd(budget.remainingUsd)} left this month
              {overBudget && counts.untagged > 0 ? ", less than this estimate" : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="touch"
              className="flex-1 md:flex-none"
              disabled={counts.untagged === 0 || taggingBlocked || batchPending}
              // Keeps focus once everything is queued, instead of dropping it to <body>.
              focusableWhenDisabled
              onClick={onStartTagging}
            >
              <Sparkles aria-hidden="true" />
              Start tagging
            </Button>
            <ReviewLink count={counts.ready} />
          </div>
        </div>
        {offerBatch ? (
          <BatchOffer
            estimateUsd={batchEstimateUsd}
            disabled={taggingBlocked || batchPending}
            pending={batchPending}
            onStart={onStartBatch}
            returnFocusTo={summaryRef}
          />
        ) : null}
      </>
    )
  }

  return (
    <section
      ref={ref}
      aria-label="Tagging"
      className={cn(
        "sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 mt-2 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur",
        "md:bottom-[calc(1.5rem+env(safe-area-inset-bottom))]"
      )}
    >
      {content}
    </section>
  )
}
