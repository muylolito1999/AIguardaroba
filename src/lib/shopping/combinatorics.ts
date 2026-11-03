// How many outfits the wardrobe makes for a kind of weather, and how many a
// purchase would add (D-040): the numbers behind "unlocks N outfits". Claude
// only ranks and explains; these counts are computed here, deterministically.
// Pure and client-safe: no I/O, env or Node APIs.
//
// An outfit here is a top (or a dress) + a bottom (not with a dress) + shoes,
// with or without outerwear. It fits a scenario when:
// - formality: every known formality is within one step of the others on
//   athletic < casual < smart_casual < business < formal (unknown fits any);
// - warmth: top + bottom + outerwear warmth (a dress counts twice, as it
//   covers both) lies in the scenario's WARMTH_BANDS range, and each piece
//   suits the month on its own: no summer-weight bottom, dress or shoes when
//   it is cool or colder, outerwear when it is near freezing, and no heavy
//   outerwear when it is mild or warm. An unknown warmth is any level the
//   piece may have, so it fits when some level would;
// - rain: in a rainy scenario the outerwear or the shoes are waterproof (an
//   unknown flag counts as not waterproof).
// Layers, hats, gloves, scarves and accessories are not part of the count, so
// a candidate of those categories unlocks 0 by definition.

import type { ClimateMonth } from "@/lib/climate/types";
import { FORMALITIES, type Formality, type ItemCategory } from "@/lib/db/enums";
import { AppError } from "@/lib/result";

export type ComboItem = {
  id: string;
  category: ItemCategory;
  warmthLevel: number | null;
  formality: Formality | null;
  waterproof: boolean | null;
};

export type Scenario = { key: string; label: string; tmeanC: number; rainy: boolean };

export type OutfitCount = {
  count: number;
  /** The enumeration stopped at the cap, so count is a lower bound. */
  capped: boolean;
};

/** The most combinations one count examines (design.md's 50K). */
export const DEFAULT_COMBINATION_CAP = 50_000;

export type WarmthBand = {
  /** The band starts at this mean temperature, °C, inclusive. */
  fromC: number;
  label: string;
  /** Allowed sum of top + bottom + outerwear warmth (a dress twice, no outerwear 0). */
  min: number;
  max: number;
  /** The least warmth the bottom (or the dress) and the shoes may each have. */
  pieceMin: number;
  /** Only outfits with outerwear count. */
  outerRequired: boolean;
  /** The most warmth the outerwear may have. */
  outerMax: number;
};

/**
 * The warmth an outfit needs by mean temperature, on the tagging rubric's
 * scale (1 summer or very light, 2 light layer, 3 mid layer, 4 warm, 5 heavy
 * winter). The sum alone would let a heavy coat make up for linen shorts or
 * sandals in January, so each piece is also checked on its own: from the cool
 * band down the bottom (or the dress) and the shoes need warmth 2 or more,
 * near freezing outerwear is required, and in mild and warm months outerwear
 * above 3 (a wool coat, a parka) does not count. Worked examples, with jeans
 * (2) as the bottom and shoes of warmth 2 or more:
 * - freezing, below 0: a mid-layer knit (3) under a down jacket (5) makes 10;
 *   under a wool coat (4) only 9, too little.
 * - cold, 0 to 5: the knit under the wool coat makes 9, under a shell (2) 7;
 *   the knit with no outerwear does not count, nor do shorts or sandals (1).
 * - chilly, 5 to 10: a shirt (2) under a shell makes 6.
 * - cool, 10 to 15: the knit alone makes 5; shorts still do not count.
 * - mild, 15 to 20: a t-shirt (1) alone makes 3; the knit under the wool coat
 *   is too warm, and the coat does not count at all.
 * - warm, 20 and above: the t-shirt alone makes 3, under a shell 5.
 * The bands overlap, as clothes do.
 */
export const WARMTH_BANDS: readonly WarmthBand[] = [
  { fromC: Number.NEGATIVE_INFINITY, label: "freezing", min: 10, max: 15, pieceMin: 2, outerRequired: true, outerMax: 5 },
  { fromC: 0, label: "cold", min: 7, max: 13, pieceMin: 2, outerRequired: true, outerMax: 5 },
  { fromC: 5, label: "chilly", min: 6, max: 11, pieceMin: 2, outerRequired: false, outerMax: 5 },
  { fromC: 10, label: "cool", min: 5, max: 10, pieceMin: 2, outerRequired: false, outerMax: 5 },
  { fromC: 15, label: "mild", min: 3, max: 7, pieceMin: 1, outerRequired: false, outerMax: 3 },
  { fromC: 20, label: "warm", min: 2, max: 5, pieceMin: 1, outerRequired: false, outerMax: 3 },
];

export function warmthBand(tmeanC: number): WarmthBand {
  if (!Number.isFinite(tmeanC)) throw new RangeError("tmeanC must be a finite number.");
  const band = [...WARMTH_BANDS].reverse().find((entry) => tmeanC >= entry.fromC);
  if (band === undefined) throw new RangeError("No warmth band.");
  return band;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * Items with the same warmth, formality and waterproof flag are
 * interchangeable here, so the count enumerates classes and multiplies by
 * their sizes: exact, and far below the cap for any real wardrobe.
 */
type ComboClass = { warmth: number | null; formality: Formality | null; waterproof: boolean; size: number };

type Pools = {
  tops: ComboClass[];
  bottoms: ComboClass[];
  dresses: ComboClass[];
  shoes: ComboClass[];
  outers: ComboClass[];
  /** Only outfits with outerwear count (an outerwear candidate). */
  outerRequired: boolean;
};

const FORMALITY_RANK = new Map<Formality, number>(FORMALITIES.map((formality, index) => [formality, index]));

function classesOf(items: readonly ComboItem[], categories: readonly ItemCategory[]): ComboClass[] {
  const byKey = new Map<string, ComboClass>();
  for (const item of items) {
    if (!categories.includes(item.category)) continue;
    const warmth = item.warmthLevel;
    const waterproof = item.waterproof === true;
    const key = `${warmth ?? "?"}|${item.formality ?? "?"}|${waterproof}`;
    const existing = byKey.get(key);
    if (existing) existing.size += 1;
    else byKey.set(key, { warmth, formality: item.formality, waterproof, size: 1 });
  }
  return [...byKey.values()];
}

function poolsOf(items: readonly ComboItem[]): Pools {
  return {
    tops: classesOf(items, ["top"]),
    bottoms: classesOf(items, ["bottom"]),
    dresses: classesOf(items, ["dress"]),
    shoes: classesOf(items, ["shoes"]),
    outers: classesOf(items, ["outerwear"]),
    outerRequired: false,
  };
}

function formalityFits(classes: readonly ComboClass[]): boolean {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const entry of classes) {
    if (entry.formality === null) continue;
    const rank = FORMALITY_RANK.get(entry.formality) ?? 0;
    min = Math.min(min, rank);
    max = Math.max(max, rank);
  }
  return max - min <= 1 || min === Number.POSITIVE_INFINITY;
}

/** A piece's warmth and the levels it may have in the band: lo to hi, an unknown one any of them. */
type WarmthPart = { warmth: number | null; weight: number; lo: number; hi: number };

/** Whether a piece suits the band on its own; an unknown warmth fits when some allowed level exists. */
function pieceFits(warmth: number | null, lo: number, hi: number): boolean {
  return warmth === null ? lo <= hi : warmth >= lo && warmth <= hi;
}

/** Whether some allowed choice for each unknown warmth puts the weighted sum in [min, max]. */
function warmthFits(parts: readonly WarmthPart[], band: { min: number; max: number }): boolean {
  let low = 0;
  let high = 0;
  for (const part of parts) {
    low += (part.warmth ?? part.lo) * part.weight;
    high += (part.warmth ?? part.hi) * part.weight;
  }
  return low <= band.max && high >= band.min;
}

function enumerate(pools: Pools, scenario: Scenario, cap: number): OutfitCount {
  if (!Number.isInteger(cap) || cap < 0) throw new RangeError("cap must be a non-negative integer.");
  const band = warmthBand(scenario.tmeanC);
  // Pieces too light or too heavy for the month on their own never count (see WARMTH_BANDS).
  const legsFit = (entry: ComboClass) => pieceFits(entry.warmth, band.pieceMin, 5);
  const shoesPool = pools.shoes.filter(legsFit);
  const outers = pools.outers.filter((outer) => pieceFits(outer.warmth, 1, band.outerMax));
  const outerOptions: (ComboClass | null)[] = pools.outerRequired || band.outerRequired ? outers : [null, ...outers];
  const bases: { garments: ComboClass[]; warmth: WarmthPart[]; size: number }[] = [];
  for (const top of pools.tops) {
    for (const bottom of pools.bottoms.filter(legsFit)) {
      bases.push({
        garments: [top, bottom],
        warmth: [
          { warmth: top.warmth, weight: 1, lo: 1, hi: 5 },
          { warmth: bottom.warmth, weight: 1, lo: band.pieceMin, hi: 5 },
        ],
        size: top.size * bottom.size,
      });
    }
  }
  for (const dress of pools.dresses.filter(legsFit)) {
    bases.push({
      garments: [dress],
      warmth: [{ warmth: dress.warmth, weight: 2, lo: band.pieceMin, hi: 5 }],
      size: dress.size,
    });
  }

  let count = 0;
  let examined = 0;
  for (const base of bases) {
    for (const shoes of shoesPool) {
      for (const outer of outerOptions) {
        if (examined === cap) return { count, capped: true };
        examined += 1;
        const garments = outer === null ? [...base.garments, shoes] : [...base.garments, shoes, outer];
        if (!formalityFits(garments)) continue;
        const warmth =
          outer === null ? base.warmth : [...base.warmth, { warmth: outer.warmth, weight: 1, lo: 1, hi: band.outerMax }];
        if (!warmthFits(warmth, band)) continue;
        if (scenario.rainy && !(shoes.waterproof || outer?.waterproof === true)) continue;
        count += base.size * shoes.size * (outer?.size ?? 1);
      }
    }
  }
  return { count, capped: false };
}

/** Outfits the items make for a scenario, examining at most `cap` class combinations. */
export function countOutfits(items: readonly ComboItem[], scenario: Scenario, cap: number = DEFAULT_COMBINATION_CAP): OutfitCount {
  return enumerate(poolsOf(items), scenario, cap);
}

/**
 * How many outfits buying `candidate` would add: countOutfits with it minus
 * countOutfits without it, computed directly as the outfits that include it
 * (the others are unchanged), so it is never negative. An item already in
 * `items` under the candidate's id is set aside first. Candidates of a
 * category the count leaves out (layers, accessories) unlock 0. When the cap
 * stops the enumeration the result is a lower bound.
 */
export function unlockCount(
  items: readonly ComboItem[],
  candidate: ComboItem,
  scenario: Scenario,
  cap: number = DEFAULT_COMBINATION_CAP,
): number {
  const pools = poolsOf(items.filter((item) => item.id !== candidate.id));
  const [own] = classesOf([candidate], [candidate.category]);
  if (own === undefined) return 0;
  switch (candidate.category) {
    case "top":
      return enumerate({ ...pools, tops: [own], dresses: [] }, scenario, cap).count;
    case "bottom":
      return enumerate({ ...pools, bottoms: [own], dresses: [] }, scenario, cap).count;
    case "dress":
      return enumerate({ ...pools, tops: [], dresses: [own] }, scenario, cap).count;
    case "shoes":
      return enumerate({ ...pools, shoes: [own] }, scenario, cap).count;
    case "outerwear":
      return enumerate({ ...pools, outers: [own], outerRequired: true }, scenario, cap).count;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** A month counts as rainy from this many days with at least 1 mm (rain on about every other day). */
export const RAINY_MONTH_DAYS = 15;

/** The months the advice scores, one per season. */
export const SCENARIO_MONTHS = [
  { month: 1, key: "jan", label: "January" },
  { month: 4, key: "apr", label: "April" },
  { month: 7, key: "jul", label: "July" },
  { month: 10, key: "oct", label: "October" },
] as const;

export type ScenarioKey = (typeof SCENARIO_MONTHS)[number]["key"];

/**
 * January, April, July and October of a climate profile: each month's mean
 * temperature, rainy from RAINY_MONTH_DAYS rain days. A profile missing either
 * value for one of those months (a placeholder) is refused with VALIDATION
 * rather than scored on guesses.
 */
export function scenariosFromProfile(profile: { city: string; months: readonly ClimateMonth[] }): Scenario[] {
  const missing: string[] = [];
  const scenarios: Scenario[] = [];
  for (const { month, key, label } of SCENARIO_MONTHS) {
    const entry = profile.months.find((candidate) => candidate.month === month);
    if (entry === undefined || entry.tmean === null || entry.precip_days === null) {
      missing.push(label);
      continue;
    }
    scenarios.push({ key, label, tmeanC: entry.tmean, rainy: entry.precip_days >= RAINY_MONTH_DAYS });
  }
  if (missing.length > 0) {
    throw new AppError(
      "VALIDATION",
      `The ${profile.city} climate profile has no mean temperature or rain days for ${missing.join(", ")}. Fill them in under Settings > Climate.`,
      { missing },
    );
  }
  return scenarios;
}

// ---------------------------------------------------------------------------
// Candidates from the shopping list
// ---------------------------------------------------------------------------

/** Tested in order; the first match wins. A "dress shirt" is a top, a "shirt dress" a dress. */
const CATEGORY_RULES: ReadonlyArray<[ItemCategory, RegExp]> = [
  ["base_layer", /\b(base ?layers?|baselayers?|thermal (tops?|bottoms?|underwear|leggings)|long johns)\b/],
  ["outerwear", /\b(jackets?|coats?|parkas?|shells?|anoraks?|raincoats?|windbreakers?|puffers?|gilets?)\b/],
  ["shoes", /\b(boots?|shoes?|sneakers?|trainers?|loafers?|sandals?|footwear|wellies|wellingtons)\b/],
  ["gloves", /\b(gloves?|mittens?|mitts)\b/],
  ["hat_beanie", /\b(beanies?|hats?|caps?|toques?)\b/],
  ["scarf", /\b(scarf|scarves|snoods?|neck gaiters?)\b/],
  ["bag", /\b(bags?|backpacks?|rucksacks?|totes?|panniers?)\b/],
  ["dress", /\b(dress|dresses|gowns?)\b(?!\s+(shirts?|trousers|pants|shoes))/],
  ["bottom", /\b(trousers|pants|jeans|chinos|shorts|skirts?|leggings|joggers)\b/],
  ["top", /\b(shirts?|t-shirts?|tees?|sweaters?|jumpers?|knits?|cardigans?|hoodies?|fleeces?|blouses?|polos?|turtlenecks?|tops?)\b/],
  ["accessory", /\b(umbrellas?|belts?|sunglasses|reflective|bands?|watch(es)?)\b/],
];

/** Heavy first, then the summer weights (a linen shirt is lighter than a shirt), then mid and light layers. */
const WARMTH_RULES: ReadonlyArray<[number, RegExp]> = [
  [5, /\b(down|puffer|parka|insulated|padded|heavy|shearling)\b/],
  [1, /\b(linen|t-shirts?|tees?|shorts|summer|lightweight|sandals?|tank)\b/],
  [3, /\b(wool|woollen|woolen|merino|fleece|knit|knitted|sweater|jumper|cardigan|flannel|thermal|lined|corduroy|cashmere)\b/],
  [2, /\b(shell|softshell|raincoat|windbreaker|rain jacket|chinos?|jeans|denim|shirt)\b/],
];

const WATERPROOF = /\b(waterproof|raincoats?|rain (jackets?|coats?|shells?|pants|trousers|boots)|gore-?tex|taped seams|wellies|wellingtons|hydrostatic|\d[\d,.]*\s?mm)\b/;

const FORMALITY_RULES: ReadonlyArray<[Formality, RegExp]> = [
  ["formal", /\b(formal|tuxedo|suit|evening|gown)\b/],
  ["business", /\b(business|office|blazer|dress shirt|oxford|tailored|dress (trousers|pants|shoes))\b/],
  ["athletic", /\b(running|hiking|trail|sports?|athletic|gym|cycling|technical|training)\b/],
  ["smart_casual", /\b(smart|chelsea|loafers?|chinos?|overcoat|trench)\b/],
  ["casual", /\b(casual|jeans|denim|sneakers?|trainers?|hoodie|t-shirts?|tees?|beanie|parka|puffer|fleece)\b/],
];

function firstMatch<T>(rules: ReadonlyArray<[T, RegExp]>, text: string): T | null {
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/**
 * A shopping list row (or a relocation gap mapped to the same shape) as a
 * ComboItem. The category is the row's own when set, otherwise read from the
 * item type. Warmth, formality and waterproofing are read from keywords in the
 * item type and specs: an approximation, documented as such; whatever no
 * keyword names stays null, which the count treats as described at the top.
 * A heavy keyword gives outerwear warmth 5 and other categories 4.
 */
export function candidateFromShoppingRow(row: {
  id: string;
  itemType: string;
  category: ItemCategory | null;
  specs: readonly string[];
}): ComboItem {
  const type = row.itemType.toLowerCase();
  const text = [row.itemType, ...row.specs].join(" \n ").toLowerCase();
  const category = row.category ?? firstMatch(CATEGORY_RULES, type) ?? "other";
  const warmth = firstMatch(WARMTH_RULES, text);
  return {
    id: row.id,
    category,
    warmthLevel: warmth === 5 && category !== "outerwear" ? 4 : warmth,
    formality: firstMatch(FORMALITY_RULES, text),
    waterproof: WATERPROOF.test(text) ? true : null,
  };
}
