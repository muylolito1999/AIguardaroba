"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"

import { settle } from "@/components/relocate/actions"
import { toast } from "@/components/ui/toast"
import { noteWardrobeChange } from "@/lib/items/wardrobe-changes"
import { toastError } from "@/lib/toast-result"
import { WEAR_UNDO_WINDOW_MS, type LogWearInput, type WearLogResultDto } from "@/lib/wear/contracts"

import type { WearActions } from "./outfit-actions"
import { noteOutfitChange } from "./outfit-changes"

// One way to log a wear for every button that does it: "+1 worn today" on the
// item page, "Wore this today" on an outfit, and the /today suggestions. The
// toast that confirms it carries Undo for the whole undo window. Every change
// the server confirmed is noted, so the wardrobe, the item page and /stats
// read the new counts when shown (D-107), and outfit pages their "Worn N
// times", wherever the owner is when Undo answers. When the answer comes
// while the button's page is no longer shown (Undo pressed on another page),
// the page shown then is read again too: the item page and /today do not
// re-read for changes while shown, since their own saves show at once (D-123,
// D-223).

export type WearCounts = WearLogResultDto["items"][number]

export type WearLoggerOptions = WearActions & {
  /**
   * The counts after a log or an undo the server confirmed; called even after
   * the page was left. `shown` says whether the button's page is still shown:
   * when it is not, the logger has already asked the shown page to read again.
   */
  onCounts?: (items: WearCounts[], context: { shown: boolean }) => void
}

export type LogWearOptions = {
  /** What was worn, for the toast: an item's or an outfit's name. */
  label: string
}

function noteChanges(outfit: boolean): void {
  noteWardrobeChange()
  if (outfit) noteOutfitChange()
}

/**
 * `log(input, { label })` sends the wear and toasts the answer: "Logged" with
 * Undo for WEAR_UNDO_WINDOW_MS, or "Already logged" when every item already
 * had that day's log (nothing to undo). It resolves to the server's answer, or
 * null after an error (already toasted) or while another log is running.
 * `pending` is true while a log runs, for the button's busy state.
 */
export function useWearLogger({ logWear, undoWear, onCounts }: WearLoggerOptions): {
  log: (input: LogWearInput, options: LogWearOptions) => Promise<WearLogResultDto | null>
  pending: boolean
} {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  // The latest callback, for an Undo pressed after a re-render.
  const countsRef = useRef(onCounts)
  useEffect(() => {
    countsRef.current = onCounts
  }, [onCounts])
  // Whether the button's page is shown: Next hiding it in <Activity>, or
  // unmounting it, runs the cleanup; StrictMode's extra mount ends shown.
  const shown = useRef(false)
  useEffect(() => {
    shown.current = true
    return () => {
      shown.current = false
    }
  }, [])

  /** Tells the button's page the new counts; a page shown instead reads itself again. */
  const confirmCounts = useCallback(
    (items: WearCounts[]) => {
      const isShown = shown.current
      countsRef.current?.(items, { shown: isShown })
      // The router's refresh reads whatever page is shown, even from a closure that outlived its component.
      if (!isShown) router.refresh()
    },
    [router]
  )

  const undo = useCallback(
    async (logIds: string[], outfit: boolean) => {
      const result = await settle(() => undoWear({ logIds }))
      if (!result.ok) {
        toastError(result.error)
        return
      }
      noteChanges(outfit)
      confirmCounts(result.data.items)
      toast.add({ title: "Wear undone", type: "success" })
    },
    [undoWear, confirmCounts]
  )

  const log = useCallback(
    async (input: LogWearInput, { label }: LogWearOptions): Promise<WearLogResultDto | null> => {
      if (busy.current) return null
      busy.current = true
      setPending(true)
      const result = await settle(() => logWear(input))
      busy.current = false
      setPending(false)
      if (!result.ok) {
        toastError(result.error)
        return null
      }

      const data = result.data
      const outfit = input.kind === "outfit"
      if (data.logIds.length === 0) {
        toast.add({
          title: "Already logged",
          description: `${label} is already logged as worn ${input.wornOn === undefined ? "today" : "that day"}.`,
          type: "info",
        })
        return data
      }
      noteChanges(outfit)
      confirmCounts(data.items)
      const logIds = data.logIds
      const id = toast.add({
        title: "Logged as worn",
        description: `${label}. You can undo this for 10 minutes.`,
        type: "success",
        // The server refuses an undo after the window, so the button goes with it.
        timeout: WEAR_UNDO_WINDOW_MS,
        actionProps: {
          children: "Undo",
          // A 44 px target; min-height wins over the small button's height.
          className: "min-h-11 px-3",
          onClick: () => {
            toast.close(id)
            void undo(logIds, outfit)
          },
        },
      })
      return data
    },
    [logWear, undo, confirmCounts]
  )

  return { log, pending }
}
