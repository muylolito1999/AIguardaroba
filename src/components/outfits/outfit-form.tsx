"use client"

import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Loader2, Plus, Save, X } from "lucide-react"

import { CATEGORY_LABELS } from "@/components/items/tag-options"
import { settle } from "@/components/relocate/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import type { OutfitSlot } from "@/lib/db/enums"
import {
  MAX_ACCESSORIES,
  OUTFIT_LIMITS,
  SLOT_LABELS,
  SLOT_ORDER,
  type OutfitDetailDto,
  type OutfitInputValues,
  type OutfitItemDto,
  type SlotCandidateDto,
} from "@/lib/outfits/contracts"
import type { Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"
import { cn } from "@/lib/utils"

import {
  checkForm,
  FIELD_ORDER,
  itemInfoFrom,
  serverErrorsFrom,
  withItem,
  type FieldErrors,
  type FieldName,
  type ItemInfo,
  type OutfitFormValues,
  type SlotMessages,
} from "./outfit-form-model"
import { ItemThumb } from "./outfit-thumbs"
import { SlotPickerDialog } from "./slot-picker-dialog"

const RATINGS = ["1", "2", "3", "4", "5"] as const

/** The slot as the picker button names it: "Choose top or dress", "Add accessory". */
const SLOT_NOUNS: Readonly<Record<OutfitSlot, string>> = {
  outerwear: "outerwear",
  base_layer: "base layer",
  top: "top or dress",
  bottom: "bottom",
  shoes: "shoes",
  hat: "hat",
  gloves: "gloves",
  scarf: "scarf",
  accessory: "accessory",
}

export type OutfitFormProps = {
  /** The starting values; read once, so a refresh of the page keeps the owner's edits. */
  initial: OutfitFormValues
  candidates: Readonly<Record<OutfitSlot, readonly SlotCandidateDto[]>>
  /** The outfit's items as last read, archived ones included, for their names and photos. */
  current: readonly OutfitItemDto[]
  submitLabel: string
  onSubmit: (outfit: OutfitInputValues) => Promise<Result<OutfitDetailDto>>
  onSaved: (outfit: OutfitDetailDto) => void
  /** Start again from `initial` after a save (the new-outfit page, which Next may keep and show again). */
  resetOnSave?: boolean
}

type Shown = { fields: FieldErrors; slots: SlotMessages }

const NONE: Shown = { fields: {}, slots: {} }

/**
 * The outfit builder: one row per slot in SLOT_ORDER, each with a picker,
 * then the name, occasion, temperatures, rain, rating and notes. Save runs
 * the server's checks first and shows each problem next to its slot or field;
 * after a failed Save the messages follow every change. Save is disabled
 * while saving.
 */
export function OutfitForm({ initial, candidates, current, submitLabel, onSubmit, onSaved, resetOnSave = false }: OutfitFormProps) {
  const id = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [values, setValues] = useState<OutfitFormValues>(initial)
  const [attempted, setAttempted] = useState(false)
  // What the server said about the last Save; cleared by the next change.
  const [serverErrors, setServerErrors] = useState<Shown>(NONE)
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const [pickerSlot, setPickerSlot] = useState<OutfitSlot | null>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const chooseButtons = useRef(new Map<OutfitSlot, HTMLButtonElement>())

  const info = useMemo(() => itemInfoFrom(candidates, current), [candidates, current])
  const check = useMemo(() => checkForm(values, info), [values, info])
  const local: Shown = attempted && !check.ok ? { fields: check.fields, slots: check.slots } : NONE
  const fieldError = (name: FieldName) => local.fields[name] ?? serverErrors.fields[name]
  const slotMessages = (slot: OutfitSlot | "outfit") => [
    ...new Set([...(local.slots[slot] ?? []), ...(serverErrors.slots[slot] ?? [])]),
  ]

  const fieldId = (name: FieldName) => `${id}-${name}`
  const errorId = (name: FieldName) => `${id}-${name}-error`
  const slotIssueId = (slot: OutfitSlot) => `${id}-${slot}-issues`

  function update(patch: Partial<OutfitFormValues>) {
    setValues((previous) => ({ ...previous, ...patch }))
    setServerErrors(NONE)
  }

  function focusFirstProblem(shown: Shown) {
    const slot = SLOT_ORDER.find((candidate) => (shown.slots[candidate]?.length ?? 0) > 0)
    if (slot !== undefined) {
      chooseButtons.current.get(slot)?.focus()
      return
    }
    const field = FIELD_ORDER.find((name) => shown.fields[name] !== undefined)
    if (field !== undefined) formRef.current?.querySelector<HTMLElement>(`#${CSS.escape(fieldId(field))}`)?.focus()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current) return
    setAttempted(true)
    if (!check.ok) {
      focusFirstProblem({ fields: check.fields, slots: check.slots })
      return
    }
    busy.current = true
    setSaving(true)
    const input = check.input
    const result = await settle(() => onSubmit(input))
    busy.current = false
    setSaving(false)
    if (!result.ok) {
      const shown = serverErrorsFrom(result.error)
      if (shown === null) {
        toastError(result.error)
        return
      }
      setServerErrors(shown)
      focusFirstProblem(shown)
      return
    }
    if (resetOnSave) {
      setValues(initial)
      setAttempted(false)
    }
    onSaved(result.data)
  }

  function openPicker(slot: OutfitSlot, button: HTMLButtonElement) {
    opener.current = button
    setPickerSlot(slot)
  }

  function choose(candidate: SlotCandidateDto) {
    if (pickerSlot === null) return
    update({ entries: withItem(values.entries, pickerSlot, candidate.id) })
    setPickerSlot(null)
  }

  function remove(slot: OutfitSlot, itemId: string) {
    update({ entries: values.entries.filter((entry) => entry.itemId !== itemId) })
    // The removed row's button is gone; the slot's own button keeps focus in the slot.
    chooseButtons.current.get(slot)?.focus()
  }

  const topEntry = values.entries.find((entry) => entry.slot === "top")
  const topIsDress = topEntry !== undefined && info.get(topEntry.itemId)?.category === "dress"
  const chosenIds = new Set(values.entries.map((entry) => entry.itemId))
  const outfitMessages = slotMessages("outfit")

  const describedBy = (name: FieldName, hint?: string) =>
    [hint, fieldError(name) === undefined ? undefined : errorId(name)].filter(Boolean).join(" ") || undefined

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void submit(event)}
      noValidate
      aria-label="Outfit"
      className="flex max-w-2xl flex-col gap-8"
    >
      <section aria-labelledby={`${id}-items`} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-items`} className="font-heading text-lg font-semibold">
            Items
          </h2>
          <p className="text-sm text-muted-foreground">
            A top or a dress is required, and a bottom unless you choose a dress. Everything else is optional.
          </p>
        </div>
        {outfitMessages.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-destructive-strong">
            {outfitMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col divide-y rounded-xl border">
          {SLOT_ORDER.map((slot) => {
            const entries = values.entries.filter((entry) => entry.slot === slot)
            const messages = slotMessages(slot)
            const full = slot === "accessory" ? entries.length >= MAX_ACCESSORIES : false
            return (
              <SlotRow
                key={slot}
                slot={slot}
                requirement={requirementOf(slot, topIsDress)}
                items={entries.map((entry) => info.get(entry.itemId) ?? unknownItem(entry.itemId))}
                messages={messages}
                issueId={slotIssueId(slot)}
                chooseLabel={chooseLabel(slot, entries.length)}
                chooseDisabled={full}
                chooseRef={(button) => {
                  if (button === null) chooseButtons.current.delete(slot)
                  else chooseButtons.current.set(slot, button)
                }}
                onChoose={(button) => openPicker(slot, button)}
                onRemove={(itemId) => remove(slot, itemId)}
              />
            )
          })}
        </div>
      </section>

      <section aria-labelledby={`${id}-details`} className="flex flex-col gap-4">
        <h2 id={`${id}-details`} className="font-heading text-lg font-semibold">
          Details
        </h2>
        <FormField id={fieldId("name")} label="Name" error={fieldError("name")} errorId={errorId("name")}>
          <Input
            id={fieldId("name")}
            value={values.name}
            onChange={(event) => update({ name: event.target.value })}
            maxLength={OUTFIT_LIMITS.nameMax + 20}
            autoComplete="off"
            placeholder="e.g. Rainy office day"
            aria-invalid={fieldError("name") !== undefined || undefined}
            aria-describedby={describedBy("name")}
            className="h-11"
          />
        </FormField>
        <FormField id={fieldId("occasion")} label="Occasion" error={fieldError("occasion")} errorId={errorId("occasion")}>
          <Input
            id={fieldId("occasion")}
            value={values.occasion}
            onChange={(event) => update({ occasion: event.target.value })}
            maxLength={OUTFIT_LIMITS.occasionMax + 20}
            autoComplete="off"
            placeholder="Optional, e.g. office or dinner out"
            aria-invalid={fieldError("occasion") !== undefined || undefined}
            aria-describedby={describedBy("occasion")}
            className="h-11"
          />
        </FormField>
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-2 gap-4">
            <FormField
              id={fieldId("weatherMin")}
              label="Lowest °C"
              error={fieldError("weatherMin")}
              errorId={errorId("weatherMin")}
            >
              <Input
                id={fieldId("weatherMin")}
                value={values.weatherMin}
                onChange={(event) => update({ weatherMin: event.target.value })}
                inputMode="decimal"
                autoComplete="off"
                placeholder="Optional"
                aria-invalid={fieldError("weatherMin") !== undefined || undefined}
                aria-describedby={describedBy("weatherMin", `${id}-weather-hint`)}
                className="h-11"
              />
            </FormField>
            <FormField
              id={fieldId("weatherMax")}
              label="Highest °C"
              error={fieldError("weatherMax")}
              errorId={errorId("weatherMax")}
            >
              <Input
                id={fieldId("weatherMax")}
                value={values.weatherMax}
                onChange={(event) => update({ weatherMax: event.target.value })}
                inputMode="decimal"
                autoComplete="off"
                placeholder="Optional"
                aria-invalid={fieldError("weatherMax") !== undefined || undefined}
                aria-describedby={describedBy("weatherMax", `${id}-weather-hint`)}
                className="h-11"
              />
            </FormField>
          </div>
          <p id={`${id}-weather-hint`} className="text-sm text-muted-foreground">
            The temperatures this outfit suits, from {OUTFIT_LIMITS.weatherMinC} to {OUTFIT_LIMITS.weatherMaxC} °C.
          </p>
        </div>
        <label htmlFor={`${id}-rainOk`} className="flex min-h-11 items-center gap-3 self-start">
          <Checkbox
            id={`${id}-rainOk`}
            checked={values.rainOk}
            onCheckedChange={(checked) => update({ rainOk: checked })}
          />
          <span className="text-sm font-medium">Fine in rain</span>
        </label>
        <FormField id={fieldId("rating")} label="Rating" error={fieldError("rating")} errorId={errorId("rating")}>
          <NativeSelect
            id={fieldId("rating")}
            value={values.rating}
            onChange={(event) => update({ rating: event.target.value })}
            aria-invalid={fieldError("rating") !== undefined || undefined}
            aria-describedby={describedBy("rating")}
            className="w-full sm:w-48 [&_select]:h-11"
          >
            <NativeSelectOption value="">Not rated</NativeSelectOption>
            {RATINGS.map((rating) => (
              <NativeSelectOption key={rating} value={rating}>
                {rating} of 5
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id={fieldId("notes")} label="Notes" error={fieldError("notes")} errorId={errorId("notes")}>
          <Textarea
            id={fieldId("notes")}
            value={values.notes}
            onChange={(event) => update({ notes: event.target.value })}
            maxLength={OUTFIT_LIMITS.notesMax + 50}
            placeholder="Optional"
            aria-invalid={fieldError("notes") !== undefined || undefined}
            aria-describedby={describedBy("notes")}
            className="min-h-20"
          />
        </FormField>
      </section>

      <Button
        type="submit"
        size="touch"
        className="self-start"
        disabled={saving}
        focusableWhenDisabled
        aria-busy={saving || undefined}
      >
        {saving ? <Loader2 aria-hidden className="animate-spin" /> : <Save aria-hidden />}
        {saving ? "Saving…" : submitLabel}
      </Button>

      <SlotPickerDialog
        slot={pickerSlot}
        candidates={pickerSlot === null ? [] : candidates[pickerSlot]}
        chosenIds={chosenIds}
        onChoose={choose}
        onClose={() => setPickerSlot(null)}
        finalFocus={opener}
      />
    </form>
  )
}

function requirementOf(slot: OutfitSlot, topIsDress: boolean): string {
  if (slot === "top") return "Required"
  if (slot === "bottom") return topIsDress ? "Optional with a dress" : "Required"
  if (slot === "accessory") return `Optional, up to ${MAX_ACCESSORIES}`
  return "Optional"
}

function chooseLabel(slot: OutfitSlot, count: number): string {
  if (slot === "accessory") return count >= MAX_ACCESSORIES ? `${MAX_ACCESSORIES} accessories chosen` : "Add"
  return count === 0 ? "Choose" : "Change"
}

function unknownItem(itemId: string): ItemInfo {
  return { id: itemId, name: "An item that no longer exists", category: null, status: null, thumbUrl: null }
}

type SlotRowProps = {
  slot: OutfitSlot
  requirement: string
  items: ItemInfo[]
  messages: string[]
  issueId: string
  chooseLabel: string
  chooseDisabled: boolean
  chooseRef: (button: HTMLButtonElement | null) => void
  onChoose: (button: HTMLButtonElement) => void
  onRemove: (itemId: string) => void
}

function SlotRow({
  slot,
  requirement,
  items,
  messages,
  issueId,
  chooseLabel,
  chooseDisabled,
  chooseRef,
  onChoose,
  onRemove,
}: SlotRowProps) {
  const labelId = useId()
  const hasMessages = messages.length > 0
  // On the row's error tint the muted grey falls below 4.5:1 for small text in light mode, so it turns full colour there.
  const smallText = hasMessages ? "text-foreground" : "text-muted-foreground"
  return (
    <div role="group" aria-labelledby={labelId} className={cn("flex flex-col gap-2 p-3", hasMessages && "bg-destructive/5")}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span id={labelId} className="text-sm font-medium">
            {SLOT_LABELS[slot]}
          </span>
          <span className={cn("text-xs", smallText)}>{requirement}</span>
        </div>
        <Button
          ref={chooseRef}
          type="button"
          variant="outline"
          size="touch"
          onClick={(event) => onChoose(event.currentTarget)}
          disabled={chooseDisabled}
          focusableWhenDisabled
          aria-label={chooseDisabled ? chooseLabel : `${chooseLabel} ${SLOT_NOUNS[slot]}`}
          aria-describedby={hasMessages ? issueId : undefined}
          aria-haspopup="dialog"
        >
          {slot === "accessory" && !chooseDisabled ? <Plus aria-hidden /> : null}
          {chooseLabel}
        </Button>
      </div>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={`${SLOT_LABELS[slot]} chosen`}>
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3">
              <ItemThumb url={item.thumbUrl} alt="" className="size-12" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium break-words">{item.name}</span>
                <span className={cn("flex flex-wrap items-center gap-1.5 text-xs", smallText)}>
                  {item.category !== null ? CATEGORY_LABELS[item.category] : "No category"}
                  {item.status === "archived" ? <Badge variant="secondary">Archived</Badge> : null}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-touch"
                onClick={() => onRemove(item.id)}
                aria-label={`Remove ${item.name}`}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {hasMessages ? (
        <ul id={issueId} className="flex flex-col gap-0.5 text-sm text-destructive-strong">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
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
