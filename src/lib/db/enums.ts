// Value lists shared by the Drizzle pgEnums, zod schemas and client forms.
// Plain constants with no Drizzle import, so client components can use them
// without pulling the database layer into a bundle. Changing a list here
// changes the database enum: generate a migration afterwards.

export const ITEM_STATUSES = ["pending_tagging", "tagged", "confirmed", "archived"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ITEM_LOCATIONS = ["bologna", "hamburg", "in_transit", "unknown"] as const;
export type ItemLocation = (typeof ITEM_LOCATIONS)[number];

export const ITEM_DECISIONS = ["bring", "leave", "donate", "sell", "undecided"] as const;
export type ItemDecision = (typeof ITEM_DECISIONS)[number];

// Which collection an item belongs to. Only "clothing" feeds outfits, the
// stats breakdowns and relocation (D-248, D-249). Every exclusion tests for
// "clothing" (the positive form), so a value added later is left out by default.
export const ITEM_COLLECTIONS = ["clothing", "running"] as const;
export type ItemCollection = (typeof ITEM_COLLECTIONS)[number];

export const ITEM_CATEGORIES = [
  "outerwear",
  "top",
  "bottom",
  "dress",
  "shoes",
  "socks",
  "gloves",
  "hat_beanie",
  "scarf",
  "base_layer",
  "accessory",
  "bag",
  "other",
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const FORMALITIES = ["athletic", "casual", "smart_casual", "business", "formal"] as const;
export type Formality = (typeof FORMALITIES)[number];

export const ITEM_CONDITIONS = ["new", "good", "worn", "needs_repair"] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

// Seasons are stored as text[] (the spec's type) and constrained by a CHECK
// built from this list, not by a pgEnum.
export const SEASONS = ["winter", "spring", "summer", "autumn"] as const;
export type Season = (typeof SEASONS)[number];

export const IMAGE_KINDS = ["original", "processed", "nobg", "thumb"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export const ANALYSIS_KINDS = ["relocation", "outfit_suggestion", "shopping"] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

export const ANALYSIS_STATUSES = ["pending", "running", "complete", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

// A relocation run is split into category chunks plus one synthesis call (D-025).
export const ANALYSIS_PART_KINDS = ["chunk", "synthesis"] as const;
export type AnalysisPartKind = (typeof ANALYSIS_PART_KINDS)[number];

export const PART_STATUSES = ["pending", "running", "complete", "failed"] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

export const SHOPPING_STATUSES = ["todo", "bought", "skipped"] as const;
export type ShoppingStatus = (typeof SHOPPING_STATUSES)[number];

export const PACKING_GROUPS = ["suitcase", "carry_on", "ship_later", "wear_on_travel_day"] as const;
export type PackingGroup = (typeof PACKING_GROUPS)[number];

export const OUTFIT_SOURCES = ["user", "ai"] as const;
export type OutfitSource = (typeof OUTFIT_SOURCES)[number];

// The spec's slots plus base_layer (D-038), mid_layer and socks (D-253).
export const OUTFIT_SLOTS = [
  "outerwear",
  "mid_layer",
  "base_layer",
  "top",
  "bottom",
  "socks",
  "shoes",
  "hat",
  "gloves",
  "scarf",
  "accessory",
] as const;
export type OutfitSlot = (typeof OUTFIT_SLOTS)[number];

// What an ai_calls row (or an ai_batches row) was spent on; the usage page
// groups by this. Relocation chunks, repairs and synthesis are separate so
// their costs can be compared with the estimate.
export const AI_PURPOSES = [
  "tagging",
  "relocation_chunk",
  "relocation_repair",
  "relocation_synthesis",
  "outfit_suggestion",
  "shopping",
  "smoke_test",
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

// One row per attempt (D-020). `error` covers transport, HTTP and deadline
// failures; error_code on the row says which.
export const AI_CALL_STATUSES = ["success", "invalid_output", "max_tokens", "refusal", "error"] as const;
export type AiCallStatus = (typeof AI_CALL_STATUSES)[number];

// in_progress, canceling and ended mirror the Message Batches processing
// status; processed means the results were applied to the items.
export const BATCH_STATUSES = ["in_progress", "canceling", "ended", "processed"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
