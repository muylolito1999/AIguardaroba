import { Download } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { ExportImageKind } from "@/lib/export/zip-plan"
import type { ImageExportKindSummary } from "@/server/services/export"

import { formatPartSize, formatPhotoCount } from "./format"

// The photo ZIPs per kind, each split into parts of at most 100 photos with
// their size and a download link. Rendered on the server from the same plan
// the download route follows.

const KIND_COPY: Record<ExportImageKind, { title: string; description: string; empty: string }> = {
  processed: {
    title: "Processed photos",
    description: "The cleaned-up photos the app shows and Claude tagged.",
    empty: "No processed photos yet.",
  },
  original: {
    title: "Original uploads",
    description: "Your photos as you uploaded them, before processing.",
    empty: "No original uploads yet.",
  },
  nobg: {
    title: "Cut-outs",
    description: "Photos with the background removed, for the items that have one.",
    empty: "No cut-outs yet.",
  },
}

function KindSection({ summary }: { summary: ImageExportKindSummary }) {
  const copy = KIND_COPY[summary.kind]
  const headingId = `export-photos-${summary.kind}`
  const partCount = summary.parts.length
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10"
    >
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="font-heading text-base font-semibold">
          {copy.title}
        </h3>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>
      {partCount === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.empty}</p>
      ) : (
        <>
          <p className="text-sm">
            {formatPhotoCount(summary.photoCount)} in {partCount === 1 ? "1 part" : `${partCount} parts`}
          </p>
          <ul className="flex flex-col divide-y rounded-lg border">
            {summary.parts.map((part) => (
              <li key={part.part} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    Part {part.part} of {part.parts}
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {formatPhotoCount(part.photoCount)} · {formatPartSize(part.estimatedBytes, part.exact)}
                  </span>
                </div>
                <a
                  href={part.href}
                  className={buttonVariants({ variant: "outline", size: "touch" })}
                >
                  <Download aria-hidden />
                  Download
                  <span className="sr-only">
                    {" "}
                    {copy.title.toLowerCase()}, part {part.part} of {part.parts}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export function PhotoExports({ summaries }: { summaries: readonly ImageExportKindSummary[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {summaries.map((summary) => (
        <KindSection key={summary.kind} summary={summary} />
      ))}
    </div>
  )
}

export function PhotoExportsSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-3" aria-busy="true">
      <p className="sr-only">Loading the photo exports…</p>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-48 rounded-xl" />
      ))}
    </div>
  )
}
