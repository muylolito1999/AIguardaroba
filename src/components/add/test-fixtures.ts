// Shared fixtures for the add-flow tests. Not imported by app code.

import type { ItemCardDto } from "@/lib/items/contracts"

import type { TaggingSetup } from "./cost-quote"

/** A pending item card as /api/items/register returns it, with a thumbnail. */
export function cardFor(id: string, overrides: Partial<ItemCardDto> = {}): ItemCardDto {
  return {
    id,
    status: "pending_tagging",
    createdAt: "2026-11-02T10:00:00.000Z",
    name: null,
    category: null,
    subcategory: null,
    colors: [],
    colorHex: [],
    materialGuess: null,
    materials: [],
    warmthLevel: null,
    waterproof: null,
    windproof: null,
    insulated: null,
    breathable: null,
    seasons: [],
    formality: null,
    pattern: null,
    fit: null,
    condition: null,
    brand: null,
    size: null,
    description: null,
    notes: "",
    purchasePrice: null,
    currency: "EUR",
    purchaseDate: null,
    location: "bologna",
    decision: "undecided",
    collection: "clothing",
    aiConfidence: null,
    multipleItemsDetected: false,
    userEditedFields: [],
    taggingError: null,
    taggingBatchId: null,
    aiModel: null,
    images: {
      thumb: { url: `https://store.public.blob.vercel-storage.com/items/${id}/thumb.webp`, width: 300, height: 400 },
      processed: {
        url: `https://store.public.blob.vercel-storage.com/items/${id}/processed.webp`,
        width: 768,
        height: 1024,
      },
      nobg: null,
    },
    ...overrides,
  }
}

/** A lowercase 64-character hex string derived from `seed`, shaped like a sha256 digest. */
export function fakeHash(seed: string): string {
  return Array.from(seed, (char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64)
}

/** A tagging setup as getTaggingSetup returns it, with round per-item rates; `budget` overrides the month's numbers. */
export function taggingSetupFor(budget: Partial<TaggingSetup["budget"]> = {}): TaggingSetup {
  return {
    model: { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    costQuote: {
      standard: { firstItemUsd: 0.02, nextItemUsd: 0.01 },
      batch: { firstItemUsd: 0.01, nextItemUsd: 0.005 },
      dryRunUsd: 0.025,
    },
    budget: { budgetUsd: 20, remainingUsd: 12.5, resetsAt: "2026-12-01T00:00:00.000Z", ...budget },
  }
}
