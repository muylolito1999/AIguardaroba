"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useId, useRef, useState } from "react"
import { Loader2, ShoppingBag, ShoppingCart } from "lucide-react"

import { CATEGORY_LABELS } from "@/components/items/tag-options"
import { noteShoppingListChange } from "@/components/shopping/shopping-changes"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { toast } from "@/components/ui/toast"
import type { RelocationViewDto } from "@/lib/relocation/contracts"
import { priorityGapsMinimumEur, type RelocationGap } from "@/lib/relocation/schemas"
import { useSavedOverlay, type ServerCopy } from "@/lib/saved-since-read"
import { toastError } from "@/lib/toast-result"
import { cn } from "@/lib/utils"

import { settle, type RelocationResultActions } from "./actions"
import { BUY_TIMING_LABELS, PRIORITY_LABELS, formatEur, formatEurRange, plural } from "./format"

function GapCard({
  gap,
  checked,
  onList,
  onCheckedChange,
}: {
  gap: RelocationGap
  checked: boolean
  onList: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const baseId = useId()
  const price = formatEurRange(gap.est_price_range_eur.min, gap.est_price_range_eur.max)
  return (
    <li className={cn("flex gap-3 rounded-xl border bg-card p-4 text-card-foreground", onList && "bg-muted/40")}>
      {/* The checkbox's own hit area plus the label's make the 44 px target. */}
      <Checkbox
        id={`${baseId}-check`}
        checked={checked || onList}
        disabled={onList}
        onCheckedChange={(next) => onCheckedChange(next)}
        aria-describedby={`${baseId}-why`}
        className="mt-1 after:-inset-3.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${baseId}-check`} className="min-w-0 font-medium break-words text-pretty">
            {gap.item_type}
          </label>
          <Badge variant="secondary">{CATEGORY_LABELS[gap.category]}</Badge>
          <Badge variant="outline">{PRIORITY_LABELS[gap.priority]}</Badge>
          {onList ? <Badge>On your shopping list</Badge> : null}
        </div>
        <p id={`${baseId}-why`} className="text-sm text-pretty">
          {gap.why_needed}
        </p>
        {gap.specs.length > 0 ? (
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {gap.specs.map((spec) => (
              <li key={spec}>{spec}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {gap.quantity > 1 ? `${gap.quantity} × ${price} each` : price} ·{" "}
          {BUY_TIMING_LABELS[gap.buy_before_or_after_move]}
        </p>
      </div>
    </li>
  )
}

/** The add button's text: the count to add, or why there is nothing to add. */
function addButtonLabel(adding: boolean, count: number, allOnList: boolean): string {
  if (adding) return "Adding…"
  if (count > 0) return `Add ${count} to shopping list`
  return allOnList ? "All gaps are on your shopping list" : "Select gaps to add"
}

export type GapsTabProps = {
  view: RelocationViewDto
  /** The page's server copy, which the gaps added here are kept over (D-180). */
  copy: ServerCopy
  addGapsToShoppingList: RelocationResultActions["addGapsToShoppingList"]
}

/**
 * What to buy. Every gap starts selected (D-029), so one press adds them all
 * to the shopping list; adding is idempotent on the gap key, and gaps already
 * there show checked and locked.
 */
export function GapsTab({ view, copy, addGapsToShoppingList }: GapsTabProps) {
  const router = useRouter()
  const gaps = view.result.gaps
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(gaps.map((gap) => gap.gap_key)))
  const [addedHere, markAdded] = useSavedOverlay<true>(copy)
  const [adding, setAdding] = useState(false)
  const busy = useRef(false)
  const onList = (gapKey: string) => view.addedGapKeys.includes(gapKey) || addedHere.has(gapKey)
  const toAdd = gaps.filter((gap) => selected.has(gap.gap_key) && !onList(gap.gap_key)).map((gap) => gap.gap_key)
  const anyOnList = gaps.some((gap) => onList(gap.gap_key))
  const allOnList = gaps.every((gap) => onList(gap.gap_key))
  const budget = view.params.purchaseBudgetEur
  const minimum = priorityGapsMinimumEur(gaps)

  function toggle(gapKey: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(gapKey)
      else next.delete(gapKey)
      return next
    })
  }

  async function add() {
    if (busy.current || toAdd.length === 0) return
    busy.current = true
    setAdding(true)
    const keys = toAdd
    const result = await settle(() => addGapsToShoppingList({ analysisId: view.id, gapKeys: keys }))
    busy.current = false
    setAdding(false)
    if (!result.ok) {
      toastError(result.error)
      return
    }
    keys.forEach((key) => markAdded(key, true))
    // /shopping, kept hidden by Next after an earlier visit, reads itself again on
    // Back, and so does this page once it is shown again (D-173). No refresh now:
    // the overlay shows what was added, and a refresh still in flight when the
    // owner opens the list at once would land as a copy that counts as current
    // although it was read before a gap deleted there.
    if (result.data.added > 0) noteShoppingListChange()
    const { added, alreadyThere } = result.data
    toast.add({
      title: added > 0 ? `Added ${plural(added, "item", "items")} to your shopping list` : "Already on your shopping list",
      // "1 was there already.", "2 were there already."
      description: alreadyThere > 0 ? `${plural(alreadyThere, "was", "were")} there already.` : undefined,
      type: "success",
      actionProps: { children: "Open list", onClick: () => router.push("/shopping") },
    })
  }

  if (gaps.length === 0) {
    return <p className="text-sm text-muted-foreground">No gaps: what you own covers the climate.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      {budget !== null ? (
        <p className={cn("text-sm", minimum > budget ? "text-destructive" : "text-muted-foreground")}>
          Priority 1 and 2 gaps cost at least {formatEur(minimum)} of your {formatEur(budget)} budget.
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {gaps.map((gap) => (
          <GapCard
            key={gap.gap_key}
            gap={gap}
            checked={selected.has(gap.gap_key)}
            onList={onList(gap.gap_key)}
            onCheckedChange={(checked) => toggle(gap.gap_key, checked)}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="touch"
          onClick={() => void add()}
          disabled={adding || toAdd.length === 0}
          focusableWhenDisabled
          aria-busy={adding || undefined}
        >
          {adding ? <Loader2 aria-hidden className="animate-spin" /> : <ShoppingCart aria-hidden />}
          {addButtonLabel(adding, toAdd.length, allOnList)}
        </Button>
        {anyOnList ? (
          <Link href="/shopping" className={buttonVariants({ variant: "outline", size: "touch" })}>
            <ShoppingBag aria-hidden />
            Open shopping list
          </Link>
        ) : null}
      </div>
    </div>
  )
}
