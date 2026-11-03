"use client"

import { useRouter } from "next/navigation"
import { useCallback, useId, useRef, useState } from "react"
import { CircleAlert, CloudRain, Loader2, Sparkles, Star, Trash2 } from "lucide-react"

import { useRefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import { PageHeader } from "@/components/layout/page-header"
import { settle } from "@/components/relocate/actions"
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
import type { OutfitSlot } from "@/lib/db/enums"
import type { OutfitDetailDto, SlotCandidateDto } from "@/lib/outfits/contracts"
import type { AppErrorPayload } from "@/lib/result"
import { useSharedRefresh } from "@/lib/saved-since-read"

import { BackToOutfits } from "./back-to-outfits"
import { formatCalendarDay, formatRating, formatTimesWorn, formatWeatherRange } from "./format"
import type { OutfitPageActions } from "./outfit-actions"
import { noteOutfitChange, useRefreshAfterOutfitChanges } from "./outfit-changes"
import { OutfitForm } from "./outfit-form"
import { valuesFromOutfit } from "./outfit-form-model"
import { WoreOutfitButton } from "./wore-outfit-button"

export type OutfitDetailProps = {
  /** The outfit as the server read it; a new object on every read. */
  outfit: OutfitDetailDto
  candidates: Readonly<Record<OutfitSlot, readonly SlotCandidateDto[]>>
  actions: OutfitPageActions
}

/**
 * /outfits/[id]: the outfit's summary with "Wore this today", Claude's reason
 * for an AI suggestion, the builder to edit it, and delete. It shows item
 * names, photos and wear counts, so it reads itself again after an item or
 * outfit change in the tab (D-107); the builder keeps the owner's edits
 * through such a read, and the summary follows the newest copy or save.
 */
export function OutfitDetail({ outfit, candidates, actions }: OutfitDetailProps) {
  const router = useRouter()
  const [shown, setShown] = useState(outfit)
  const [lastServer, setLastServer] = useState(outfit)
  const [deleted, setDeleted] = useState(false)
  const deletedRef = useRef(false)

  if (outfit !== lastServer) {
    setLastServer(outfit)
    setShown(outfit)
  }

  const sharedRefresh = useSharedRefresh()
  // A deleted outfit's page would read the not-found page while it leaves for the list.
  const refresh = useCallback(() => {
    if (!deletedRef.current) sharedRefresh()
  }, [sharedRefresh])
  useRefreshAfterItemChanges(outfit, refresh)
  useRefreshAfterOutfitChanges(outfit, refresh)

  const weather = formatWeatherRange(shown.weatherMinC, shown.weatherMaxC)

  if (deleted) {
    return (
      <div className="flex flex-col gap-4">
        <BackToOutfits />
        <PageHeader title="Outfit deleted" description="Its items are still in your wardrobe." />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <BackToOutfits className="mb-2" />
      <PageHeader
        title={shown.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {shown.source === "ai" ? (
              <Badge variant="secondary">
                <Sparkles aria-hidden />
                AI suggestion
              </Badge>
            ) : null}
            {shown.occasion !== null ? <span>{shown.occasion}</span> : null}
            {weather !== null ? <Badge variant="outline">{weather}</Badge> : null}
            {shown.rainOk ? (
              <Badge variant="outline">
                <CloudRain aria-hidden />
                Fine in rain
              </Badge>
            ) : null}
            {shown.rating !== null ? (
              <Badge variant="outline">
                <Star aria-hidden />
                {formatRating(shown.rating)}
              </Badge>
            ) : null}
          </span>
        }
        actions={
          <WoreOutfitButton
            outfitId={shown.id}
            outfitName={shown.name}
            logWear={actions.logWear}
            undoWear={actions.undoWear}
            disabled={shown.items.length === 0}
          />
        }
      />

      <div className="mb-8 flex flex-col gap-4">
        <p className="text-sm">
          {formatTimesWorn(shown.timesWorn)}
          {shown.lastWornOn !== null ? (
            <span className="text-muted-foreground">
              {", last on "}
              <time dateTime={shown.lastWornOn}>{formatCalendarDay(shown.lastWornOn)}</time>
            </span>
          ) : null}
        </p>
        {shown.aiReasoning !== null && shown.aiReasoning.trim() !== "" ? (
          <section aria-label="Why Claude suggested it" className="max-w-2xl rounded-xl border bg-muted/40 p-4">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-medium">
              <Sparkles aria-hidden className="size-4" />
              Why Claude suggested it
            </h2>
            <p className="text-sm text-pretty">{shown.aiReasoning}</p>
          </section>
        ) : null}
      </div>

      <OutfitForm
        initial={valuesFromOutfit(outfit)}
        candidates={candidates}
        current={shown.items}
        submitLabel="Save changes"
        onSubmit={(input) => actions.saveOutfit({ id: shown.id, outfit: input })}
        onSaved={(saved) => {
          setShown(saved)
          // The list (and this page, through its own check) read the change.
          noteOutfitChange()
          toast.add({ title: "Outfit saved", description: saved.name, type: "success" })
        }}
      />

      <DeleteOutfit
        outfit={shown}
        deleteOutfit={actions.deleteOutfit}
        onDeleted={() => {
          deletedRef.current = true
          setDeleted(true)
          noteOutfitChange()
          toast.add({ title: "Outfit deleted", description: shown.name, type: "success" })
          router.replace("/outfits")
        }}
      />
    </div>
  )
}

type DeleteOutfitProps = {
  outfit: OutfitDetailDto
  deleteOutfit: OutfitPageActions["deleteOutfit"]
  onDeleted: () => void
}

function DeleteOutfit({ outfit, deleteOutfit, onDeleted }: DeleteOutfitProps) {
  const headingId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<AppErrorPayload | null>(null)

  async function confirmDelete() {
    if (deleting) return
    setDeleting(true)
    setError(null)
    const result = await settle(() => deleteOutfit({ id: outfit.id }))
    setDeleting(false)
    // Deleted elsewhere already: the outfit is gone either way.
    if (result.ok || result.error.code === "NOT_FOUND") {
      setOpen(false)
      onDeleted()
      return
    }
    setError(result.error)
  }

  return (
    <section
      aria-labelledby={headingId}
      className="mt-10 flex max-w-2xl flex-col gap-3 rounded-xl border border-destructive/30 p-4"
    >
      <h2 id={headingId} className="font-heading text-lg font-semibold">
        Delete outfit
      </h2>
      <p className="text-sm text-muted-foreground">Its items stay in your wardrobe, with their wear counts.</p>
      {/* A plain button rather than AlertDialogTrigger, so the dialog can hand focus back to it. */}
      <Button
        ref={buttonRef}
        type="button"
        variant="destructive"
        size="touch"
        className="self-start"
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        <Trash2 aria-hidden />
        Delete outfit
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          // The request cannot be cancelled once sent; the dialog waits for its answer.
          if (!next && deleting) return
          setOpen(next)
        }}
      >
        <AlertDialogContent finalFocus={buttonRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {outfit.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The outfit is deleted. Its items stay in your wardrobe, and their wear counts and wear history do not
              change. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error !== null ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden />
              <AlertTitle>Not deleted</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
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
    </section>
  )
}
