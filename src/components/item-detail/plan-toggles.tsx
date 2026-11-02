"use client"

import { useId, useOptimistic, useTransition } from "react"

import { ChoiceGroup } from "@/components/items/tag-form-controls"
import { DECISION_LABELS, LOCATION_LABELS } from "@/components/items/tag-options"
import { ITEM_DECISIONS, ITEM_LOCATIONS, type ItemDecision, type ItemLocation } from "@/lib/db/enums"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type { ItemCardDto } from "@/lib/items/contracts"
import { err, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"

import type { SetItemDecisionAction, SetItemLocationAction } from "./detail-actions"

type PlanToggleProps<T extends string> = {
  label: string
  values: readonly T[]
  labels: Record<T, string>
  /** The saved value. */
  value: T
  /** Saves a new value; resolves to the server's item. */
  save: (value: T) => Promise<Result<ItemCardDto>>
  /** The server saved the value. */
  onSaved: (item: ItemCardDto) => void
}

/**
 * One single-select group that saves on every press. The pressed option
 * changes at once (useOptimistic) and falls back to the saved value when the
 * save fails, with an error toast. Next sends Server Actions one at a time,
 * so quick presses are saved in order and the last one wins.
 */
function PlanToggle<T extends string>({ label, values, labels, value, save, onSaved }: PlanToggleProps<T>) {
  const labelId = useId()
  const [optimistic, setOptimistic] = useOptimistic(value)
  const [pending, startTransition] = useTransition()

  function change(next: T) {
    if (next === optimistic) return
    startTransition(async () => {
      setOptimistic(next)
      let result: Result<ItemCardDto>
      try {
        result = await save(next)
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
    <div className="flex flex-col gap-2" aria-busy={pending || undefined}>
      <h3 id={labelId} className="text-sm font-medium">
        {label}
      </h3>
      <ChoiceGroup
        labelId={labelId}
        values={values}
        labels={labels}
        value={optimistic}
        onChange={change}
        buttonRef={null}
      />
      <p className="sr-only" aria-live="polite">
        {pending ? `Saving ${label.toLowerCase()}…` : ""}
      </p>
    </div>
  )
}

export type PlanTogglesProps = {
  itemId: string
  decision: ItemDecision
  location: ItemLocation
  setItemDecision: SetItemDecisionAction
  setItemLocation: SetItemLocationAction
  /** Receives the field the toggle owns, so newer state from elsewhere (a re-tag, a cut-out) is not undone. */
  onDecisionSaved: (decision: ItemDecision) => void
  onLocationSaved: (location: ItemLocation) => void
}

/** The move plan and the current place of an item, each saved as soon as it is pressed. */
export function PlanToggles({
  itemId,
  decision,
  location,
  setItemDecision,
  setItemLocation,
  onDecisionSaved,
  onLocationSaved,
}: PlanTogglesProps) {
  return (
    <div className="flex flex-col gap-5">
      <PlanToggle
        label="Plan for the move"
        values={ITEM_DECISIONS}
        labels={DECISION_LABELS}
        value={decision}
        save={(next) => setItemDecision({ id: itemId, decision: next })}
        onSaved={(item) => onDecisionSaved(item.decision)}
      />
      <PlanToggle
        label="Where it is now"
        values={ITEM_LOCATIONS}
        labels={LOCATION_LABELS}
        value={location}
        save={(next) => setItemLocation({ id: itemId, location: next })}
        onSaved={(item) => onLocationSaved(item.location)}
      />
    </div>
  )
}
