"use client"

import { useId, useLayoutEffect, useRef, useState } from "react"
import Link from "next/link"
import { CircleAlert, Link2, Loader2, Trash2, Unlink } from "lucide-react"

import { ItemPhoto } from "@/components/items/item-photo"
import { CATEGORY_LABELS } from "@/components/items/tag-options"
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
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { focusWasLost } from "@/lib/focus"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { ShoppingItemDto } from "@/lib/relocation/contracts"
import { err, type AppErrorPayload, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"
import { cn } from "@/lib/utils"

import { LinkItemDialog } from "./link-item-dialog"
import type { ShoppingActions } from "./shopping-actions"
import { BUY_TIMING_LABELS, formatEurRange, REASON_COLLAPSE_CHARS, type LinkableItemDto } from "./shopping-model"
import { StatusControl } from "./status-control"

/** Runs an action; a rejected call (offline, an action unknown after a redeploy) becomes a network error. */
async function settle<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call()
  } catch {
    return err("UPSTREAM", NETWORK_ERROR_MESSAGE)
  }
}

export type ShoppingRowProps = {
  item: ShoppingItemDto
  actions: Pick<ShoppingActions, "updateShoppingItem" | "deleteShoppingItem" | "searchLinkableItems">
  /** The server saved a change to the row. */
  onSaved: (item: ShoppingItemDto) => void
  /** The server deleted the row. */
  onDeleted: (id: string) => void
}

/** One shopping list entry: what it is and why, its status, the owned item it is linked to, and Delete. */
export function ShoppingRow({ item, actions, onSaved, onDeleted }: ShoppingRowProps) {
  const titleId = useId()
  const [linkOpen, setLinkOpen] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<AppErrorPayload | null>(null)
  // Whichever of "Link to an item I own" and Unlink is shown: the link
  // dialog returns focus through it after a link (when Unlink has replaced
  // the link button), and unlink() focuses the link button through it.
  const linkControlRef = useRef<HTMLButtonElement>(null)
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  // Whether the page is shown (Next hides kept pages in an <Activity>, which
  // cleans layout effects up), and whether an Unlink that answered while it
  // was asks for focus on the link button that replaces it.
  const shown = useRef(false)
  const focusLinkNext = useRef(false)

  // Next hides this page in an <Activity> on navigation; a dialog left open
  // would greet the owner on return (preserving-ui-state.md).
  useLayoutEffect(() => {
    shown.current = true
    return () => {
      shown.current = false
      focusLinkNext.current = false
      setLinkOpen(false)
      setDeleteOpen(false)
      setDeleteError(null)
    }
  }, [])

  // After Unlink, focus moves to "Link to an item I own" once the commit that
  // removes Unlink is done (an animation frame can come before it), and only
  // when focus was lost: never from a field the owner moved to meanwhile
  // (D-172, D-182).
  useLayoutEffect(() => {
    if (!focusLinkNext.current) return
    focusLinkNext.current = false
    if (focusWasLost(document.activeElement)) linkControlRef.current?.focus()
  }, [item.linkedItem])

  const price = formatEurRange(item.estPriceMinEur, item.estPriceMaxEur)
  const facts = [
    item.quantity > 1 ? `${item.quantity} pieces` : null,
    item.category === null ? null : CATEGORY_LABELS[item.category],
    item.buyTiming === null ? null : BUY_TIMING_LABELS[item.buyTiming],
  ].filter((fact): fact is string => fact !== null)

  async function link(chosen: LinkableItemDto): Promise<boolean> {
    const result = await settle(() => actions.updateShoppingItem({ id: item.id, linkedItemId: chosen.id }))
    if (!result.ok) {
      toastError(result.error)
      return false
    }
    onSaved(result.data)
    setLinkOpen(false)
    toast.add({ title: "Linked", description: `${item.itemType}: you own ${chosen.name}.`, type: "success" })
    return true
  }

  async function unlink() {
    setUnlinking(true)
    const result = await settle(() => actions.updateShoppingItem({ id: item.id, linkedItemId: null }))
    setUnlinking(false)
    if (!result.ok) {
      toastError(result.error)
      return
    }
    // The Unlink button leaves with this save; the link button takes its place.
    // An answer that comes while Next hides the page moves no focus on return.
    focusLinkNext.current = shown.current
    onSaved(result.data)
  }

  async function confirmDelete() {
    setDeleting(true)
    setDeleteError(null)
    const result = await settle(() => actions.deleteShoppingItem({ id: item.id }))
    if (!result.ok) {
      setDeleting(false)
      // Shown in the dialog, which stays open: the row is untouched.
      setDeleteError(result.error)
      return
    }
    toast.add({ title: "Removed from your list", description: item.itemType, type: "success" })
    onDeleted(item.id)
  }

  return (
    <li aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={titleId} className="font-medium break-words">
            {item.itemType}
          </h3>
          {facts.length > 0 ? <p className="text-sm text-muted-foreground">{facts.join(" · ")}</p> : null}
          {price !== null ? (
            <p className="text-sm">
              {price}
              {item.quantity > 1 ? " each" : ""}
            </p>
          ) : null}
        </div>
        <Button
          ref={deleteButtonRef}
          type="button"
          variant="ghost"
          size="icon-touch"
          className="-mt-2 -mr-2 shrink-0"
          aria-label={`Delete ${item.itemType}`}
          aria-haspopup="dialog"
          onClick={() => {
            setDeleteError(null)
            setDeleteOpen(true)
          }}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>

      {item.specs.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Specs for ${item.itemType}`}>
          {item.specs.map((spec, index) => (
            <li key={`${index}-${spec}`} className="max-w-full rounded-md bg-muted px-2 py-0.5 text-xs break-words">
              {spec}
            </li>
          ))}
        </ul>
      ) : null}

      {item.reason !== "" ? <Reason text={item.reason} /> : null}

      <StatusControl
        id={item.id}
        itemType={item.itemType}
        status={item.status}
        updateShoppingItem={actions.updateShoppingItem}
        onSaved={onSaved}
      />

      {item.linkedItem !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden className="shrink-0">
            <ItemPhoto image={item.linkedItem.thumb} alt="" className="size-11" />
          </span>
          <p className="min-w-0 flex-1 text-sm">
            You own:{" "}
            <Link href={`/wardrobe/${item.linkedItem.id}`} className="font-medium break-words underline underline-offset-4">
              {item.linkedItem.name}
            </Link>
          </p>
          <Button
            ref={linkControlRef}
            type="button"
            variant="outline"
            size="touch"
            onClick={() => void unlink()}
            disabled={unlinking}
            focusableWhenDisabled
            aria-busy={unlinking || undefined}
            aria-label={`Unlink ${item.linkedItem.name} from ${item.itemType}`}
          >
            {unlinking ? <Loader2 aria-hidden className="animate-spin" /> : <Unlink aria-hidden />}
            Unlink
          </Button>
        </div>
      ) : (
        <Button
          ref={linkControlRef}
          type="button"
          variant="outline"
          size="touch"
          className="self-start"
          aria-haspopup="dialog"
          onClick={() => setLinkOpen(true)}
        >
          <Link2 aria-hidden />
          Link to an item I own
        </Button>
      )}

      <LinkItemDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        itemType={item.itemType}
        searchLinkableItems={actions.searchLinkableItems}
        onChoose={link}
        finalFocus={linkControlRef}
      />

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          // The request cannot be cancelled once sent; the dialog waits for its answer.
          if (!open && deleting) return
          setDeleteOpen(open)
        }}
      >
        <AlertDialogContent finalFocus={deleteButtonRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {item.itemType}?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed from your shopping list. Items you own are not changed.
              {item.gapKey !== null ? " Adding the plan's gaps again brings it back." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError !== null ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden />
              <AlertTitle>Not deleted</AlertTitle>
              <AlertDescription>{deleteError.message}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel size="touch" disabled={deleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="touch"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              focusableWhenDisabled
              aria-busy={deleting || undefined}
            >
              {deleting ? <Loader2 aria-hidden className="animate-spin" /> : <Trash2 aria-hidden />}
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

/** The reason, collapsed to two lines when it is long. */
function Reason({ text }: { text: string }) {
  const textId = useId()
  const [expanded, setExpanded] = useState(false)
  if (text.length <= REASON_COLLAPSE_CHARS) {
    return <p className="text-sm text-pretty text-muted-foreground">{text}</p>
  }
  return (
    <div className="flex flex-col items-start">
      <p id={textId} className={cn("text-sm text-pretty text-muted-foreground", !expanded && "line-clamp-2")}>
        {text}
      </p>
      <Button
        type="button"
        variant="link"
        size="touch"
        className="px-0"
        aria-expanded={expanded}
        aria-controls={textId}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? "Show less" : "Show more"}
      </Button>
    </div>
  )
}
