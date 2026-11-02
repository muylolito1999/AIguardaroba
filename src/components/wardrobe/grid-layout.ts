// Column and row arithmetic for the virtualised wardrobe grid. Pure, so the
// breakpoints are unit-tested without a browser.

export const GRID_MIN_COLUMNS = 2
export const GRID_MAX_COLUMNS = 6
/** Narrowest tile, before the gap; two columns are kept even below it. */
export const GRID_MIN_TILE = 150
/** Space between tiles and between rows, in px (Tailwind gap-4). */
export const GRID_GAP = 16
/**
 * Height of a tile's caption (name, category line and one row of badges), in
 * px, added to the square photo for the row estimate. Rows are measured once
 * rendered, so a caption whose badges wrap only corrects the estimate.
 */
export const GRID_CAPTION_ESTIMATE = 76

export type GridLayout = {
  columns: number
  /** Width of one tile in px, rounded down so the row never overflows. */
  tileWidth: number
}

export type GridLayoutOptions = {
  minTile?: number
  gap?: number
}

/**
 * The most columns of at least `minTile` px that fit, with `gap` between
 * them, clamped to 2..6: two on a 360 px phone, four at about 800 px, six from
 * about 1000 px. A zero width (not laid out yet) still gives two columns.
 */
export function computeGridLayout(containerWidth: number, options: GridLayoutOptions = {}): GridLayout {
  const minTile = options.minTile ?? GRID_MIN_TILE
  const gap = options.gap ?? GRID_GAP
  const width = Math.max(0, containerWidth)
  const fitting = Math.floor((width + gap) / (minTile + gap))
  const columns = Math.min(GRID_MAX_COLUMNS, Math.max(GRID_MIN_COLUMNS, fitting))
  const tileWidth = Math.max(0, Math.floor((width - gap * (columns - 1)) / columns))
  return { columns, tileWidth }
}

/** Rows needed for `itemCount` tiles. */
export function gridRowCount(itemCount: number, columns: number): number {
  if (itemCount <= 0 || columns <= 0) return 0
  return Math.ceil(itemCount / columns)
}

/** The item indexes of one row, as a half-open range [start, end). */
export function gridRowRange(rowIndex: number, columns: number, itemCount: number): { start: number; end: number } {
  const start = Math.min(itemCount, rowIndex * columns)
  return { start, end: Math.min(itemCount, start + columns) }
}

/** The row an item sits in. */
export function gridRowOf(itemIndex: number, columns: number): number {
  return Math.floor(itemIndex / columns)
}

/** Estimated row height before measuring: the square photo plus its caption. */
export function estimateRowHeight(tileWidth: number): number {
  return tileWidth + GRID_CAPTION_ESTIMATE
}
