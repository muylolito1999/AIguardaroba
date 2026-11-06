// The style library's shared types (D-256): what the deterministic outfit
// rules, colour harmony, weather fit, scoring and selection exchange. Client-
// and server-safe: type imports and plain constants only. Nothing in
// src/lib/outfits/style may import @/lib/outfits/suggestion, which holds the
// prompt and stays off the client (D-156).

import type { Formality, ItemCategory, ItemCondition, OutfitSlot } from "@/lib/db/enums";
import type { OutfitCheckItem } from "@/lib/outfits/contracts";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";

// ---------------------------------------------------------------------------
// Items and outfits
// ---------------------------------------------------------------------------

/** What the style rules know about an item. Built from an items row plus its wear history. */
export type StyleItem = {
  id: string;
  category: ItemCategory;
  subcategory: string | null;
  name: string | null;
  /** Colour names, dominant first. */
  colors: readonly string[];
  /** Lowercase #rrggbb, parallel to colors; may be shorter or empty. */
  colorHex: readonly string[];
  pattern: string | null;
  fit: string | null;
  materials: readonly string[];
  formality: Formality | null;
  warmthLevel: number | null;
  waterproof: boolean | null;
  windproof: boolean | null;
  insulated: boolean | null;
  seasons: readonly string[];
  condition: ItemCondition | null;
  wearCount: number;
  /** Whole days since the item was last worn, in the forecast's time zone (0 = today); null = never worn. */
  daysSinceWorn: number | null;
};

export type StyleEntry = { slot: OutfitSlot; itemId: string };
export type StyleOutfit = readonly StyleEntry[];

// ---------------------------------------------------------------------------
// Layering vocabulary
// ---------------------------------------------------------------------------

/**
 * What kind of top an item is, read from its subcategory and name:
 * tee (t-shirts, tanks, polos, henleys, long sleeves), shirt (button shirts,
 * blouses), knit (sweaters, cardigans), sweat (hoodies, sweatshirts, fleeces,
 * quarter-zips), tailored (blazers, overshirts), unknown.
 */
export type TopKind = "tee" | "shirt" | "knit" | "sweat" | "tailored" | "unknown";

/** base: worn next to the skin or under a layer; mid: worn over a top; either: can be both, or unknown. */
export type LayerRole = "base" | "mid" | "either";

/** open: sandals and slides (never socks); sockless: loafers, espadrilles (socks optional); closed: everything else. */
export type FootwearKind = "open" | "sockless" | "closed";

export type SockStyle = "dress" | "athletic" | "warm" | "no_show" | "everyday";

/** What the wardrobe offers, so a layering rule only fires when it can be met. */
export type WardrobeCounts = {
  /** Tops whose kind (topKind) is tee or shirt, the kinds whose layer role is base; tops of unplaced kind do not count. */
  baseTops: number;
  socks: number;
  shoes: number;
};

// ---------------------------------------------------------------------------
// Style directions
// ---------------------------------------------------------------------------

/** The aesthetic directions a candidate outfit can follow. Labels in directions.ts, briefs in the prompt. */
export const DIRECTION_KEYS = [
  "tonal_neutrals",
  "dark_monochrome",
  "light_and_airy",
  "neutral_with_accent",
  "smart_collar",
  "knit_layers",
  "elevated_denim",
  "earth_tones",
  "preppy_layers",
  "sporty_clean",
  "texture_play",
  "sharp_tailoring",
  "pattern_anchor",
  "weather_ready",
  "cosy_winter",
  "dress_led",
  "classic_balanced",
] as const;
export type DirectionKey = (typeof DIRECTION_KEYS)[number];

export function isDirectionKey(value: unknown): value is DirectionKey {
  return typeof value === "string" && (DIRECTION_KEYS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// History and taste
// ---------------------------------------------------------------------------

/** An outfit seen before: its item ids and how many days ago (0 = today). */
export type HistoryEntry = { itemIds: readonly string[]; ageDays: number };

/** A saved outfit that says something about the owner's taste. */
export type TasteEntry = {
  itemIds: readonly string[];
  rating: number | null;
  timesWorn: number;
  source: "user" | "ai";
};

/** The inputs that make a paid suggestion differ from earlier ones (D-257). */
export type VarietyHistory = {
  /** Outfits of complete suggestions from the last 7 days, today's earlier runs included. */
  suggested: readonly (HistoryEntry & { direction: string | null })[];
  /** Outfits worn in the last 14 days: wear logs grouped by day and outfit (loose item logs of a day form one group). */
  worn: readonly HistoryEntry[];
  /** Saved outfits the owner liked: rated 4 or 5 first, then worn more than once; at most 8. */
  liked: readonly TasteEntry[];
  /** Saved outfits rated 1 or 2; at most 4. */
  disliked: readonly TasteEntry[];
  /** Directions of today's and yesterday's suggestions. */
  recentDirections: readonly { key: string; ageDays: number }[];
  /** Complete suggestions already stored today for this home city. */
  runIndex: number;
};

export const EMPTY_HISTORY: VarietyHistory = {
  suggested: [],
  worn: [],
  liked: [],
  disliked: [],
  recentDirections: [],
  runIndex: 0,
};

// ---------------------------------------------------------------------------
// Candidates, scores and the selection
// ---------------------------------------------------------------------------

/** One outfit Claude proposed, with aliases already mapped to item ids. */
export type Candidate = {
  /** Position in Claude's reply, from 0. */
  index: number;
  direction: DirectionKey | null;
  title: string;
  why: string;
  rain_ok: boolean;
  entries: StyleEntry[];
};

export type DropReason = "malformed" | "unknown_alias" | "invalid_outfit" | "layering" | "duplicate";

export type RepairKind =
  | "moved_to_mid"
  | "swapped_top_mid"
  | "base_top_added"
  | "socks_added"
  | "socks_removed"
  | "shoes_added";

export type ScoreContext = {
  /** Every item Claude could use today (the snapshot), by id: repairs pick companions from here. */
  items: ReadonlyMap<string, StyleItem>;
  weather: WeatherSnapshot;
  history: VarietyHistory;
};

export type SelectionContext = ScoreContext & {
  /** What validateOutfit needs, by id. */
  checkItems: ReadonlyMap<string, OutfitCheckItem>;
  /** Outfits to keep (OUTFIT_SUGGESTION_COUNT). */
  count: number;
};

/** Each part in [0, 1], higher is better; total is the weighted sum (SELECTION_WEIGHTS). */
export type ScoreBreakdown = {
  color: number;
  pattern: number;
  formality: number;
  weather: number;
  novelty: number;
  taste: number;
  total: number;
};

export type SelectedOutfit = {
  candidateIndex: number;
  direction: DirectionKey | null;
  title: string;
  why: string;
  rain_ok: boolean;
  /** In slot order. */
  entries: StyleEntry[];
  repairs: RepairKind[];
  score: ScoreBreakdown;
};

export type SelectionReport = {
  /** Candidates in the reply. */
  received: number;
  /** Candidates left after drops (before the final pick). */
  usable: number;
  /** Usable candidates that needed at least one repair. */
  repaired: number;
  dropped: Partial<Record<DropReason, number>>;
};

export type SelectionResult =
  | { ok: true; outfits: SelectedOutfit[]; report: SelectionReport }
  | { ok: false; report: SelectionReport; detail: string };
