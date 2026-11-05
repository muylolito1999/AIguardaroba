"use client"

import { Check } from "lucide-react"

import { PRESSED_CLASSES } from "@/components/items/tag-form-controls"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ITEM_COLLECTIONS, type ItemCollection } from "@/lib/db/enums"
import { cn } from "@/lib/utils"

import type { FiltersChange } from "./use-wardrobe-filters"

// The Clothes | Running switch at the top of /wardrobe (D-251). Each option
// is a view of one collection: the search, filters, sort and chips stay as
// they are and apply to the other collection. The Clothes view is the default
// and hides running gear, as the default statuses hide archived items.

/** Short labels, so both fit side by side on a phone (COLLECTION_LABELS has the badge text). */
const SWITCH_LABELS: Record<ItemCollection, string> = {
  clothing: "Clothes",
  running: "Running",
}

function isCollection(value: unknown): value is ItemCollection {
  return ITEM_COLLECTIONS.some((collection) => collection === value)
}

type CollectionSwitchProps = {
  value: ItemCollection
  onChange: (change: FiltersChange) => void
}

export function CollectionSwitch({ value, onChange }: CollectionSwitchProps) {
  return (
    <ToggleGroup
      aria-label="Show"
      variant="outline"
      size="touch"
      spacing={0}
      value={[value]}
      onValueChange={(next) => {
        // Pressing the pressed option would leave none; the view stays as it is.
        const [chosen] = next
        if (isCollection(chosen) && chosen !== value) onChange({ collection: chosen })
      }}
      // Full width on a phone, two even halves; its own width from sm up.
      className="w-full sm:w-fit"
    >
      {ITEM_COLLECTIONS.map((collection) => (
        <ToggleGroupItem
          key={collection}
          value={collection}
          className={cn("flex-1 gap-2 sm:min-w-32 sm:flex-none", PRESSED_CLASSES)}
        >
          {collection === value ? <Check aria-hidden /> : null}
          {SWITCH_LABELS[collection]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
