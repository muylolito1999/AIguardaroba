"use client"

import { useId, useMemo, useState, type RefObject } from "react"
import { Check, Search } from "lucide-react"

import { CATEGORY_LABELS, LOCATION_LABELS } from "@/components/items/tag-options"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { OutfitSlot } from "@/lib/db/enums"
import { MAX_ACCESSORIES, type SlotCandidateDto } from "@/lib/outfits/contracts"

import { formatTimesWorn, formatTimestampDay } from "./format"
import { ItemThumb } from "./outfit-thumbs"

/** Longest search text; a name is far shorter. */
const SEARCH_MAX = 100

export const PICK_TITLES: Readonly<Record<OutfitSlot, string>> = {
  outerwear: "Choose outerwear",
  base_layer: "Choose a base layer",
  top: "Choose a top or dress",
  bottom: "Choose a bottom",
  shoes: "Choose shoes",
  hat: "Choose a hat",
  gloves: "Choose gloves",
  scarf: "Choose a scarf",
  accessory: "Add an accessory",
}

export type SlotPickerDialogProps = {
  /** The slot being filled; null when the dialog is closed. */
  slot: OutfitSlot | null
  /** The slot's items (its categories, not archived, clothing only: D-249), by name. */
  candidates: readonly SlotCandidateDto[]
  /** Items already in the outfit: shown as chosen and not offered again. */
  chosenIds: ReadonlySet<string>
  onChoose: (candidate: SlotCandidateDto) => void
  onClose: () => void
  /** Where focus returns when the dialog closes: the button that opened it. */
  finalFocus?: RefObject<HTMLElement | null>
}

/**
 * The picker for one slot: a search over the slot's items, each with its
 * photo, wear count, last wear and where it is. One responsive dialog, as the
 * shopping link picker: full width with a 1 rem margin on a phone.
 */
export function SlotPickerDialog({ slot, candidates, chosenIds, onChoose, onClose, finalFocus }: SlotPickerDialogProps) {
  return (
    <Dialog
      open={slot !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent finalFocus={finalFocus} className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_1fr] sm:max-w-md">
        {slot !== null ? (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle>{PICK_TITLES[slot]}</DialogTitle>
              <DialogDescription>
                {slot === "accessory"
                  ? `Up to ${MAX_ACCESSORIES} accessories or bags. Items worn least recently are a good pick.`
                  : "Items worn least recently are a good pick."}
              </DialogDescription>
            </DialogHeader>
            {/* Mounted only while open, so every opening starts with an empty search. */}
            <SlotSearch candidates={candidates} chosenIds={chosenIds} onChoose={onChoose} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function matches(candidate: SlotCandidateDto, query: string): boolean {
  if (query === "") return true
  const words = [
    candidate.name,
    candidate.subcategory ?? "",
    CATEGORY_LABELS[candidate.category],
    ...candidate.colors,
  ]
  return words.some((word) => word.toLowerCase().includes(query))
}

/** "Never worn", "Worn 3 times, last 2 Nov 2026". */
function wearLine(candidate: SlotCandidateDto): string {
  const times = formatTimesWorn(candidate.wearCount)
  if (candidate.wearCount === 0 || candidate.lastWornAt === null) return times
  return `${times}, last ${formatTimestampDay(candidate.lastWornAt)}`
}

type SlotSearchProps = Pick<SlotPickerDialogProps, "candidates" | "chosenIds" | "onChoose">

function SlotSearch({ candidates, chosenIds, onChoose }: SlotSearchProps) {
  const inputId = useId()
  const resultsId = useId()
  const [query, setQuery] = useState("")
  const normalized = query.trim().toLowerCase()
  const shown = useMemo(() => candidates.filter((candidate) => matches(candidate, normalized)), [candidates, normalized])

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-medium">
          Search
        </label>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={inputId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={SEARCH_MAX}
            autoComplete="off"
            placeholder="Name, type or colour"
            aria-controls={resultsId}
            className="h-11 pl-9"
          />
        </div>
      </div>

      <div id={resultsId} className="min-h-0 overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground" role="status">
            You have no items for this slot yet.
          </p>
        ) : shown.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground" role="status">
            No items match “{query.trim()}”.
          </p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Items">
            {shown.map((candidate) => {
              const chosen = chosenIds.has(candidate.id)
              return (
                <li key={candidate.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-14 w-full justify-start gap-3 px-2 py-1.5 text-left whitespace-normal"
                    onClick={() => onChoose(candidate)}
                    disabled={chosen}
                    focusableWhenDisabled
                  >
                    {/* Decorative next to the name; hidden so "no photo" does not join the button's name. */}
                    <span aria-hidden className="shrink-0">
                      <ItemThumb url={candidate.thumbUrl} alt="" className="size-12" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium break-words">{candidate.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {CATEGORY_LABELS[candidate.category]} · {LOCATION_LABELS[candidate.location]}
                      </span>
                      <span className="text-xs text-muted-foreground">{wearLine(candidate)}</span>
                    </span>
                    {chosen ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Check aria-hidden className="size-3.5" />
                        Chosen
                      </span>
                    ) : null}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
