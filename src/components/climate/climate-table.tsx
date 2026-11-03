"use client"

import { Fragment, type FormEvent } from "react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import {
  CLIMATE_FIELD_SPECS,
  CLIMATE_FIELDS,
  monthName,
  type CellDraft,
  type ClimateField,
  type MonthCheck,
  type MonthDraft,
} from "./climate-model"

export type ClimateTableProps = {
  /** Unique per profile, for the ids of the inputs and the row messages. */
  idPrefix: string
  city: string
  months: readonly MonthDraft[]
  /** One check per month, in the same order. */
  checks: readonly MonthCheck[]
  /** Whether a month's problems are shown yet (after its row was left, or after Save). */
  showErrors: (month: number) => boolean
  onCellChange: (index: number, field: ClimateField, cell: CellDraft) => void
  /** Focus left a cell of this month. */
  onRowBlur: (month: number) => void
  disabled?: boolean
}

export function cellInputId(idPrefix: string, month: number, field: ClimateField): string {
  return `${idPrefix}-m${month}-${field}`
}

/**
 * The 12-month editor: one row per month and one number input per value,
 * where an empty input means unknown. It is wider than a phone, so it scrolls
 * inside its own container with the month column kept in view; the page never
 * scrolls sideways.
 */
export function ClimateTable({
  idPrefix,
  city,
  months,
  checks,
  showErrors,
  onCellChange,
  onRowBlur,
  disabled,
}: ClimateTableProps) {
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[42rem] border-collapse text-sm">
        <caption className="sr-only">
          Monthly climate values for {city}. An empty value means unknown.
        </caption>
        <thead>
          <tr className="border-b bg-muted/50">
            <th scope="col" className="sticky left-0 z-10 bg-muted px-3 py-2 text-left font-medium">
              Month
            </th>
            {CLIMATE_FIELDS.map((field) => (
              <th key={field} scope="col" className="px-2 py-2 text-left font-medium whitespace-nowrap">
                {CLIMATE_FIELD_SPECS[field].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((draft, index) => {
            const check = checks[index]
            const name = monthName(draft.month)
            const errorId = `${idPrefix}-m${draft.month}-error`
            const visible = check !== undefined && check.errors.length > 0 && showErrors(draft.month)
            return (
              <Fragment key={draft.month}>
                <tr className={cn("border-b last:border-b-0", visible && "border-b-0")}>
                  <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1 text-left font-medium whitespace-nowrap">
                    {name}
                  </th>
                  {CLIMATE_FIELDS.map((field) => {
                    const invalid = visible && check.invalidFields.includes(field)
                    // A number input reports "" for text it cannot read; keep
                    // that apart from "unknown". React's onChange skips an
                    // input event that leaves the value "" as it was (typing
                    // "-" into an empty cell), so onInput reads it too (D-182).
                    const update = (event: FormEvent<HTMLInputElement>) =>
                      onCellChange(index, field, {
                        text: event.currentTarget.value,
                        bad: event.currentTarget.validity.badInput,
                      })
                    return (
                      <td key={field} className="px-1 py-1">
                        <Input
                          id={cellInputId(idPrefix, draft.month, field)}
                          type="number"
                          step="any"
                          value={draft.cells[field].text}
                          onChange={update}
                          onInput={update}
                          onBlur={() => onRowBlur(draft.month)}
                          aria-label={`${name} ${CLIMATE_FIELD_SPECS[field].short}`}
                          aria-invalid={invalid || undefined}
                          aria-describedby={invalid ? errorId : undefined}
                          disabled={disabled}
                          className="h-11 w-20 tabular-nums"
                        />
                      </td>
                    )
                  })}
                </tr>
                {visible ? (
                  <tr className="border-b last:border-b-0">
                    <td colSpan={CLIMATE_FIELDS.length + 1} className="px-3 pb-2">
                      {/* Sticky, so the message stays in view while the table is scrolled sideways. */}
                      <div id={errorId} className="sticky left-3 max-w-[calc(100vw-5rem)] text-sm text-destructive-strong">
                        <span className="font-medium">{name}:</span> {check.errors.join(" ")}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
