"use client"

import { useId, useState } from "react"
import Link from "next/link"

import { Input } from "@/components/ui/input"
import type { ShoppingItemDto } from "@/lib/relocation/contracts"

import { budgetVerdict, formatEur, parseBudgetInput, toBuyTotals, type BudgetVerdict } from "./shopping-model"

export type BudgetPanelProps = {
  items: readonly ShoppingItemDto[]
  /** The purchase budget of the latest relocation run; prefills the field. */
  latestBudgetEur: number | null
  /** That run, linked from the hint. */
  latestAnalysisId: string | null
}

function verdictText(verdict: BudgetVerdict): string | null {
  switch (verdict.kind) {
    case "none":
      return null
    case "within":
      return `Within budget, with ${formatEur(verdict.leftEur)} left even at the high end.`
    case "maybe_over":
      return `Could go over: the high end is ${formatEur(verdict.overEur)} over budget.`
    case "over":
      return `Over budget by ${formatEur(verdict.overEur)}, even at the low end.`
  }
}

/**
 * What the "To buy" rows cost against a budget. The budget lives in this
 * field only: it is prefilled from the latest relocation run, and a change is
 * not saved anywhere (the hint says so).
 */
export function BudgetPanel({ items, latestBudgetEur, latestAnalysisId }: BudgetPanelProps) {
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const prefill = latestBudgetEur === null ? "" : String(latestBudgetEur)
  const [text, setText] = useState(prefill)
  const [lastPrefill, setLastPrefill] = useState(prefill)
  // A newer relocation run brought another budget: show that one.
  if (prefill !== lastPrefill) {
    setLastPrefill(prefill)
    setText(prefill)
  }

  const totals = toBuyTotals(items)
  const budget = parseBudgetInput(text)
  const verdict = budgetVerdict(totals, budget.ok ? budget.value : null)
  const verdictMessage = verdictText(verdict)

  return (
    <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground">
      <h2 id={`${inputId}-heading`} className="font-heading text-base font-semibold">
        Budget
      </h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-medium">
          Budget for new purchases (€)
        </label>
        <Input
          id={inputId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="No budget"
          aria-invalid={!budget.ok || undefined}
          aria-describedby={[hintId, budget.ok ? null : errorId].filter(Boolean).join(" ")}
          className="h-11 max-w-48"
        />
        {budget.ok ? null : (
          <p id={errorId} className="text-sm text-destructive-strong">
            {budget.message}
          </p>
        )}
        <p id={hintId} className="text-sm text-muted-foreground">
          {latestBudgetEur === null ? (
            "Only used for this comparison; it is not saved."
          ) : (
            <>
              Prefilled from{" "}
              {latestAnalysisId === null ? (
                "your latest relocation plan"
              ) : (
                <Link href={`/relocate/${latestAnalysisId}`} className="underline underline-offset-4 hover:text-foreground">
                  your latest relocation plan
                </Link>
              )}
              . Only used for this comparison; changes are not saved.
            </>
          )}
        </p>
      </div>
      <div className="flex flex-col gap-1 text-sm" role="status">
        {totals.count === 0 ? (
          <p>Nothing left to buy.</p>
        ) : (
          <p>
            <span className="font-medium">
              To buy: {totals.count} {totals.count === 1 ? "item" : "items"}
              {totals.units !== totals.count ? ` (${totals.units} pieces)` : ""}
            </span>
            {totals.count > totals.unpriced
              ? `, ${totals.minEur === totals.maxEur ? formatEur(totals.minEur) : `${formatEur(totals.minEur)}–${formatEur(totals.maxEur)}`} in all.`
              : "."}
          </p>
        )}
        {totals.unpriced > 0 ? (
          <p className="text-muted-foreground">
            {totals.unpriced === 1 ? "1 item has" : `${totals.unpriced} items have`} no price yet and {totals.unpriced === 1 ? "is" : "are"} not counted.
          </p>
        ) : null}
        {verdictMessage !== null && totals.count > 0 ? (
          <p className={verdict.kind === "within" ? "text-muted-foreground" : "font-medium text-destructive-strong"}>{verdictMessage}</p>
        ) : null}
      </div>
    </section>
  )
}
