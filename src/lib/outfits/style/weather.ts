// How well a whole outfit suits today's weather (D-256): a score from 0 to 1
// that the selection weighs against colour, formality, novelty and taste, with
// a short note per penalty for logs and tests. The warmth model is the
// shopping count's (combinatorics.ts: top + bottom + outerwear warmth inside a
// WARMTH_BANDS range), extended for the layers an outfit can hold. The rain,
// ideal-warmth and season helpers behave exactly as suggestion.ts's, which
// stays off the client and must not be imported here (types.ts, D-156).
// Pure and client-safe: no I/O, no clock.

import { firstItemInSlot as pieceIn, footwearKind } from "@/lib/outfits/style/layering";
import type { StyleItem, StyleOutfit } from "@/lib/outfits/style/types";
import { warmthBand, type WarmthBand } from "@/lib/shopping/combinatorics";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";

// ---------------------------------------------------------------------------
// Shared weather helpers (same values and behaviour as suggestion.ts)
// ---------------------------------------------------------------------------

/** Rain gear counts from this chance of precipitation (percent), or from this much rain (mm). */
export const RAINY_DAY = { probability: 50, sumMm: 2 } as const;

/** An unknown chance of rain counts as none; the rain sum alone can still make the day rainy. */
export function isRainyDay(weather: Pick<WeatherSnapshot, "precipProbMax" | "precipSumMm">): boolean {
  return (weather.precipProbMax ?? 0) >= RAINY_DAY.probability || weather.precipSumMm >= RAINY_DAY.sumMm;
}

/** The warmth level (1 to 5) an item would ideally have on a day that feels like `feelsLikeC`. */
export function idealWarmth(feelsLikeC: number): number {
  if (feelsLikeC >= 22) return 1;
  if (feelsLikeC >= 16) return 2;
  if (feelsLikeC >= 10) return 3;
  if (feelsLikeC >= 3) return 4;
  return 5;
}

/**
 * Whether the outfit keeps the wearer dry: waterproof outerwear, or
 * waterproof shoes under any outerwear (a layer that sheds a shower), the
 * prompt's rule for rain_ok. Shoes alone do not do it, and an unknown
 * waterproof flag counts as not waterproof. The rain penalty (weatherFit),
 * the selection's dry pick and its rain_ok check all read this.
 */
export function keepsDry(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>): boolean {
  const outer = pieceIn(entries, items, "outerwear");
  if (outer === null) return false;
  if (outer.waterproof === true) return true;
  return pieceIn(entries, items, "shoes")?.waterproof === true;
}

/** Northern-hemisphere season of a YYYY-MM-DD date (both home cities are in Europe). */
export function seasonOf(date: string): "winter" | "spring" | "summer" | "autumn" {
  const month = Number(date.slice(5, 7));
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "autumn";
}

// ---------------------------------------------------------------------------
// Outfit warmth
// ---------------------------------------------------------------------------

/** An unknown warmth counts as a light layer (2), the commonest level of tops, bottoms and jackets. */
export const UNKNOWN_WARMTH = 2;

/**
 * Two torso layers trap air between them, so a shirt under a knit is warmer
 * than the knit alone, though less than the two added up: the warmer layer
 * plus this. A summer-weight tee (warmth 1) under a knit adds next to
 * nothing, so both layers need at least LAYERING_MIN_WARMTH for the bonus.
 */
export const LAYERING_BONUS = 1;
export const LAYERING_MIN_WARMTH = 2;

/** A thermal base layer is thin but close to the skin: one level, whatever its own tag says. */
export const BASE_LAYER_WARMTH = 1;

function warmthOf(item: StyleItem): number {
  return item.warmthLevel ?? UNKNOWN_WARMTH;
}

/** Every distinct item of the outfit that the map knows, in entry order. */
function piecesOf(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>): StyleItem[] {
  const seen = new Map<string, StyleItem>();
  for (const entry of entries) {
    const item = items.get(entry.itemId);
    if (item !== undefined && !seen.has(item.id)) seen.set(item.id, item);
  }
  return [...seen.values()];
}

/**
 * The outfit's warmth on the WARMTH_BANDS scale: the torso (the warmer of top
 * and mid layer, plus LAYERING_BONUS when both are worn and each is at least
 * LAYERING_MIN_WARMTH), plus BASE_LAYER_WARMTH with a base layer, plus the
 * legs (the bottom; a dress with no bottom counts again, as in combinatorics,
 * since it covers both), plus the outerwear. Hats, gloves, scarves, socks,
 * shoes and accessories do not add: the bands are calibrated without them.
 * An unknown warmth counts as UNKNOWN_WARMTH; entries whose item is missing
 * from the map are ignored.
 */
export function outfitWarmth(entries: StyleOutfit, items: ReadonlyMap<string, StyleItem>): number {
  const top = pieceIn(entries, items, "top");
  const mid = pieceIn(entries, items, "mid_layer");
  const base = pieceIn(entries, items, "base_layer");
  const bottom = pieceIn(entries, items, "bottom");
  const outer = pieceIn(entries, items, "outerwear");

  const topWarmth = top === null ? 0 : warmthOf(top);
  const midWarmth = mid === null ? 0 : warmthOf(mid);
  const layered = top !== null && mid !== null && Math.min(topWarmth, midWarmth) >= LAYERING_MIN_WARMTH;
  const torso = Math.max(topWarmth, midWarmth) + (layered ? LAYERING_BONUS : 0);

  let legs = 0;
  if (bottom !== null) legs = warmthOf(bottom);
  else if (top?.category === "dress") legs = topWarmth;

  return torso + (base === null ? 0 : BASE_LAYER_WARMTH) + legs + (outer === null ? 0 : warmthOf(outer));
}

// ---------------------------------------------------------------------------
// Weather fit
// ---------------------------------------------------------------------------

export const WEATHER_THRESHOLDS = {
  /** A feels-like range wider than this (°C) calls for layers that come off, as the prompt says. */
  wideRangeC: 8,
  /** On such a day outerwear is judged at the low end plus this (°C): dress for the commute, not the afternoon. */
  commuteOffsetC: 2,
  /** Below this mean feels-like (°C) open shoes leave feet cold. */
  openShoesBelowC: 15,
  /** From these gusts (km/h) a jacket that lets the wind through feels cold; the prompt's "about 40". */
  gustKmh: 40,
} as const;

/**
 * What each problem costs, from a score of 1. The weights rank how much the
 * wearer would notice: being cold without a coat or wet without rain gear
 * matters most; a missing hat below freezing or a jacket that is not
 * windproof is only a nudge between otherwise equal outfits.
 */
export const WEATHER_PENALTIES = {
  /** Per warmth point outside the band: one point is a noticeable but wearable miss (a shirt instead of a knit). */
  warmthPerPoint: 0.12,
  /** Five points off is already unwearable; further distance does not change the ranking. */
  warmthMax: 0.6,
  /** The band needs outerwear and there is none: cold through the commute whatever is underneath. */
  noOuterwear: 0.35,
  /** Outerwear above the band's outerMax on a mild or warm day: too hot to wear, bulky to carry. */
  heavyOuterwear: 0.25,
  /** A rainy day and an outfit that does not keep the wearer dry (keepsDry): wet through. */
  rainNoGear: 0.3,
  /** Open shoes in the rain: wet feet even under a raincoat. */
  rainOpenShoes: 0.2,
  /** Open shoes below WEATHER_THRESHOLDS.openShoesBelowC: cold feet. */
  coldOpenShoes: 0.25,
  /**
   * Per summer-weight bottom, dress or pair of closed shoes when the band's
   * pieceMin wants more (below 15 °C): cold legs or feet that a parka over
   * the top does not warm, the cost of open shoes on such a day.
   */
  summerPiece: 0.25,
  summerPieceMax: 0.5,
  /** Gusty, and the outerwear is known not to be windproof: noticeably colder, but still wearable. */
  notWindproof: 0.05,
  /** Per piece tagged for other seasons: a weak signal, since warmth already covers most of it. */
  offSeasonEach: 0.05,
  offSeasonMax: 0.2,
  /** Freezing with no hat, gloves or scarf: extras are nice, not essential. */
  freezingNoExtras: 0.05,
  /** A piece needs repair: wearable, but not the best choice when another exists. Counted once. */
  needsRepair: 0.1,
} as const;

/**
 * Open shoes as the layering rules read them (footwearKind): sandals, slides,
 * flip-flops and their German and Italian names, so the shoes that lose their
 * socks are the same ones that leave feet cold or wet.
 */
function isOpenShoe(item: StyleItem): boolean {
  return footwearKind(item) === "open";
}

export type WeatherFit = {
  /** 0 to 1; 1 = nothing to fault. */
  score: number;
  /** One short English reason per penalty, in the order applied. */
  notes: string[];
};

function formatC(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (rounded === 0 ? 0 : rounded).toFixed(1);
}

/** What the checks read, worked out once per outfit. */
type FitContext = {
  weather: WeatherSnapshot;
  feelsMeanC: number;
  /** The band of the mean feels-like temperature. */
  band: WarmthBand;
  /** The band outerwear is judged in: the commute's on a wide-range day, otherwise `band`. */
  outerBand: WarmthBand;
  /** "a cold day" or "the 4.0 °C commute", for the notes. */
  outerWhen: string;
  /** outfitWarmth, outerwear included. */
  warmth: number;
  /** The warmth worn in the warm hours: without the outerwear on a wide-range day. */
  warmthWorn: number;
  outer: StyleItem | null;
  shoes: StyleItem | null;
  /** keepsDry. */
  dry: boolean;
  /** Every distinct piece of the outfit. */
  pieces: StyleItem[];
  hasExtras: boolean;
  /** A base layer (thermals, tights) is worn. */
  hasBaseLayer: boolean;
};

type Penalty = { amount: number; note: string };

const P = WEATHER_PENALTIES;
const T = WEATHER_THRESHOLDS;

function warmthMiss({ band, warmth, warmthWorn }: FitContext): Penalty | null {
  const range = `the ${band.label} band wants ${band.min}-${band.max}`;
  if (warmth < band.min) {
    return { amount: Math.min(P.warmthMax, (band.min - warmth) * P.warmthPerPoint), note: `too cool: warmth ${warmth}, ${range}` };
  }
  if (warmthWorn > band.max) {
    const without = warmthWorn === warmth ? "" : " without the outerwear";
    return {
      amount: Math.min(P.warmthMax, (warmthWorn - band.max) * P.warmthPerPoint),
      note: `too warm: warmth ${warmthWorn}${without}, ${range}`,
    };
  }
  return null;
}

function missingOuterwear({ outerBand, outer, outerWhen }: FitContext): Penalty | null {
  return outerBand.outerRequired && outer === null ? { amount: P.noOuterwear, note: `no outerwear for ${outerWhen}` } : null;
}

/** outerMax is below 5 only in the mild and warm bands. */
function heavyOuterwear({ outerBand, outer, outerWhen }: FitContext): Penalty | null {
  if (outer === null || warmthOf(outer) <= outerBand.outerMax) return null;
  return { amount: P.heavyOuterwear, note: `heavy outerwear (warmth ${warmthOf(outer)}) for ${outerWhen}` };
}

function rainWithoutGear({ weather, dry }: FitContext): Penalty | null {
  if (!isRainyDay(weather) || dry) return null;
  return { amount: P.rainNoGear, note: "rain without waterproof outerwear, or waterproof shoes under outerwear" };
}

function openShoesInRain({ weather, shoes }: FitContext): Penalty | null {
  if (shoes === null || !isOpenShoe(shoes) || !isRainyDay(weather)) return null;
  return { amount: P.rainOpenShoes, note: "open shoes in the rain" };
}

function openShoesWhenCool({ feelsMeanC, shoes }: FitContext): Penalty | null {
  if (shoes === null || !isOpenShoe(shoes) || feelsMeanC >= T.openShoesBelowC) return null;
  return { amount: P.coldOpenShoes, note: `open shoes at ${formatC(feelsMeanC)} °C feels-like` };
}

/** The categories whose warmth is judged on its own: what covers the legs and the feet. */
const SUMMER_PIECE_CATEGORIES: ReadonlySet<StyleItem["category"]> = new Set(["bottom", "dress", "shoes"]);

/**
 * Each piece suits the day on its own, as in the shopping count
 * (combinatorics.ts, WARMTH_BANDS' pieceMin): below 15 °C a bottom, dress or
 * pair of shoes of known warmth under the band's pieceMin (warmth 1, summer
 * weight) costs summerPiece, whatever a coat adds to the total. A dress over
 * a base layer (tights) counts BASE_LAYER_WARMTH warmer. Open shoes are left
 * to openShoesWhenCool, so the same pair is not charged twice.
 */
function summerPieces({ band, feelsMeanC, pieces, hasBaseLayer }: FitContext): Penalty | null {
  const count = pieces.filter((item) => {
    if (!SUMMER_PIECE_CATEGORIES.has(item.category) || item.warmthLevel === null || isOpenShoe(item)) return false;
    const warmth = item.category === "dress" && hasBaseLayer ? item.warmthLevel + BASE_LAYER_WARMTH : item.warmthLevel;
    return warmth < band.pieceMin;
  }).length;
  if (count === 0) return null;
  const what = count === 1 ? "1 summer-weight piece" : `${count} summer-weight pieces`;
  return { amount: Math.min(P.summerPieceMax, count * P.summerPiece), note: `${what} at ${formatC(feelsMeanC)} °C feels-like` };
}

/** Only a windproof flag known to be false counts; an unknown one gets the benefit of the doubt. */
function notWindproof({ weather, outer }: FitContext): Penalty | null {
  if (weather.windGustMaxKmh < T.gustKmh || outer === null || outer.windproof !== false) return null;
  return { amount: P.notWindproof, note: `outerwear not windproof in ${Math.round(weather.windGustMaxKmh)} km/h gusts` };
}

/** An empty seasons list fits any season. */
function offSeason({ weather, pieces }: FitContext): Penalty | null {
  const season = seasonOf(weather.date);
  const count = pieces.filter((item) => item.seasons.length > 0 && !item.seasons.includes(season)).length;
  if (count === 0) return null;
  const what = count === 1 ? "1 piece" : `${count} pieces`;
  return { amount: Math.min(P.offSeasonMax, count * P.offSeasonEach), note: `${what} out of season for ${season}` };
}

function freezingWithoutExtras({ band, hasExtras }: FitContext): Penalty | null {
  return band.label === "freezing" && !hasExtras
    ? { amount: P.freezingNoExtras, note: "no hat, gloves or scarf below freezing" }
    : null;
}

function needsRepair({ pieces }: FitContext): Penalty | null {
  return pieces.some((item) => item.condition === "needs_repair") ? { amount: P.needsRepair, note: "a piece needs repair" } : null;
}

/** The checks in the order their notes appear. */
const CHECKS: readonly ((context: FitContext) => Penalty | null)[] = [
  warmthMiss,
  missingOuterwear,
  heavyOuterwear,
  rainWithoutGear,
  openShoesInRain,
  openShoesWhenCool,
  summerPieces,
  notWindproof,
  offSeason,
  freezingWithoutExtras,
  needsRepair,
];

/**
 * How well the outfit suits the day: 1 minus WEATHER_PENALTIES for each
 * problem, clamped to [0, 1] (and rounded to six decimals so logs read 0.53,
 * not 0.5300000000000001). The band is warmthBand of the mean feels-like
 * temperature. Penalties: warmth outside the band; no outerwear when the band
 * requires it; heavy outerwear on a mild or warm day; an outfit that does
 * not keep the wearer dry on a rainy day (keepsDry, isRainyDay: waterproof
 * shoes alone are not enough); open shoes in the rain;
 * open shoes on a cool day; a summer-weight bottom, dress or pair of closed
 * shoes below 15 °C, however warm the rest (summerPieces, capped at
 * summerPieceMax); non-windproof outerwear (known false) in gusts;
 * pieces whose seasons leave out today's (an empty list fits any season);
 * no hat, gloves or scarf below freezing; a piece that needs repair. Each
 * note ends with what it cost, such as "(-0.35)".
 *
 * A wide range (more than WEATHER_THRESHOLDS.wideRangeC between the low and
 * the high) is dressed for the commute: whether outerwear is required, and
 * whether it is too heavy, is judged at the low end plus commuteOffsetC
 * instead of the mean, and the too-warm check leaves the outerwear out, since
 * it comes off and is carried in the warm hours. The too-cool check still
 * counts it. Items missing from the map are ignored.
 */
export function weatherFit(
  entries: StyleOutfit,
  items: ReadonlyMap<string, StyleItem>,
  weather: WeatherSnapshot,
): WeatherFit {
  const feelsMeanC = (weather.apparentMinC + weather.apparentMaxC) / 2;
  const band = warmthBand(feelsMeanC);
  const wideRange = weather.apparentMaxC - weather.apparentMinC > T.wideRangeC;
  const commuteC = weather.apparentMinC + T.commuteOffsetC;
  const outer = pieceIn(entries, items, "outerwear");
  const warmth = outfitWarmth(entries, items);

  const context: FitContext = {
    weather,
    feelsMeanC,
    band,
    outerBand: wideRange ? warmthBand(commuteC) : band,
    outerWhen: wideRange ? `the ${formatC(commuteC)} °C commute` : `a ${band.label} day`,
    warmth,
    warmthWorn: wideRange && outer !== null ? warmth - warmthOf(outer) : warmth,
    outer,
    shoes: pieceIn(entries, items, "shoes"),
    dry: keepsDry(entries, items),
    pieces: piecesOf(entries, items),
    hasExtras: (["hat", "gloves", "scarf"] as const).some((slot) => pieceIn(entries, items, slot) !== null),
    hasBaseLayer: pieceIn(entries, items, "base_layer") !== null,
  };

  let penalty = 0;
  const notes: string[] = [];
  for (const check of CHECKS) {
    const found = check(context);
    if (found === null) continue;
    penalty += found.amount;
    notes.push(`${found.note} (-${found.amount.toFixed(2)})`);
  }
  const score = Math.min(1, Math.max(0, 1 - penalty));
  return { score: Math.round(score * 1e6) / 1e6, notes };
}
