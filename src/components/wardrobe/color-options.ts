import type { ColorFacet } from "@/lib/items/wardrobe"

/** A colour the filter panel offers, with a swatch when an item carries its hex value. */
export type ColorOption = ColorFacet

/**
 * The server's colour facet (the colours of the items every filter except
 * colour matches), plus every chosen colour it lacks, so a choice can always
 * be undone even when it matches nothing.
 */
export function colorOptionsWithChosen(facet: readonly ColorFacet[], selected: readonly string[]): ColorOption[] {
  const shown = new Set(facet.map((option) => option.name))
  const chosen = selected.filter((name) => !shown.has(name)).map((name) => ({ name, hex: null, count: 0 }))
  return [...facet, ...chosen]
}
