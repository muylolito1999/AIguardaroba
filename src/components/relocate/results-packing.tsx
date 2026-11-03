"use client"

import Link from "next/link"
import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react"
import { ArrowUpRight, Loader2, Plus, Printer, X } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import type { ItemDecision, PackingGroup } from "@/lib/db/enums"
import { focusWasLost } from "@/lib/focus"
import { placeAtDestination, type PackingRowDto, type RelocationItemRefDto, type RelocationViewDto } from "@/lib/relocation/contracts"
import { RELOCATION_LIMITS } from "@/lib/relocation/schemas"
import { useSavedOverlay, type ServerCopy } from "@/lib/saved-since-read"
import { toastError } from "@/lib/toast-result"
import { cn } from "@/lib/utils"

import { settle, type RelocationResultActions } from "./actions"
import { PACKING_GROUP_LABELS, PACKING_GROUP_ORDER, notComingNote, plural } from "./format"
import { ItemRef } from "./item-ref"
import { notePackingChange, notePrintAsked } from "./packing-changes"
import { isChangeable } from "./results-items"

type PackingRowProps = {
  row: PackingRowDto
  packed: boolean
  item: RelocationItemRefDto | undefined
  /** Why the item is no longer coming, in words; null when it is (D-181). A string, so the memo holds. */
  notComing: string | null
  setPackingItemPacked: RelocationResultActions["setPackingItemPacked"]
  onSaved: (rowId: string, packed: boolean) => void
  onRemove: ((row: PackingRowDto) => Promise<void>) | null
}

/**
 * One checklist row: the box is saved at once and falls back with a toast when
 * the save fails. Memoised with stable props, so a tick re-renders its own row
 * and not the other hundred (D-174).
 */
const PackingRow = memo(function PackingRow({
  row,
  packed,
  item,
  notComing,
  setPackingItemPacked,
  onSaved,
  onRemove,
}: PackingRowProps) {
  const baseId = useId()
  const [optimistic, setOptimistic] = useOptimistic(packed)
  const [pending, startTransition] = useTransition()
  const [removing, setRemoving] = useState(false)

  function toggle(next: boolean) {
    startTransition(async () => {
      setOptimistic(next)
      const result = await settle(() => setPackingItemPacked({ id: row.id, packed: next }))
      if (!result.ok) {
        toastError(result.error)
        return
      }
      const saved = result.data.packed
      // The print page may be kept with the older ticks (D-173).
      notePackingChange()
      startTransition(() => onSaved(row.id, saved))
    })
  }

  return (
    // content-visibility skips the style and layout of rows off screen (D-174).
    // It also clips what is painted outside the row, so the row keeps room
    // inside its own box for the 3 px focus rings and the checkbox's wider
    // hit area; the negative margin keeps it aligned with the group (D-182).
    <li
      className="-mx-3.5 flex min-h-11 items-center gap-3 px-3.5 py-1 [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
      aria-busy={pending || removing || undefined}
    >
      <Checkbox
        id={`${baseId}-box`}
        checked={optimistic}
        onCheckedChange={(next) => toggle(next)}
        aria-describedby={notComing === null ? undefined : `${baseId}-note`}
        // 16 px box plus 14 px on each side: a 44 px target.
        className="after:-inset-3.5"
      />
      <div className="flex min-w-0 flex-1 flex-col py-2">
        <label
          htmlFor={`${baseId}-box`}
          className={cn(
            "text-sm break-words text-pretty",
            (optimistic || notComing !== null) && "text-muted-foreground",
            optimistic && "line-through"
          )}
        >
          {row.label}
        </label>
        {notComing !== null ? (
          <span id={`${baseId}-note`} className="text-xs text-muted-foreground">
            {notComing}
          </span>
        ) : null}
      </div>
      {row.itemId !== null && item !== undefined && item.exists ? (
        <Link
          href={`/wardrobe/${item.id}`}
          aria-label={`Open ${row.label}`}
          className={buttonVariants({ variant: "ghost", size: "icon-touch" })}
        >
          <ArrowUpRight aria-hidden />
        </Link>
      ) : null}
      {onRemove !== null ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label={`Remove ${row.label}`}
          disabled={removing}
          // A failed delete keeps the row, and focus stays on its button.
          focusableWhenDisabled
          onClick={() => {
            setRemoving(true)
            void onRemove(row).finally(() => setRemoving(false))
          }}
        >
          {removing ? <Loader2 aria-hidden className="animate-spin" /> : <X aria-hidden />}
        </Button>
      ) : null}
    </li>
  )
})

/** The input that adds a free-text extra to one group. */
function AddExtra({
  group,
  onAdd,
}: {
  group: PackingGroup
  onAdd: (group: PackingGroup, label: string) => Promise<boolean>
}) {
  const inputId = useId()
  const [label, setLabel] = useState("")
  const [adding, setAdding] = useState(false)
  const busy = useRef(false)
  const trimmed = label.trim()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || trimmed === "") return
    busy.current = true
    setAdding(true)
    const added = await onAdd(group, trimmed)
    busy.current = false
    setAdding(false)
    if (added) setLabel("")
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex gap-2">
      <label htmlFor={inputId} className="sr-only">
        Add to {PACKING_GROUP_LABELS[group]}
      </label>
      <Input
        id={inputId}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        maxLength={RELOCATION_LIMITS.extraMax}
        placeholder="Add something, such as an umbrella"
        className="h-11 min-w-0 flex-1"
      />
      <Button
        type="submit"
        variant="outline"
        size="touch"
        disabled={adding || trimmed === ""}
        // Pressed, it is busy and then empty again: a natively disabled button
        // would drop focus to <body>. submit() ignores a press while busy or empty.
        focusableWhenDisabled
        aria-busy={adding || undefined}
      >
        {adding ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
        Add <span className="sr-only">to {PACKING_GROUP_LABELS[group]}</span>
      </Button>
    </form>
  )
}

export type PackingTabProps = {
  view: RelocationViewDto
  /** The page's server copy, which the ticks saved here are kept over (D-180). */
  copy: ServerCopy
  /** The view's rows with extras added or removed on this page (RelocationResults keeps them for the tab count). */
  rows: PackingRowDto[]
  onExtraAdded: (row: PackingRowDto) => void
  onExtraRemoved: (rowId: string) => void
  decisionOf: (itemId: string) => ItemDecision
  actions: Pick<RelocationResultActions, "setPackingItemPacked" | "addPackingExtra" | "deletePackingExtra">
}

/**
 * The persisted packing checklist, by group: suitcase, carry-on, what to wear
 * on the travel day, and what to ship later. Item rows link to the item;
 * extras can be added and removed. Items the owner is bringing that no group
 * holds are listed below, so nothing is forgotten.
 */
export function PackingTab({ view, copy, rows, onExtraAdded, onExtraRemoved, decisionOf, actions }: PackingTabProps) {
  const [packedHere, savePacked] = useSavedOverlay<boolean>(copy)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const deletePackingExtra = actions.deletePackingExtra
  // The row and its Remove button leave with the removal, and focus would fall
  // to <body>: it moves to the count, which says what is left (D-172). A layout
  // effect, so it runs once the row is gone from the DOM (an animation frame
  // can come first), and only when focus was lost.
  const focusStatusNext = useRef(false)
  useLayoutEffect(() => {
    if (!focusStatusNext.current) return
    focusStatusNext.current = false
    if (focusWasLost(document.activeElement)) statusRef.current?.focus()
  }, [rows])

  const packedOf = (row: PackingRowDto) => packedHere.get(row.id) ?? row.packed
  const aiDecisions = new Map(view.result.items.map((entry) => [entry.item_id, entry.decision]))
  // An item the owner (or the AI, where the owner has not decided) no longer
  // brings stays listed with a note, so a change of mind can tick it again,
  // but leaves the counts (D-181).
  const notComingOf = (row: PackingRowDto): string | null =>
    row.itemId === null ? null : notComingNote(decisionOf(row.itemId), aiDecisions.get(row.itemId))
  const isComing = (row: PackingRowDto) => notComingOf(row) === null
  const coming = rows.filter(isComing)
  const packedCount = coming.filter(packedOf).length

  const listed = new Set(rows.map((row) => row.itemId).filter((itemId): itemId is string => itemId !== null))
  // Bring by the owner's decision, or by the AI's where the owner has not decided.
  // Items already at the run's destination or on their way there need no
  // packing (the run never packs them), by where they are now (D-170).
  const unlisted = view.result.items.filter((entry) => {
    const item = view.items[entry.item_id]
    if (listed.has(entry.item_id) || !isChangeable(item)) return false
    if (item.location !== null && placeAtDestination(item.location, view.destination) !== null) return false
    const decision = decisionOf(entry.item_id)
    return decision === "bring" || (decision === "undecided" && entry.decision === "bring")
  })

  async function addExtra(group: PackingGroup, label: string): Promise<boolean> {
    const result = await settle(() => actions.addPackingExtra({ analysisId: view.id, group, label }))
    if (!result.ok) {
      toastError(result.error)
      return false
    }
    onExtraAdded(result.data)
    notePackingChange()
    return true
  }

  // Stable, so the memoised rows keep their props (D-174).
  const removeExtra = useCallback(
    async (row: PackingRowDto): Promise<void> => {
      const result = await settle(() => deletePackingExtra({ id: row.id }))
      if (!result.ok) {
        toastError(result.error)
        return
      }
      focusStatusNext.current = true
      onExtraRemoved(row.id)
      notePackingChange()
    },
    [deletePackingExtra, onExtraRemoved]
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          ref={statusRef}
          tabIndex={-1}
          className="text-sm text-muted-foreground outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
          role="status"
        >
          {packedCount} of {plural(coming.length, "thing", "things")} packed
        </p>
        <Link
          href={`/relocate/${view.id}/print`}
          // A tick still saving when this is pressed answers before the print page shows (D-184).
          onClick={notePrintAsked}
          className={buttonVariants({ variant: "outline", size: "touch" })}
        >
          <Printer aria-hidden />
          Print checklist
        </Link>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {PACKING_GROUP_ORDER.map((group) => {
          const groupRows = rows
            .filter((row) => row.group === group)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
          const groupComing = groupRows.filter(isComing)
          const headingId = `packing-${group}`
          return (
            <section key={group} aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2 rounded-xl border p-4">
              <h3 id={headingId} className="font-heading text-base font-semibold">
                {PACKING_GROUP_LABELS[group]}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({groupComing.filter(packedOf).length} of {groupComing.length})
                </span>
              </h3>
              {groupRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet.</p>
              ) : (
                <ul className="flex flex-col">
                  {groupRows.map((row) => (
                    <PackingRow
                      key={row.id}
                      row={row}
                      packed={packedOf(row)}
                      item={row.itemId === null ? undefined : view.items[row.itemId]}
                      notComing={notComingOf(row)}
                      setPackingItemPacked={actions.setPackingItemPacked}
                      onSaved={savePacked}
                      onRemove={row.itemId === null ? removeExtra : null}
                    />
                  ))}
                </ul>
              )}
              <AddExtra group={group} onAdd={addExtra} />
            </section>
          )
        })}
      </div>
      {unlisted.length > 0 ? (
        <section aria-labelledby="packing-unlisted" className="flex flex-col gap-2">
          <h3 id="packing-unlisted" className="font-heading text-base font-semibold">
            Bring items not in the checklist ({unlisted.length})
          </h3>
          <p className="text-sm text-muted-foreground">
            You are bringing these, but no group holds them. Add them to a group as an extra, or pack them with the
            rest.
          </p>
          <ul className="flex flex-col">
            {unlisted.map((entry) => (
              <li key={entry.item_id}>
                <ItemRef item={view.items[entry.item_id]} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
