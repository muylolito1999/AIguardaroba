"use client"

import type { ReactNode } from "react"
import { TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Field, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field"
import { cn } from "@/lib/utils"

// Shared frame for one review-form control: label, "Edited" marker,
// low-confidence hint and errors, with the ids the control needs for
// aria-labelledby and aria-describedby.

export type FieldIds = {
  label: string
  control: string
  hint: string
  error: string
}

export function fieldIds(base: string, name: string): FieldIds {
  return {
    label: `${base}-${name}-label`,
    control: `${base}-${name}`,
    hint: `${base}-${name}-hint`,
    error: `${base}-${name}-error`,
  }
}

/** Space-separated ids for aria-describedby, or undefined when none apply. */
export function joinIds(...ids: Array<string | false | null | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(" ")
  return joined === "" ? undefined : joined
}

/** react-hook-form error objects nest by path (colors.0.name); FieldError wants a flat list. */
export function errorMessages(error: unknown): { message: string }[] {
  if (error === null || typeof error !== "object") return []
  const messages: { message: string }[] = []
  for (const [key, value] of Object.entries(error)) {
    // `ref` holds the DOM element; `type` and `types` are codes, not text.
    if (key === "ref" || key === "type" || key === "types") continue
    if (key === "message") {
      if (typeof value === "string" && value !== "") messages.push({ message: value })
      continue
    }
    messages.push(...errorMessages(value))
  }
  return messages
}

/** Classes that mark a low-confidence field; the hint text carries the meaning, the ring only draws attention. */
export const LOW_CONFIDENCE_RING = "rounded-lg p-3 ring-2 ring-amber-500 dark:ring-amber-400"

export function ConfidenceHint({ id, confidence }: { id: string; confidence: number }) {
  return (
    <span
      id={id}
      className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-300"
    >
      <TriangleAlert aria-hidden className="size-3.5" />
      Check this: Claude was {Math.round(confidence * 100)}% sure
    </span>
  )
}

type TagFieldProps = {
  ids: FieldIds
  label: string
  /**
   * True when the control is a labelable element (input, textarea, select
   * trigger): the label then points at it with htmlFor. Groups such as toggle
   * groups and chip lists use aria-labelledby instead.
   */
  labelFor?: boolean
  /** Shown as a hint when Claude was unsure and the owner has not edited the field. */
  confidence?: number
  /** The owner changed this tag; a re-tag keeps the value. */
  edited?: boolean
  error?: unknown
  /** Extra line under the label, such as a counter or format help. */
  description?: ReactNode
  className?: string
  children: ReactNode
}

export function TagField({
  ids,
  label,
  labelFor = false,
  confidence,
  edited = false,
  error,
  description,
  className,
  children,
}: TagFieldProps) {
  const messages = errorMessages(error)
  return (
    <Field
      data-invalid={messages.length > 0 || undefined}
      data-low-confidence={confidence !== undefined || undefined}
      className={cn(confidence !== undefined && LOW_CONFIDENCE_RING, className)}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {labelFor ? (
          <FieldLabel id={ids.label} htmlFor={ids.control}>
            {label}
          </FieldLabel>
        ) : (
          <FieldTitle id={ids.label}>{label}</FieldTitle>
        )}
        {edited ? <Badge variant="outline">Edited</Badge> : null}
        {confidence !== undefined ? <ConfidenceHint id={ids.hint} confidence={confidence} /> : null}
      </div>
      {description}
      {children}
      <FieldError id={ids.error} errors={messages} />
    </Field>
  )
}
