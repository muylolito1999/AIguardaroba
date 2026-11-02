"use client"

import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { CheckCheck, Loader2 } from "lucide-react"

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
import type { TaggingSetup } from "@/components/add/cost-quote"
import type { requestTaggingSetup } from "@/components/add/tagging-setup-request"
import { Button } from "@/components/ui/button"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { ItemCardDto } from "@/lib/items/contracts"
import { err, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"

import type { ReviewActions } from "./review-actions"
import { focusWasLost, ReviewCard, reviewHeadingId } from "./review-card"
import { ReviewEmpty } from "./review-empty"
import { mergeServerItems } from "./review-merge"
import { ReviewTagging } from "./review-tagging"
import { hasTags, isUntouched, itemTitle, lowConfidenceFields } from "./tag-form-model"
import { requestTagging } from "./tag-request"

/** Cards rendered at first; each form has dozens of controls, so long queues load in steps. */
export const REVIEW_PAGE_SIZE = 10

const SUMMARY_ID = "review-summary"
const EMPTY_TITLE_ID = "review-empty-title"

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * Where focus goes once `ids` leave the list: the "All caught up" title when
 * nothing is left, the summary after a bulk confirm, else the card that slides
 * into the first removed card's place, or the one before it.
 */
function focusTargetAfterRemoval(
  previous: readonly ItemCardDto[],
  remaining: readonly ItemCardDto[],
  ids: ReadonlySet<string>,
  focus: "next-card" | "summary"
): string {
  if (remaining.length === 0) return EMPTY_TITLE_ID
  if (focus === "summary") return SUMMARY_ID
  const index = previous.findIndex((item) => ids.has(item.id))
  const neighbour = remaining[index] ?? remaining[index - 1]
  return neighbour ? reviewHeadingId(neighbour.id) : SUMMARY_ID
}

export type ReviewListProps = {
  /** Items with status pending_tagging or tagged, newest first. */
  items: ItemCardDto[]
  actions: ReviewActions
  /** All items waiting for review; larger than items.length when the page capped the list. */
  totalCount: number
  /** The tagging model, rates and budget for the bulk tagging controls, or why they are unavailable. */
  tagging: Result<TaggingSetup>
  /** Injected by tests; POSTs /api/items/[id]/tag otherwise. */
  tagRequest?: typeof requestTagging
  /** Injected by tests; GETs /api/ai/tagging-setup otherwise. */
  setupRequest?: typeof requestTaggingSetup
}

/**
 * The review queue. Holds the cards' current state, removes confirmed items,
 * and moves focus to the next card's heading when one leaves, so keyboard
 * users never land on <body>. "Confirm all untouched" confirms tagged items
 * nobody has edited, saved or unsaved, after a confirmation dialog.
 *
 * With Cache Components the page stays mounted in a hidden <Activity> when
 * the owner navigates away, and a later visit passes this same list a newer
 * `items` array. The list then merges it in (mergeServerItems) instead of
 * remounting, so cards with unsaved edits or a running request keep their
 * state while new items, applied batch results and items confirmed elsewhere
 * show up. The shown page grows by the new items above, so no card that was
 * on screen is pushed past it and unmounted.
 */
export function ReviewList({
  items: initialItems,
  actions,
  totalCount,
  tagging,
  tagRequest = requestTagging,
  setupRequest,
}: ReviewListProps) {
  const [items, setItems] = useState(initialItems)
  const [serverItems, setServerItems] = useState(initialItems)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [visibleCount, setVisibleCount] = useState(REVIEW_PAGE_SIZE)
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmedCount, setConfirmedCount] = useState(0)
  const [announcement, setAnnouncement] = useState("")
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProblem, setBulkProblem] = useState<string | null>(null)
  // Where focus goes after the next list change, and the element that asked
  // for it (Show more stays on screen and keeps focus until then).
  const pendingFocusRef = useRef<{ id: string; from: Element | null } | null>(null)
  const bulkButtonRef = useRef<HTMLButtonElement>(null)
  const summaryRef = useRef<HTMLHeadingElement>(null)
  const bulkConfirmedRef = useRef(false)

  // React's "adjust state when a prop changes": runs during render, before the
  // children see the new list. Not a key, which would also drop unsaved edits.
  if (initialItems !== serverItems) {
    // A capped page lists only the newest items, so a dirty card it no longer
    // lists may just have been pushed out of the window; the merge keeps it.
    const merged = mergeServerItems(items, initialItems, dirtyIds, busyIds, {
      capped: totalCount > initialItems.length,
    })
    // New items arrive at the top (newest first); without this they push a card
    // with unsaved edits or an open hand-tagging form past the page and unmount it.
    const shownIds = new Set(items.slice(0, visibleCount).map((item) => item.id))
    const lastShown = merged.findLastIndex((item) => shownIds.has(item.id))
    const mergedIds = new Set(merged.map((item) => item.id))
    setServerItems(initialItems)
    setItems(merged)
    if (lastShown + 1 > visibleCount) setVisibleCount(lastShown + 1)
    setDirtyIds((previous) => {
      const next = new Set([...previous].filter((id) => mergedIds.has(id)))
      return next.size === previous.size ? previous : next
    })
    setBulkProblem(null)
    // "All caught up" counted this visit's confirmations; the new list starts a new count.
    if (items.length === 0) setConfirmedCount(0)
  }

  // Runs after the list re-renders with cards removed or more cards shown. It
  // leaves focus alone when the owner moved it elsewhere meanwhile (typing in
  // another card while a confirm was running). A layout effect: a passive one
  // still pending from an earlier commit would run first, use the target up
  // while the clicked button still had focus, and focus would then fall to
  // <body> (the same race as on /add).
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current
    if (pending === null) return
    pendingFocusRef.current = null
    const active = document.activeElement
    if (focusWasLost(active) || active === pending.from) document.getElementById(pending.id)?.focus()
  }, [items, visibleCount])

  const handleDirtyChange = useCallback((itemId: string, dirty: boolean) => {
    setDirtyIds((previous) => {
      if (previous.has(itemId) === dirty) return previous
      const next = new Set(previous)
      if (dirty) next.add(itemId)
      else next.delete(itemId)
      return next
    })
  }, [])

  /** Swaps in a fresh server version of an item. */
  const handleItemChange = useCallback((next: ItemCardDto) => {
    setItems((previous) => previous.map((item) => (item.id === next.id ? next : item)))
  }, [])

  /**
   * Changes some fields of the current card. Runs that started from an older
   * render use this, so a newer card (a cut-out that finished meanwhile) keeps
   * what it gained.
   */
  const handleItemPatch = useCallback((itemId: string, patch: Partial<ItemCardDto>) => {
    setItems((previous) => previous.map((item) => (item.id === itemId ? { ...item, ...patch } : item)))
  }, [])

  // Shared by the cards and the bulk run, so neither sends a second paid call
  // for an item the other is already tagging.
  const handleBusyChange = useCallback((itemIds: readonly string[], busy: boolean) => {
    setBusyIds((previous) => {
      const next = new Set(previous)
      for (const id of itemIds) {
        if (busy) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  // Runs after an awaited request, from the closure of the render that started
  // it, so it works on the latest list: results, batch patches and merges that
  // arrived during the request stay.
  function removeItems(ids: ReadonlySet<string>, focus: "next-card" | "summary") {
    setItems((previous) => {
      const remaining = previous.filter((item) => !ids.has(item.id))
      if (remaining.length === previous.length) return previous
      // Writes the same value if StrictMode runs the updater twice.
      pendingFocusRef.current = { id: focusTargetAfterRemoval(previous, remaining, ids, focus), from: null }
      return remaining
    })
    setDirtyIds((previous) => new Set([...previous].filter((id) => !ids.has(id))))
  }

  const handleConfirmed = (item: ItemCardDto) => {
    removeItems(new Set([item.id]), "next-card")
    setConfirmedCount((count) => count + 1)
    setAnnouncement(`${itemTitle(item)} confirmed and moved to your wardrobe.`)
  }

  const untouched = items.filter((item) => isUntouched(item) && !dirtyIds.has(item.id))
  const untouchedUnsure = untouched.filter((item) => lowConfidenceFields(item).size > 0).length
  const taggedCount = items.filter(hasTags).length
  const pendingCount = items.length - taggedCount
  const waitingForTags = items.filter((item) => !hasTags(item) && item.taggingBatchId === null)
  const visible = items.slice(0, visibleCount)
  const hiddenCount = items.length - visible.length
  const capped = totalCount > initialItems.length

  async function confirmUntouched() {
    const ids = untouched.map((item) => item.id)
    bulkConfirmedRef.current = true
    setBulkOpen(false)
    setBulkBusy(true)
    setBulkProblem(null)
    let result: Result<{ confirmed: number }>
    try {
      result = await actions.confirmItems({ ids })
    } catch {
      // A rejected action call means the request itself failed (offline, a platform error page).
      result = err("UPSTREAM", NETWORK_ERROR_MESSAGE)
    } finally {
      setBulkBusy(false)
    }
    if (!result.ok) {
      toastError(result.error)
      // The toast disappears; the line under the summary keeps the reason visible.
      setBulkProblem(result.error.message)
      return
    }
    const { confirmed } = result.data
    if (confirmed !== ids.length) {
      // The action reports a count, not which items; reloading shows the truth.
      setBulkProblem(
        `Confirmed ${confirmed} of ${ids.length} items. Some changed in the meantime; ` +
          "reload the page to see which are left."
      )
      return
    }
    removeItems(new Set(ids), "summary")
    setConfirmedCount((count) => count + confirmed)
    setAnnouncement(`Confirmed ${plural(confirmed, "item", "items")}.`)
  }

  if (items.length === 0) {
    return (
      <>
        <p role="status" className="sr-only">
          {announcement}
        </p>
        <ReviewEmpty afterConfirming={confirmedCount > 0} titleId={EMPTY_TITLE_ID} />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby={SUMMARY_ID}
        className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex flex-col gap-1">
          <h2
            ref={summaryRef}
            id={SUMMARY_ID}
            tabIndex={-1}
            className="font-heading text-base font-semibold outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {plural(items.length, "item", "items")} to review
          </h2>
          <p className="text-sm text-muted-foreground">
            {taggedCount} tagged · {pendingCount} waiting for tags
            {confirmedCount > 0 ? ` · ${confirmedCount} confirmed just now` : ""}
          </p>
          {capped ? (
            <p className="text-sm text-muted-foreground">
              Showing the newest {initialItems.length} of {totalCount}. Reload after confirming these to see
              the rest.
            </p>
          ) : null}
        </div>
        <Button
          ref={bulkButtonRef}
          type="button"
          variant="outline"
          size="touch"
          onClick={() => {
            bulkConfirmedRef.current = false
            setBulkOpen(true)
          }}
          disabled={untouched.length === 0 || bulkBusy}
          focusableWhenDisabled
          aria-haspopup="dialog"
          aria-busy={bulkBusy || undefined}
        >
          {bulkBusy ? <Loader2 aria-hidden className="animate-spin" /> : <CheckCheck aria-hidden />}
          Confirm all untouched ({untouched.length})
        </Button>
      </section>

      {bulkProblem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {bulkProblem}
        </p>
      ) : null}

      <ReviewTagging
        waiting={waitingForTags}
        busyIds={busyIds}
        setup={tagging}
        tagRequest={tagRequest}
        setupRequest={setupRequest}
        startTaggingBatch={actions.startTaggingBatch}
        onItemChange={handleItemChange}
        onItemPatch={handleItemPatch}
        onBusyChange={handleBusyChange}
        returnFocusTo={summaryRef}
      />

      <AlertDialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <AlertDialogContent
          // After confirming, the button may be disabled (nothing left untouched), so
          // focus goes to the summary heading instead.
          finalFocus={() => (bulkConfirmedRef.current ? summaryRef.current : bulkButtonRef.current)}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Confirm {plural(untouched.length, "untouched item", "untouched items")}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {untouched.length === 1 ? "It keeps" : "They keep"} Claude&apos;s tags exactly as they are and move
              to your wardrobe. Items you edited, items with unsaved changes and items still waiting for tags
              stay here.
              {untouchedUnsure > 0
                ? ` ${plural(untouchedUnsure, "of them has", "of them have")} tags Claude was unsure about.`
                : ""}
              {untouched.length > visible.filter((item) => untouched.includes(item)).length
                ? " This includes items further down the list that are not shown yet."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="touch">Cancel</AlertDialogCancel>
            <AlertDialogAction size="touch" onClick={() => void confirmUntouched()}>
              Confirm {untouched.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <p role="status" className="sr-only">
        {announcement}
      </p>

      <ol className="flex flex-col gap-6" aria-label="Items to review">
        {visible.map((item, index) => (
          <li key={item.id}>
            <ReviewCard
              item={item}
              updateItemTags={actions.updateItemTags}
              confirmItem={actions.confirmItem}
              tagItemByHand={actions.tagItemByHand}
              onItemChange={handleItemChange}
              onItemPatch={handleItemPatch}
              onConfirmed={handleConfirmed}
              onDirtyChange={handleDirtyChange}
              busy={busyIds.has(item.id)}
              onBusyChange={handleBusyChange}
              tagRequest={tagRequest}
              eager={index < 2}
            />
          </li>
        ))}
      </ol>

      {hiddenCount > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="self-center"
          onClick={(event) => {
            // Focus the first newly shown card, so keyboard users continue where the list grew.
            const firstNew = items[visibleCount]
            if (firstNew) pendingFocusRef.current = { id: reviewHeadingId(firstNew.id), from: event.currentTarget }
            setVisibleCount((count) => count + REVIEW_PAGE_SIZE)
          }}
        >
          Show {Math.min(hiddenCount, REVIEW_PAGE_SIZE)} more ({hiddenCount} not shown)
        </Button>
      ) : null}
    </div>
  )
}
