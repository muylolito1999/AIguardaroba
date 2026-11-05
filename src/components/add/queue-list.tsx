"use client"

import { CircleAlert, CircleCheck, CopyCheck, ImageIcon, LoaderCircle, RotateCcw, X } from "lucide-react"
import Image from "next/image"

import { COLLECTION_LABELS } from "@/components/items/tag-options"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

import {
  isUploadInFlight,
  tagStatusText,
  uploadStatusText,
  type QueueEntry,
} from "./upload-queue"

/** The id of an entry's Remove button, where focus goes after a row action. */
export function removeButtonId(key: string): string {
  return `add-remove-${key}`
}

type QueueListProps = {
  entries: readonly QueueEntry[]
  /** True while no tagging call can start: the AI budget is used up, or tagging is unavailable. */
  taggingBlocked: boolean
  onRetryUpload: (key: string) => void
  onRetryTag: (key: string) => void
  onRemove: (key: string) => void
}

export function QueueList({ entries, taggingBlocked, onRetryUpload, onRetryTag, onRemove }: QueueListProps) {
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => (
        <QueueRow
          key={entry.key}
          entry={entry}
          taggingBlocked={taggingBlocked}
          onRetryUpload={onRetryUpload}
          onRetryTag={onRetryTag}
          onRemove={onRemove}
        />
      ))}
    </ul>
  )
}

type QueueRowProps = Omit<QueueListProps, "entries"> & { entry: QueueEntry }

function StatusIcon({ entry }: { entry: QueueEntry }) {
  const className = "size-4 shrink-0"
  if (entry.upload.kind === "failed" || entry.tag.kind === "failed") {
    return <CircleAlert aria-hidden="true" className={cn(className, "text-destructive")} />
  }
  if (entry.upload.kind === "duplicate") return <CopyCheck aria-hidden="true" className={className} />
  if (isUploadInFlight(entry) || entry.tag.kind === "queued" || entry.tag.kind === "tagging") {
    return <LoaderCircle aria-hidden="true" className={cn(className, "animate-spin")} />
  }
  return <CircleCheck aria-hidden="true" className={className} />
}

function QueueRow({ entry, taggingBlocked, onRetryUpload, onRetryTag, onRemove }: QueueRowProps) {
  const { upload, tag } = entry
  const uploadFailed = upload.kind === "failed"
  const tagText = upload.kind === "ready" ? tagStatusText(tag) : null
  const tagFailed = upload.kind === "ready" && tag.kind === "failed"
  const title = entry.item?.name ?? entry.fileName
  const canRetry = uploadFailed || tagFailed

  return (
    // Phones put Retry under the status, so the message keeps the row's width
    // instead of wrapping into a narrow column; wider screens keep one line.
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-xl border bg-card p-2 text-card-foreground sm:grid-cols-[3.5rem_minmax(0,1fr)_auto_auto]">
      <div
        className={cn(
          "flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted",
          canRetry && "row-span-2 self-start sm:row-span-1 sm:self-center"
        )}
      >
        {entry.previewUrl === null ? (
          <ImageIcon aria-hidden="true" className="size-5 text-muted-foreground" />
        ) : (
          // Unoptimized: previews are local object URLs or pre-sized Blob
          // thumbnails, so this renders a plain <img> (D-033).
          <Image
            src={entry.previewUrl}
            alt=""
            width={56}
            height={56}
            unoptimized
            className="size-full object-cover"
          />
        )}
      </div>

      <div className="col-start-2 row-start-1 flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate text-sm font-medium" title={entry.fileName}>
            {title}
          </p>
          {/* The stamp this photo was queued with (D-252); clothing, the default, shows none. */}
          {entry.collection !== "clothing" ? (
            <Badge variant="outline">{COLLECTION_LABELS[entry.collection]}</Badge>
          ) : null}
        </div>
        <p
          className={cn(
            "flex items-start gap-1.5 text-sm",
            canRetry ? "text-destructive" : "text-muted-foreground"
          )}
        >
          <StatusIcon entry={entry} />
          <span className="min-w-0 break-words">{tagText ?? uploadStatusText(upload)}</span>
        </p>
        {upload.kind === "uploading" ? (
          <Progress value={upload.percent} aria-label={`Uploading ${entry.fileName}`} className="max-w-48" />
        ) : null}
      </div>

      {canRetry ? (
        <div className="col-start-2 row-start-2 flex items-center gap-1 sm:col-start-3 sm:row-start-1">
          {uploadFailed ? (
            <Button
              variant="outline"
              size="touch"
              aria-label={`Retry ${entry.fileName}`}
              onClick={() => onRetryUpload(entry.key)}
            >
              <RotateCcw aria-hidden="true" />
              Retry
            </Button>
          ) : null}
          {tagFailed ? (
            <Button
              variant="outline"
              size="touch"
              aria-label={`Retry tagging ${entry.fileName}`}
              disabled={taggingBlocked}
              onClick={() => onRetryTag(entry.key)}
            >
              <RotateCcw aria-hidden="true" />
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      <Button
        id={removeButtonId(entry.key)}
        variant="ghost"
        size="icon-touch"
        aria-label={`Remove ${entry.fileName} from this list`}
        onClick={() => onRemove(entry.key)}
        className="col-start-3 row-start-1 sm:col-start-4"
      >
        <X aria-hidden="true" />
      </Button>
    </li>
  )
}
