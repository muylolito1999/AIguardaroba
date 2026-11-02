import type { ReactNode } from "react"

import { formatCount } from "@/components/usage/format"
import { cn } from "@/lib/utils"

// A horizontal bar chart that is a real table: each row is a row header and a
// cell holding the bar and its count, so screen readers read the numbers as a
// table and sighted readers get the count printed at the tip of every bar.
// The bar itself is decoration (aria-hidden). Pure CSS, rendered on the
// server, one neutral hue in both themes (one series needs no colour key).

export type BarRow = {
  key: string
  label: ReactNode
  /** A second, muted line under the label. */
  hint?: string
  value: number
}

type BarTableProps = {
  id: string
  title: string
  description?: ReactNode
  /** Header of the label column; screen readers announce it, the chart shows the labels alone. */
  labelHeader: string
  /** Header of the count column. */
  valueHeader?: string
  rows: readonly BarRow[]
  /**
   * The whole the bars are measured against. Without it the longest bar is the
   * largest row; with it every row is a share of the same total and a faint
   * track shows that total.
   */
  max?: number
  className?: string
}

// Room kept free at the end of the bar column for the count printed at the tip.
const VALUE_ROOM = "3.5rem"

/** 0..1, safe for an empty or zero scale. */
export function barRatio(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0
  return Math.min(1, value / max)
}

function barWidth(ratio: number): string {
  return `calc((100% - ${VALUE_ROOM}) * ${ratio})`
}

export function BarTable({
  id,
  title,
  description,
  labelHeader,
  valueHeader = "Items",
  rows,
  max,
  className,
}: BarTableProps) {
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`
  const scale = max ?? Math.max(0, ...rows.map((row) => row.value))
  return (
    <section aria-labelledby={titleId} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="font-heading text-base font-semibold">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <table
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="w-full table-fixed border-collapse text-sm"
      >
        <thead className="sr-only">
          <tr>
            <th scope="col">{labelHeader}</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const ratio = barRatio(row.value, scale)
            return (
              <tr key={row.key} data-bar-row={row.key} className="hover:bg-muted/40">
                <th scope="row" className="w-[42%] py-1.5 pr-3 text-left align-middle font-normal sm:w-[38%]">
                  <span className="block break-words">{row.label}</span>
                  {row.hint ? (
                    <span className="block text-xs break-words text-muted-foreground">{row.hint}</span>
                  ) : null}
                </th>
                {/* The left border is the zero baseline every bar grows from. */}
                <td className="border-l border-border py-1.5 align-middle">
                  <div className="flex items-center gap-2">
                    {max === undefined ? (
                      <div
                        aria-hidden
                        data-slot="bar"
                        className="h-3 shrink-0 rounded-r-[4px] bg-chart-2"
                        style={{ width: barWidth(ratio) }}
                      />
                    ) : (
                      <div
                        aria-hidden
                        data-slot="bar-track"
                        className="h-3 shrink-0 rounded-r-[4px] bg-muted"
                        style={{ width: barWidth(1) }}
                      >
                        <div
                          data-slot="bar"
                          className="h-full rounded-r-[4px] bg-chart-2"
                          style={{ width: `${ratio * 100}%` }}
                        />
                      </div>
                    )}
                    <span className="font-medium tabular-nums">{formatCount(row.value)}</span>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
