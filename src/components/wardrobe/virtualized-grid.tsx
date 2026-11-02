"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from "react"
import { defaultRangeExtractor, useWindowVirtualizer, type Range } from "@tanstack/react-virtual"

import { focusWasLost } from "@/lib/focus"
import type { WardrobeItemDto } from "@/lib/items/wardrobe"

import { GridSkeletonTiles } from "./grid-skeleton"
import {
  computeGridLayout,
  estimateRowHeight,
  GRID_GAP,
  gridRowCount,
  gridRowOf,
  gridRowRange,
} from "./grid-layout"
import { ItemCard } from "./item-card"

/** Rows rendered above and below the visible ones. */
const OVERSCAN_ROWS = 3
/** Rows whose photos load eagerly: what a first screen shows. */
const EAGER_ROWS = 2

type Measured = {
  /** Content width of the grid container, px. */
  width: number
  /** The container's distance from the top of the document, px (the virtualizer's scrollMargin). */
  scrollMargin: number
}

/** The card at the top of the screen, where its row was, and the results it was seen in. */
type ScrollAnchor = {
  id: string
  /** Its row's top minus window.scrollY, px. */
  offset: number
  columns: number
  resultsKey: string
}

export type VirtualizedGridProps = {
  items: readonly WardrobeItemDto[]
  /** True while newer results are loading; the grid is marked busy. */
  busy?: boolean
  /**
   * Names the results the items are (the filters they were read with). New
   * items under the same key are the same results read again, which keep the
   * cards on screen in place; a new key is a new search, and nothing is kept.
   */
  resultsKey?: string
}

/** The item an element belongs to, from the data-item-id its list item carries. */
function itemIdOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>("[data-item-id]")?.dataset.itemId ?? null
}

/**
 * The wardrobe grid, virtualised by rows against the window scroll, so 2000
 * tiles cost what one screen of them costs. Columns follow the container's
 * width (computeGridLayout); rows are measured once rendered, since badges can
 * wrap.
 *
 * Activity (Cache Components keeps this page alive but hidden after leaving
 * it): every listener here and in the virtualizer lives in a layout effect, so
 * hiding the page removes them all and nothing listens while it is hidden.
 * Showing it again re-runs them: the width and offset are measured afresh
 * (rows re-measured when the columns changed meanwhile), the window is put
 * back at the last scroll position the grid saw, and the virtualizer
 * re-subscribes to the window, so Back from an item returns to the same place
 * in the grid (the hidden page kept its rows, so the document is tall enough
 * for it). A zero width (the hidden, display:none state) is never stored, so a
 * late resize notice cannot collapse the grid.
 */
export function VirtualizedGrid({ items, busy = false, resultsKey = "" }: VirtualizedGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<Measured | null>(null)
  // The card holding focus, by item id. Its row is always rendered, even when
  // scrolled far away, and focus goes back to it when new columns or new rows
  // remount it, so virtualisation never drops focus to <body>.
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const layout = computeGridLayout(measured?.width ?? 0)
  const { columns, tileWidth } = layout
  const rowCount = measured === null ? 0 : gridRowCount(items.length, columns)

  const indexById = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items])
  const focusedIndex = focusedId === null ? undefined : indexById.get(focusedId)
  // Derived from the current columns, so the card's row after a column change is the one kept.
  const focusedRow = focusedIndex === undefined ? null : gridRowOf(focusedIndex, columns)

  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range)
      if (focusedRow === null || focusedRow >= range.count || indexes.includes(focusedRow)) return indexes
      return [...indexes, focusedRow].sort((a, b) => a - b)
    },
    [focusedRow]
  )

  // A row is keyed by the ids of the tiles it holds, so a measured height
  // stays with the same tiles: a refreshed list with the same rows (D-107)
  // keeps every height, while a row whose tiles changed (new columns, an item
  // gone) is a new node, which its ref callback measures. Memoised: a new
  // getItemKey would make the virtualizer recompute every row on each render.
  const rowKeys = useMemo(
    () =>
      Array.from({ length: rowCount }, (_, row) => {
        const { start, end } = gridRowRange(row, columns, items.length)
        return items
          .slice(start, end)
          .map((item) => item.id)
          .join(" ")
      }),
    [items, columns, rowCount]
  )
  const getItemKey = useCallback((index: number) => rowKeys[index] ?? index, [rowKeys])

  // A layout effect, so the real columns replace the placeholder before the
  // first paint, and so its listeners stop as soon as the page is hidden.
  useLayoutEffect(() => {
    const element = containerRef.current
    if (element === null) return
    const measure = () => {
      const width = element.clientWidth
      if (width === 0) return
      const scrollMargin = Math.round(element.getBoundingClientRect().top + window.scrollY)
      setMeasured((previous) =>
        previous !== null && previous.width === width && previous.scrollMargin === scrollMargin
          ? previous
          : { width, scrollMargin }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    // Content above the grid (the toolbar wrapping, a notice appearing) moves
    // it down without resizing it; the body grows with it.
    observer.observe(document.body)
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])

  // Back from an item: Next shows this page again before the popstate event,
  // so the window is still where the item page left it (usually the top) when
  // the virtualizer re-subscribes and reads the offset; only the browser's own
  // restoration, after popstate and not the same in every browser, would put
  // it back. The last position seen while the grid was visible is restored
  // here first instead (this effect runs before the virtualizer's), so Back
  // lands where the owner left. A fresh navigation to the list (a link or the
  // tab) still starts at the top: Next scrolls the page into view after its
  // children's layout effects have run.
  const lastScrollY = useRef<number | null>(null)
  useLayoutEffect(() => {
    const saved = lastScrollY.current
    if (saved !== null && Math.abs(window.scrollY - saved) >= 1) window.scrollTo(0, saved)
    const record = () => {
      // Leaving can hide the grid (display: none) a moment before this
      // listener is removed; the scroll that hiding causes is not the owner's.
      if (containerRef.current === null || containerRef.current.getClientRects().length === 0) return
      lastScrollY.current = window.scrollY
    }
    record()
    window.addEventListener("scroll", record, { passive: true })
    return () => window.removeEventListener("scroll", record)
  }, [])

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    getItemKey,
    estimateSize: () => estimateRowHeight(tileWidth),
    overscan: OVERSCAN_ROWS,
    gap: GRID_GAP,
    scrollMargin: measured?.scrollMargin ?? 0,
    rangeExtractor,
    // React 19 warns about flushSync during rendering; batched updates are enough here.
    useFlushSync: false,
  })

  // Only a new tile width changes the height of a row with the same tiles
  // (the photo is square). measure() then drops the cached heights, so rows
  // off screen fall back to the new estimate; the rows on screen really
  // resize, and the virtualizer's ResizeObserver measures them again. New
  // results or columns need nothing here (see the row keys). Layout effects
  // also re-run whenever Next shows the page; the width is the same then, so
  // the measured heights, and with them the restored position, are kept.
  const measuredTileWidth = useRef<number | null>(null)
  useLayoutEffect(() => {
    const last = measuredTileWidth.current
    measuredTileWidth.current = tileWidth
    if (last === null || last === tileWidth) return
    virtualizer.measure()
  }, [virtualizer, tileWidth])

  // New columns (a resize, zoom or rotation) or new rows remount the focused
  // card in another row, and focus falls to <body>; it goes back to the same
  // card, unless the owner has already moved it somewhere else.
  const layoutForFocus = useRef({ columns, items })
  useLayoutEffect(() => {
    const last = layoutForFocus.current
    layoutForFocus.current = { columns, items }
    if (focusedId === null || (last.columns === columns && last.items === items)) return
    if (!focusWasLost(document.activeElement)) return
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-item-id="${focusedId}"] a`)
      ?.focus({ preventScroll: true })
  }, [columns, items, focusedId])

  // Next hiding the page (Activity) means the owner left it: a card that had
  // focus is not taken back when the page is shown again with other columns.
  useLayoutEffect(() => () => setFocusedId(null), [])

  // The same results read again while the grid is shown (a D-107 refresh, a
  // late save, D-123) can hold an item more or less above the screen. Every
  // row after it then holds other tiles and gets a new key, and rows above the
  // rendered ones fall back to the estimate, so the cards on screen would jump
  // by the sum of the estimates' errors, well over a row deep in the list. The
  // first card whose row starts on screen is remembered with its distance
  // from the top of the window; when the items change it is put back there
  // (D-131). Rows above it that are measured later are compensated by the
  // virtualizer itself, which keeps it there. Not for new results (another
  // search or sort), not at the top of the list, where a new item should show,
  // and not when the card is gone or the columns changed.
  const anchorRef = useRef<ScrollAnchor | null>(null)
  // The rows of the last commit. A render with new rows hands the virtualizer
  // their keys before they are committed; a scroll in between (a render can
  // yield) must not take an anchor from rows the page does not show yet.
  const committed = useRef({ items, columns, resultsKey, getItemKey })
  const rememberAnchor = useCallback(() => {
    const grid = containerRef.current
    // Only a displayed grid: hiding it (display: none) moves the window, not the owner.
    if (grid === null || grid.getClientRects().length === 0) return
    const shown = committed.current
    if (virtualizer.options.getItemKey !== shown.getItemKey) return
    const scrollY = window.scrollY
    const nearest = virtualizer.getVirtualItemForOffset(scrollY)
    const row =
      nearest === undefined || nearest.start >= scrollY ? nearest : virtualizer.measurementsCache[nearest.index + 1]
    const item = row === undefined ? undefined : shown.items[row.index * shown.columns]
    anchorRef.current =
      row === undefined || item === undefined
        ? null
        : { id: item.id, offset: row.start - scrollY, columns: shown.columns, resultsKey: shown.resultsKey }
  }, [virtualizer])

  // Runs after every commit, since measured rows move without a scroll event.
  // It comes after the scroll restore above, so a return first puts the window
  // back and the cards are then kept in place from there.
  useLayoutEffect(() => {
    const previous = committed.current
    committed.current = { items, columns, resultsKey, getItemKey }
    const anchor = anchorRef.current
    if (
      previous.items !== items &&
      anchor !== null &&
      anchor.columns === columns &&
      anchor.resultsKey === resultsKey &&
      window.scrollY > virtualizer.options.scrollMargin
    ) {
      const index = indexById.get(anchor.id)
      // Rows this commit mounted were measured as they attached; reading an
      // offset brings the measurements up to date before the cache is read.
      virtualizer.getVirtualItemForOffset(0)
      const start = index === undefined ? undefined : virtualizer.measurementsCache[gridRowOf(index, columns)]?.start
      if (start !== undefined) {
        const target = Math.max(0, start - anchor.offset)
        if (Math.abs(target - window.scrollY) >= 1) window.scrollTo(0, target)
      }
    }
    rememberAnchor()
  })

  useLayoutEffect(() => {
    window.addEventListener("scroll", rememberAnchor, { passive: true })
    return () => window.removeEventListener("scroll", rememberAnchor)
  }, [rememberAnchor])

  function handleFocus(event: FocusEvent<HTMLDivElement>) {
    const id = itemIdOf(event.target)
    if (id !== null) setFocusedId(id)
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    // Moving to another card is handled by its focus event.
    if (event.currentTarget.contains(event.relatedTarget)) return
    const card = event.target
    // A card that a re-render removes can report a blur on its way out; the
    // restore above still needs to know it had focus. Only a card still on
    // the page has lost focus to something outside the grid.
    queueMicrotask(() => {
      if (card.isConnected) setFocusedId(null)
    })
  }

  const rows = virtualizer.getVirtualItems()
  const scrollMargin = virtualizer.options.scrollMargin

  return (
    <div
      ref={containerRef}
      aria-busy={busy || undefined}
      data-columns={measured === null ? undefined : columns}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={busy ? "opacity-60 transition-opacity" : "transition-opacity"}
    >
      {measured === null ? (
        // Server render and the first client render: the width is not known
        // yet, so placeholder tiles hold the space until the layout effect runs.
        <GridSkeletonTiles count={Math.min(items.length, 12)} />
      ) : (
        // The rows in between are role="none", so the list owns the items directly.
        <div role="list" aria-label="Items" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((row) => {
            const { start, end } = gridRowRange(row.index, columns, items.length)
            return (
              <div
                key={row.key}
                role="none"
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 grid w-full"
                style={{
                  transform: `translateY(${row.start - scrollMargin}px)`,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  columnGap: GRID_GAP,
                }}
              >
                {items.slice(start, end).map((item, offset) => (
                  <div
                    key={item.id}
                    role="listitem"
                    data-item-id={item.id}
                    aria-setsize={items.length}
                    aria-posinset={start + offset + 1}
                    className="min-w-0"
                  >
                    <ItemCard item={item} loading={row.index < EAGER_ROWS ? "eager" : "lazy"} />
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
