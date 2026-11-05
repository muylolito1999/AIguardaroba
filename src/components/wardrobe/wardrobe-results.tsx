"use client"

import { useLayoutEffect, useMemo, useRef } from "react"
import { Info, Loader2 } from "lucide-react"

import { useRefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { focusWasLost } from "@/lib/focus"
import { DEFAULT_ITEM_FILTERS, hasActiveFilters, itemFiltersKey, type ItemFilters } from "@/lib/items/filters"
import type { WardrobeListDto } from "@/lib/items/wardrobe"

import { CategoryChips } from "./category-chips"
import { CollectionSwitch } from "./collection-switch"
import { colorOptionsWithChosen } from "./color-options"
import { useWardrobeFilters } from "./use-wardrobe-filters"
import { VirtualizedGrid } from "./virtualized-grid"
import { WardrobeEmpty } from "./wardrobe-empty"
import { WardrobeToolbar } from "./wardrobe-toolbar"

const numberFormat = new Intl.NumberFormat("en")

function itemCount(count: number): string {
  return `${numberFormat.format(count)} ${count === 1 ? "item" : "items"}`
}

export type WardrobeResultsProps = {
  /** Parsed from the URL on the server. */
  filters: ItemFilters
  list: WardrobeListDto
}

/**
 * Everything below the page header: the Clothes | Running switch, toolbar,
 * category chips, the result count, and the grid or an empty state.
 * Server-rendered props carry the filters and results; changes go to the URL
 * (useWardrobeFilters) and come back as new props. Kept mounted across those
 * changes (no key), so the typed search, focus and the pressed view survive
 * while the next list loads.
 */
export function WardrobeResults({ filters: serverFilters, list }: WardrobeResultsProps) {
  const { filters, isPending, update, refresh } = useWardrobeFilters(serverFilters)
  // A back/forward return brings the list as it was; when an item was changed
  // since (on its detail page, for example), or a save answers while the list
  // is shown, the list is read again (D-107).
  useRefreshAfterItemChanges(list, refresh)
  const colorOptions = useMemo(() => colorOptionsWithChosen(list.colors, filters.color), [list.colors, filters.color])
  // Judged on the filters the list was loaded with, not the ones being requested.
  // The collection is a view, not a filter, and the counts cover that view
  // only, so this is per view: no running gear yet, or no clothes yet (D-251).
  const wardrobeEmpty = !hasActiveFilters(serverFilters) && list.counts.total === 0
  const collection = serverFilters.collection

  // "Reset filters" sits in the no-matches state, which leaves the page when
  // the reset's list arrives, and focus would fall to <body>. It moves to the
  // result count instead, just above the new results. Compared by list object,
  // so a later return or refresh (Activity re-runs layout effects) never
  // moves focus, and only when focus was lost, never from where the owner went.
  const countRef = useRef<HTMLParagraphElement>(null)
  const resetFromList = useRef<WardrobeListDto | null>(null)
  useLayoutEffect(() => {
    const from = resetFromList.current
    if (from === null || from === list) return
    resetFromList.current = null
    if (focusWasLost(document.activeElement)) countRef.current?.focus()
  }, [list])

  function resetAll() {
    resetFromList.current = list
    // The view stays: Reset clears what narrows it, not which collection it shows.
    update((current) => ({ ...DEFAULT_ITEM_FILTERS, collection: current.collection, sort: current.sort }))
  }

  function emptyState() {
    if (!wardrobeEmpty) return <WardrobeEmpty kind="no-matches" onReset={resetAll} />
    // Every item archived is not an empty wardrobe: say where the items are.
    if (list.counts.archived > 0) {
      return <WardrobeEmpty kind="all-archived" collection={collection} archived={list.counts.archived} />
    }
    return <WardrobeEmpty kind="no-items" collection={collection} />
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Always shown, empty states included, so the other view is one press away. */}
      <CollectionSwitch value={filters.collection} onChange={update} />
      <WardrobeToolbar
        filters={filters}
        total={list.total}
        isPending={isPending}
        colorOptions={colorOptions}
        onChange={update}
      />
      {wardrobeEmpty ? null : <CategoryChips filters={filters} counts={list.counts} onChange={update} />}
      <div className="flex min-h-5 items-center gap-2 text-sm text-muted-foreground">
        {/* Announced politely whenever a new list arrives. */}
        <p
          ref={countRef}
          role="status"
          aria-live="polite"
          tabIndex={-1}
          className="rounded-sm tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {itemCount(list.total)}
        </p>
        {isPending ? (
          <span aria-hidden className="inline-flex items-center gap-1">
            <Loader2 className="size-3.5 animate-spin" />
            Updating…
          </span>
        ) : null}
      </div>
      {list.capped ? (
        // A standing note, not an error: no role="alert" interruption.
        <Alert role="note">
          <Info aria-hidden />
          <AlertDescription>
            Showing the first {numberFormat.format(list.items.length)} of {itemCount(list.total)}. Narrow the search
            or filters to see the rest.
          </AlertDescription>
        </Alert>
      ) : null}
      {list.items.length > 0 ? (
        <VirtualizedGrid items={list.items} busy={isPending} resultsKey={itemFiltersKey(serverFilters)} />
      ) : (
        emptyState()
      )}
    </div>
  )
}
