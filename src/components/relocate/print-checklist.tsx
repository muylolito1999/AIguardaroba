import { Check } from "lucide-react"

import type { PackingRowDto, RelocationViewDto } from "@/lib/relocation/contracts"
import { cn } from "@/lib/utils"

import { PACKING_GROUP_LABELS, PACKING_GROUP_ORDER, formatCalendarDay, formatMonths, notComingNote } from "./format"

/** A square to tick by hand on paper; packed rows print already ticked. */
function Box({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[3px] border-[1.5px] border-current"
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  )
}

function PrintRow({ row, note }: { row: PackingRowDto; note?: string }) {
  // A row never splits across two sheets.
  return (
    <li className={cn("flex break-inside-avoid items-start gap-2 text-sm", row.itemId === null && "italic")}>
      <Box checked={note === undefined && row.packed} />
      <span>
        {row.label}
        {note !== undefined ? ` (${note})` : null}
        <span className="sr-only">{note === undefined && row.packed ? " (packed)" : ""}</span>
      </span>
    </li>
  )
}

/**
 * The packing checklist laid out for paper: every group with its rows (items
 * and extras), packed ones ticked. Items the owner (or the AI, where the
 * owner has not decided) no longer brings are listed apart under "Not
 * bringing", by the decisions as they are now (D-181). Server-rendered; the
 * print page wraps it with its Print button and back link, which do not print.
 */
export function PrintChecklist({ view }: { view: RelocationViewDto }) {
  const place = view.profile === null ? null : `${view.profile.city}, ${view.profile.country}`
  const aiDecisions = new Map(view.result.items.map((entry) => [entry.item_id, entry.decision]))
  const noteOf = (row: PackingRowDto): string | null =>
    row.itemId === null ? null : notComingNote(view.items[row.itemId]?.currentDecision, aiDecisions.get(row.itemId))
  const sorted = [...view.packing].sort(
    (a, b) =>
      PACKING_GROUP_ORDER.indexOf(a.group) - PACKING_GROUP_ORDER.indexOf(b.group) ||
      a.sortOrder - b.sortOrder ||
      a.label.localeCompare(b.label)
  )
  const notComing = sorted.flatMap((row) => {
    const note = noteOf(row)
    return note === null ? [] : [{ row, note }]
  })
  return (
    <article className="flex flex-col gap-6 print:gap-4 print:text-black">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Packing checklist</h1>
        <p className="text-sm text-muted-foreground print:text-black">
          {[place, `${formatCalendarDay(view.params.dateFrom)} to ${formatCalendarDay(view.params.dateTo)}`, formatMonths(view.months)]
            .filter(Boolean)
            .join(" · ")}
          {view.profile?.isPlaceholder ? " · placeholder climate data" : ""}
        </p>
      </header>
      <div className="grid gap-6 sm:grid-cols-2 print:grid-cols-2 print:gap-4">
        {PACKING_GROUP_ORDER.map((group) => {
          const rows = sorted.filter((row) => row.group === group && noteOf(row) === null)
          // A long group flows onto the next sheet: kept whole, a group longer
          // than a page left the first sheet with the title alone (D-181).
          return (
            <section key={group} aria-labelledby={`print-${group}`} className="flex flex-col gap-2">
              <h2
                id={`print-${group}`}
                className="break-after-avoid border-b pb-1 text-base font-semibold print:border-black"
              >
                {PACKING_GROUP_LABELS[group]}
              </h2>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground print:text-black">Nothing.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {rows.map((row) => (
                    <PrintRow key={row.id} row={row} />
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
      {notComing.length > 0 ? (
        <section aria-labelledby="print-not-coming" className="flex flex-col gap-2">
          <h2 id="print-not-coming" className="break-after-avoid border-b pb-1 text-base font-semibold print:border-black">
            Not bringing
          </h2>
          <p className="text-sm text-muted-foreground print:text-black">
            {"In the plan's checklist, but not decided Bring: leave these out."}
          </p>
          <ul className="flex flex-col gap-1.5">
            {notComing.map(({ row, note }) => (
              <PrintRow key={row.id} row={row} note={note} />
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  )
}
