"use client"

import type { Ref } from "react"
import { Check } from "lucide-react"
import { Controller, type Control, type FieldError as FieldErrorValue } from "react-hook-form"

import { Badge } from "@/components/ui/badge"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TAG_LIMITS } from "@/lib/items/contracts"
import { cn } from "@/lib/utils"

import { TextChips } from "./chip-inputs"
import { ConfidenceHint, joinIds, LOW_CONFIDENCE_RING, TagField, type FieldIds } from "./tag-field"
import type { TagFormOutput, TagFormValues } from "./tag-form-model"

// The review form's building blocks: each wraps one Base UI control with its
// label, hint, error and the aria wiring react-hook-form needs to focus it.

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

/** Pressed toggles get a strong fill plus a check icon, so the state never relies on colour alone. */
export const PRESSED_CLASSES =
  "aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90"

export const SWITCH_COPY = {
  waterproof: {
    label: "Waterproof",
    description: "Taped seams, a membrane or rubber. Water-resistant (such as waxed cotton) is not waterproof.",
  },
  windproof: { label: "Windproof", description: "Blocks wind: a dense shell, membrane or leather." },
  insulated: { label: "Insulated", description: "Down, synthetic fill, fleece lining or shearling." },
} as const

type TextFieldName =
  | "name"
  | "subcategory"
  | "material_guess"
  | "pattern"
  | "fit"
  | "brand"
  | "size"
  | "purchase_price"
  | "currency"
  | "purchase_date"

export type TextFieldProps = {
  control: Control<TagFormValues, unknown, TagFormOutput>
  name: TextFieldName
  ids: FieldIds
  label: string
  placeholder?: string
  maxLength?: number
  type?: "text" | "date"
  inputMode?: "decimal" | "text"
  autoCapitalize?: string
  confidence?: number
  edited?: boolean
  className?: string
}

export function TextField({
  control,
  name,
  ids,
  label,
  placeholder,
  maxLength,
  type = "text",
  inputMode,
  autoCapitalize,
  confidence,
  edited,
  className,
}: TextFieldProps) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TagField
          ids={ids}
          label={label}
          labelFor
          confidence={confidence}
          edited={edited}
          error={fieldState.error}
          className={className}
        >
          <Input
            id={ids.control}
            ref={field.ref}
            name={field.name}
            value={field.value}
            onChange={(event) => field.onChange(event.target.value)}
            onBlur={field.onBlur}
            type={type}
            inputMode={inputMode}
            autoCapitalize={autoCapitalize}
            autoComplete="off"
            placeholder={placeholder}
            // A little slack over the limit, so a pasted value can be seen and trimmed.
            maxLength={maxLength === undefined ? undefined : maxLength + 20}
            aria-invalid={fieldState.invalid || undefined}
            aria-describedby={joinIds(confidence !== undefined && ids.hint, fieldState.invalid && ids.error)}
            className="h-11"
          />
        </TagField>
      )}
    />
  )
}

type EnumSelectProps<T extends string> = {
  ids: FieldIds
  values: readonly T[]
  labels: Record<T, string>
  /** null shows the "Choose…" placeholder (a hand-tagged item before its first pick). */
  value: T | null
  onChange: (value: T) => void
  onBlur: () => void
  inputRef: Ref<HTMLInputElement>
  invalid: boolean
  describedBy?: string
  disabled?: boolean
}

function EnumSelect<T extends string>({
  ids,
  values,
  labels,
  value,
  onChange,
  onBlur,
  inputRef,
  invalid,
  describedBy,
  disabled,
}: EnumSelectProps<T>) {
  const items = values.map((option) => ({ value: option, label: labels[option] }))
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (isOneOf(values, next)) onChange(next)
      }}
      inputRef={inputRef}
      disabled={disabled}
    >
      <SelectTrigger
        id={ids.control}
        aria-labelledby={ids.label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onBlur={onBlur}
        // The trigger sets its height under data-[size=default], which a plain
        // h-11 does not override; this one replaces it (44 px touch target).
        className="w-full data-[size=default]:h-11"
      >
        <SelectValue placeholder="Choose…" />
      </SelectTrigger>
      <SelectContent>
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value} className="min-h-11">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type EnumFieldProps<T extends string> = Omit<EnumSelectProps<T>, "invalid" | "describedBy"> & {
  label: string
  error: FieldErrorValue | undefined
  confidence?: number
  edited: boolean
}

export function EnumField<T extends string>({ label, error, confidence, edited, ...select }: EnumFieldProps<T>) {
  const { ids } = select
  const invalid = error !== undefined
  return (
    <TagField ids={ids} label={label} labelFor confidence={confidence} edited={edited} error={error}>
      <EnumSelect
        {...select}
        invalid={invalid}
        describedBy={joinIds(confidence !== undefined && ids.hint, invalid && ids.error)}
      />
    </TagField>
  )
}

type ChoiceGroupProps<T extends string> = {
  labelId: string
  values: readonly T[]
  labels: Record<T, string>
  value: T
  onChange: (value: T) => void
  buttonRef: Ref<HTMLButtonElement>
  disabled?: boolean
}

/** A single-choice toggle group that always keeps one option pressed. */
export function ChoiceGroup<T extends string>({
  labelId,
  values,
  labels,
  value,
  onChange,
  buttonRef,
  disabled,
}: ChoiceGroupProps<T>) {
  return (
    <ToggleGroup
      variant="outline"
      size="touch"
      value={[value]}
      onValueChange={(next) => {
        // Pressing the active option again would empty the group; a choice stays required.
        const [chosen] = next
        if (isOneOf(values, chosen)) onChange(chosen)
      }}
      aria-labelledby={labelId}
      disabled={disabled}
      className="w-full flex-wrap"
    >
      {values.map((option) => (
        <ToggleGroupItem
          key={option}
          value={option}
          ref={option === value ? buttonRef : undefined}
          className={PRESSED_CLASSES}
        >
          {option === value ? <Check aria-hidden /> : null}
          {labels[option]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

type SwitchRowProps = {
  ids: FieldIds
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  onBlur: () => void
  inputRef: Ref<HTMLInputElement>
  confidence?: number
  edited?: boolean
  disabled?: boolean
}

export function SwitchRow({
  ids,
  label,
  description,
  checked,
  onCheckedChange,
  onBlur,
  inputRef,
  confidence,
  edited,
  disabled,
}: SwitchRowProps) {
  const descriptionId = `${ids.control}-description`
  return (
    <Field
      orientation="horizontal"
      data-low-confidence={confidence !== undefined || undefined}
      className={cn("min-h-11 items-center justify-between gap-4", confidence !== undefined && LOW_CONFIDENCE_RING)}
    >
      <FieldContent>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <FieldLabel id={ids.label} htmlFor={ids.control}>
            {label}
          </FieldLabel>
          {edited ? <Badge variant="outline">Edited</Badge> : null}
          {confidence !== undefined ? <ConfidenceHint id={ids.hint} confidence={confidence} /> : null}
        </div>
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      </FieldContent>
      <Switch
        id={ids.control}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        onBlur={onBlur}
        inputRef={inputRef}
        aria-describedby={joinIds(descriptionId, confidence !== undefined && ids.hint)}
        disabled={disabled}
        // Taller invisible hit area: 18 px switch plus 14 px above and below is 46 px.
        className="after:-inset-y-3.5"
      />
    </Field>
  )
}

type MaterialsFieldsProps = {
  control: TextFieldProps["control"]
  ids: (name: string) => FieldIds
  confidence?: number
  editedMaterials: boolean
  editedGuess: boolean
  disabled: boolean
}

/** The material list and the one-line material guess share Claude's single "materials" confidence. */
export function MaterialsFields({
  control,
  ids,
  confidence,
  editedMaterials,
  editedGuess,
  disabled,
}: MaterialsFieldsProps) {
  const materialIds = ids("materials")
  return (
    <div className="flex flex-col gap-4">
      <Controller
        control={control}
        name="materials"
        render={({ field, fieldState }) => (
          <TagField
            ids={materialIds}
            label="Materials"
            confidence={confidence}
            edited={editedMaterials}
            error={fieldState.error}
          >
            <TextChips
              labelId={materialIds.label}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              inputRef={field.ref}
              invalid={fieldState.invalid}
              describedBy={joinIds(
                confidence !== undefined && materialIds.hint,
                fieldState.invalid && materialIds.error
              )}
              max={TAG_LIMITS.materialsMax}
              noun="material"
              placeholder="e.g. wool, polyester shell"
              disabled={disabled}
            />
          </TagField>
        )}
      />
      <TextField
        control={control}
        name="material_guess"
        ids={ids("material-guess")}
        label="Material in a few words"
        placeholder="e.g. boiled wool with a cotton lining"
        maxLength={TAG_LIMITS.shortTextMax}
        edited={editedGuess}
      />
    </div>
  )
}
