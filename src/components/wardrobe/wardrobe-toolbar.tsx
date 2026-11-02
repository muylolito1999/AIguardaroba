"use client"

import { useCallback, useId } from "react"
import Link from "next/link"
import { ChartColumn } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ITEM_SORTS, type ItemFilters, type ItemSort } from "@/lib/items/filters"

import type { ColorOption } from "./color-options"
import { FilterPanel } from "./filter-panel"
import { SearchField } from "./search-field"
import type { FiltersChange } from "./use-wardrobe-filters"

export const SORT_LABELS: Record<ItemSort, string> = {
  created_desc: "Newest first",
  created_asc: "Oldest first",
  warmth_desc: "Warmest first",
  warmth_asc: "Lightest first",
  wear_desc: "Most worn first",
}

function isSort(value: string): value is ItemSort {
  return (ITEM_SORTS as readonly string[]).includes(value)
}

export type WardrobeToolbarProps = {
  filters: ItemFilters
  /** Items matching the current filters, for the panel's "Show N items". */
  total: number
  isPending: boolean
  colorOptions: readonly ColorOption[]
  /** Must be stable across renders (the search debounce depends on it). */
  onChange: (change: FiltersChange) => void
}

/** Search, Filters, Sort and the Stats link. Wraps to two rows on a phone. */
export function WardrobeToolbar({ filters, total, isPending, colorOptions, onChange }: WardrobeToolbarProps) {
  const sortId = useId()
  const onSearch = useCallback((q: string) => onChange({ q }), [onChange])

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      <SearchField value={filters.q} onSearch={onSearch} />
      <div className="flex min-w-0 items-center gap-2">
        <FilterPanel
          filters={filters}
          total={total}
          isPending={isPending}
          colorOptions={colorOptions}
          onChange={onChange}
        />
        <label htmlFor={sortId} className="sr-only">
          Sort
        </label>
        <NativeSelect
          id={sortId}
          value={filters.sort}
          onChange={(event) => {
            const sort = event.target.value
            if (isSort(sort)) onChange({ sort })
          }}
          className="min-w-0 flex-1 md:w-44 md:flex-none [&_select]:h-11"
        >
          {ITEM_SORTS.map((sort) => (
            <NativeSelectOption key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Link href="/stats" className={buttonVariants({ variant: "outline", size: "touch" })}>
          <ChartColumn aria-hidden />
          Stats
        </Link>
      </div>
    </div>
  )
}
