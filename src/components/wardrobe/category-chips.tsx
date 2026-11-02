"use client"

import { useLayoutEffect, useRef } from "react"
import { Check } from "lucide-react"

import { CATEGORY_LABELS } from "@/components/items/tag-options"
import { PRESSED_CLASSES } from "@/components/items/tag-form-controls"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ITEM_CATEGORIES, type ItemCategory } from "@/lib/db/enums"
import { focusWasLost } from "@/lib/focus"
import { DEFAULT_STATUSES, isUntaggedView, statusesAfterChip, type ItemFilters } from "@/lib/items/filters"
import type { CategoryCounts } from "@/lib/items/wardrobe"
import { cn } from "@/lib/utils"

import type { FiltersChange } from "./use-wardrobe-filters"

// The category chip row. "All" clears the category filter; each category chip
// toggles that category in or out (several chosen means any of them). Items
// still waiting for tags have no category, so no category chip can show them:
// the "Untagged" chip stands for them and maps to status=pending_tagging with
// no category filter (isUntaggedView). It appears when the other filters leave
// any item waiting for tags, or while it is on. Each badge counts what
// pressing its chip would list (CategoryCounts), whatever view is on now.

export type ChipKey = "all" | "untagged" | ItemCategory

const CHIP_KEYS: readonly string[] = ["all", "untagged", ...ITEM_CATEGORIES]

function isChipKey(value: string): value is ChipKey {
  return CHIP_KEYS.includes(value)
}

/** The filters after pressing one chip. */
export function applyChip(current: ItemFilters, key: ChipKey): ItemFilters {
  // Leaving the Untagged view goes back to the usual statuses; the service
  // counts All and the categories with the same rule.
  const status = statusesAfterChip(current)
  if (key === "all") return { ...current, category: [], status }
  if (key === "untagged") {
    return isUntaggedView(current)
      ? { ...current, status: [...DEFAULT_STATUSES] }
      : { ...current, category: [], status: ["pending_tagging"] }
  }
  const category = current.category.includes(key)
    ? current.category.filter((value) => value !== key)
    : [...current.category, key]
  return { ...current, category, status }
}

/** Which chips show as pressed. */
export function pressedChips(filters: ItemFilters): ChipKey[] {
  if (isUntaggedView(filters)) return ["untagged"]
  return filters.category.length === 0 ? ["all"] : [...filters.category]
}

/** A chip's badge: how many items the list shows with that chip alone on. */
export function chipCount(counts: CategoryCounts, key: ChipKey): number {
  if (key === "all") return counts.total
  if (key === "untagged") return counts.untagged
  return counts.byCategory[key]
}

type CategoryChipsProps = {
  filters: ItemFilters
  counts: CategoryCounts
  onChange: (change: FiltersChange) => void
}

/**
 * The chip's label and count badge; screen readers hear "Shoes, 3 items". The
 * name is one visually hidden span and the visible parts are hidden from them:
 * Chrome puts a space before a separate hidden ", 3 items" span (it is
 * absolutely positioned), which made the name "Shoes , 3 items".
 */
function ChipLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      <span aria-hidden>{label}</span>
      <span
        aria-hidden
        className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-foreground group-aria-pressed/toggle:bg-primary-foreground/20 group-aria-pressed/toggle:text-primary-foreground"
      >
        {count}
      </span>
      <span className="sr-only">
        {label}, {count} {count === 1 ? "item" : "items"}
      </span>
    </>
  )
}

export function CategoryChips({ filters, counts, onChange }: CategoryChipsProps) {
  const pressed = pressedChips(filters)
  const showUntagged = counts.untagged > 0 || isUntaggedView(filters)
  const allChipRef = useRef<HTMLButtonElement>(null)
  // Set when the pressed Untagged chip is pressed to leave its view. With no
  // item waiting for tags (a search in that view often finds none), the chip
  // then leaves the page while it has focus, which would fall to <body>; it
  // goes to All instead, the chip that view returns to. Once only, and only
  // when focus was lost, so a later render or Next showing the page again
  // never moves it.
  const leavingUntagged = useRef(false)
  useLayoutEffect(() => {
    // Waits for the render that has left the view (the optimistic filters).
    if (!leavingUntagged.current || isUntaggedView(filters)) return
    leavingUntagged.current = false
    if (!showUntagged && focusWasLost(document.activeElement)) allChipRef.current?.focus()
  }, [filters, showUntagged])

  return (
    // Scrolls sideways inside its own box (never the page); the negative margin
    // lets the row run to the screen edges on phones. The padding keeps the
    // focus ring inside the box, which would otherwise clip it. relative makes
    // the box the containing block of the chips' visually hidden (absolutely
    // positioned) names; otherwise they escape the scroll box and widen the page.
    <div className="relative -mx-4 overflow-x-auto px-4 py-1 [scrollbar-width:thin] md:-mx-1 md:px-1">
      <ToggleGroup
        multiple
        variant="outline"
        size="touch"
        aria-label="Category"
        value={pressed}
        onValueChange={(next) => {
          // Exactly one chip changed; find which one, then apply its meaning
          // (the group's own idea of "pressed" does not know about All or Untagged).
          const added = next.filter(isChipKey).filter((key) => !pressed.includes(key))
          const removed = pressed.filter((key) => !next.includes(key))
          const [key] = [...added, ...removed]
          if (key === undefined) return
          if (key === "untagged" && isUntaggedView(filters)) leavingUntagged.current = true
          onChange((current) => applyChip(current, key))
        }}
        className="w-max flex-nowrap"
      >
        <ToggleGroupItem ref={allChipRef} value="all" className={cn("gap-2 rounded-full", PRESSED_CLASSES)}>
          {pressed.includes("all") ? <Check aria-hidden /> : null}
          <ChipLabel label="All" count={chipCount(counts, "all")} />
        </ToggleGroupItem>
        {ITEM_CATEGORIES.map((category) => {
          const count = chipCount(counts, category)
          const on = pressed.includes(category)
          return (
            <ToggleGroupItem
              key={category}
              value={category}
              className={cn("gap-2 rounded-full", PRESSED_CLASSES, count === 0 && !on && "text-muted-foreground")}
            >
              {on ? <Check aria-hidden /> : null}
              <ChipLabel label={CATEGORY_LABELS[category]} count={count} />
            </ToggleGroupItem>
          )
        })}
        {showUntagged ? (
          <ToggleGroupItem value="untagged" className={cn("gap-2 rounded-full", PRESSED_CLASSES)}>
            {pressed.includes("untagged") ? <Check aria-hidden /> : null}
            <ChipLabel label="Untagged" count={chipCount(counts, "untagged")} />
          </ToggleGroupItem>
        ) : null}
      </ToggleGroup>
    </div>
  )
}
