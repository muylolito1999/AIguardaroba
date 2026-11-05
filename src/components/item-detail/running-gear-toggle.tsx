"use client"

import { useId, useOptimistic, useTransition } from "react"

import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import type { ItemCollection } from "@/lib/db/enums"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { ItemCardDto } from "@/lib/items/contracts"
import { err, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"

import type { SetItemCollectionAction } from "./detail-actions"

export type RunningGearToggleProps = {
  itemId: string
  /** The saved collection. */
  collection: ItemCollection
  setItemCollection: SetItemCollectionAction
  /** The server saved the move; receives the server's item. */
  onSaved: (item: ItemCardDto) => void
}

/**
 * Moves an item into or out of running gear, from any status (D-252). Running
 * gear stays out of outfits, Today's suggestions, the stats breakdowns and
 * relocation (D-249). Like the plan toggles, the switch flips at once
 * (useOptimistic) and falls back to the saved value when the save fails, with
 * an error toast. Off means clothing.
 */
export function RunningGearToggle({ itemId, collection, setItemCollection, onSaved }: RunningGearToggleProps) {
  const controlId = useId()
  const descriptionId = useId()
  const [optimistic, setOptimistic] = useOptimistic(collection)
  const [pending, startTransition] = useTransition()

  function change(checked: boolean) {
    const next: ItemCollection = checked ? "running" : "clothing"
    if (next === optimistic) return
    startTransition(async () => {
      setOptimistic(next)
      let result: Result<ItemCardDto>
      try {
        result = await setItemCollection({ id: itemId, collection: next })
      } catch {
        // Offline, a platform error page, or an action unknown after a redeploy.
        result = err("UPSTREAM", NETWORK_ERROR_MESSAGE)
      }
      if (!result.ok) {
        toastError(result.error)
        return
      }
      const saved = result.data
      // Updates after an await need their own transition to stay part of this one.
      startTransition(() => onSaved(saved))
    })
  }

  return (
    <div className="flex flex-col" aria-busy={pending || undefined}>
      <Field orientation="horizontal" className="min-h-11 items-center justify-between gap-4">
        <FieldContent>
          <FieldLabel htmlFor={controlId}>Running gear</FieldLabel>
          <FieldDescription id={descriptionId}>
            Kept out of outfits, Today&apos;s suggestions, the stats breakdowns and relocation.
          </FieldDescription>
        </FieldContent>
        <Switch
          id={controlId}
          checked={optimistic === "running"}
          onCheckedChange={(checked) => change(checked)}
          aria-describedby={descriptionId}
          // Taller invisible hit area: 18 px switch plus 14 px above and below is 46 px.
          className="after:-inset-y-3.5"
        />
      </Field>
      <p className="sr-only" aria-live="polite">
        {pending ? "Saving running gear…" : ""}
      </p>
    </div>
  )
}
