"use client"

import Link from "next/link"
import { Check, CloudRain, FolderOpen, Loader2, Save, Shirt } from "lucide-react"

import { formatTimesWorn, itemProblemLabel } from "@/components/outfits/format"
import { ItemThumb } from "@/components/outfits/outfit-thumbs"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { SLOT_LABELS } from "@/lib/outfits/contracts"

import type { SuggestedOutfitDto } from "./today-model"

export type SuggestionCardProps = {
  outfit: SuggestedOutfitDto
  /** Unique on the page, for the heading's id. */
  cardId: string
  /** The outfit Save made, shown over the server's copy until that copy has it. */
  savedOutfitId: string | null
  wornToday: boolean
  saving: boolean
  wearing: boolean
  onSave: () => void
  onWore: () => void
}

/**
 * One suggested outfit: its items with their slots, Claude's reason, whether
 * it keeps the owner dry, and Save and "Wore this today". An outfit whose
 * item was deleted, archived or moved to running gear since offers neither
 * (D-250); that item carries a badge saying which.
 */
export function SuggestionCard({
  outfit,
  cardId,
  savedOutfitId,
  wornToday,
  saving,
  wearing,
  onSave,
  onWore,
}: SuggestionCardProps) {
  const titleId = `${cardId}-title`
  return (
    <article
      aria-labelledby={titleId}
      className="flex h-full min-w-0 flex-col gap-4 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={titleId} className="min-w-0 font-heading text-base font-semibold text-pretty">
          {outfit.title}
        </h3>
        {outfit.rainOk ? (
          <Badge variant="secondary">
            <CloudRain aria-hidden />
            Rain-ready
          </Badge>
        ) : (
          <Badge variant="outline">Not for rain</Badge>
        )}
      </header>

      <ul aria-label={`Items in ${outfit.title}`} className="flex flex-col gap-2">
        {outfit.items.map((item) => {
          const problem = itemProblemLabel(item)
          return (
            <li key={item.itemId} className="flex min-w-0 items-center gap-3">
              <ItemThumb url={item.thumbUrl} alt="" className="size-12" />
              <div className="flex min-w-0 flex-col">
                <span className="text-xs text-muted-foreground">
                  {SLOT_LABELS[item.slot]}
                  {item.exists ? <> · {formatTimesWorn(item.wearCount)}</> : null}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm font-medium">
                  <span className="min-w-0 break-words">{item.name}</span>
                  {problem === null ? null : <Badge variant="destructive">{problem}</Badge>}
                </span>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="text-sm text-pretty">{outfit.why}</p>

      {outfit.available ? null : (
        <p className="text-sm text-destructive-strong">
          An item of this outfit was deleted, archived or moved to running gear, so it can no longer be saved or logged.
        </p>
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        {savedOutfitId !== null ? (
          <Link
            id={`${cardId}-open`}
            href={`/outfits/${savedOutfitId}`}
            className={buttonVariants({ variant: "outline", size: "touch" })}
          >
            <FolderOpen aria-hidden />
            Open saved outfit <span className="sr-only">{outfit.title}</span>
          </Link>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={!outfit.available || saving}
            focusableWhenDisabled
            aria-busy={saving || undefined}
            onClick={onSave}
          >
            {saving ? <Loader2 aria-hidden className="animate-spin" /> : <Save aria-hidden />}
            Save <span className="sr-only">{outfit.title}</span>
          </Button>
        )}
        <Button
          type="button"
          size="touch"
          disabled={!outfit.available || wornToday || wearing}
          focusableWhenDisabled
          aria-busy={wearing || undefined}
          onClick={onWore}
        >
          {wearing ? <Loader2 aria-hidden className="animate-spin" /> : wornToday ? <Check aria-hidden /> : <Shirt aria-hidden />}
          {wornToday ? "Worn today" : "Wore this today"} <span className="sr-only">({outfit.title})</span>
        </Button>
      </div>
    </article>
  )
}
