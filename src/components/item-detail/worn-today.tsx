"use client"

import { Loader2 } from "lucide-react"
import { useCallback } from "react"

import type { WearActions } from "@/components/outfits/outfit-actions"
import { useWearLogger, type WearCounts } from "@/components/outfits/use-wear-logger"
import { Button } from "@/components/ui/button"
import type { ItemDetailDto } from "@/lib/items/wardrobe"

export type WornTodayProps = WearActions & {
  item: Pick<ItemDetailDto, "id" | "status">
  /** The item's display name, for the toast. */
  name: string
  /** The counts the server confirmed after a log or an Undo, for the page to show. */
  onCountsChange: (counts: Pick<ItemDetailDto, "wearCount" | "lastWornAt">) => void
}

/**
 * "+1 worn today" on the item page: logs a wear of this item alone, today in
 * the home time zone, with Undo in the toast for 10 minutes. Logging twice on
 * one day counts once. The wear logger notes the change, so the wardrobe and
 * /stats read the new count when shown (D-107). Archived items cannot be worn.
 */
export function WornToday({ item, name, logWear, undoWear, onCountsChange }: WornTodayProps) {
  const itemId = item.id
  const onCounts = useCallback(
    (items: WearCounts[]) => {
      const counts = items.find((counted) => counted.id === itemId)
      if (counts !== undefined) onCountsChange({ wearCount: counts.wearCount, lastWornAt: counts.lastWornAt })
    },
    [itemId, onCountsChange]
  )
  const { log, pending } = useWearLogger({ logWear, undoWear, onCounts })

  if (item.status === "archived") return null

  return (
    <Button
      type="button"
      variant="outline"
      size="touch"
      className="self-start"
      disabled={pending}
      focusableWhenDisabled
      aria-busy={pending || undefined}
      onClick={() => void log({ kind: "items", itemIds: [itemId] }, { label: name })}
    >
      {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
      +1 worn today
    </Button>
  )
}
