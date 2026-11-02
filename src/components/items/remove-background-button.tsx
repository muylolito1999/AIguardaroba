"use client"

import { put } from "@vercel/blob/client"
import { Eraser, Loader2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

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
import { Button } from "@/components/ui/button"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { toast } from "@/components/ui/toast"
import {
  BG_MODEL_DOWNLOAD_MB,
  removeBackgroundFromUrl,
  saveCutout,
  type BgRemovalProgress,
  type SaveCutoutDeps,
} from "@/lib/images/bg-removal"
import type { ItemCardDto } from "@/lib/items/contracts"
import { toErrorPayload } from "@/lib/result"
import { toastError } from "@/lib/toast-result"
import { cn } from "@/lib/utils"

// Optional and separate from tagging (D-034): nothing waits for it, and a
// failure only shows a toast. The model download is large, so the first run
// asks first; the answer is remembered per browser.

/** localStorage key holding "1" once the owner has accepted the model download. */
export const BG_DOWNLOAD_CONSENT_KEY = "wardrobe.bgRemoval.downloadAccepted"

function hasAcceptedDownload(): boolean {
  try {
    return window.localStorage.getItem(BG_DOWNLOAD_CONSENT_KEY) === "1"
  } catch {
    // Storage blocked (private mode, strict settings): ask every time.
    return false
  }
}

function rememberAcceptedDownload(): void {
  try {
    window.localStorage.setItem(BG_DOWNLOAD_CONSENT_KEY, "1")
  } catch {
    // Not remembered; the next run asks again, which is harmless.
  }
}

type RunProgress =
  | BgRemovalProgress
  | { stage: "prepare"; percent: number }
  | { stage: "upload"; percent: number }
  | { stage: "save"; percent: number }

const STEP_LABELS = {
  decode: "Reading the photo",
  inference: "Finding the item",
  mask: "Cutting it out",
  encode: "Cutting it out",
} as const

function stageLabel(progress: RunProgress): string {
  switch (progress.stage) {
    case "prepare":
      return "Getting ready"
    case "download":
      return "Loading the model"
    case "process":
      return STEP_LABELS[progress.step]
    case "upload":
      return "Uploading the cut-out"
    case "save":
      return "Saving"
  }
}

const DEFAULT_SAVE_DEPS: SaveCutoutDeps = {
  fetch: (input, init) => fetch(input, init),
  putBlob: put,
}

export type RemoveBackgroundButtonProps = {
  item: ItemCardDto
  /** Receives the updated card once the cut-out is stored. */
  onDone: (item: ItemCardDto) => void
  className?: string
  /** Injected by tests; the browser's fetch and Blob put otherwise. */
  saveDeps?: SaveCutoutDeps
}

/**
 * Removes the photo's background in the browser, uploads the cut-out and
 * attaches it to the item. Shows the stage and progress while it runs and can
 * be cancelled until the upload has finished.
 */
export function RemoveBackgroundButton({
  item,
  onDone,
  className,
  saveDeps = DEFAULT_SAVE_DEPS,
}: RemoveBackgroundButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [progress, setProgress] = useState<RunProgress | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const running = progress !== null
  const source = item.images.processed

  // Leaving the page (or the card) cancels a run, so it never updates a card that is gone.
  useEffect(() => () => controllerRef.current?.abort(), [])

  async function run() {
    if (source === null || controllerRef.current !== null) return
    const controller = new AbortController()
    const { signal } = controller
    controllerRef.current = controller
    setProgress({ stage: "prepare", percent: 0 })
    try {
      const cutout = await removeBackgroundFromUrl(source.url, { signal, onProgress: setProgress })
      setProgress({ stage: "upload", percent: 0 })
      const result = await saveCutout(saveDeps, {
        itemId: item.id,
        cutout,
        signal,
        onUploadProgress: (percent) => setProgress({ stage: "upload", percent }),
        onUploaded: () => setProgress({ stage: "save", percent: 100 }),
      })
      if (signal.aborted) return
      if (!result.ok) {
        toastError(result.error)
        return
      }
      toast.add({ title: "Background removed", type: "success" })
      onDone(result.data.item)
    } catch (error) {
      if (signal.aborted) return
      // removeBackgroundFromUrl rejects with AppErrors; anything else becomes the generic message.
      toastError(toErrorPayload(error))
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      setProgress(null)
    }
  }

  function start() {
    if (hasAcceptedDownload()) {
      void run()
    } else {
      setConfirmOpen(true)
    }
  }

  function confirm() {
    rememberAcceptedDownload()
    setConfirmOpen(false)
    void run()
  }

  function cancel() {
    controllerRef.current?.abort()
  }

  const canCancel = progress !== null && progress.stage !== "save"

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Button
        type="button"
        variant="outline"
        size="touch"
        className="self-start"
        onClick={start}
        disabled={running || source === null}
        focusableWhenDisabled
        aria-busy={running || undefined}
      >
        {running ? <Loader2 aria-hidden className="animate-spin" /> : <Eraser aria-hidden />}
        {running ? "Removing background…" : item.images.nobg !== null ? "Remove background again" : "Remove background"}
      </Button>

      {progress !== null ? (
        <div className="flex items-center gap-3">
          <Progress value={progress.percent} className="min-w-0 flex-1">
            <ProgressLabel>{stageLabel(progress)}</ProgressLabel>
            <ProgressValue />
          </Progress>
          {canCancel ? (
            <Button type="button" variant="ghost" size="touch" onClick={cancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      {/* Announces stage changes once each, not every percent. */}
      <p className="sr-only" aria-live="polite">
        {progress !== null ? stageLabel(progress) : ""}
      </p>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the background?</AlertDialogTitle>
            <AlertDialogDescription>
              The first time, your browser downloads the background-removal model from IMG.LY and its runtime from
              this app, about {BG_MODEL_DOWNLOAD_MB} MB, and keeps them in its cache. The photo is processed on this
              device and is not sent to IMG.LY. It takes several seconds, longer on a phone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="touch">Not now</AlertDialogCancel>
            <AlertDialogAction size="touch" onClick={confirm}>
              Download and remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
