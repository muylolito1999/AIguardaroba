"use client"

import Link from "next/link"
import { memo, useId, useLayoutEffect, useOptimistic, useRef, useState, useTransition } from "react"
import { CircleAlert, Loader2, Sparkles } from "lucide-react"

import { ChoiceGroup } from "@/components/items/tag-form-controls"
import { DECISION_LABELS } from "@/components/items/tag-options"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ITEM_DECISIONS, type ItemDecision } from "@/lib/db/enums"
import { noteWardrobeChange, noteWardrobeChangeIfOk } from "@/lib/items/wardrobe-changes"
import type { RelocationItemRefDto, RelocationViewDto } from "@/lib/relocation/contracts"
import type { RelocationItemResult } from "@/lib/relocation/schemas"
import type { AppErrorPayload } from "@/lib/result"
import { toastError } from "@/lib/toast-result"
import { cn } from "@/lib/utils"

import { settle, type RelocationResultActions } from "./actions"
import {
  DECISION_COLUMN_LABELS,
  DECISION_COLUMNS,
  PRIORITY_LABELS,
  RELOCATION_DECISION_LABELS,
  decisionColumn,
  plural,
  type DecisionColumn,
} from "./format"
import { ItemThumb, itemGoneLabel } from "./item-ref"

/** Whether the owner can still change this item: it exists and is not archived. */
export function isChangeable(item: RelocationItemRefDto | undefined): item is RelocationItemRefDto {
  return item !== undefined && item.exists && item.status !== "archived"
}

type DecisionCardProps = {
  entry: RelocationItemResult
  item: RelocationItemRefDto | undefined
  /** The owner's decision now: saved here, or from the server. */
  decision: ItemDecision
  setItemDecision: RelocationResultActions["setItemDecision"]
  onSaved: (itemId: string, decision: ItemDecision) => void
}

/**
 * One analysed item: what the AI decided and why, the owner's own decision
 * when there is one, and the toggles that override it. A press shows at once
 * (useOptimistic) and falls back with an error toast when the save fails;
 * Next sends Server Actions one at a time, so quick presses save in order.
 * Memoised: every prop is stable per card, so one override re-renders one
 * card, not every card of a large wardrobe (D-174).
 */
const DecisionCard = memo(function DecisionCard({ entry, item, decision, setItemDecision, onSaved }: DecisionCardProps) {
  const labelId = useId()
  const [optimistic, setOptimistic] = useOptimistic(decision)
  const [pending, startTransition] = useTransition()
  const changeable = isChangeable(item)
  const gone = itemGoneLabel(item)
  const name = item?.name ?? "Unknown item"

  function change(next: ItemDecision) {
    if (!changeable || next === optimistic) return
    startTransition(async () => {
      setOptimistic(next)
      // The wardrobe and stats pages show the decision too (D-107).
      const result = noteWardrobeChangeIfOk(await settle(() => setItemDecision({ id: entry.item_id, decision: next })))
      if (!result.ok) {
        toastError(result.error)
        return
      }
      const saved = result.data.decision
      // Updates after an await need their own transition to stay part of this one.
      startTransition(() => onSaved(entry.item_id, saved))
    })
  }

  return (
    <li
      className={cn(
        // content-visibility skips style, layout and paint of cards off screen,
        // which is most of the cost of a tab switch or Back (D-174); auto keeps
        // each card's measured height once it was shown.
        "flex flex-col gap-3 rounded-xl border bg-card p-3 text-card-foreground [contain-intrinsic-size:auto_13rem] [content-visibility:auto]",
        !changeable && "opacity-70"
      )}
      aria-busy={pending || undefined}
    >
      <div className="flex items-start gap-3">
        <ItemThumb item={item} className="size-14" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {item !== undefined && item.exists ? (
              // 44 px tall, so the name is a full touch target on its own.
              <Link
                href={`/wardrobe/${item.id}`}
                className="inline-flex min-h-11 min-w-0 items-center rounded-md font-medium break-words text-pretty underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {name}
              </Link>
            ) : (
              <span className="min-w-0 font-medium break-words text-pretty">{name}</span>
            )}
            {gone !== null ? <Badge variant="outline">{gone}</Badge> : null}
          </div>
          <p className="text-sm">
            <span className="font-medium">AI: {RELOCATION_DECISION_LABELS[entry.decision]}</span>
            <span className="text-muted-foreground"> · {PRIORITY_LABELS[entry.priority]}</span>
          </p>
          <p className="text-sm text-muted-foreground text-pretty">{entry.reason}</p>
          {optimistic !== "undecided" ? (
            <Badge variant="secondary">Yours: {DECISION_LABELS[optimistic]}</Badge>
          ) : null}
        </div>
      </div>
      {changeable ? (
        <div className="flex flex-col gap-1.5">
          <p id={labelId} className="text-xs font-medium text-muted-foreground">
            Your decision <span className="sr-only">for {name}</span>
          </p>
          <ChoiceGroup
            labelId={labelId}
            values={ITEM_DECISIONS}
            labels={DECISION_LABELS}
            value={optimistic}
            onChange={change}
            buttonRef={null}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {gone === "Archived"
            ? "Archived since this run, so its decision cannot be changed here."
            : "Deleted since this run."}
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {pending ? `Saving the decision for ${name}…` : ""}
      </p>
    </li>
  )
})

type ApplyAiDecisionsProps = {
  analysisId: string
  /** Clothing the owner left undecided that can still change, with the AI's decision for each (D-249). */
  undecided: RelocationItemResult[]
  applyAiDecisionsToUndecided: RelocationResultActions["applyAiDecisionsToUndecided"]
  onApplied: (applied: { itemId: string; decision: ItemDecision }[]) => void
  /** The page's own refresh, which knows the applied decisions are saved (D-180). */
  refresh: () => void
}

/** "Apply AI decisions to N undecided items", after a confirmation; never touches the owner's decisions (D-028). */
function ApplyAiDecisions({ analysisId, undecided, applyAiDecisionsToUndecided, onApplied, refresh }: ApplyAiDecisionsProps) {
  const [open, setOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [failure, setFailure] = useState<AppErrorPayload | null>(null)
  // Read by the reset below, which runs outside render.
  const applyingRef = useRef(false)
  const count = undecided.length
  const label = `Apply AI decisions to ${plural(count, "undecided item", "undecided items")}`

  // Next hides this page in an <Activity> on navigation; the confirmation or
  // its error left open would greet the owner on return (preserving-ui-state.md).
  // A dialog waiting for its answer stays, so a failure is still shown.
  useLayoutEffect(
    () => () => {
      if (applyingRef.current) return
      setOpen(false)
      setFailure(null)
    },
    []
  )

  async function apply() {
    applyingRef.current = true
    setApplying(true)
    setFailure(null)
    const result = await settle(() => applyAiDecisionsToUndecided({ analysisId }))
    applyingRef.current = false
    setApplying(false)
    if (!result.ok) {
      setFailure(result.error)
      return
    }
    noteWardrobeChange()
    const updated = new Set(result.data.itemIds)
    onApplied(
      undecided.filter((entry) => updated.has(entry.item_id)).map((entry) => ({ itemId: entry.item_id, decision: entry.decision }))
    )
    setOpen(false)
    toast.add({
      title: `Applied ${plural(result.data.updated, "AI decision", "AI decisions")}`,
      description: "Your own decisions were left as they were.",
      type: "success",
    })
    refresh()
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="touch"
        className="h-auto min-h-11 self-start whitespace-normal text-left"
        onClick={() => {
          setFailure(null)
          setOpen(true)
        }}
        disabled={count === 0}
        // Focus returns here when the dialog closes, also after an apply
        // that leaves nothing undecided; a natively disabled button would
        // refuse it and focus would fall to <body>.
        focusableWhenDisabled
        aria-haspopup="dialog"
      >
        <Sparkles aria-hidden />
        {count === 0 ? "No undecided items left" : label}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          // The request cannot be cancelled once sent; the dialog waits for its answer.
          if (!next && applying) return
          setOpen(next)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Each of these items gets the decision shown on its card. Items you already decided keep your
              decision. You can change any of them afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {failure !== null ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden />
              <AlertTitle>Nothing was applied</AlertTitle>
              <AlertDescription>{failure.message}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel size="touch" disabled={applying}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              size="touch"
              onClick={() => void apply()}
              disabled={applying}
              focusableWhenDisabled
              aria-busy={applying || undefined}
            >
              {applying ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {applying ? "Applying…" : "Apply"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export type ItemsTabProps = {
  view: RelocationViewDto
  decisionOf: (itemId: string) => ItemDecision
  onDecisionSaved: (itemId: string, decision: ItemDecision) => void
  /** Reads the page again after "Apply AI decisions". */
  refresh: () => void
  actions: Pick<RelocationResultActions, "setItemDecision" | "applyAiDecisionsToUndecided">
}

function byPriorityThenName(items: RelocationViewDto["items"]) {
  return (a: RelocationItemResult, b: RelocationItemResult) =>
    a.priority - b.priority || (items[a.item_id]?.name ?? "").localeCompare(items[b.item_id]?.name ?? "")
}

/**
 * The AI's decisions in three columns, Bring, Leave and Donate or sell, side
 * by side from the lg breakpoint; below it a segmented control shows one
 * column at a time. Each card can override the owner's decision.
 */
export function ItemsTab({ view, decisionOf, onDecisionSaved, refresh, actions }: ItemsTabProps) {
  const [column, setColumn] = useState<DecisionColumn>("bring")
  const headingId = useId()
  const sort = byPriorityThenName(view.items)
  const columns = Object.fromEntries(
    DECISION_COLUMNS.map((name) => [
      name,
      view.result.items.filter((entry) => decisionColumn(entry.decision) === name).sort(sort),
    ])
  ) as Record<DecisionColumn, RelocationItemResult[]>
  // The same rows the server writes: still clothing, so an item moved to
  // running gear since the run is not counted (D-249). Its card can still be
  // set by hand.
  const undecided = view.result.items.filter(
    (entry) =>
      isChangeable(view.items[entry.item_id]) &&
      view.items[entry.item_id]?.collection === "clothing" &&
      decisionOf(entry.item_id) === "undecided"
  )

  return (
    <div className="flex flex-col gap-4">
      <ApplyAiDecisions
        analysisId={view.id}
        undecided={undecided}
        applyAiDecisionsToUndecided={actions.applyAiDecisionsToUndecided}
        onApplied={(applied) => applied.forEach(({ itemId, decision }) => onDecisionSaved(itemId, decision))}
        refresh={refresh}
      />
      <ToggleGroup
        variant="outline"
        size="touch"
        spacing={0}
        value={[column]}
        onValueChange={(next) => {
          const [chosen] = next
          if (chosen === "bring" || chosen === "leave" || chosen === "donate_sell") setColumn(chosen)
        }}
        aria-label="Show decisions"
        className="w-full lg:hidden"
      >
        {DECISION_COLUMNS.map((name) => (
          <ToggleGroupItem
            key={name}
            value={name}
            // Wraps instead of pushing the page sideways at 390 px.
            className="h-auto min-h-11 min-w-0 flex-1 px-2 leading-tight whitespace-normal aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90"
          >
            {DECISION_COLUMN_LABELS[name]} ({columns[name].length})
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="grid gap-6 lg:grid-cols-3">
        {DECISION_COLUMNS.map((name) => (
          <section
            key={name}
            aria-labelledby={`${headingId}-${name}`}
            className={cn("flex min-w-0 flex-col gap-3", column !== name && "hidden", "lg:flex")}
          >
            <h3 id={`${headingId}-${name}`} className="font-heading text-base font-semibold">
              {DECISION_COLUMN_LABELS[name]} ({columns[name].length})
            </h3>
            {columns[name].length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing here.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {columns[name].map((entry) => (
                  <DecisionCard
                    key={entry.item_id}
                    entry={entry}
                    item={view.items[entry.item_id]}
                    decision={decisionOf(entry.item_id)}
                    setItemDecision={actions.setItemDecision}
                    onSaved={onDecisionSaved}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
