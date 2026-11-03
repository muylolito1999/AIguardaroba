"use client"

import { Check, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import type { WearActions } from "./outfit-actions"
import { useWearLogger } from "./use-wear-logger"

export type WoreOutfitButtonProps = WearActions & {
  outfitId: string
  outfitName: string
  /** Fewer than one item left: there is nothing to log. */
  disabled?: boolean
  /** The id of the outfit's name on a list, so each of several such buttons says which outfit it logs. */
  describedBy?: string
  className?: string
}

/**
 * "Wore this today": logs a wear of every item in the outfit (one log each,
 * carrying the outfit), with Undo in the toast. The outfit pages read their
 * "Worn N times" again through the outfit change it notes.
 */
export function WoreOutfitButton({
  outfitId,
  outfitName,
  logWear,
  undoWear,
  disabled = false,
  describedBy,
  className,
}: WoreOutfitButtonProps) {
  const { log, pending } = useWearLogger({ logWear, undoWear })
  return (
    <Button
      type="button"
      variant="outline"
      size="touch"
      className={cn(className)}
      disabled={pending || disabled}
      focusableWhenDisabled
      aria-busy={pending || undefined}
      aria-describedby={describedBy}
      onClick={() => void log({ kind: "outfit", outfitId }, { label: outfitName })}
    >
      {pending ? <Loader2 aria-hidden className="animate-spin" /> : <Check aria-hidden />}
      Wore this today
    </Button>
  )
}
