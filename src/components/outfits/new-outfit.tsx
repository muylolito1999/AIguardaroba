"use client"

import { useRouter } from "next/navigation"
import { useMemo } from "react"

import { useRefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import { toast } from "@/components/ui/toast"
import type { OutfitSlot } from "@/lib/db/enums"
import type { SlotCandidateDto } from "@/lib/outfits/contracts"
import { useSharedRefresh } from "@/lib/saved-since-read"

import type { SaveOutfitAction } from "./outfit-actions"
import { noteOutfitChange } from "./outfit-changes"
import { OutfitForm } from "./outfit-form"
import { valuesFromOutfit } from "./outfit-form-model"

export type NewOutfitProps = {
  candidates: Readonly<Record<OutfitSlot, readonly SlotCandidateDto[]>>
  saveOutfit: SaveOutfitAction
}

const NO_ITEMS: readonly [] = []

/**
 * /outfits/new: the builder, empty. After a save it starts empty again (Next
 * may keep this page and show it as it was) and the list opens, read fresh by
 * the navigation; the outfit change makes a kept list read too. The pickers
 * show each item's wear count and leave archived items and running gear out
 * (D-249), so the page reads its items again when shown after a wear, an
 * Undo, an archive or a move to running gear elsewhere in the tab (D-107);
 * the choices made so far stay.
 */
export function NewOutfit({ candidates, saveOutfit }: NewOutfitProps) {
  const router = useRouter()
  const refresh = useSharedRefresh()
  useRefreshAfterItemChanges(candidates, refresh)
  const initial = useMemo(() => valuesFromOutfit(null), [])
  return (
    <OutfitForm
      initial={initial}
      candidates={candidates}
      current={NO_ITEMS}
      submitLabel="Save outfit"
      resetOnSave
      onSubmit={(outfit) => saveOutfit({ outfit })}
      onSaved={(saved) => {
        noteOutfitChange()
        toast.add({ title: "Outfit saved", description: saved.name, type: "success" })
        router.push("/outfits")
      }}
    />
  )
}
