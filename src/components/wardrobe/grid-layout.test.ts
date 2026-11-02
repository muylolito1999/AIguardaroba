import { describe, expect, it } from "vitest"

import {
  computeGridLayout,
  estimateRowHeight,
  GRID_CAPTION_ESTIMATE,
  GRID_GAP,
  gridRowCount,
  gridRowOf,
  gridRowRange,
} from "./grid-layout"

describe("computeGridLayout", () => {
  it("gives 2 columns on a phone, 4 at about 800 px and 6 on a wide screen", () => {
    expect(computeGridLayout(360).columns).toBe(2)
    expect(computeGridLayout(800).columns).toBe(4)
    expect(computeGridLayout(1400).columns).toBe(6)
  })

  it("keeps 2 columns on very narrow or unmeasured containers", () => {
    expect(computeGridLayout(0)).toEqual({ columns: 2, tileWidth: 0 })
    expect(computeGridLayout(-10)).toEqual({ columns: 2, tileWidth: 0 })
    expect(computeGridLayout(280).columns).toBe(2)
  })

  it("never goes past 6 columns", () => {
    expect(computeGridLayout(4000).columns).toBe(6)
  })

  it("adds a column exactly when one more minimum tile and gap fit", () => {
    // n tiles need n * 150 + (n - 1) * 16 px.
    expect(computeGridLayout(3 * 150 + 2 * GRID_GAP - 1).columns).toBe(2)
    expect(computeGridLayout(3 * 150 + 2 * GRID_GAP).columns).toBe(3)
    expect(computeGridLayout(5 * 150 + 4 * GRID_GAP).columns).toBe(5)
  })

  it("fills the width without overflowing it", () => {
    for (const width of [320, 360, 390, 768, 800, 1024, 1400]) {
      const { columns, tileWidth } = computeGridLayout(width)
      const used = columns * tileWidth + (columns - 1) * GRID_GAP
      expect(used).toBeLessThanOrEqual(width)
      expect(width - used).toBeLessThan(columns)
    }
    expect(computeGridLayout(360)).toEqual({ columns: 2, tileWidth: 172 })
  })

  it("takes a custom minimum tile and gap", () => {
    expect(computeGridLayout(800, { minTile: 100, gap: 0 }).columns).toBe(6)
    expect(computeGridLayout(800, { minTile: 250, gap: 10 })).toEqual({ columns: 3, tileWidth: 260 })
  })
})

describe("row arithmetic", () => {
  it("counts rows, rounding a partial last row up", () => {
    expect(gridRowCount(0, 2)).toBe(0)
    expect(gridRowCount(1, 2)).toBe(1)
    expect(gridRowCount(4, 2)).toBe(2)
    expect(gridRowCount(5, 2)).toBe(3)
    expect(gridRowCount(300, 6)).toBe(50)
    expect(gridRowCount(301, 6)).toBe(51)
    expect(gridRowCount(5, 0)).toBe(0)
  })

  it("gives each row's item range, the last one short", () => {
    expect(gridRowRange(0, 4, 10)).toEqual({ start: 0, end: 4 })
    expect(gridRowRange(1, 4, 10)).toEqual({ start: 4, end: 8 })
    expect(gridRowRange(2, 4, 10)).toEqual({ start: 8, end: 10 })
    // Past the end: empty, never negative.
    expect(gridRowRange(5, 4, 10)).toEqual({ start: 10, end: 10 })
  })

  it("finds an item's row", () => {
    expect(gridRowOf(0, 3)).toBe(0)
    expect(gridRowOf(2, 3)).toBe(0)
    expect(gridRowOf(3, 3)).toBe(1)
    expect(gridRowOf(299, 6)).toBe(49)
  })

  it("estimates a row as the square photo plus the caption", () => {
    expect(estimateRowHeight(172)).toBe(172 + GRID_CAPTION_ESTIMATE)
  })
})
