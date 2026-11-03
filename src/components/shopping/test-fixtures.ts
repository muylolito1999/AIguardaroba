import type { ShoppingItemDto } from "@/lib/relocation/contracts"

// Shopping rows for the component tests.

let sequence = 0

/** A "To buy" row with every optional field empty unless overridden. */
export function shoppingItem(overrides: Partial<ShoppingItemDto> = {}): ShoppingItemDto {
  sequence += 1
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    analysisId: null,
    itemType: `Item ${sequence}`,
    category: null,
    priority: 2,
    reason: "",
    specs: [],
    quantity: 1,
    estPriceMinEur: null,
    estPriceMaxEur: null,
    buyTiming: null,
    status: "todo",
    linkedItem: null,
    gapKey: null,
    createdAt: "2026-11-03T09:00:00.000Z",
    ...overrides,
  }
}
