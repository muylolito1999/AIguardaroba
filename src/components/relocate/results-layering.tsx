import { CircleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { RelocationViewDto } from "@/lib/relocation/contracts"

import { WARNING_KIND_LABELS } from "./format"
import { ItemRef } from "./item-ref"

/** Example outfits for typical conditions, built from owned items, each with what is still missing. */
export function LayeringTab({ view }: { view: RelocationViewDto }) {
  return (
    <ul className="grid gap-4 lg:grid-cols-2">
      {view.result.layering_systems.map((system, index) => (
        <li key={`${index}-${system.title}`} className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground">
          <div className="flex flex-col gap-1">
            <h3 className="font-heading text-base font-semibold text-pretty">{system.title}</h3>
            <p className="text-sm text-muted-foreground text-pretty">{system.conditions}</p>
          </div>
          {system.item_ids.length > 0 ? (
            <ul aria-label={`Items for ${system.title}`} className="flex flex-col">
              {system.item_ids.map((itemId) => (
                <li key={itemId}>
                  <ItemRef item={view.items[itemId]} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">None of your items fit this one.</p>
          )}
          {system.gap_note !== null ? (
            <p className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-sm text-pretty">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-medium">Missing: </span>
                {system.gap_note}
              </span>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** What to double-check: uncertain tags, duplicates, worn items, and the app's own checks. */
export function WarningsTab({ view }: { view: RelocationViewDto }) {
  const warnings = view.result.warnings
  if (warnings.length === 0) return <p className="text-sm text-muted-foreground">No warnings.</p>
  return (
    <ul className="flex flex-col gap-3">
      {warnings.map((warning, index) => (
        <li key={`${index}-${warning.kind}`} className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{WARNING_KIND_LABELS[warning.kind]}</Badge>
            {warning.source === "computed" ? <Badge variant="outline">Checked by the app</Badge> : null}
          </div>
          <p className="text-sm text-pretty">{warning.message}</p>
          {warning.item_ids.length > 0 ? (
            <ul aria-label="Items concerned" className="flex flex-col">
              {warning.item_ids.map((itemId) => (
                <li key={itemId}>
                  <ItemRef item={view.items[itemId]} />
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
