"use client"

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Check, Plus, SlidersHorizontal } from "lucide-react"

import {
  CONDITION_LABELS,
  DECISION_LABELS,
  FORMALITY_LABELS,
  LOCATION_LABELS,
  SEASON_LABELS,
  STATUS_LABELS,
  WARMTH_RUBRIC,
} from "@/components/items/tag-options"
import { PRESSED_CLASSES } from "@/components/items/tag-form-controls"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  FORMALITIES,
  ITEM_CONDITIONS,
  ITEM_DECISIONS,
  ITEM_LOCATIONS,
  ITEM_STATUSES,
  SEASONS,
} from "@/lib/db/enums"
import { WARMTH_LEVELS, type WarmthLevel } from "@/lib/items/contracts"
import {
  activeFilterCount,
  DEFAULT_ITEM_FILTERS,
  ITEM_FILTER_LIMITS,
  normalizeColors,
  type ItemFilters,
} from "@/lib/items/filters"
import { cn } from "@/lib/utils"

import type { ColorOption } from "./color-options"
import type { FiltersChange } from "./use-wardrobe-filters"

/** The filters the panel owns; search, category and sort have their own controls and survive a reset. */
export function resetPanelFilters(current: ItemFilters): ItemFilters {
  return { ...DEFAULT_ITEM_FILTERS, q: current.q, category: current.category, sort: current.sort }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * One filter with its heading and an optional hint. The controls get the
 * heading as their name and the hint as their description (hintId, undefined
 * without a hint), so a screen reader that moves into a group hears the rule
 * the hint states, like the tag form's controls.
 */
function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: (labelId: string, hintId: string | undefined) => ReactNode
}) {
  const labelId = useId()
  const hintId = useId()
  return (
    <section aria-labelledby={labelId} className="flex flex-col gap-2">
      <h3 id={labelId} className="text-sm font-medium text-foreground">
        {title}
      </h3>
      {hint ? (
        <p id={hintId} className="-mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {children(labelId, hint ? hintId : undefined)}
    </section>
  )
}

type MultiChoiceProps<T extends string> = {
  labelId: string
  /** The section's hint, read as the group's description. */
  hintId?: string
  values: readonly T[]
  labels: Record<T, string>
  selected: readonly T[]
  onChange: (next: T[]) => void
}

/** Toggle buttons where any number may be pressed; none pressed means "any". */
function MultiChoice<T extends string>({ labelId, hintId, values, labels, selected, onChange }: MultiChoiceProps<T>) {
  return (
    <ToggleGroup
      multiple
      variant="outline"
      size="touch"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      value={[...selected]}
      onValueChange={(next) => onChange(values.filter((value) => next.includes(value)))}
      className="w-full flex-wrap"
    >
      {values.map((value) => (
        <ToggleGroupItem key={value} value={value} className={PRESSED_CLASSES}>
          {selected.includes(value) ? <Check aria-hidden /> : null}
          {labels[value]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

const TRI_STATE = ["any", "yes", "no"] as const
type TriState = (typeof TRI_STATE)[number]
const TRI_STATE_LABELS: Record<TriState, string> = { any: "Any", yes: "Yes", no: "No" }

function toTriState(value: boolean | null): TriState {
  if (value === null) return "any"
  return value ? "yes" : "no"
}

/** Any, Yes or No: one is always pressed. */
function TriStateChoice({
  labelId,
  value,
  onChange,
}: {
  labelId: string
  value: boolean | null
  onChange: (next: boolean | null) => void
}) {
  const current = toTriState(value)
  return (
    <ToggleGroup
      variant="outline"
      size="touch"
      aria-labelledby={labelId}
      value={[current]}
      onValueChange={(next) => {
        // Pressing the pressed option again would leave none; the choice stays as it is.
        const [chosen] = next
        if (chosen === "any") onChange(null)
        else if (chosen === "yes") onChange(true)
        else if (chosen === "no") onChange(false)
      }}
      className="w-full"
    >
      {TRI_STATE.map((option) => (
        <ToggleGroupItem key={option} value={option} className={cn("flex-1", PRESSED_CLASSES)}>
          {option === current ? <Check aria-hidden /> : null}
          {TRI_STATE_LABELS[option]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function parseWarmthOption(value: string): WarmthLevel | null {
  return WARMTH_LEVELS.find((level) => String(level) === value) ?? null
}

function WarmthSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: WarmthLevel | null
  onChange: (next: WarmthLevel | null) => void
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <NativeSelect
        id={id}
        value={value === null ? "" : String(value)}
        onChange={(event) => onChange(parseWarmthOption(event.target.value))}
        className="w-full [&_select]:h-11"
      >
        <NativeSelectOption value="">Any</NativeSelectOption>
        {WARMTH_LEVELS.map((level) => (
          <NativeSelectOption key={level} value={String(level)}>
            {level} · {WARMTH_RUBRIC[level].label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  )
}

function ColorChoice({
  labelId,
  hintId,
  options,
  selected,
  onChange,
}: {
  labelId: string
  hintId?: string
  options: readonly ColorOption[]
  selected: readonly string[]
  onChange: (next: string[]) => void
}) {
  const inputId = useId()
  const [draft, setDraft] = useState("")
  const atLimit = selected.length >= ITEM_FILTER_LIMITS.colorsMax

  function addDraft() {
    const [color] = normalizeColors([draft])
    if (color === undefined) return
    onChange([...selected, color])
    setDraft("")
  }

  return (
    <div className="flex flex-col gap-3">
      {options.length > 0 ? (
        <ToggleGroup
          multiple
          variant="outline"
          size="touch"
          aria-labelledby={labelId}
          aria-describedby={hintId}
          value={[...selected]}
          onValueChange={(next) => onChange(next)}
          className="w-full flex-wrap"
        >
          {options.map((option) => (
            <ToggleGroupItem
              key={option.name}
              value={option.name}
              // A new colour cannot be added past the limit; removing one always works.
              disabled={atLimit && !selected.includes(option.name)}
              className={cn("gap-2", PRESSED_CLASSES)}
            >
              {selected.includes(option.name) ? (
                <Check aria-hidden />
              ) : (
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full border border-foreground/20"
                  style={option.hex === null ? undefined : { backgroundColor: option.hex }}
                />
              )}
              {option.name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <p className="text-xs text-muted-foreground">None of these items has a colour yet.</p>
      )}
      <div className="flex gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={inputId} className="text-xs text-muted-foreground">
            Another colour
          </label>
          <Input
            id={inputId}
            value={draft}
            maxLength={ITEM_FILTER_LIMITS.colorMax}
            autoComplete="off"
            placeholder="e.g. olive"
            // Without colours on offer the group above is not there; the field still explains itself.
            aria-describedby={hintId}
            disabled={atLimit}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                addDraft()
              }
            }}
            className="h-11"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="touch"
          onClick={addDraft}
          disabled={atLimit || draft.trim() === ""}
          focusableWhenDisabled
          className="self-end"
        >
          <Plus aria-hidden />
          Add
        </Button>
      </div>
      {atLimit ? (
        <p className="text-xs text-muted-foreground">
          Up to {ITEM_FILTER_LIMITS.colorsMax} colours at once; remove one to add another.
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel body and footer
// ---------------------------------------------------------------------------

export type FilterFieldsProps = {
  filters: ItemFilters
  colorOptions: readonly ColorOption[]
  onChange: (change: FiltersChange) => void
}

/** Every filter the panel holds. Changes apply at once (the URL is the only state). */
export function FilterFields({ filters, colorOptions, onChange }: FilterFieldsProps) {
  return (
    <div className="flex flex-col gap-6">
      <Section title="Season">
        {(labelId) => (
          <MultiChoice
            labelId={labelId}
            values={SEASONS}
            labels={SEASON_LABELS}
            selected={filters.season}
            onChange={(season) => onChange({ season })}
          />
        )}
      </Section>
      <Section title="Warmth" hint="1 is summer-light, 5 heavy winter. Items without a warmth are left out.">
        {(labelId, hintId) => (
          <div role="group" aria-labelledby={labelId} aria-describedby={hintId} className="flex gap-3">
            <WarmthSelect label="From" value={filters.warmthMin} onChange={(warmthMin) => onChange({ warmthMin })} />
            <WarmthSelect label="To" value={filters.warmthMax} onChange={(warmthMax) => onChange({ warmthMax })} />
          </div>
        )}
      </Section>
      <Section title="Waterproof">
        {(labelId) => (
          <TriStateChoice
            labelId={labelId}
            value={filters.waterproof}
            onChange={(waterproof) => onChange({ waterproof })}
          />
        )}
      </Section>
      <Section title="Windproof">
        {(labelId) => (
          <TriStateChoice labelId={labelId} value={filters.windproof} onChange={(windproof) => onChange({ windproof })} />
        )}
      </Section>
      <Section title="Colour" hint="Colours of the items the other filters show. Several chosen means any of them.">
        {(labelId, hintId) => (
          <ColorChoice
            labelId={labelId}
            hintId={hintId}
            options={colorOptions}
            selected={filters.color}
            onChange={(color) => onChange({ color })}
          />
        )}
      </Section>
      <Section title="Formality">
        {(labelId) => (
          <MultiChoice
            labelId={labelId}
            values={FORMALITIES}
            labels={FORMALITY_LABELS}
            selected={filters.formality}
            onChange={(formality) => onChange({ formality })}
          />
        )}
      </Section>
      <Section title="Condition">
        {(labelId) => (
          <MultiChoice
            labelId={labelId}
            values={ITEM_CONDITIONS}
            labels={CONDITION_LABELS}
            selected={filters.condition}
            onChange={(condition) => onChange({ condition })}
          />
        )}
      </Section>
      <Section title="Location">
        {(labelId) => (
          <MultiChoice
            labelId={labelId}
            values={ITEM_LOCATIONS}
            labels={LOCATION_LABELS}
            selected={filters.location}
            onChange={(location) => onChange({ location })}
          />
        )}
      </Section>
      <Section title="Decision">
        {(labelId) => (
          <MultiChoice
            labelId={labelId}
            values={ITEM_DECISIONS}
            labels={DECISION_LABELS}
            selected={filters.decision}
            onChange={(decision) => onChange({ decision })}
          />
        )}
      </Section>
      <Section title="Status" hint="Archived items stay hidden unless Archived is chosen. None chosen shows the usual three.">
        {(labelId, hintId) => (
          <MultiChoice
            labelId={labelId}
            hintId={hintId}
            values={ITEM_STATUSES}
            labels={STATUS_LABELS}
            selected={filters.status}
            onChange={(status) => onChange({ status })}
          />
        )}
      </Section>
    </div>
  )
}

type FilterActionsProps = {
  filters: ItemFilters
  total: number
  isPending: boolean
  onReset: () => void
  /** The close button; the Drawer passes its own so focus returns to the Filters button. */
  closeButton: (label: string) => ReactNode
}

/** "Reset filters" and "Show N items". */
export function FilterActions({ filters, total, isPending, onReset, closeButton }: FilterActionsProps) {
  const active = activeFilterCount(filters)
  return (
    <div className="flex gap-2">
      <Button
        type="button"
        variant="outline"
        size="touch"
        onClick={onReset}
        disabled={active === 0}
        // Stays focusable when it greys out, so focus is not dropped after the reset.
        focusableWhenDisabled
      >
        Reset filters
      </Button>
      {closeButton(isPending ? "Updating…" : `Show ${plural(total, "item", "items")}`)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export type FilterPanelProps = {
  filters: ItemFilters
  /** Items matching the current filters (the server's count). */
  total: number
  isPending: boolean
  colorOptions: readonly ColorOption[]
  onChange: (change: FiltersChange) => void
}

/**
 * The Filters button and its panel: a bottom drawer below md, a side drawer
 * from the right at md and up. Focus returns to the Filters button on close.
 */
export function FilterPanel({ filters, total, isPending, colorOptions, onChange }: FilterPanelProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const isMobile = useIsMobile()
  const active = activeFilterCount(filters)

  // A panel is a transient interaction: when Next hides the page (Activity),
  // it closes, so coming back does not land in an open drawer.
  useLayoutEffect(() => {
    return () => setOpen(false)
  }, [])

  return (
    <Drawer open={open} onOpenChange={setOpen} swipeDirection={isMobile ? "down" : "right"}>
      <DrawerTrigger ref={triggerRef} render={<Button variant="outline" size="touch" />}>
        <SlidersHorizontal aria-hidden />
        {active > 0 ? (
          // One hidden name, as on the category chips: a separate ", 1 active"
          // span made Chrome's name "Filters , 1 active".
          <>
            <span aria-hidden>Filters</span>
            <span
              aria-hidden
              className="rounded-full bg-primary px-1.5 text-xs font-semibold tabular-nums text-primary-foreground"
            >
              {active}
            </span>
            <span className="sr-only">Filters, {active} active</span>
          </>
        ) : (
          "Filters"
        )}
      </DrawerTrigger>
      <DrawerContent finalFocus={triggerRef} aria-busy={isPending || undefined}>
        <DrawerHeader className="border-b pb-4 md:text-left">
          <DrawerTitle>Filters</DrawerTitle>
          <DrawerDescription>Changes apply right away.</DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
          <FilterFields filters={filters} colorOptions={colorOptions} onChange={onChange} />
        </div>
        <DrawerFooter className="border-t pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <FilterActions
            filters={filters}
            total={total}
            isPending={isPending}
            onReset={() => onChange(resetPanelFilters)}
            closeButton={(label) => (
              <DrawerClose render={<Button size="touch" className="flex-1" />}>{label}</DrawerClose>
            )}
          />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
