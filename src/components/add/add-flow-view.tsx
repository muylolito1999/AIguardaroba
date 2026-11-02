"use client"

import { CircleAlert } from "lucide-react"
import Link from "next/link"
import { useCallback, useLayoutEffect, useRef, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { toast } from "@/components/ui/toast"
import { isLikelyImageFile } from "@/lib/images/client-pipeline"
import type { Result } from "@/lib/result"

import type { TaggingSetup } from "./cost-quote"
import { FilePickers } from "./file-pickers"
import { QueueList, removeButtonId } from "./queue-list"
import { TaggingBar } from "./tagging-bar"
import { useAddFlow, type AddFlowDeps } from "./use-add-flow"
import { useLeaveGuard } from "./use-leave-guard"
import { hasWorkInFlight, leaveWarning, progressAnnouncement } from "./upload-queue"

export type AddFlowProps = {
  /**
   * The tagging model, its rates and the month's budget, read on the server
   * when the page renders, or why they could not be read (a CONFIG problem),
   * which disables only tagging.
   */
  setup: Result<TaggingSetup>
}

const QUEUE_HEADING_ID = "add-queue-heading"
/** Focus styles for the elements that only receive focus from code. */
const FOCUS_TARGET = "outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"

function elementById(id: string | undefined): HTMLElement | null {
  return id === undefined ? null : document.getElementById(id)
}

/** The add flow with its dependencies passed in; AddFlow supplies the real ones. */
export function AddFlowView({ setup: serverSetup, deps }: AddFlowProps & { deps: AddFlowDeps }) {
  // The setup the controls use: the server's, replaced by later re-reads.
  const [setup, setSetup] = useState(serverSetup)
  const [setupFromServer, setSetupFromServer] = useState(serverSetup)
  if (serverSetup !== setupFromServer) {
    // React's "adjust state when a prop changes": a new server render wins.
    setSetupFromServer(serverSetup)
    setSetup(serverSetup)
  }

  // Each run of tagging and each batch start spends budget, so "left this
  // month" is read again. A failed read keeps the last numbers; only the
  // latest read is applied.
  const readsRef = useRef(0)
  const rereadSetup = useCallback(() => {
    readsRef.current += 1
    const read = readsRef.current
    void deps.api.taggingSetup().then((result) => {
      if (result.ok && read === readsRef.current) setSetup(result)
    })
  }, [deps])

  const flow = useAddFlow(deps, { serverSetup, taggingAvailable: setup.ok, onTaggingSettled: rereadSetup })
  const { entries, budgetBlock } = flow.state
  const { counts } = flow
  // Leaving hides the page (cacheComponents keeps it in a hidden <Activity>),
  // which the flow treats as leaving: it cancels uploads and queued tagging
  // calls and empties the list.
  const guard = useLeaveGuard(hasWorkInFlight(counts))

  // Where focus goes once the list has re-rendered after Remove or Retry,
  // whose buttons leave with the change. Resolved after the commit, so the
  // target exists.
  const pendingFocusRef = useRef<(() => HTMLElement | null) | null>(null)
  const pickersRef = useRef<HTMLDivElement>(null)

  // A layout effect, not a passive one: a passive effect still pending from an
  // earlier background commit (an upload that just failed) runs when the click's
  // update starts rendering, after the handler set the ref, and would use the
  // ref up while the clicked button is still focused. Layout effects never stay
  // pending across events.
  useLayoutEffect(() => {
    const resolve = pendingFocusRef.current
    if (resolve === null) return
    pendingFocusRef.current = null
    // A Retry that changed nothing leaves focus where it was.
    const active = document.activeElement
    if (active !== null && active !== document.body && active.isConnected) return
    resolve()?.focus()
  }, [entries])

  function handleFiles(files: File[]) {
    const photos = files.filter(isLikelyImageFile)
    const skipped = files.length - photos.length
    if (skipped > 0) {
      toast.add({
        title: `Skipped ${skipped} ${skipped === 1 ? "file" : "files"}`,
        description: "Only photos can be added, such as JPEG, PNG, WebP or HEIC.",
        type: "warning",
      })
    }
    flow.addFiles(photos)
  }

  function handleRemove(key: string) {
    const index = entries.findIndex((entry) => entry.key === key)
    const next = entries[index + 1]?.key
    const previous = index > 0 ? entries[index - 1]?.key : undefined
    // The row that moves into its place, else the one before it, else the
    // list's heading; with the list gone, the photo picker.
    pendingFocusRef.current = () =>
      elementById(next === undefined ? undefined : removeButtonId(next)) ??
      elementById(previous === undefined ? undefined : removeButtonId(previous)) ??
      elementById(QUEUE_HEADING_ID) ??
      pickersRef.current?.querySelector<HTMLElement>('input[type="file"]:not([capture])') ??
      null
    flow.remove(key)
  }

  function handleRetry(key: string, retry: (key: string) => void) {
    // The Retry button goes away once the row is working again; its row stays.
    pendingFocusRef.current = () => elementById(removeButtonId(key))
    retry(key)
  }

  return (
    <div className="flex flex-col gap-6">
      <div ref={pickersRef}>
        <FilePickers onFiles={handleFiles} />
      </div>

      {setup.ok ? null : (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Tagging is unavailable</AlertTitle>
          <AlertDescription>
            <p>{setup.error.message}</p>
            <p>Photos can still be uploaded and reviewed.</p>
          </AlertDescription>
        </Alert>
      )}

      {budgetBlock === null ? null : (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>AI budget reached</AlertTitle>
          <AlertDescription>
            <p>{budgetBlock.message}</p>
            <p>
              No new tagging starts until then. <Link href="/settings/usage">See AI usage</Link>
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Present from the first render, so later changes are announced. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {progressAnnouncement(counts)}
      </p>

      {entries.length > 0 ? (
        <section aria-labelledby={QUEUE_HEADING_ID} className="flex flex-col gap-3">
          <h2 id={QUEUE_HEADING_ID} tabIndex={-1} className={`font-heading text-base font-semibold ${FOCUS_TARGET}`}>
            Photos
          </h2>
          <QueueList
            entries={entries}
            taggingBlocked={budgetBlock !== null || !setup.ok}
            onRetryUpload={(key) => handleRetry(key, flow.retryUpload)}
            onRetryTag={(key) => handleRetry(key, flow.retryTag)}
            onRemove={handleRemove}
          />
        </section>
      ) : null}

      {counts.ready > 0 ? (
        <TaggingBar
          counts={counts}
          setup={setup.ok ? setup.data : null}
          taggingBlocked={budgetBlock !== null}
          batchPending={flow.batchPending}
          onStartTagging={flow.startTagging}
          onStartBatch={() => void flow.startBatch()}
        />
      ) : null}

      <AlertDialog
        open={guard.pendingHref !== null}
        onOpenChange={(open) => {
          if (!open) guard.stay()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this page?</AlertDialogTitle>
            <AlertDialogDescription>{leaveWarning(counts, { batchPending: flow.batchPending })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="touch">Stay here</AlertDialogCancel>
            <AlertDialogAction size="touch" variant="destructive" onClick={guard.leave}>
              Leave anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
