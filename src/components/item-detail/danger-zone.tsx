"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Archive, ArchiveRestore, CircleAlert, Loader2, Trash2 } from "lucide-react"

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
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { ItemDetailDto } from "@/lib/items/wardrobe"
import { noteWardrobeChange } from "@/lib/items/wardrobe-changes"
import { err, type AppErrorPayload, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"

import type { ArchiveItemAction, DeleteItemAction, UnarchiveItemAction } from "./detail-actions"

/** Runs an action; a rejected call (offline, an action unknown after a redeploy) becomes a network error. */
async function settle<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call()
  } catch {
    return err("UPSTREAM", NETWORK_ERROR_MESSAGE)
  }
}

/**
 * What the unarchive toast says about the status the item came back to
 * (D-128): confirmed only when the owner had confirmed it before archiving.
 */
export function unarchivedDescription(name: string, status: ItemDetailDto["status"]): string {
  if (status === "confirmed") return `${name} is confirmed again.`
  if (status === "tagged") return `${name} is back on the review page, with its tags still to check.`
  return `${name} is waiting for tags again.`
}

export type DangerZoneProps = {
  item: Pick<ItemDetailDto, "id" | "status" | "wearCount">
  /** The item's display name, for the dialog and the toasts. */
  name: string
  archiveItem: ArchiveItemAction
  unarchiveItem: UnarchiveItemAction
  deleteItem: DeleteItemAction
  /** Archive or Unarchive succeeded; receives the server's detail. */
  onStatusChange: (item: ItemDetailDto) => void
}

/**
 * Archive (reversible, from any status) and Delete (final, behind a
 * confirmation). After a delete the page is replaced by the wardrobe, so Back
 * does not return to an item that no longer exists.
 */
export function DangerZone({ item, name, archiveItem, unarchiveItem, deleteItem, onStatusChange }: DangerZoneProps) {
  const router = useRouter()
  const [archiving, setArchiving] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<AppErrorPayload | null>(null)
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const archived = item.status === "archived"

  // Next hides this page in an <Activity> on navigation; a dialog left open
  // would greet the owner on return (the reset from preserving-ui-state.md).
  useLayoutEffect(() => {
    return () => {
      setDialogOpen(false)
      setDeleteError(null)
    }
  }, [])

  async function toggleArchive() {
    setArchiving(true)
    const result = await settle(() => (archived ? unarchiveItem({ id: item.id }) : archiveItem({ id: item.id })))
    setArchiving(false)
    if (!result.ok) {
      toastError(result.error)
      return
    }
    onStatusChange(result.data)
    toast.add({
      title: archived ? "Back in your wardrobe" : "Archived",
      description: archived
        ? unarchivedDescription(name, result.data.status)
        : `${name} is hidden from the wardrobe and the relocation plan.`,
      type: "success",
    })
  }

  async function confirmDelete() {
    setDeleting(true)
    setDeleteError(null)
    const result = await settle(() => deleteItem({ id: item.id }))
    if (!result.ok) {
      setDeleting(false)
      // Shown in the dialog, which stays open: the item and its photos are untouched.
      setDeleteError(result.error)
      return
    }
    // deleting stays true: the page is about to be replaced. Lists kept in
    // Next's back/forward cache still show the item until they read again (D-107).
    noteWardrobeChange()
    toast.add({ title: "Item deleted", description: `${name} and its photos are gone.`, type: "success" })
    router.replace("/wardrobe")
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground text-pretty">
          {archived
            ? "This item is archived: it is hidden from the wardrobe and left out of the relocation plan."
            : "Archiving hides the item from the wardrobe and the relocation plan. You can unarchive it at any time."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="self-start"
          onClick={() => void toggleArchive()}
          disabled={archiving}
          focusableWhenDisabled
          aria-busy={archiving || undefined}
        >
          {archiving ? <Loader2 aria-hidden className="animate-spin" /> : archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
          {archived ? "Unarchive" : "Archive"}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground text-pretty">
          Deleting removes the item and its photos for good.
        </p>
        {/* A plain button rather than AlertDialogTrigger, so the dialog can hand focus back to it. */}
        <Button
          ref={deleteButtonRef}
          type="button"
          variant="destructive"
          size="touch"
          className="self-start"
          onClick={() => {
            setDeleteError(null)
            setDialogOpen(true)
          }}
          aria-haspopup="dialog"
        >
          <Trash2 aria-hidden />
          Delete item
        </Button>
        <AlertDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            // The request cannot be cancelled once sent; the dialog waits for its answer.
            if (!open && deleting) return
            setDialogOpen(open)
          }}
        >
          <AlertDialogContent finalFocus={deleteButtonRef}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The item and its photos are deleted, including from photo storage
                {item.wearCount > 0 ? ", along with its wear history" : ""}. Outfits that include it lose it;
                shopping and packing lists keep their entries. This cannot be undone. To only hide it, archive it
                instead.
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
      </div>
    </div>
  )
}
