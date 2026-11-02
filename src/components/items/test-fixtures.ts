// Item cards and fake actions for the review component tests. Not a test file
// itself, so the fixtures can be shared; nothing in the app imports it.

import { vi } from "vitest"

import type { ItemCardDto } from "@/lib/items/contracts"

import type {
  ConfirmItemAction,
  ConfirmItemsAction,
  ReviewActions,
  StartTaggingBatchAction,
  TagItemByHandAction,
  UpdateItemTagsAction,
} from "./review-actions"

let counter = 0

function nextId(): string {
  counter += 1
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`
}

/** A tagged item with every required field, low confidence on materials only. */
export function taggedCard(overrides: Partial<ItemCardDto> = {}): ItemCardDto {
  return {
    id: nextId(),
    status: "tagged",
    createdAt: "2026-11-02T10:00:00.000Z",
    name: "Navy wool coat",
    category: "outerwear",
    subcategory: "coat",
    colors: ["navy", "black"],
    colorHex: ["#1f2a44", "#111111"],
    materialGuess: "boiled wool",
    materials: ["wool"],
    warmthLevel: 4,
    waterproof: false,
    windproof: true,
    insulated: true,
    breathable: null,
    seasons: ["winter", "autumn"],
    formality: "smart_casual",
    pattern: "solid",
    fit: null,
    condition: "good",
    brand: null,
    size: null,
    description: "Knee-length navy wool coat.",
    notes: "",
    purchasePrice: null,
    currency: "EUR",
    purchaseDate: null,
    location: "bologna",
    decision: "undecided",
    aiConfidence: {
      category: 0.95,
      colors: 0.9,
      materials: 0.45,
      warmth_level: 0.8,
      waterproof: 0.9,
      windproof: 0.7,
      insulated: 0.85,
      formality: 0.8,
      condition: 0.9,
      brand: 0.2,
    },
    multipleItemsDetected: false,
    userEditedFields: [],
    taggingError: null,
    taggingBatchId: null,
    aiModel: "claude-haiku-5-5",
    images: {
      thumb: { url: "https://blob.example/items/a/thumb.webp", width: 400, height: 300 },
      processed: { url: "https://blob.example/items/a/processed.webp", width: 1024, height: 768 },
      nobg: null,
    },
    ...overrides,
  }
}

/** An item still waiting for tags: no tag fields at all. */
export function pendingCard(overrides: Partial<ItemCardDto> = {}): ItemCardDto {
  return taggedCard({
    status: "pending_tagging",
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
    condition: null,
    description: null,
    aiConfidence: null,
    aiModel: null,
    ...overrides,
  })
}

/** Every review action as a mock, each answering nothing until a test sets it up. */
export function fakeReviewActions() {
  return {
    updateItemTags: vi.fn<UpdateItemTagsAction>(),
    confirmItem: vi.fn<ConfirmItemAction>(),
    confirmItems: vi.fn<ConfirmItemsAction>(),
    startTaggingBatch: vi.fn<StartTaggingBatchAction>(),
    tagItemByHand: vi.fn<TagItemByHandAction>(),
  } satisfies ReviewActions
}
