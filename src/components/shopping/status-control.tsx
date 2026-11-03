"use client"

import { useId, useOptimistic, useTransition } from "react"

import { ChoiceGroup } from "@/components/items/tag-form-controls"
import { SHOPPING_STATUSES, type ShoppingStatus } from "@/lib/db/enums"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { ShoppingItemDto } from "@/lib/relocation/contracts"
import { err, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"

import type { UpdateShoppingItemAction } from "./shopping-actions"
import { SHOPPING_STATUS_LABELS } from "./shopping-model"

export type StatusControlProps = {
  id: string
  /** What the row is, for the group's accessible name ("Status of Rain shell"). */
  itemType: string
  /** The saved status. */
  status: ShoppingStatus
  updateShoppingItem: UpdateShoppingItemAction
  /** The server saved the change; receives the updated row. */
  onSaved: (item: ShoppingItemDto) => void
}

/**
 * To buy / Bought / Skipped, saved on every press. The pressed option changes
 * at once (useOptimistic) and falls back to the saved status when the save
 * fails, with an error toast. Next sends Server Actions one at a time, so
 * quick presses are saved in order and the last one wins.
 */
export function StatusControl({ id, itemType, status, updateShoppingItem, onSaved }: StatusControlProps) {
  const labelId = useId()
  const [optimistic, setOptimistic] = useOptimistic(status)
  const [pending, startTransition] = useTransition()

  function change(next: ShoppingStatus) {
    if (next === optimistic) return
    startTransition(async () => {
      setOptimistic(next)
      let result: Result<ShoppingItemDto>
      try {
        result = await updateShoppingItem({ id, status: next })
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
    <div className="flex min-w-0 flex-col gap-1.5" aria-busy={pending || undefined}>
      <span id={labelId} className="sr-only">
        Status of {itemType}
      </span>
      <ChoiceGroup
        labelId={labelId}
        values={SHOPPING_STATUSES}
        labels={SHOPPING_STATUS_LABELS}
        value={optimistic}
        onChange={change}
        buttonRef={null}
      />
      <p className="sr-only" aria-live="polite">
        {pending ? `Saving the status of ${itemType}…` : ""}
      </p>
    </div>
  )
}
