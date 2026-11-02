"use client"

import { useLayoutEffect, useRef, useState } from "react"
import Link from "next/link"
import { CircleAlert, Clock, Loader2, PencilLine, Sparkles } from "lucide-react"

import { ItemTagForm } from "@/components/items/item-tag-form"
import type { TagItemByHandAction } from "@/components/items/review-actions"
import type { requestTagging } from "@/components/items/tag-request"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { ItemCardDto, TagData } from "@/lib/items/contracts"
import { err, type Result } from "@/lib/result"

export type PendingTagsProps = {
  item: ItemCardDto
  tagItemByHand: TagItemByHandAction
  tagRequest: typeof requestTagging
  /** The item now has tags (from Claude or by hand); receives the server's card. */
  onTagged: (item: ItemCardDto) => void
  /** A tagging attempt failed; the reason is stored on the item, as the server does. */
  onTaggingError: (message: string) => void
}

/**
 * The detail page's controls for an item without tags: the review card's
 * "Tag now" (or "Retry tagging" after a failure, D-022) and "Fill in by hand"
 * (D-093), here so an item older than the review page's newest 200 can still
 * be tagged. An item waiting in a batch points to the review page instead,
 * which applies finished batch results on every visit and offers "Tag now
 * instead" behind its billing warning (D-083, D-094).
 */
export function PendingTags({ item, tagItemByHand, tagRequest, onTagged, onTaggingError }: PendingTagsProps) {
  const [busy, setBusy] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const fillInButtonRef = useRef<HTMLButtonElement>(null)
  const focusFillInRef = useRef(false)
  // A new attempt hides the previous reason until it has its own outcome.
  const error = busy ? null : item.taggingError
  const batchId = item.taggingBatchId
  const inBatch = batchId !== null && error === null

  // Cancel brings the controls back; focus returns to the button that opened the form.
  useLayoutEffect(() => {
    if (manualOpen || !focusFillInRef.current) return
    focusFillInRef.current = false
    fillInButtonRef.current?.focus()
  }, [manualOpen])

  async function tag() {
    setBusy(true)
    let result: Result<TagData>
    try {
      // Only an item still linked to a batch needs force; the batch id lets the
      // server answer with the batch's tags if they were applied meanwhile.
      result = batchId === null ? await tagRequest(item.id) : await tagRequest(item.id, { force: true, batchId })
    } catch {
      result = err("UPSTREAM", NETWORK_ERROR_MESSAGE)
    }
    setBusy(false)
    if (!result.ok) {
      onTaggingError(result.error.message)
      return
    }
    onTagged(result.data.item)
  }

  if (manualOpen) {
    return (
      <ItemTagForm
        mode="manual"
        item={item}
        tagItemByHand={tagItemByHand}
        // The page's quick toggles own decision and location.
        showPlans={false}
        onItemChange={(next) => {
          setManualOpen(false)
          onTagged(next)
        }}
        onConfirmed={(next) => {
          setManualOpen(false)
          onTagged(next)
        }}
        onCancel={() => {
          focusFillInRef.current = true
          setManualOpen(false)
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground text-pretty">
        {inBatch
          ? "This item is waiting in a tagging batch. Results usually arrive within an hour; the review page " +
            "applies them each time it opens."
          : "This item has no tags yet. Ask Claude to tag it, or fill in the tags yourself."}
      </p>
      {error !== null ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>Tagging failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {inBatch ? (
        <Link href="/add/review" className={buttonVariants({ variant: "outline", size: "touch", className: "self-start" })}>
          <Clock aria-hidden />
          Open the review page
        </Link>
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
          {/* The server refuses hand tags for an item linked to a batch. */}
          {batchId !== null ? null : (
            <Button
              ref={fillInButtonRef}
              type="button"
              variant="outline"
              size="touch"
              onClick={() => setManualOpen(true)}
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
