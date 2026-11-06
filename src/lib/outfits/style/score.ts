// Scoring for outfit suggestions (D-256): how good one outfit is today, as
// parts in [0, 1] that the selection weighs (colour harmony, pattern
// restraint, formality coherence, weather fit, novelty against recent history,
// taste), and the companions a layering repair adds (a tee under a hoodie,
// socks for closed shoes, shoes for an outfit without any). Pure and
// client-safe: no I/O, no clock, no randomness; every tie falls to the item id,
// so the same inputs always give the same outfit.

import { FORMALITIES, type ItemCategory, type OutfitSlot } from "@/lib/db/enums";
import { SLOT_CATEGORIES, sortBySlot } from "@/lib/outfits/contracts";
import { itemColors, paletteHarmony, patternScore, type ColorInfo } from "@/lib/outfits/style/color";
import {
  firstItemInSlot as itemInSlot,
  footwearKind,
  isSneaker,
  layerRole,
  sockStyle,
  topKind,
  type LayerFix,
  type LayerVerdict,
} from "@/lib/outfits/style/layering";
import type {
  FootwearKind,
  RepairKind,
  ScoreBreakdown,
  ScoreContext,
  SockStyle,
  StyleEntry,
  StyleItem,
  StyleOutfit,
  TopKind,
} from "@/lib/outfits/style/types";
import { idealWarmth, isRainyDay, UNKNOWN_WARMTH, WEATHER_THRESHOLDS, weatherFit } from "@/lib/outfits/style/weather";

// ---------------------------------------------------------------------------
// Weights and penalties
// ---------------------------------------------------------------------------

/**
 * How much each part counts in the total; the weights sum to 1. Weather and
 * colour lead: an outfit that leaves the owner cold or wet, or whose colours
 * fight, fails whatever else it does well. Novelty comes close behind, since
 * a daily suggestion that repeats yesterday's is no suggestion. Formality
 * coherence matters but is mostly settled by the direction Claude followed;
 * pattern restraint only bites when two statement patterns meet; taste is a
 * light nudge from a handful of ratings.
 */
export const SELECTION_WEIGHTS = {
  color: 0.25,
  pattern: 0.08,
  formality: 0.15,
  weather: 0.25,
  novelty: 0.22,
  taste: 0.05,
} as const;

/**
 * Taken per unit of the largest Jaccard similarity of core pieces with an
 * outfit already picked. The same core pieces twice (1.0) never get this far,
 * since selection drops the repeat as a duplicate; sharing four of five
 * pieces each (4/6) costs about 0.23, more than most quality gaps, and
 * sharing only the jeans (1/9) about 0.04, a tie-breaker.
 */
export const DIVERSITY_PENALTY = 0.35;

/** Two picks following the same direction read as one idea shown twice: a nudge, smaller than a real quality gap. */
export const SAME_DIRECTION_PENALTY = 0.1;

/**
 * The slots that make an outfit's look: what the owner would call "the same
 * outfit again". Socks, base layers and the extras change without changing it.
 */
export const CORE_SLOTS: readonly OutfitSlot[] = ["outerwear", "mid_layer", "top", "bottom", "shoes"];

const CORE_SLOT_SET: ReadonlySet<OutfitSlot> = new Set(CORE_SLOTS);

/** The categories those slots take: what a past outfit, known only by item ids, counts as core. */
const CORE_CATEGORIES: ReadonlySet<ItemCategory> = new Set(CORE_SLOTS.flatMap((slot) => SLOT_CATEGORIES[slot]));

/**
 * The pieces whose colours and patterns people see. The base layer sits under
 * the top, socks barely show, gloves are on and off, accessories are small.
 */
const VISIBLE_SLOTS: ReadonlySet<OutfitSlot> = new Set<OutfitSlot>([
  "outerwear",
  "mid_layer",
  "top",
  "bottom",
  "shoes",
  "scarf",
  "hat",
]);

/** Socks and accessories have a formality tag but do not set the outfit's register. */
const FORMALITY_IGNORED_SLOTS: ReadonlySet<OutfitSlot> = new Set<OutfitSlot>(["socks", "accessory"]);

/**
 * The formality score by spread, in FORMALITIES steps between the most and
 * the least formal piece: neighbours (jeans with an oxford shirt) are one
 * outfit, two steps (a business blazer over jeans) is a deliberate high-low
 * that half works, three or more (gym shorts with dress shoes) is a clash.
 */
const FORMALITY_BY_SPREAD: readonly number[] = [1, 1, 0.5];

/**
 * Novelty. An echo is a past outfit (suggested in the last 7 days or worn in
 * the last 14) that shares core pieces with this one; it costs
 * recency weight x ECHO x the share of this outfit's core pieces it holds,
 * x IDENTICAL when the core sets are the same. RECENCY_WEIGHTS[n] is the
 * weight n days ago, RECENCY_TAIL from day 6. The largest echo counts in
 * full and the others at OTHER_ECHOES, so many old, partial echoes add up
 * gently instead of sinking every outfit with the owner's favourite jeans.
 */
const NOVELTY = {
  echo: 0.6,
  identical: 1.5,
  otherEchoes: 0.25,
  /** Per core piece worn today or yesterday: the same jeans two days running is noticed. */
  fatigueRecent: 0.15,
  fatigueRecentDays: 1,
  /** Per core piece worn two or three days ago. */
  fatigueNear: 0.05,
  fatigueNearDays: 3,
  /** Times the mean rest of the core pieces: rested clothes get their turn. */
  restBonus: 0.1,
  /** Rest saturates here: a month unworn is as rested as never worn. */
  restDays: 30,
} as const;

const RECENCY_WEIGHTS: readonly number[] = [1, 0.7, 0.5, 0.4, 0.3, 0.2];
const RECENCY_TAIL = 0.15;

/**
 * Taste starts neutral and moves up to LIKED towards a liked outfit and down
 * to DISLIKED away from a disliked one, by the core-piece Jaccard similarity.
 * A liked outfit that was worn often but not rated 4 or 5 says less.
 */
const TASTE = { neutral: 0.5, liked: 0.4, disliked: 0.4, likedHighRating: 4, unratedLikeWeight: 0.6 } as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Six decimals, as weatherFit rounds: logs read 0.53, and equal outfits tie exactly. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Into [0, 1]; NaN, which Math.min and Math.max pass through, counts as 0. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A score part as it is stored: clamped (clamp01) and rounded (round6). */
function part(value: number): number {
  return round6(clamp01(value));
}

/** Code-unit order, the same on every machine and locale. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Distinct items of the outfit in `slots` that the map knows, in entry order. */
function itemsIn(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>, slots: ReadonlySet<OutfitSlot>): StyleItem[] {
  const found = new Map<string, StyleItem>();
  for (const entry of entries) {
    if (!slots.has(entry.slot)) continue;
    const item = items.get(entry.itemId);
    if (item !== undefined && !found.has(item.id)) found.set(item.id, item);
  }
  return [...found.values()];
}

/** FORMALITIES positions of the pieces that set the register (not socks or accessories), unknown ones left out. */
function formalityLevels(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>): number[] {
  const levels: number[] = [];
  for (const entry of entries) {
    if (FORMALITY_IGNORED_SLOTS.has(entry.slot)) continue;
    const formality = items.get(entry.itemId)?.formality ?? null;
    if (formality !== null) levels.push(FORMALITIES.indexOf(formality));
  }
  return levels;
}

/** Days since the item was last worn; null when never worn, and for a value that is not a finite number (bad data reads as never worn). */
function daysSinceWorn(item: StyleItem): number | null {
  return item.daysSinceWorn !== null && Number.isFinite(item.daysSinceWorn) ? item.daysSinceWorn : null;
}

/** 0 (worn today) to 1 (rested a month or more, or never worn). */
function restOf(item: StyleItem): number {
  const days = daysSinceWorn(item);
  if (days === null) return 1;
  return Math.min(Math.max(days, 0), NOVELTY.restDays) / NOVELTY.restDays;
}

function feelsMeanC(ctx: ScoreContext): number {
  return (ctx.weather.apparentMinC + ctx.weather.apparentMaxC) / 2;
}

// ---------------------------------------------------------------------------
// Core pieces and similarity
// ---------------------------------------------------------------------------

/** The item ids in the core slots (CORE_SLOTS), distinct and sorted. */
export function coreItems(entries: StyleOutfit): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (CORE_SLOT_SET.has(entry.slot)) ids.add(entry.itemId);
  }
  return [...ids].sort(compareIds);
}

/**
 * The core pieces of a past outfit known only by its item ids: ids whose item
 * is of a core category, plus ids the map does not know. An unknown item may
 * be core (a jacket now in the other city), so counting it keeps a past
 * outfit from looking identical when that cannot be confirmed.
 */
function coreOfIds(itemIds: readonly string[], items: ReadonlyMap<string, StyleItem>): string[] {
  const ids = new Set<string>();
  for (const id of itemIds) {
    const item = items.get(id);
    if (item === undefined || CORE_CATEGORIES.has(item.category)) ids.add(id);
  }
  return [...ids].sort(compareIds);
}

/** |a ∩ b| / |a ∪ b| over distinct ids; 0 when both are empty (nothing in common to speak of). */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const id of left) {
    if (right.has(id)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
}

// ---------------------------------------------------------------------------
// The parts
// ---------------------------------------------------------------------------

/**
 * Formality coherence: 1 when every known formality is within one step of
 * the others, 0.5 at a two-step spread, 0 at three or more. Socks and
 * accessories are left out, and so are pieces of unknown formality; fewer
 * than two known pieces score 1.
 */
export function formalityScore(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>): number {
  const levels = formalityLevels(entries, items);
  if (levels.length < 2) return 1;
  const spread = Math.max(...levels) - Math.min(...levels);
  return FORMALITY_BY_SPREAD[spread] ?? 0;
}

function recencyWeight(ageDays: number): number {
  const day = Math.max(0, Math.floor(ageDays));
  return RECENCY_WEIGHTS[day] ?? RECENCY_TAIL;
}

/** The largest echo in full plus NOVELTY.otherEchoes of the rest. */
function combineEchoes(penalties: readonly number[]): number {
  if (penalties.length === 0) return 0;
  const largest = Math.max(...penalties);
  const sum = penalties.reduce((total, penalty) => total + penalty, 0);
  return largest + NOVELTY.otherEchoes * (sum - largest);
}

/**
 * How fresh the outfit is against recent history, 1 = fresh. From 1: minus
 * the echoes of suggested and worn outfits (see NOVELTY), minus fatigue for
 * core pieces worn in the last days, plus a small bonus for rested core
 * pieces; clamped to [0, 1]. Core pieces the map does not know count for the
 * echoes but not for fatigue or rest.
 */
export function noveltyScore(entries: StyleOutfit, ctx: ScoreContext): number {
  const core = coreItems(entries);
  const penalties: number[] = [];
  for (const past of [...ctx.history.suggested, ...ctx.history.worn]) {
    const pastIds = new Set(past.itemIds);
    const shared = core.filter((id) => pastIds.has(id)).length;
    if (shared === 0) continue;
    const identical = jaccard(core, coreOfIds(past.itemIds, ctx.items)) === 1;
    penalties.push(
      recencyWeight(past.ageDays) * NOVELTY.echo * (shared / core.length) * (identical ? NOVELTY.identical : 1),
    );
  }

  let fatigue = 0;
  let rest = 0;
  let known = 0;
  for (const id of core) {
    const item = ctx.items.get(id);
    if (item === undefined) continue;
    known += 1;
    rest += restOf(item);
    const days = daysSinceWorn(item);
    if (days === null) continue;
    if (days <= NOVELTY.fatigueRecentDays) fatigue += NOVELTY.fatigueRecent;
    else if (days <= NOVELTY.fatigueNearDays) fatigue += NOVELTY.fatigueNear;
  }
  const restBonus = known === 0 ? 0 : NOVELTY.restBonus * (rest / known);

  return round6(clamp01(1 - combineEchoes(penalties) - fatigue + restBonus));
}

/**
 * How close the outfit is to the owner's taste, 0.5 = neutral: up to +0.4 by
 * the core-piece similarity to the closest liked outfit (an outfit rated 4 or
 * 5 counts in full, one only worn often at 0.6), down to -0.4 by the
 * similarity to the closest disliked one; clamped to [0, 1].
 */
export function tasteScore(entries: StyleOutfit, ctx: ScoreContext): number {
  const core = coreItems(entries);
  let liked = 0;
  for (const outfit of ctx.history.liked) {
    const weight = outfit.rating !== null && outfit.rating >= TASTE.likedHighRating ? 1 : TASTE.unratedLikeWeight;
    liked = Math.max(liked, weight * jaccard(core, coreOfIds(outfit.itemIds, ctx.items)));
  }
  let disliked = 0;
  for (const outfit of ctx.history.disliked) {
    disliked = Math.max(disliked, jaccard(core, coreOfIds(outfit.itemIds, ctx.items)));
  }
  return round6(clamp01(TASTE.neutral + TASTE.liked * liked - TASTE.disliked * disliked));
}

/**
 * Every part of the outfit's score and their weighted total
 * (SELECTION_WEIGHTS). Colour and pattern read the visible pieces only
 * (outerwear, mid layer, top, bottom, shoes, scarf, hat); formality reads
 * every piece but socks and accessories; weather is weatherFit's score. Each
 * part is clamped to [0, 1] with NaN read as 0, so bad data can lower a score
 * but never poison the ranking.
 */
export function scoreOutfit(entries: StyleOutfit, ctx: ScoreContext): ScoreBreakdown {
  const visible = itemsIn(entries, ctx.items, VISIBLE_SLOTS);
  const parts = {
    color: part(paletteHarmony(visible.map((item) => itemColors(item))).score),
    pattern: part(patternScore(visible.map((item) => item.pattern))),
    formality: part(formalityScore(entries, ctx.items)),
    weather: part(weatherFit(entries, ctx.items, ctx.weather).score),
    novelty: part(noveltyScore(entries, ctx)),
    taste: part(tasteScore(entries, ctx)),
  };
  const w = SELECTION_WEIGHTS;
  const total =
    w.color * parts.color +
    w.pattern * parts.pattern +
    w.formality * parts.formality +
    w.weather * parts.weather +
    w.novelty * parts.novelty +
    w.taste * parts.taste;
  return { ...parts, total: round6(total) };
}

// ---------------------------------------------------------------------------
// Companions
// ---------------------------------------------------------------------------

export type CompanionKind = "base_top" | "socks" | "shoes";

/**
 * How a companion is ranked, after its tier (below). Points add up: the
 * formality distance to the outfit's median costs most, then colour harmony
 * with the companion added, then the warmth fit, with rest as the smallest
 * term. Kind-specific points (neutral base tops, the sock rules) sit on top.
 */
const COMPANION_POINTS = {
  /** Per FORMALITIES step from the outfit's median. */
  formalityStep: 0.3,
  /** An unknown formality counts as this many steps: neither a match nor a clash. */
  unknownFormalitySteps: 0.5,
  /** Times paletteHarmony of the visible pieces with the companion added. */
  harmony: 0.5,
  /**
   * Per warmth level from idealWarmth of the mean feels-like temperature, for
   * base tops and shoes. Socks are thin whatever the day, so the garment
   * scale does not fit them: their warmth fit is the sock rules'
   * (SOCKS_WHEN_COLD, SOCKS_WHEN_HOT).
   */
  warmthStep: 0.1,
  /** A base top whose main colour is neutral: a tee under a hoodie should not compete with it. */
  neutralBaseTop: 0.3,
  /** Times rest (0 worn today, 1 rested a month or never worn). */
  rest: 0.05,
  /**
   * Taken off a companion another shown outfit already got (`avoid`): an
   * equally fitting piece wins instead, so the cards do not all repeat one tee
   * or one pair of socks, but a clearly better fit still repeats. Smaller than
   * neutralBaseTop and a formality step, so variety never buys a clash.
   */
  avoided: 0.25,
} as const;

/** Below this mean feels-like temperature (°C) warm socks earn their place. */
const WARM_SOCKS_BELOW_C = 8;
/** From this mean feels-like temperature (°C) light socks do. */
const LIGHT_SOCKS_FROM_C = 20;

/** What the outfit's shoes ask of socks: sport (sneakers, athletic), smart (smart casual and up), plain, or none. */
type ShoeClass = "sport" | "smart" | "plain" | "none";

/**
 * Sock points by the shoes: dress socks with smart shoes, athletic socks
 * (and liners) with sneakers; athletic socks in smart shoes and dress socks
 * in sneakers look wrong, and chunky warm socks crowd smart shoes. The
 * matches outweigh the formality distance of a sock tagged athletic or
 * business against a casual outfit, which the shoes already speak for.
 */
const SOCKS_FOR_SHOES: Readonly<Record<ShoeClass, Partial<Record<SockStyle, number>>>> = {
  smart: { dress: 0.6, warm: -0.3, athletic: -0.6 },
  sport: { athletic: 0.5, no_show: 0.2, dress: -0.6 },
  plain: {},
  none: {},
};
/**
 * Sock points on a cold day (below WARM_SOCKS_BELOW_C): warm socks, not ankle
 * liners. Warm socks outrank athletic ones even in sneakers, whatever the
 * athletic pair's formality tag; in smart shoes dress socks still win.
 */
const SOCKS_WHEN_COLD: Partial<Record<SockStyle, number>> = { warm: 0.8, no_show: -0.3 };
/** Sock points on a hot day (from LIGHT_SOCKS_FROM_C): light socks, not wool. */
const SOCKS_WHEN_HOT: Partial<Record<SockStyle, number>> = { no_show: 0.3, everyday: 0.3, warm: -0.5 };

/** Sport: sneakers and sport shoes by their words (isSneaker) or tagged athletic. */
function shoeClass(shoes: StyleItem | null): ShoeClass {
  if (shoes === null) return "none";
  if (isSneaker(shoes) || shoes.formality === "athletic") return "sport";
  if (shoes.formality !== null && FORMALITIES.indexOf(shoes.formality) >= FORMALITIES.indexOf("smart_casual")) {
    return "smart";
  }
  return "plain";
}

/** What ranking a companion needs to know about the outfit, worked out once. */
type CompanionView = {
  /** Visible pieces' colours, the companion's own slot left out. */
  palette: ColorInfo[][];
  /** Median FORMALITIES position of the outfit's pieces (socks and accessories left out); null when none is known. */
  medianFormality: number | null;
  feelsMeanC: number;
  idealWarmth: number;
  rainy: boolean;
  /** Cold enough that open shoes leave feet cold (WEATHER_THRESHOLDS.openShoesBelowC). */
  cold: boolean;
  shoes: ShoeClass;
  hasSocks: boolean;
};

const COMPANION_SLOT: Readonly<Record<CompanionKind, OutfitSlot>> = { base_top: "top", socks: "socks", shoes: "shoes" };

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function companionView(kind: CompanionKind, entries: StyleOutfit, ctx: ScoreContext): CompanionView {
  const slot = COMPANION_SLOT[kind];
  const others = entries.filter((entry) => entry.slot !== slot);
  const feels = feelsMeanC(ctx);
  return {
    palette: itemsIn(others, ctx.items, VISIBLE_SLOTS).map((item) => itemColors(item)),
    medianFormality: median(formalityLevels(others, ctx.items)),
    feelsMeanC: feels,
    idealWarmth: idealWarmth(feels),
    rainy: isRainyDay(ctx.weather),
    cold: feels < WEATHER_THRESHOLDS.openShoesBelowC,
    shoes: shoeClass(itemInSlot(entries, ctx.items, "shoes")),
    hasSocks: entries.some((entry) => entry.slot === "socks"),
  };
}

/**
 * A base top is a tee or a shirt (layerRole base), the tops WardrobeCounts.baseTops
 * counts: an unplaced top (a turtleneck, a vest, a puffer filed as a top) is never
 * put under a layer, even when every tee and shirt needs repair.
 */
function isCompanionKind(kind: CompanionKind, item: StyleItem): boolean {
  if (kind === "base_top") return item.category === "top" && layerRole(item) === "base";
  return item.category === kind;
}

/** Shoe tiers on a rainy day; closed and waterproof shoes come before these, at tier 0. */
const RAIN_SHOE_TIER: Readonly<Record<FootwearKind, number>> = { closed: 1, sockless: 2, open: 3 };
/** Shoe tiers on a cold dry day. */
const COLD_SHOE_TIER: Readonly<Record<FootwearKind, number>> = { closed: 0, sockless: 1, open: 2 };

/** The kinds in `prefer` in that order, then the other base tops (isCompanionKind admits only tees and shirts). */
function baseTopTier(item: StyleItem, prefer: readonly TopKind[]): number {
  const index = prefer.indexOf(topKind(item));
  return index >= 0 ? index : prefer.length;
}

/**
 * Rainy: closed and waterproof, closed, sockless, open. Cold and dry: closed,
 * sockless, open. Otherwise one tier. Open shoes drop one more tier when the
 * outfit has socks, which open shoes would take off.
 */
function shoeTier(item: StyleItem, view: CompanionView): number {
  const footwear = footwearKind(item) ?? "closed";
  const socksPenalty = view.hasSocks && footwear === "open" ? 1 : 0;
  if (view.rainy) {
    return footwear === "closed" && item.waterproof === true ? 0 : RAIN_SHOE_TIER[footwear] + socksPenalty;
  }
  if (view.cold) return COLD_SHOE_TIER[footwear] + socksPenalty;
  return socksPenalty;
}

/** The hard order before any points (baseTopTier, shoeTier); socks have one tier. */
function companionTier(kind: CompanionKind, item: StyleItem, view: CompanionView, prefer: readonly TopKind[]): number {
  if (kind === "base_top") return baseTopTier(item, prefer);
  if (kind === "shoes") return shoeTier(item, view);
  return 0;
}

function sockPoints(item: StyleItem, view: CompanionView): number {
  const style = sockStyle(item);
  if (style === null) return 0;
  let points = SOCKS_FOR_SHOES[view.shoes][style] ?? 0;
  if (view.feelsMeanC < WARM_SOCKS_BELOW_C) points += SOCKS_WHEN_COLD[style] ?? 0;
  else if (view.feelsMeanC >= LIGHT_SOCKS_FROM_C) points += SOCKS_WHEN_HOT[style] ?? 0;
  return points;
}

function companionPoints(kind: CompanionKind, item: StyleItem, view: CompanionView): number {
  const P = COMPANION_POINTS;
  let formalitySteps = 0;
  if (view.medianFormality !== null) {
    formalitySteps =
      item.formality === null
        ? P.unknownFormalitySteps
        : Math.abs(FORMALITIES.indexOf(item.formality) - view.medianFormality);
  }
  const colors = itemColors(item);
  const harmony = paletteHarmony([...view.palette, colors]).score;

  let points = -P.formalityStep * formalitySteps + P.harmony * harmony + P.rest * restOf(item);
  if (kind === "socks") return points + sockPoints(item, view);
  points -= P.warmthStep * Math.abs((item.warmthLevel ?? UNKNOWN_WARMTH) - view.idealWarmth);
  if (kind === "base_top" && colors[0]?.neutral === true) points += P.neutralBaseTop;
  return points;
}

/**
 * The best item to add to the outfit as a base top, socks or shoes, or null
 * when the wardrobe has none. Candidates are the items of that kind in
 * ctx.items that the outfit does not hold (a base top is a top whose layer
 * role is not mid), leaving out pieces that need repair unless nothing else
 * is left. Ranked by tier (companionTier: preferred top kinds; closed and
 * waterproof shoes when cold or rainy), then points (COMPANION_POINTS:
 * formality distance to the outfit's median, colour harmony with the item
 * added, warmth against idealWarmth for base tops and shoes, neutral colours
 * for a base top, sock style for the day and the shoes, rest), then item id.
 * `prefer` orders the base top kinds (BASE_TOP_PREFERENCE); other kinds
 * ignore it. An item in `avoid` (a companion another shown outfit already
 * got) loses COMPANION_POINTS.avoided points: another piece that fits about
 * as well is chosen instead, while a clearly better fit is still repeated.
 */
export function bestCompanion(
  kind: CompanionKind,
  entries: StyleOutfit,
  ctx: ScoreContext,
  prefer: readonly TopKind[] = [],
  avoid?: ReadonlySet<string>,
): string | null {
  const inOutfit = new Set(entries.map((entry) => entry.itemId));
  const pool = [...ctx.items.values()].filter((item) => !inOutfit.has(item.id) && isCompanionKind(kind, item));
  const sound = pool.filter((item) => item.condition !== "needs_repair");
  const candidates = sound.length > 0 ? sound : pool;
  if (candidates.length === 0) return null;

  const view = companionView(kind, entries, ctx);
  const ranked = candidates.map((item) => ({
    id: item.id,
    tier: companionTier(kind, item, view, prefer),
    points: round6(companionPoints(kind, item, view) - (avoid?.has(item.id) === true ? COMPANION_POINTS.avoided : 0)),
  }));
  ranked.sort((a, b) => a.tier - b.tier || b.points - a.points || compareIds(a.id, b.id));
  return ranked[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------

type AddBaseTop = Extract<LayerFix, { kind: "add_base_top" }>;

function isAddBaseTop(fix: LayerFix): fix is AddBaseTop {
  return fix.kind === "add_base_top";
}

/** The outfit being repaired, what has been done to it so far, and the companions to avoid (bestCompanion). */
type Repair = { entries: StyleEntry[]; repairs: RepairKind[]; ctx: ScoreContext; avoid: ReadonlySet<string> | undefined };

function hasSlot(entries: readonly StyleEntry[], slot: OutfitSlot): boolean {
  return entries.some((entry) => entry.slot === slot);
}

/** The entries with the one at `from` moved to `to`. */
function moveEntry(entries: readonly StyleEntry[], from: OutfitSlot, to: OutfitSlot): StyleEntry[] {
  return entries.map((entry) => (entry.slot === from ? { slot: to, itemId: entry.itemId } : entry));
}

function addEntry(state: Repair, slot: OutfitSlot, itemId: string, repair: RepairKind): void {
  state.entries = [...state.entries, { slot, itemId }];
  state.repairs.push(repair);
}

/** The top moves to mid_layer, unless an add_base_top follows that no base top can meet. */
function moveTopToMid(state: Repair, later: readonly LayerFix[]): void {
  if (!hasSlot(state.entries, "top") || hasSlot(state.entries, "mid_layer")) return;
  const moved = moveEntry(state.entries, "top", "mid_layer");
  const addBase = later.find(isAddBaseTop);
  if (addBase !== undefined && bestCompanion("base_top", moved, state.ctx, addBase.prefer) === null) return;
  state.entries = moved;
  state.repairs.push("moved_to_mid");
}

function swapTopAndMid(state: Repair): void {
  if (!hasSlot(state.entries, "top") || !hasSlot(state.entries, "mid_layer")) return;
  state.entries = state.entries.map((entry) => {
    if (entry.slot === "top") return { slot: "mid_layer", itemId: entry.itemId };
    if (entry.slot === "mid_layer") return { slot: "top", itemId: entry.itemId };
    return entry;
  });
  state.repairs.push("swapped_top_mid");
}

function addBaseTop(state: Repair, prefer: readonly TopKind[]): void {
  if (hasSlot(state.entries, "top")) return;
  const base = bestCompanion("base_top", state.entries, state.ctx, prefer, state.avoid);
  if (base !== null) addEntry(state, "top", base, "base_top_added");
}

/** Socks, only while the outfit has none and its shoes are known to be closed. */
function addSocks(state: Repair): void {
  if (hasSlot(state.entries, "socks")) return;
  const shoes = itemInSlot(state.entries, state.ctx.items, "shoes");
  if (shoes === null || footwearKind(shoes) !== "closed") return;
  const socks = bestCompanion("socks", state.entries, state.ctx, [], state.avoid);
  if (socks !== null) addEntry(state, "socks", socks, "socks_added");
}

function removeSocks(state: Repair): void {
  if (!hasSlot(state.entries, "socks")) return;
  state.entries = state.entries.filter((entry) => entry.slot !== "socks");
  state.repairs.push("socks_removed");
}

/** Shoes, then the socks they call for: added for closed shoes (unless an add_socks follows), removed for open ones. */
function addShoes(state: Repair, later: readonly LayerFix[]): void {
  if (hasSlot(state.entries, "shoes")) return;
  const shoesId = bestCompanion("shoes", state.entries, state.ctx, [], state.avoid);
  if (shoesId === null) return;
  addEntry(state, "shoes", shoesId, "shoes_added");
  const shoes = state.ctx.items.get(shoesId);
  const footwear = shoes === undefined ? null : footwearKind(shoes);
  if (footwear === "closed" && !later.some((fix) => fix.kind === "add_socks")) addSocks(state);
  else if (footwear === "open") removeSocks(state);
}

function applyFix(state: Repair, fix: LayerFix, later: readonly LayerFix[]): void {
  switch (fix.kind) {
    case "move_top_to_mid":
      return moveTopToMid(state, later);
    case "swap_top_and_mid":
      return swapTopAndMid(state);
    case "add_base_top":
      return addBaseTop(state, fix.prefer);
    case "add_socks":
      return addSocks(state);
    case "remove_socks":
      return removeSocks(state);
    case "add_shoes":
      return addShoes(state, later);
  }
}

/**
 * Applies a layering verdict's fixes in order, picking each companion with
 * bestCompanion (passing `avoid` on, so another of the same tier is taken
 * over a companion an earlier outfit already got); a fix whose companion is
 * missing is skipped and not reported. Returns the entries in slot order and
 * the repairs made.
 *
 * - move_top_to_mid: the top moves to mid_layer. Skipped when an
 *   add_base_top follows and no base top exists, so the top slot is never
 *   left empty.
 * - swap_top_and_mid: the two trade slots.
 * - add_base_top: a base top of the preferred kinds goes in `top`.
 * - add_socks: socks are added, only while the shoes are known to be closed
 *   (the verdict pairs add_shoes with add_socks taking the new shoes for
 *   closed ones; sandals chosen on a hot day take no socks).
 * - remove_socks: the socks go.
 * - add_shoes: shoes are added; then, when they are closed, the outfit has
 *   no socks and no add_socks follows, socks are added too; when they are
 *   open and the outfit has socks, the socks go.
 *
 * A dropped verdict, or a fix whose slots are not as it expects (no top to
 * move, a top slot already filled), changes nothing. The entries are expected
 * to pass validateOutfit (one item per slot); the input is not changed.
 */
export function repairOutfit(
  entries: StyleOutfit,
  verdict: LayerVerdict,
  ctx: ScoreContext,
  avoid?: ReadonlySet<string>,
): { entries: StyleEntry[]; repairs: RepairKind[] } {
  const state: Repair = {
    entries: entries.map((entry) => ({ slot: entry.slot, itemId: entry.itemId })),
    repairs: [],
    ctx,
    avoid,
  };
  const fixes = verdict.drop ? [] : verdict.fixes;
  fixes.forEach((fix, index) => applyFix(state, fix, fixes.slice(index + 1)));
  return { entries: sortBySlot(state.entries), repairs: state.repairs };
}
