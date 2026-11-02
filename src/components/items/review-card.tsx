"use client"

import { useEffect, useRef, useState, type Ref } from "react"
import { CircleAlert, Clock, Layers, Loader2, PencilLine, Sparkles } from "lucide-react"

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
import { focusWasLost } from "@/lib/focus"
import type { ItemCardDto } from "@/lib/items/contracts"

import { ItemPhoto } from "./item-photo"
import { ItemTagForm } from "./item-tag-form"
import { RemoveBackgroundButton } from "./remove-background-button"
import type { ConfirmItemAction, TagItemByHandAction, UpdateItemTagsAction } from "./review-actions"
import { cardPhoto, hasTags, itemTitle, lowConfidenceFields, type HintField } from "./tag-form-model"
import { requestTagging } from "./tag-request"

/** id of a card's heading; the list moves focus there after a neighbouring card leaves. */
export function reviewHeadingId(itemId: string): string {
  return `review-item-${itemId}`
}

const HINT_LABELS: Record<HintField, string> = {
  category: "category",
  colors: "colours",
  materials: "materials",
  warmth_level: "warmth",
  waterproof: "waterproof",
  windproof: "windproof",
  insulated: "insulated",
  formality: "formality",
  condition: "condition",
  brand: "brand",
}

function listPhrase(words: string[]): string {
  if (words.length <= 1) return words.join("")
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

export type ReviewCardProps = {
  item: ItemCardDto
  updateItemTags: UpdateItemTagsAction
  confirmItem: ConfirmItemAction
  tagItemByHand: TagItemByHandAction
  /** Replaces the card with a fresh server version of the item. */
  onItemChange: (item: ItemCardDto) => void
  /** Changes some fields of the list's current card, so a newer card (a finished cut-out) is not undone. */
  onItemPatch: (itemId: string, patch: Partial<ItemCardDto>) => void
  onConfirmed: (item: ItemCardDto) => void
  onDirtyChange: (itemId: string, dirty: boolean) => void
  /** A tagging request for this item is running, from this card or the list's bulk run. */
  busy?: boolean
  onBusyChange?: (itemIds: readonly string[], busy: boolean) => void
  /** Injected by tests; POSTs /api/items/[id]/tag otherwise. */
  tagRequest?: typeof requestTagging
  /** Load the photo at once (the first cards on screen). */
  eager?: boolean
}

/**
 * One item in the review list: photo, badges and either the tag form (tagged
 * items), the tagging controls (items still waiting for tags) or the same
 * form filled in by hand (D-093).
 */
export function ReviewCard({
  item,
  updateItemTags,
  confirmItem,
  tagItemByHand,
  onItemChange,
  onItemPatch,
  onConfirmed,
  onDirtyChange,
  busy = false,
  onBusyChange,
  tagRequest = requestTagging,
  eager = false,
}: ReviewCardProps) {
  const headingId = reviewHeadingId(item.id)
  const articleRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusAfterTaggingRef = useRef(false)
  const fillInButtonRef = useRef<HTMLButtonElement>(null)
  const focusFillInRef = useRef(false)
  const [manualOpen, setManualOpen] = useState(false)
  const tagged = hasTags(item)
  const manual = manualOpen && !tagged
  const hints = tagged ? [...lowConfidenceFields(item).keys()].map((field) => HINT_LABELS[field]) : []

  // "Tag now" disappears once the form replaces it; the heading takes focus so
  // keyboard and screen-reader users land at the top of the new form. Not
  // when the owner moved on to another card during the call.
  useEffect(() => {
    if (tagged && focusAfterTaggingRef.current) {
      focusAfterTaggingRef.current = false
      const active = document.activeElement
      if (focusWasLost(active) || articleRef.current?.contains(active)) headingRef.current?.focus()
    }
  }, [tagged])

  // Cancel brings the tagging controls back; focus returns to the button that opened the form.
  useEffect(() => {
    if (!manual && focusFillInRef.current) {
      focusFillInRef.current = false
      fillInButtonRef.current?.focus()
    }
  }, [manual])

  function handleTagged(next: ItemCardDto) {
    focusAfterTaggingRef.current = true
    onItemChange(next)
  }

  // The open form counts as busy, so the list's bulk run and a batch leave the
  // item out. Reported from the handlers rather than an effect, whose cleanup
  // would also run when the page is hidden (Activity) and drop the mark.
  function openManual() {
    onBusyChange?.([item.id], true)
    setManualOpen(true)
  }

  function closeManual() {
    setManualOpen(false)
    onBusyChange?.([item.id], false)
    onDirtyChange(item.id, false)
  }

  return (
    <article ref={articleRef} aria-labelledby={headingId} className="rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
      <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3 md:sticky md:top-4 md:self-start">
          <ItemPhoto
            image={cardPhoto(item)}
            alt={item.name ?? "Photo of an item that has no tags yet"}
            loading={eager ? "eager" : "lazy"}
            className="mx-auto aspect-square w-full max-w-xs md:max-w-none"
          />
          {/* Optional and independent of tagging (D-034); it works from the processed photo. */}
          {item.images.processed !== null ? (
            <RemoveBackgroundButton item={item} onDone={onItemChange} className="self-center md:self-stretch" />
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <header className="flex flex-col gap-2">
            <h2
              ref={headingRef}
              id={headingId}
              tabIndex={-1}
              className="font-heading text-lg font-semibold break-words text-balance outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {itemTitle(item)}
            </h2>
            <div className="flex flex-wrap gap-2">
              {!tagged ? <Badge variant="secondary">Waiting for tags</Badge> : null}
              {item.multipleItemsDetected ? (
                <Badge variant="outline">
                  <Layers aria-hidden />
                  Several items in photo
                </Badge>
              ) : null}
              {item.taggingBatchId !== null ? (
                <Badge variant="outline">
                  <Clock aria-hidden />
                  In batch
                </Badge>
              ) : null}
            </div>
            {item.multipleItemsDetected ? (
              <p className="text-sm text-muted-foreground">
                Claude saw more than one item and tagged the most prominent one.
              </p>
            ) : null}
            {hints.length > 0 ? (
              <p className="text-sm text-amber-800 dark:text-amber-300">
                Claude was unsure about {listPhrase(hints)}. Check the highlighted fields.
              </p>
            ) : null}
            {tagged && item.taggingError !== null ? (
              <p className="text-sm text-destructive">Last tagging attempt failed: {item.taggingError}</p>
            ) : null}
          </header>
          {tagged ? (
            <ItemTagForm
              item={item}
              updateItemTags={updateItemTags}
              confirmItem={confirmItem}
              onItemChange={onItemChange}
              onConfirmed={onConfirmed}
              onDirtyChange={onDirtyChange}
              tagRequest={tagRequest}
            />
          ) : manual ? (
            <ItemTagForm
              mode="manual"
              item={item}
              tagItemByHand={tagItemByHand}
              onItemChange={(next) => {
                closeManual()
                handleTagged(next)
              }}
              onConfirmed={(next) => {
                closeManual()
                onConfirmed(next)
              }}
              onDirtyChange={onDirtyChange}
              onCancel={() => {
                focusFillInRef.current = true
                closeManual()
              }}
            />
          ) : (
            <PendingTagging
              item={item}
              busy={busy}
              onBusyChange={onBusyChange}
              onTagged={handleTagged}
              onItemPatch={onItemPatch}
              onFillIn={openManual}
              fillInButtonRef={fillInButtonRef}
              tagRequest={tagRequest}
            />
          )}
        </div>
      </div>
    </article>
  )
}

type PendingTaggingProps = {
  item: ItemCardDto
  busy: boolean
  onBusyChange: ((itemIds: readonly string[], busy: boolean) => void) | undefined
  onTagged: (item: ItemCardDto) => void
  onItemPatch: (itemId: string, patch: Partial<ItemCardDto>) => void
  /** Opens the tag form to fill in by hand. */
  onFillIn: () => void
  fillInButtonRef: Ref<HTMLButtonElement>
  tagRequest: typeof requestTagging
}

/**
 * Tag now, or Retry after a failure. Failed items stay pending_tagging with
 * the reason (D-022), which lives on the item itself, so a failure from the
 * list's bulk run shows here too. An item waiting in a batch offers "Tag now
 * instead" behind a confirmation, because the batch result is billed anyway.
 * Items in no batch can also be filled in by hand, which is the way out for a
 * photo Claude refuses (D-093).
 */
function PendingTagging({
  item,
  busy: listBusy,
  onBusyChange,
  onTagged,
  onItemPatch,
  onFillIn,
  fillInButtonRef,
  tagRequest,
}: PendingTaggingProps) {
  const [ownBusy, setOwnBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const busy = ownBusy || listBusy
  // A new attempt hides the previous reason until it has its own outcome.
  const error = busy ? null : item.taggingError
  const batchId = item.taggingBatchId
  const linkedToBatch = batchId !== null
  const inBatch = linkedToBatch && error === null

  async function tag() {
    setOwnBusy(true)
    onBusyChange?.([item.id], true)
    // Only an item still linked to a batch needs force: without it the server
    // refuses to pay twice for the same photo. The batch id lets the server
    // answer with the batch's tags instead when the batch was applied meanwhile.
    const result =
      batchId === null ? await tagRequest(item.id) : await tagRequest(item.id, { force: true, batchId })
    setOwnBusy(false)
    onBusyChange?.([item.id], false)
    if (!result.ok) {
      // A patch, not a copy of this render's item: a cut-out may have finished meanwhile.
      onItemPatch(item.id, { taggingError: result.error.message })
      return
    }
    onTagged(result.data.item)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {inBatch
          ? "This item is in a batch. Results usually arrive within an hour, " +
            "and this page applies them each time it loads."
          : "Claude has not tagged this item yet."}
      </p>
      {error !== null ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>Tagging failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {inBatch ? (
        <>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="self-start"
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
            focusableWhenDisabled
            aria-haspopup="dialog"
            aria-busy={busy || undefined}
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
            {busy ? "Tagging…" : "Tag now instead"}
          </Button>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Tag this item now?</AlertDialogTitle>
                <AlertDialogDescription>
                  Claude tags it right away at the normal price. The batch still returns a result for this item
                  later; that result is billed at the batch price but not used.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel size="touch">Keep waiting</AlertDialogCancel>
                <AlertDialogAction
                  size="touch"
                  onClick={() => {
                    setConfirmOpen(false)
                    void tag()
                  }}
                >
                  Tag now
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="touch"
            onClick={() => void tag()}
            disabled={busy}
            focusableWhenDisabled
            aria-busy={busy || undefined}
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Sparkles aria-hidden />}
            {busy ? "Tagging…" : error !== null ? "Retry tagging" : "Tag now"}
          </Button>
          {/* The server refuses hand tags for an item in a batch, so a linked item never offers them. */}
          {linkedToBatch ? null : (
            <Button
              ref={fillInButtonRef}
              type="button"
              variant="outline"
              size="touch"
              onClick={onFillIn}
              disabled={busy}
              focusableWhenDisabled
            >
              <PencilLine aria-hidden />
              Fill in by hand
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
