"use client"

import { useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Loader2, Plus } from "lucide-react"
import type { z } from "zod"

import { CATEGORY_LABELS } from "@/components/items/tag-options"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { ITEM_CATEGORIES } from "@/lib/db/enums"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import {
  BUY_TIMINGS,
  MAX_EUR,
  RELOCATION_PRIORITIES,
  SHOPPING_LIMITS,
  ShoppingItemInputSchema,
  type ShoppingItemDto,
} from "@/lib/relocation/contracts"
import { err, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"
import { cn } from "@/lib/utils"

import type { AddShoppingItemAction, ShoppingItemFormInput } from "./shopping-actions"
import { BUY_TIMING_LABELS, PRIORITY_LABELS } from "./shopping-model"

type FormValues = {
  itemType: string
  category: string
  priority: string
  quantity: string
  priceMin: string
  priceMax: string
  buyTiming: string
  specs: string
  reason: string
}

type FieldName = keyof FormValues
type FieldErrors = Partial<Record<FieldName, string>>

const EMPTY: FormValues = {
  itemType: "",
  category: "",
  priority: "2",
  quantity: "1",
  priceMin: "",
  priceMax: "",
  buyTiming: "",
  specs: "",
  reason: "",
}

const EUR_HINT = `Enter whole euros from 0 to ${MAX_EUR.toLocaleString("en-US")}.`

/** Empty text is null; anything else becomes a number (NaN for text that is not one, which the schema rejects). */
function optionalNumber(text: string): number | null {
  const trimmed = text.trim()
  return trimmed === "" ? null : Number(trimmed)
}

/** The form's text as the action's input; the schema does the checking. */
export function formToInput(values: FormValues): ShoppingItemFormInput {
  const category = ITEM_CATEGORIES.find((option) => option === values.category) ?? null
  const priority = RELOCATION_PRIORITIES.find((option) => String(option) === values.priority) ?? 2
  const buyTiming = BUY_TIMINGS.find((option) => option === values.buyTiming) ?? null
  return {
    itemType: values.itemType,
    category,
    priority,
    reason: values.reason,
    specs: values.specs
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
    quantity: values.quantity.trim() === "" ? Number.NaN : Number(values.quantity.trim()),
    estPriceMinEur: optionalNumber(values.priceMin),
    estPriceMaxEur: optionalNumber(values.priceMax),
    buyTiming,
  }
}

const SCHEMA_FIELDS: Record<string, FieldName> = {
  itemType: "itemType",
  category: "category",
  priority: "priority",
  quantity: "quantity",
  estPriceMinEur: "priceMin",
  estPriceMaxEur: "priceMax",
  buyTiming: "buyTiming",
  specs: "specs",
  reason: "reason",
}

/** One plain message per field. The schema's own wording is kept where it was written for people. */
export function fieldErrors(issues: readonly z.core.$ZodIssue[]): FieldErrors {
  const errors: FieldErrors = {}
  for (const issue of issues) {
    const field = SCHEMA_FIELDS[String(issue.path[0])]
    if (field === undefined || errors[field] !== undefined) continue
    errors[field] = messageFor(field, issue)
  }
  return errors
}

function messageFor(field: FieldName, issue: z.core.$ZodIssue): string {
  switch (field) {
    case "itemType":
      return issue.code === "too_big" ? `Keep it under ${SHOPPING_LIMITS.itemTypeMax} characters.` : "Say what to buy."
    case "quantity":
      return `Enter a whole number from ${SHOPPING_LIMITS.quantityMin} to ${SHOPPING_LIMITS.quantityMax}.`
    case "priceMin":
      return EUR_HINT
    case "priceMax":
      // The schema's refine names the actual problem: the range is upside down.
      return issue.code === "custom" ? issue.message : EUR_HINT
    case "specs":
      return `Up to ${SHOPPING_LIMITS.specsMax} specs, one per line, each under ${SHOPPING_LIMITS.specMax} characters.`
    case "reason":
      return `Keep the reason under ${SHOPPING_LIMITS.reasonMax} characters.`
    default:
      return "Choose one of the options."
  }
}

export type AddShoppingItemFormProps = {
  addShoppingItem: AddShoppingItemAction
  /** The server added the row. */
  onAdded: (item: ShoppingItemDto) => void
}

/** Adds an entry by hand. Only "What to buy" is required; prices are whole euros per piece. */
export function AddShoppingItemForm({ addShoppingItem, onAdded }: AddShoppingItemFormProps) {
  const id = useId()
  const [values, setValues] = useState<FormValues>(EMPTY)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [saving, setSaving] = useState(false)
  const itemTypeRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const fieldId = (name: FieldName) => `${id}-${name}`
  const errorId = (name: FieldName) => `${id}-${name}-error`

  function set(name: FieldName, value: string) {
    setValues((current) => ({ ...current, [name]: value }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const parsed = ShoppingItemInputSchema.safeParse(formToInput(values))
    if (!parsed.success) {
      const next = fieldErrors(parsed.error.issues)
      setErrors(next)
      // Focus the first field with a message, in form order.
      const first = (Object.keys(EMPTY) as FieldName[]).find((name) => next[name] !== undefined)
      if (first !== undefined) formRef.current?.querySelector<HTMLElement>(`#${CSS.escape(fieldId(first))}`)?.focus()
      return
    }
    setErrors({})
    setSaving(true)
    let result: Result<ShoppingItemDto>
    try {
      result = await addShoppingItem(parsed.data)
    } catch {
      result = err("UPSTREAM", NETWORK_ERROR_MESSAGE)
    }
    setSaving(false)
    if (!result.ok) {
      toastError(result.error)
      return
    }
    onAdded(result.data)
    setValues(EMPTY)
    toast.add({ title: "Added to your list", description: result.data.itemType, type: "success" })
    itemTypeRef.current?.focus()
  }

  const describedBy = (name: FieldName, hint?: string) =>
    [hint, errors[name] === undefined ? undefined : errorId(name)].filter(Boolean).join(" ") || undefined

  return (
    <form ref={formRef} onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4" aria-label="Add an item">
      <FormField id={fieldId("itemType")} label="What to buy" error={errors.itemType} errorId={errorId("itemType")}>
        <Input
          ref={itemTypeRef}
          id={fieldId("itemType")}
          value={values.itemType}
          onChange={(event) => set("itemType", event.target.value)}
          maxLength={SHOPPING_LIMITS.itemTypeMax + 20}
          autoComplete="off"
          placeholder="e.g. Waterproof shell jacket"
          aria-invalid={errors.itemType !== undefined || undefined}
          aria-describedby={describedBy("itemType")}
          className="h-11"
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField id={fieldId("category")} label="Category" error={errors.category} errorId={errorId("category")}>
          <NativeSelect
            id={fieldId("category")}
            value={values.category}
            onChange={(event) => set("category", event.target.value)}
            className="w-full [&_select]:h-11"
          >
            <NativeSelectOption value="">No category</NativeSelectOption>
            {ITEM_CATEGORIES.map((category) => (
              <NativeSelectOption key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id={fieldId("priority")} label="Priority" error={errors.priority} errorId={errorId("priority")}>
          <NativeSelect
            id={fieldId("priority")}
            value={values.priority}
            onChange={(event) => set("priority", event.target.value)}
            className="w-full [&_select]:h-11"
          >
            {RELOCATION_PRIORITIES.map((priority) => (
              <NativeSelectOption key={priority} value={String(priority)}>
                {PRIORITY_LABELS[priority]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id={fieldId("quantity")} label="Quantity" error={errors.quantity} errorId={errorId("quantity")}>
          <Input
            id={fieldId("quantity")}
            value={values.quantity}
            onChange={(event) => set("quantity", event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={errors.quantity !== undefined || undefined}
            aria-describedby={describedBy("quantity")}
            className="h-11"
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField id={fieldId("priceMin")} label="Lowest price (€)" error={errors.priceMin} errorId={errorId("priceMin")}>
          <Input
            id={fieldId("priceMin")}
            value={values.priceMin}
            onChange={(event) => set("priceMin", event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Optional"
            aria-invalid={errors.priceMin !== undefined || undefined}
            aria-describedby={describedBy("priceMin", `${id}-price-hint`)}
            className="h-11"
          />
        </FormField>
        <FormField id={fieldId("priceMax")} label="Highest price (€)" error={errors.priceMax} errorId={errorId("priceMax")}>
          <Input
            id={fieldId("priceMax")}
            value={values.priceMax}
            onChange={(event) => set("priceMax", event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Optional"
            aria-invalid={errors.priceMax !== undefined || undefined}
            aria-describedby={describedBy("priceMax", `${id}-price-hint`)}
            className="h-11"
          />
        </FormField>
        <FormField id={fieldId("buyTiming")} label="When to buy" error={errors.buyTiming} errorId={errorId("buyTiming")}>
          <NativeSelect
            id={fieldId("buyTiming")}
            value={values.buyTiming}
            onChange={(event) => set("buyTiming", event.target.value)}
            className="w-full [&_select]:h-11"
          >
            <NativeSelectOption value="">Not set</NativeSelectOption>
            {BUY_TIMINGS.map((timing) => (
              <NativeSelectOption key={timing} value={timing}>
                {BUY_TIMING_LABELS[timing]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      <p id={`${id}-price-hint`} className="-mt-2 text-sm text-muted-foreground">
        Prices are per piece, in whole euros.
      </p>

      <FormField id={fieldId("specs")} label="Specs" error={errors.specs} errorId={errorId("specs")}>
        <Textarea
          id={fieldId("specs")}
          value={values.specs}
          onChange={(event) => set("specs", event.target.value)}
          placeholder={"One per line, e.g.\nhood, ≥10,000 mm waterproof"}
          aria-invalid={errors.specs !== undefined || undefined}
          aria-describedby={describedBy("specs")}
          className="min-h-20"
        />
      </FormField>

      <FormField id={fieldId("reason")} label="Why" error={errors.reason} errorId={errorId("reason")}>
        <Textarea
          id={fieldId("reason")}
          value={values.reason}
          onChange={(event) => set("reason", event.target.value)}
          maxLength={SHOPPING_LIMITS.reasonMax + 20}
          placeholder="Optional"
          aria-invalid={errors.reason !== undefined || undefined}
          aria-describedby={describedBy("reason")}
          className="min-h-16"
        />
      </FormField>

      <Button
        type="submit"
        size="touch"
        className="self-start"
        disabled={saving}
        focusableWhenDisabled
        aria-busy={saving || undefined}
      >
        {saving ? <Loader2 aria-hidden className="animate-spin" /> : <Plus aria-hidden />}
        {saving ? "Adding…" : "Add to list"}
      </Button>
    </form>
  )
}

type FormFieldProps = {
  id: string
  label: string
  error: string | undefined
  errorId: string
  children: ReactNode
}

function FormField({ id, label, error, errorId, children }: FormFieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={cn("text-sm font-medium", error !== undefined && "text-destructive-strong")}>
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive-strong">
          {error}
        </p>
      ) : null}
    </div>
  )
}
