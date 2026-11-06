// Display labels for the item enums and the warmth rubric. Plain constants with
// no server imports, so client forms and server-rendered pages share one
// wording. Keys come from src/lib/db/enums.ts; a new enum value fails the
// Record types below until it gets a label.

import type {
  Formality,
  ItemCategory,
  ItemCollection,
  ItemCondition,
  ItemDecision,
  ItemLocation,
  ItemStatus,
  Season,
} from "@/lib/db/enums"
import type { WarmthLevel } from "@/lib/items/contracts"

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  outerwear: "Outerwear",
  top: "Top",
  bottom: "Bottom",
  dress: "Dress",
  shoes: "Shoes",
  socks: "Socks",
  gloves: "Gloves",
  hat_beanie: "Hat or beanie",
  scarf: "Scarf",
  base_layer: "Base layer",
  accessory: "Accessory",
  bag: "Bag",
  other: "Other",
}

export const FORMALITY_LABELS: Record<Formality, string> = {
  athletic: "Athletic",
  casual: "Casual",
  smart_casual: "Smart casual",
  business: "Business",
  formal: "Formal",
}

export const CONDITION_LABELS: Record<ItemCondition, string> = {
  new: "New",
  good: "Good",
  worn: "Worn",
  needs_repair: "Needs repair",
}

export const SEASON_LABELS: Record<Season, string> = {
  winter: "Winter",
  spring: "Spring",
  summer: "Summer",
  autumn: "Autumn",
}

export const LOCATION_LABELS: Record<ItemLocation, string> = {
  bologna: "Bologna",
  hamburg: "Hamburg",
  in_transit: "In transit",
  unknown: "Unknown",
}

export const DECISION_LABELS: Record<ItemDecision, string> = {
  bring: "Bring",
  leave: "Leave",
  donate: "Donate",
  sell: "Sell",
  undecided: "Undecided",
}

/** The wardrobe's views and the item badges (D-248). */
export const COLLECTION_LABELS: Record<ItemCollection, string> = {
  clothing: "Clothes",
  running: "Running gear",
}

export const STATUS_LABELS: Record<ItemStatus, string> = {
  pending_tagging: "Waiting for tags",
  tagged: "Tagged",
  confirmed: "Confirmed",
  archived: "Archived",
}

/** The spec's warmth scale (Phase 3 tagging prompt), so the slider uses the words Claude was given. */
export const WARMTH_RUBRIC: Record<WarmthLevel, { label: string; examples: string | null }> = {
  1: { label: "Summer, very light", examples: "linen, T-shirt" },
  2: { label: "Light layer", examples: null },
  3: { label: "Mid layer", examples: "sweater, light jacket" },
  4: { label: "Warm", examples: "wool coat, fleece-lined, insulated boots" },
  5: { label: "Heavy winter", examples: "down parka, shearling, insulated waterproof boots" },
}

/** "3 · Mid layer (sweater, light jacket)": the slider's visible caption and its aria-valuetext. */
export function warmthDescription(level: WarmthLevel): string {
  const { label, examples } = WARMTH_RUBRIC[level]
  return examples === null ? `${level} · ${label}` : `${level} · ${label} (${examples})`
}
