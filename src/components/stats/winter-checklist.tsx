import Link from "next/link"
import { CircleCheck, CircleX } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import type { WinterReadinessRow } from "@/lib/items/winter-readiness"
import { cn } from "@/lib/utils"

// The winter-ready checklist. Each rule says Ready or Missing in words next to
// its icon, links the items that meet it, and says what is still needed.

/** Evidence links shown per rule before the rest are summarised as "and N more". */
export const EVIDENCE_LINKS_SHOWN = 6

function EvidenceLinks({ row }: { row: WinterReadinessRow }) {
  const shown = row.evidence.slice(0, EVIDENCE_LINKS_SHOWN)
  const hidden = row.evidence.length - shown.length
  const labelId = `winter-${row.key}-evidence`
  return (
    <div className="flex flex-col gap-1.5">
      <p id={labelId} className="text-sm text-muted-foreground">
        {row.satisfied ? "Covered by" : "So far"}
      </p>
      <ul aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {shown.map((item) => (
          <li key={item.id} className="max-w-full min-w-0">
            {/* A styled Link, not Button render={<Link />}: Base UI's Button
                would announce the anchor as a button. */}
            <Link
              href={`/wardrobe/${item.id}`}
              className={cn(buttonVariants({ variant: "outline", size: "touch" }), "max-w-full justify-start")}
            >
              {/* min-w-0 lets a long name shrink and truncate inside the inline-flex link at phone width. */}
              <span className="min-w-0 truncate">{item.name}</span>
            </Link>
          </li>
        ))}
        {hidden > 0 ? (
          <li className="flex min-h-11 items-center text-sm text-muted-foreground">and {hidden} more</li>
        ) : null}
      </ul>
    </div>
  )
}

export function WinterChecklist({ rows }: { rows: readonly WinterReadinessRow[] }) {
  const ready = rows.filter((row) => row.satisfied).length
  return (
    <section aria-labelledby="stats-winter-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="stats-winter-title" className="font-heading text-base font-semibold">
          Winter-ready checklist
        </h2>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {ready} of {rows.length} ready
          </span>{" "}
          for a Hamburg winter. Only tagged and confirmed items count, and items marked Leave, Donate or Sell do
          not, since they will not be in Hamburg.
        </p>
      </div>
      <ul className="flex flex-col divide-y rounded-xl ring-1 ring-foreground/10">
        {rows.map((row) => (
          <li key={row.key} data-readiness={row.key} className="flex gap-3 p-4">
            {row.satisfied ? (
              <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-emerald-700 dark:text-emerald-400" />
            ) : (
              <CircleX aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <h3 className="flex flex-wrap items-baseline gap-x-2 font-medium">
                {/* The space keeps "Scarf Ready" one phrase in the heading's accessible name;
                    the flex gap does the visual spacing. */}
                <span>{row.label}</span>{" "}
                <span
                  className={cn(
                    "text-sm",
                    row.satisfied ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"
                  )}
                >
                  {row.satisfied ? "Ready" : "Missing"}
                </span>
              </h3>
              {row.need ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">Needed: </span>
                  {row.need}
                </p>
              ) : null}
              {row.evidence.length > 0 ? <EvidenceLinks row={row} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
