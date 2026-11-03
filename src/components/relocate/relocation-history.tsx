import Link from "next/link"
import { ChevronRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { RelocationListItemDto } from "@/lib/relocation/contracts"

import { formatDay, formatMonths, formatUsdEstimate, plural } from "./format"
import { RefreshRunsWhenShown } from "./run-changes"

/** "Spent $0.48" for a finished run; estimate and spend so far for one that is not. */
function costText(run: RelocationListItemDto): string {
  if (run.status === "complete") return `Cost ${formatUsdEstimate(run.costUsd)}`
  const estimate = run.estimatedCostUsd === null ? null : `estimated ${formatUsdEstimate(run.estimatedCostUsd)}`
  return [`Spent ${formatUsdEstimate(run.costUsd)} so far`, estimate].filter(Boolean).join(", ")
}

/**
 * Earlier relocation runs, newest first. A finished run opens its result; an
 * unfinished one (stopped, failed or left mid-run) opens its progress page,
 * which resumes it. Rendered on the server; the list reads itself again when
 * Next shows the kept page after a run changed in this tab.
 */
export function RelocationHistory({ runs }: { runs: RelocationListItemDto[] }) {
  return (
    <section aria-labelledby="relocation-history" className="flex max-w-2xl flex-col gap-3">
      <RefreshRunsWhenShown list={runs} />
      <h2 id="relocation-history" className="font-heading text-lg font-semibold">
        Earlier analyses
      </h2>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No analyses yet. Your runs will be listed here.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {runs.map((run) => {
            const finished = run.status === "complete"
            return (
              <li key={run.id}>
                <Link
                  href={`/relocate/${run.id}`}
                  className="flex min-h-11 items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{run.city ?? "Unknown place"}</span>
                      <span className="text-sm text-muted-foreground">{formatDay(run.createdAt)}</span>
                      {run.isPlaceholder ? <Badge variant="outline">Placeholder data</Badge> : null}
                      {finished ? null : <Badge variant="secondary">Not finished</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {formatMonths(run.months)} · {plural(run.itemCount, "item", "items")} · {costText(run)}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-1 text-sm font-medium">
                    {finished ? "View" : "Resume"}
                    <ChevronRight aria-hidden className="size-4" />
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
