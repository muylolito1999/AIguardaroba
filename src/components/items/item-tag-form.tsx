"use client"

import { useEffect, useId, useRef, useState, type BaseSyntheticEvent } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Check, CheckCheck, Loader2, RefreshCw, Save, X } from "lucide-react"
import {
  Controller,
  useForm,
  useFormState,
  type Control,
  type DefaultValues,
  type UseFormSetError,
} from "react-hook-form"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  FORMALITIES,
  ITEM_CATEGORIES,
  ITEM_CONDITIONS,
  ITEM_DECISIONS,
  ITEM_LOCATIONS,
  SEASONS,
} from "@/lib/db/enums"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import { ItemPatchSchema, TAG_LIMITS, type EditableTagField, type ItemCardDto } from "@/lib/items/contracts"
import { err, type AppErrorPayload, type Result } from "@/lib/result"
import { toastError } from "@/lib/toast-result"
import { cn } from "@/lib/utils"

import { ColorChips } from "./chip-inputs"
import type { ConfirmItemAction, TagItemByHandAction, UpdateItemTagsAction } from "./review-actions"
import { fieldIds, joinIds, TagField, type FieldIds } from "./tag-field"
import {
  ChoiceGroup,
  EnumField,
  MaterialsFields,
  PRESSED_CLASSES,
  SWITCH_COPY,
  SwitchRow,
  TextField,
} from "./tag-form-controls"
import {
  BREATHABLE_CHOICES,
  diffPatch,
  hasTags,
  isEmptyPatch,
  isSeason,
  isTagFormField,
  itemTitle,
  lowConfidenceFields,
  manualTagFormDefaults,
  sortSeasons,
  tagFormBaseline,
  tagFormDefaults,
  tagFormErrorMap,
  tagFormSchema,
  type BreathableChoice,
  type HintField,
  type TagFormOutput,
  type TagFormValues,
  type TaggedItemCard,
} from "./tag-form-model"
import {
  CATEGORY_LABELS,
  CONDITION_LABELS,
  DECISION_LABELS,
  FORMALITY_LABELS,
  LOCATION_LABELS,
  SEASON_LABELS,
} from "./tag-options"
import { requestTagging } from "./tag-request"
import { WarmthSlider } from "./warmth-slider"

type FormCallbacks = {
  /** The item was confirmed and can leave the review list. */
  onConfirmed: (item: ItemCardDto) => void
  /** Reports unsaved edits, so bulk confirm and a server re-sync leave this item alone. */
  onDirtyChange?: (itemId: string, dirty: boolean) => void
}

/** Checking and editing Claude's tags on a tagged item. */
export type ReviewTagFormProps = FormCallbacks & {
  mode?: "review"
  item: TaggedItemCard
  updateItemTags: UpdateItemTagsAction
  confirmItem: ConfirmItemAction
  /** The server's new version of the item after Save or Re-tag. */
  onItemChange: (item: ItemCardDto) => void
  /** Injected by tests; POSTs /api/items/[id]/tag otherwise. */
  tagRequest?: typeof requestTagging
}

/** Filling in the tags of a pending item by hand, without Claude (D-093). */
export type ManualTagFormProps = FormCallbacks & {
  mode: "manual"
  item: ItemCardDto
  tagItemByHand: TagItemByHandAction
  /** The tags were saved: the server's item, now tagged. */
  onItemChange: (item: ItemCardDto) => void
  /** Back to the tagging controls without saving. */
  onCancel: () => void
}

export type ItemTagFormProps = ReviewTagFormProps | ManualTagFormProps

type BusyAction = "save" | "confirm" | "retag"

type TagFormControl = Control<TagFormValues, unknown, TagFormOutput>

const BREATHABLE_LABELS: Record<BreathableChoice, string> = { yes: "Yes", no: "No", unknown: "Unknown" }

// Form fields whose saved value differs from Claude's, by the names
// user_edited_fields stores (colours are one control for two columns).
const EDITED_NAMES: Partial<Record<keyof TagFormValues, readonly EditableTagField[]>> = {
  colors: ["colors", "color_hex"],
}

/** True when react-hook-form marks the field, or anything inside it, as changed. */
function isMarkedDirty(marker: unknown): boolean {
  if (marker === true) return true
  if (marker === null || typeof marker !== "object") return false
  return Object.values(marker).some(isMarkedDirty)
}

/** Maps a server field name (patch path head or EditableTagField) to the form control showing it. */
function formFieldFor(name: string): keyof TagFormValues | null {
  const field = name === "color_hex" ? "colors" : name
  return isTagFormField(field) ? field : null
}

/**
 * Puts server-side VALIDATION problems back on the matching controls: issues
 * with paths like "patch.name", and the required fields a hand-tagged item
 * still lacks (details.missing).
 */
function applyServerIssues(error: AppErrorPayload, setError: UseFormSetError<TagFormValues>): void {
  if (error.code !== "VALIDATION") return
  const issues = error.details?.issues
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      if (issue === null || typeof issue !== "object") continue
      const path = "path" in issue && typeof issue.path === "string" ? issue.path : ""
      const message = "message" in issue && typeof issue.message === "string" ? issue.message : error.message
      const field = formFieldFor(path.replace(/^patch\./, "").split(".")[0] ?? "")
      if (field !== null) setError(field, { type: "server", message })
    }
  }
  const missing = error.details?.missing
  if (Array.isArray(missing)) {
    for (const name of missing) {
      const field = typeof name === "string" ? formFieldFor(name) : null
      if (field !== null) setError(field, { type: "server", message: "Required." })
    }
  }
}

/**
 * State both modes share: the form, the running request, the status line and
 * the dirty report. A newer card from the list (fresh server data after a
 * revisit, a finished cut-out) becomes the form's starting point when it
 * arrives while nothing is unsaved and no request runs.
 */
function useTagForm<I extends ItemCardDto>(
  item: I,
  toDefaults: (item: I) => DefaultValues<TagFormValues>,
  onDirtyChange: FormCallbacks["onDirtyChange"]
) {
  const base = useId()
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [status, setStatus] = useState("")
  const focusBeforeBusyRef = useRef<HTMLElement | null>(null)
  const previousItemRef = useRef(item)

  const form = useForm<TagFormValues, unknown, TagFormOutput>({
    resolver: zodResolver(tagFormSchema, { error: tagFormErrorMap }),
    defaultValues: toDefaults(item),
  })
  const { isDirty, dirtyFields } = useFormState({ control: form.control })

  useEffect(() => {
    onDirtyChange?.(item.id, isDirty)
  }, [isDirty, item.id, onDirtyChange])

  // Reacts to a new item prop only; unsaved edits and a running request keep the form as it is.
  useEffect(() => {
    if (previousItemRef.current === item) return
    previousItemRef.current = item
    if (busy !== null || isDirty) return
    form.reset(toDefaults(item))
  }, [item, busy, isDirty, form, toDefaults])

  // The fieldsets are disabled while a request runs, which drops focus from a
  // text field when Enter saved the form; put it back once they are enabled.
  useEffect(() => {
    if (busy !== null) return
    const previous = focusBeforeBusyRef.current
    focusBeforeBusyRef.current = null
    if (previous?.isConnected && document.activeElement === document.body) previous.focus()
  }, [busy])

  /**
   * Runs one request with the form disabled. A rejected call (offline, a
   * platform error page, an action unknown after a redeploy) becomes a
   * network error, so the form is enabled again and the edits stay.
   */
  async function run<T>(action: BusyAction, pending: string, call: () => Promise<Result<T>>): Promise<Result<T>> {
    focusBeforeBusyRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setBusy(action)
    setStatus(pending)
    try {
      return await call()
    } catch {
      return err("UPSTREAM", NETWORK_ERROR_MESSAGE)
    } finally {
      setBusy(null)
    }
  }

  function fail(outcome: string, error: AppErrorPayload) {
    applyServerIssues(error, form.setError)
    toastError(error)
    // The toast disappears; the line under the buttons keeps the reason visible.
    setStatus(`${outcome}: ${error.message}`)
  }

  function ids(name: string): FieldIds {
    return fieldIds(base, name)
  }

  return { form, busy, status, setStatus, isDirty, dirtyFields, run, fail, ids }
}

/** Shows either form: the review form for tagged items, the hand-tagging form for pending ones. */
export function ItemTagForm(props: ItemTagFormProps) {
  return props.mode === "manual" ? <ManualTagForm {...props} /> : <ReviewTagForm {...props} />
}

/**
 * The editable tags of one tagged item. Save and Confirm send only the fields
 * that differ from the item's current values; the server records which of
 * them differ from Claude's output in user_edited_fields, and a re-tag keeps
 * those. Fields Claude was unsure about carry a visible "Check this" hint and
 * an amber ring until they are edited.
 */
function ReviewTagForm({
  item,
  updateItemTags,
  confirmItem,
  onItemChange,
  onConfirmed,
  onDirtyChange,
  tagRequest = requestTagging,
}: ReviewTagFormProps) {
  const { form, busy, status, setStatus, isDirty, dirtyFields, run, fail, ids } = useTagForm(
    item,
    tagFormDefaults,
    onDirtyChange
  )
  const [retagOpen, setRetagOpen] = useState(false)
  const retagButtonRef = useRef<HTMLButtonElement>(null)

  const hints = lowConfidenceFields(item)
  const edited = new Set(item.userEditedFields)

  /** Confidence to show for a field, or undefined once it is edited (saved or not). */
  function hintFor(field: HintField, ...formFields: (keyof TagFormValues)[]): number | undefined {
    const confidence = hints.get(field)
    if (confidence === undefined) return undefined
    const touched = (formFields.length > 0 ? formFields : [field]).some((name) =>
      isMarkedDirty(dirtyFields[name])
    )
    return touched ? undefined : confidence
  }

  function isEdited(field: keyof TagFormValues): boolean {
    const names = EDITED_NAMES[field] ?? [field]
    return names.some((name) => edited.has(name))
  }

  /** Swaps in the server's version of the item and makes it the form's new baseline. */
  function adopt(next: ItemCardDto) {
    onItemChange(next)
    if (hasTags(next)) form.reset(tagFormDefaults(next))
  }

  async function saveValues(values: TagFormOutput) {
    const patch = diffPatch(tagFormBaseline(item), values)
    if (isEmptyPatch(patch)) {
      setStatus("Nothing to save: no field differs from the saved tags.")
      return
    }
    const result = await run("save", "Saving…", () => updateItemTags({ id: item.id, patch }))
    if (!result.ok) return fail("Not saved", result.error)
    adopt(result.data)
    // Focus stays where it was (Save is focusableWhenDisabled; a text field gets it
    // back from the effect in useTagForm), so this status line announces the outcome.
    setStatus("Saved.")
  }

  async function confirmValues(values: TagFormOutput) {
    const patch = diffPatch(tagFormBaseline(item), values)
    const result = await run("confirm", "Confirming…", () =>
      confirmItem(isEmptyPatch(patch) ? { id: item.id } : { id: item.id, patch })
    )
    if (!result.ok) return fail("Not confirmed", result.error)
    setStatus("Confirmed.")
    onConfirmed(result.data)
  }

  // handleSubmit runs zod first and calls the handler only with valid values;
  // it is built inside the event handlers so nothing here runs during render.
  function save(event: BaseSyntheticEvent) {
    return form.handleSubmit(saveValues)(event)
  }

  function confirm(event: BaseSyntheticEvent) {
    return form.handleSubmit(confirmValues)(event)
  }

  async function retag() {
    setRetagOpen(false)
    const result = await run("retag", "Claude is re-tagging this item…", () =>
      tagRequest(item.id, { force: true })
    )
    if (!result.ok) return fail("Re-tag failed", result.error)
    adopt(result.data.item)
    setStatus("Claude re-tagged this item. Fields you had edited kept your values.")
  }

  const disabled = busy !== null

  return (
    <form
      noValidate
      aria-label={`Tags for ${item.name}`}
      aria-busy={busy !== null || undefined}
      // Enter in a text field saves (reversible) rather than confirms.
      onSubmit={(event) => void save(event)}
      className="flex flex-col gap-6"
    >
      <TagFormSections control={form.control} ids={ids} disabled={disabled} hintFor={hintFor} isEdited={isEdited} />

      <div className="flex flex-col gap-3 border-t pt-4">
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {status}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="touch"
            onClick={(event) => void confirm(event)}
            disabled={disabled}
            focusableWhenDisabled
            aria-busy={busy === "confirm" || undefined}
          >
            {busy === "confirm" ? <Loader2 aria-hidden className="animate-spin" /> : <CheckCheck aria-hidden />}
            {isDirty ? "Save and confirm" : "Confirm"}
          </Button>
          <Button
            type="submit"
            variant="outline"
            size="touch"
            disabled={disabled || !isDirty}
            focusableWhenDisabled
            aria-busy={busy === "save" || undefined}
          >
            {busy === "save" ? <Loader2 aria-hidden className="animate-spin" /> : <Save aria-hidden />}
            Save
          </Button>
          {/* A plain button rather than AlertDialogTrigger: it must stay focusable while the
              re-tag runs, so the dialog can hand focus back to it on close. */}
          <Button
            ref={retagButtonRef}
            type="button"
            variant="ghost"
            size="touch"
            onClick={() => setRetagOpen(true)}
            disabled={disabled}
            focusableWhenDisabled
            aria-haspopup="dialog"
            aria-busy={busy === "retag" || undefined}
          >
            {busy === "retag" ? <Loader2 aria-hidden className="animate-spin" /> : <RefreshCw aria-hidden />}
            Re-tag
          </Button>
          <AlertDialog open={retagOpen} onOpenChange={setRetagOpen}>
            <AlertDialogContent finalFocus={retagButtonRef}>
              <AlertDialogHeader>
                <AlertDialogTitle>Ask Claude to tag this item again?</AlertDialogTitle>
                <AlertDialogDescription>
                  Claude looks at the photo again and replaces its tags. Fields you edited keep your
                  values. This is one new Claude call, which counts toward the monthly AI budget.
                  {isDirty ? " Unsaved changes in this form will be lost." : ""}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel size="touch">Cancel</AlertDialogCancel>
                <AlertDialogAction size="touch" onClick={() => void retag()}>
                  Re-tag
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </form>
  )
}

const NO_HINT = (): undefined => undefined
const NOT_EDITED = (): boolean => false

/**
 * The same form for a pending item, filled in by hand (D-093): no Claude call,
 * no hints and no Re-tag. Category, formality and condition start unset; the
 * form schema requires them, a name, a colour and a season before anything is
 * sent. Save stores the tags (the item becomes tagged and shows the review
 * form); Save and confirm moves it to the wardrobe. The server records every
 * tag field with a value as the owner's own and keeps ai_raw empty.
 */
function ManualTagForm({
  item,
  tagItemByHand,
  onItemChange,
  onConfirmed,
  onDirtyChange,
  onCancel,
}: ManualTagFormProps) {
  const { form, busy, status, setStatus, ids, run, fail } = useTagForm(item, manualTagFormDefaults, onDirtyChange)
  const introId = `${ids("manual").control}-intro`
  const focusedOnOpenRef = useRef(false)

  // Opening replaces the button that had focus; start at the first field. A
  // ref, so showing the page again after a navigation does not move focus.
  useEffect(() => {
    if (focusedOnOpenRef.current) return
    focusedOnOpenRef.current = true
    form.setFocus("name")
  }, [form])

  async function store(values: TagFormOutput, confirm: boolean) {
    // Every field: the server keeps those with a value and checks the required ones again.
    const patch = ItemPatchSchema.parse(values)
    const result = await run(confirm ? "confirm" : "save", confirm ? "Saving and confirming…" : "Saving…", () =>
      tagItemByHand({ id: item.id, patch, confirm })
    )
    if (!result.ok) return fail(confirm ? "Not confirmed" : "Not saved", result.error)
    setStatus(confirm ? "Confirmed." : "Saved.")
    if (confirm) onConfirmed(result.data)
    else onItemChange(result.data)
  }

  function save(event: BaseSyntheticEvent) {
    return form.handleSubmit((values) => store(values, false))(event)
  }

  function saveAndConfirm(event: BaseSyntheticEvent) {
    return form.handleSubmit((values) => store(values, true))(event)
  }

  const disabled = busy !== null

  return (
    <form
      noValidate
      aria-label={`Tags for ${itemTitle(item)}`}
      aria-describedby={introId}
      aria-busy={busy !== null || undefined}
      // Enter in a text field saves; confirming stays a deliberate click.
      onSubmit={(event) => void save(event)}
      className="flex flex-col gap-6"
    >
      <p id={introId} className="text-sm text-muted-foreground text-pretty">
        Fill in the tags yourself; Claude is not asked and nothing counts toward the AI budget. A name,
        category, colour, season, formality and condition are required.
      </p>

      <TagFormSections control={form.control} ids={ids} disabled={disabled} hintFor={NO_HINT} isEdited={NOT_EDITED} />

      <div className="flex flex-col gap-3 border-t pt-4">
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {status}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="touch"
            onClick={(event) => void saveAndConfirm(event)}
            disabled={disabled}
            focusableWhenDisabled
            aria-busy={busy === "confirm" || undefined}
          >
            {busy === "confirm" ? <Loader2 aria-hidden className="animate-spin" /> : <CheckCheck aria-hidden />}
            Save and confirm
          </Button>
          <Button
            type="submit"
            variant="outline"
            size="touch"
            disabled={disabled}
            focusableWhenDisabled
            aria-busy={busy === "save" || undefined}
          >
            {busy === "save" ? <Loader2 aria-hidden className="animate-spin" /> : <Save aria-hidden />}
            Save
          </Button>
          <Button type="button" variant="ghost" size="touch" onClick={onCancel} disabled={disabled} focusableWhenDisabled>
            <X aria-hidden />
            Cancel
          </Button>
        </div>
      </div>
    </form>
  )
}

type TagFormSectionsProps = {
  control: TagFormControl
  ids: (name: string) => FieldIds
  disabled: boolean
  /** Claude's confidence to show on a field, or undefined for none. */
  hintFor: (field: HintField, ...formFields: (keyof TagFormValues)[]) => number | undefined
  /** True when the owner's saved value differs from Claude's. */
  isEdited: (field: keyof TagFormValues) => boolean
}

/** Every field section of the tag form; both modes share them and differ only in the footer. */
function TagFormSections({ control, ids, disabled, hintFor, isEdited }: TagFormSectionsProps) {
  return (
    <>
      <FieldSet disabled={disabled}>
        <FieldLegend className="sr-only">Basics</FieldLegend>
        <TextField
          control={control}
          name="name"
          ids={ids("name")}
          label="Name"
          maxLength={TAG_LIMITS.nameMax}
          edited={isEdited("name")}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Controller
            control={control}
            name="category"
            render={({ field, fieldState }) => (
              <EnumField
                ids={ids("category")}
                label="Category"
                values={ITEM_CATEGORIES}
                labels={CATEGORY_LABELS}
                value={field.value ?? null}
                onChange={field.onChange}
                onBlur={field.onBlur}
                inputRef={field.ref}
                error={fieldState.error}
                confidence={hintFor("category")}
                edited={isEdited("category")}
                disabled={disabled}
              />
            )}
          />
          <TextField
            control={control}
            name="subcategory"
            ids={ids("subcategory")}
            label="Type"
            placeholder="e.g. parka, chinos, chelsea boots"
            maxLength={TAG_LIMITS.shortTextMax}
            edited={isEdited("subcategory")}
          />
        </div>
        <Controller
          control={control}
          name="description"
          render={({ field, fieldState }) => {
            const fieldIdSet = ids("description")
            const counterId = `${fieldIdSet.control}-counter`
            const length = field.value.trim().length
            const over = length > TAG_LIMITS.descriptionMax
            return (
              <TagField
                ids={fieldIdSet}
                label="Description"
                labelFor
                edited={isEdited("description")}
                error={fieldState.error}
              >
                <Textarea
                  id={fieldIdSet.control}
                  ref={field.ref}
                  name={field.name}
                  value={field.value}
                  onChange={(event) => field.onChange(event.target.value)}
                  onBlur={field.onBlur}
                  rows={3}
                  aria-invalid={fieldState.invalid || undefined}
                  aria-describedby={joinIds(counterId, fieldState.invalid && fieldIdSet.error)}
                  disabled={disabled}
                />
                <p
                  id={counterId}
                  className={cn(
                    "text-xs tabular-nums",
                    over ? "font-medium text-destructive" : "text-muted-foreground"
                  )}
                >
                  {length} of {TAG_LIMITS.descriptionMax} characters{over ? ", too long" : ""}
                </p>
              </TagField>
            )
          }}
        />
      </FieldSet>

      <FieldSet disabled={disabled}>
        <FieldLegend>Colours and materials</FieldLegend>
        <Controller
          control={control}
          name="colors"
          render={({ field, fieldState }) => {
            const fieldIdSet = ids("colors")
            const confidence = hintFor("colors")
            return (
              <TagField
                ids={fieldIdSet}
                label="Colours"
                confidence={confidence}
                edited={isEdited("colors")}
                error={fieldState.error}
                description={
                  <FieldDescription>
                    Main colour first. Tap a swatch to change it.
                  </FieldDescription>
                }
              >
                <ColorChips
                  labelId={fieldIdSet.label}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  inputRef={field.ref}
                  invalid={fieldState.invalid}
                  describedBy={joinIds(
                    confidence !== undefined && fieldIdSet.hint,
                    fieldState.invalid && fieldIdSet.error
                  )}
                  disabled={disabled}
                />
              </TagField>
            )
          }}
        />
        <MaterialsFields
          control={control}
          ids={ids}
          confidence={hintFor("materials", "materials", "material_guess")}
          editedMaterials={isEdited("materials")}
          editedGuess={isEdited("material_guess")}
          disabled={disabled}
        />
      </FieldSet>

      <FieldSet disabled={disabled}>
        <FieldLegend>Warmth and weather</FieldLegend>
        <Controller
          control={control}
          name="warmth_level"
          render={({ field, fieldState }) => {
            const fieldIdSet = ids("warmth")
            const confidence = hintFor("warmth_level")
            return (
              <TagField
                ids={fieldIdSet}
                label="Warmth"
                confidence={confidence}
                edited={isEdited("warmth_level")}
                error={fieldState.error}
              >
                <WarmthSlider
                  labelId={fieldIdSet.label}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  inputRef={field.ref}
                  describedBy={joinIds(confidence !== undefined && fieldIdSet.hint)}
                  disabled={disabled}
                />
              </TagField>
            )
          }}
        />
        <div className="flex flex-col gap-2">
          {(["waterproof", "windproof", "insulated"] as const).map((name) => (
            <Controller
              key={name}
              control={control}
              name={name}
              render={({ field }) => (
                <SwitchRow
                  ids={ids(name)}
                  label={SWITCH_COPY[name].label}
                  description={SWITCH_COPY[name].description}
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  onBlur={field.onBlur}
                  inputRef={field.ref}
                  confidence={hintFor(name)}
                  edited={isEdited(name)}
                  disabled={disabled}
                />
              )}
            />
          ))}
        </div>
        <Controller
          control={control}
          name="breathable"
          render={({ field, fieldState }) => (
            <TagField
              ids={ids("breathable")}
              label="Breathable"
              edited={isEdited("breathable")}
              error={fieldState.error}
            >
              <ChoiceGroup
                labelId={ids("breathable").label}
                values={BREATHABLE_CHOICES}
                labels={BREATHABLE_LABELS}
                value={field.value}
                onChange={field.onChange}
                buttonRef={field.ref}
                disabled={disabled}
              />
            </TagField>
          )}
        />
        <Controller
          control={control}
          name="seasons"
          render={({ field, fieldState }) => {
            const fieldIdSet = ids("seasons")
            return (
              <TagField ids={fieldIdSet} label="Seasons" edited={isEdited("seasons")} error={fieldState.error}>
                <ToggleGroup
                  multiple
                  variant="outline"
                  size="touch"
                  value={field.value}
                  onValueChange={(next) => field.onChange(sortSeasons(next.filter(isSeason)))}
                  aria-labelledby={fieldIdSet.label}
                  aria-describedby={joinIds(fieldState.invalid && fieldIdSet.error)}
                  disabled={disabled}
                  className="w-full flex-wrap"
                >
                  {SEASONS.map((season, index) => (
                    <ToggleGroupItem
                      key={season}
                      value={season}
                      ref={index === 0 ? field.ref : undefined}
                      onBlur={field.onBlur}
                      className={PRESSED_CLASSES}
                    >
                      {field.value.includes(season) ? <Check aria-hidden /> : null}
                      {SEASON_LABELS[season]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </TagField>
            )
          }}
        />
      </FieldSet>

      <FieldSet disabled={disabled}>
        <FieldLegend>Style and condition</FieldLegend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Controller
            control={control}
            name="formality"
            render={({ field, fieldState }) => (
              <EnumField
                ids={ids("formality")}
                label="Formality"
                values={FORMALITIES}
                labels={FORMALITY_LABELS}
                value={field.value ?? null}
                onChange={field.onChange}
                onBlur={field.onBlur}
                inputRef={field.ref}
                error={fieldState.error}
                confidence={hintFor("formality")}
                edited={isEdited("formality")}
                disabled={disabled}
              />
            )}
          />
          <Controller
            control={control}
            name="condition"
            render={({ field, fieldState }) => (
              <EnumField
                ids={ids("condition")}
                label="Condition"
                values={ITEM_CONDITIONS}
                labels={CONDITION_LABELS}
                value={field.value ?? null}
                onChange={field.onChange}
                onBlur={field.onBlur}
                inputRef={field.ref}
                error={fieldState.error}
                confidence={hintFor("condition")}
                edited={isEdited("condition")}
                disabled={disabled}
              />
            )}
          />
          <TextField
            control={control}
            name="brand"
            ids={ids("brand")}
            label="Brand"
            placeholder="Only if a label or logo shows it"
            maxLength={TAG_LIMITS.brandMax}
            confidence={hintFor("brand")}
            edited={isEdited("brand")}
          />
          <TextField
            control={control}
            name="pattern"
            ids={ids("pattern")}
            label="Pattern"
            placeholder="e.g. solid, striped, check"
            maxLength={TAG_LIMITS.shortTextMax}
            edited={isEdited("pattern")}
          />
          <TextField
            control={control}
            name="fit"
            ids={ids("fit")}
            label="Fit"
            placeholder="e.g. slim, regular, oversized"
            maxLength={TAG_LIMITS.shortTextMax}
            edited={isEdited("fit")}
          />
          <TextField
            control={control}
            name="size"
            ids={ids("size")}
            label="Size"
            placeholder="e.g. M, 42, 32/34"
            maxLength={40}
          />
        </div>
      </FieldSet>

      <FieldSet disabled={disabled}>
        <FieldLegend>Purchase and plans</FieldLegend>
        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-4 sm:grid-cols-[minmax(0,12rem)_6rem_minmax(0,12rem)]">
          <TextField
            control={control}
            name="purchase_price"
            ids={ids("price")}
            label="Price"
            inputMode="decimal"
            placeholder="e.g. 49.90"
          />
          <TextField
            control={control}
            name="currency"
            ids={ids("currency")}
            label="Currency"
            maxLength={3}
            autoCapitalize="characters"
          />
          <TextField
            control={control}
            name="purchase_date"
            ids={ids("purchase-date")}
            label="Bought on"
            type="date"
            className="col-span-2 sm:col-span-1"
          />
        </div>
        <Controller
          control={control}
          name="location"
          render={({ field }) => (
            <TagField ids={ids("location")} label="Where it is now">
              <ChoiceGroup
                labelId={ids("location").label}
                values={ITEM_LOCATIONS}
                labels={LOCATION_LABELS}
                value={field.value}
                onChange={field.onChange}
                buttonRef={field.ref}
                disabled={disabled}
              />
            </TagField>
          )}
        />
        <Controller
          control={control}
          name="decision"
          render={({ field }) => (
            <TagField ids={ids("decision")} label="Plan for the move">
              <ChoiceGroup
                labelId={ids("decision").label}
                values={ITEM_DECISIONS}
                labels={DECISION_LABELS}
                value={field.value}
                onChange={field.onChange}
                buttonRef={field.ref}
                disabled={disabled}
              />
            </TagField>
          )}
        />
        <Controller
          control={control}
          name="notes"
          render={({ field, fieldState }) => (
            <TagField ids={ids("notes")} label="Notes" labelFor error={fieldState.error}>
              <Textarea
                id={ids("notes").control}
                ref={field.ref}
                name={field.name}
                value={field.value}
                onChange={(event) => field.onChange(event.target.value)}
                onBlur={field.onBlur}
                rows={2}
                aria-invalid={fieldState.invalid || undefined}
                aria-describedby={joinIds(fieldState.invalid && ids("notes").error)}
                disabled={disabled}
              />
            </TagField>
          )}
        />
      </FieldSet>
    </>
  )
}
