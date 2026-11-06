// Style directions for outfit suggestions (D-256): the aesthetic each of
// Claude's candidate outfits is asked to follow, so the candidates of one
// request differ in look (tonal neutrals, a smart collar, knit layers...) and
// not only in which hoodie goes with which trousers. This module names the
// directions, profiles the wardrobe, decides which directions the wardrobe and
// today's weather can actually support, and assigns them to candidates with a
// seeded, weighted draw that rotates from day to day and between runs. The
// one-line brief per direction lives in the prompt module; this one holds the
// labels and the logic only. Pure and client-safe: no I/O, no clock, no
// Math.random.

import { FORMALITIES, type Formality, type ItemCategory } from "@/lib/db/enums";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";

import { DARK_NEUTRAL_LIGHTNESS, itemColors, patternClass } from "./color";
import { foldText, footwearKind, isSneaker, topKind } from "./layering";
import { seededRandom } from "./random";
import {
  DIRECTION_KEYS,
  isDirectionKey,
  type DirectionKey,
  type StyleItem,
  type TopKind,
  type VarietyHistory,
} from "./types";
import { isRainyDay, WEATHER_THRESHOLDS } from "./weather";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** What the owner sees for each direction: UK spelling, sentence case, at most 24 characters. */
export const DIRECTION_LABELS: Readonly<Record<DirectionKey, string>> = {
  tonal_neutrals: "Tonal neutrals",
  dark_monochrome: "Dark monochrome",
  light_and_airy: "Light and airy",
  neutral_with_accent: "Neutrals with an accent",
  smart_collar: "Smart collar",
  knit_layers: "Knit layers",
  elevated_denim: "Elevated denim",
  earth_tones: "Earth tones",
  preppy_layers: "Preppy layers",
  sporty_clean: "Clean and sporty",
  texture_play: "Mixed textures",
  sharp_tailoring: "Sharp tailoring",
  pattern_anchor: "One bold pattern",
  weather_ready: "Weather-ready",
  cosy_winter: "Cosy winter",
  dress_led: "Dress-led",
  classic_balanced: "Classic and balanced",
};

/** The direction every wardrobe supports, and the padding when too few others are feasible. */
export const FALLBACK_DIRECTION: DirectionKey = "classic_balanced";

/** The label of a known key; null for anything else (a stored row may hold a key since removed). */
export function directionLabel(key: string | null | undefined): string | null {
  return isDirectionKey(key) ? DIRECTION_LABELS[key] : null;
}

// ---------------------------------------------------------------------------
// Wardrobe profile
// ---------------------------------------------------------------------------

/**
 * What the wardrobe holds, as counts over the items given (the caller decides
 * which items are available today). Each count says how many items qualify;
 * one item can count in several fields (a navy wool blazer is tailored,
 * neutral, dark and textured). The Upper counts take tops (worn as the top or
 * the mid layer) and dresses, the Lower counts bottoms and dresses: a look
 * needs one of each, and a dress is both.
 */
export type WardrobeProfile = {
  /** Every top, whatever its kind (a turtleneck or a plain "top" counts here and in no kind below). */
  tops: number;
  /** Tops by topKind. Blazers and sport coats filed as outerwear also count as tailored. */
  tees: number;
  shirts: number;
  knits: number;
  sweats: number;
  tailored: number;
  dresses: number;
  bottoms: number;
  /** Bottoms whose subcategory or name says jeans or denim, or whose main material is denim. */
  jeans: number;
  /**
   * Bottoms of formality smart_casual or above, or called chinos, trousers,
   * slacks, dress pants and the like, unless athletic or casual by a word
   * (track, cargo, rain, ski...).
   */
  smartBottoms: number;
  outerwear: number;
  /** Outerwear tagged waterproof. */
  waterproofOuter: number;
  /** Outerwear tagged insulated, or of warmth 4 or more (a wool coat). */
  insulatedOuter: number;
  /** Outerwear tagged windproof. */
  windproofOuter: number;
  shoes: number;
  /** Shoes whose footwearKind is closed (boots, sneakers, derbies...; not loafers, heels or sandals). */
  closedShoes: number;
  /** Shoes of formality smart_casual or above, or loafers, derbies, oxfords, brogues, chelsea boots and the like (unless athletic). */
  smartShoes: number;
  /** Shoes called sneakers or trainers (and the like), or of formality athletic. */
  sneakers: number;
  /** Shoes tagged waterproof. */
  waterproofShoes: number;
  /** Garments (outerwear, tops, bottoms, dresses) of formality athletic; athletic shoes count as sneakers instead. */
  athleticPieces: number;
  /** Outfit pieces (outerwear, tops, bottoms, dresses, shoes) whose dominant colour is neutral. */
  neutralPieces: number;
  /** Tops and dresses among neutralPieces. */
  neutralUpper: number;
  /** Bottoms and dresses among neutralPieces. */
  neutralLower: number;
  /** Outfit pieces whose dominant colour is a neutral darker than DARK_LIGHTNESS: black, charcoal, navy, dark brown, olive. */
  darkNeutralPieces: number;
  /** Tops and dresses among darkNeutralPieces. */
  darkUpper: number;
  /** Bottoms and dresses among darkNeutralPieces. */
  darkLower: number;
  /** Outfit pieces whose dominant colour, neutral or not, is at least LIGHT_LIGHTNESS: white, cream, beige, pale blue, pastels. */
  lightPieces: number;
  /** Tops and dresses among lightPieces. */
  lightUpper: number;
  /** Bottoms and dresses among lightPieces. */
  lightLower: number;
  /** Outfit pieces whose dominant colour is an earth tone (camel, tan, brown, olive, rust, terracotta, muted mustard). */
  earthPieces: number;
  /** Outfit pieces, scarves and hats whose dominant colour is not neutral: a scarf or a beanie is the classic accent. */
  accentPieces: number;
  /** Outfit pieces, scarves and hats with a bold pattern (stripes, checks, florals, prints). */
  patterned: number;
  /** Outfit pieces with a texture pattern (cable, ribbed, herringbone...) or a textured material (wool, tweed, corduroy, suede, leather, denim...). */
  textured: number;
  /** Tops and dresses among textured. */
  texturedUpper: number;
  /** Bottoms, dresses and outerwear among textured: what a textured top plays against (shoes do not count). */
  texturedLowerOrOuter: number;
  hats: number;
  scarves: number;
  gloves: number;
};

/** A neutral with lightness (HSL, 0-1) below this reads dark: navy (0.19), charcoal (0.25), dark brown (0.30), not mid denim (0.37). The colour scorer's threshold. */
export const DARK_LIGHTNESS = DARK_NEUTRAL_LIGHTNESS;

/** A colour with lightness at or above this reads light: white, cream, beige (0.75), light blue (0.78), stone (0.68), khaki (0.67); not mid grey (0.55) or camel (0.59). */
export const LIGHT_LIGHTNESS = 0.65;

/** The pieces an outfit is seen by: what the colour, earth, light, dark and texture counts read. */
const OUTFIT_PIECES: ReadonlySet<ItemCategory> = new Set<ItemCategory>(["outerwear", "top", "bottom", "dress", "shoes"]);

/** Small pieces that carry a colour or a pattern well, counted for accents and patterns only. */
const STATEMENT_EXTRAS: ReadonlySet<ItemCategory> = new Set<ItemCategory>(["scarf", "hat_beanie"]);

/** The garments athleticPieces counts. */
const GARMENTS: ReadonlySet<ItemCategory> = new Set<ItemCategory>(["outerwear", "top", "bottom", "dress"]);

/** Any letters, for compounds: `chino${LETTERS}` takes chinos and Chinohose. */
const LETTERS = String.raw`\p{L}*`;

/**
 * Phrases as one pattern over folded text (foldText): lowercase, accents
 * dropped, every run of other characters one space. Each phrase covers whole
 * words, as layering.ts's keyword tables do. English first, then Italian and
 * German.
 */
function phrases(...list: readonly string[]): RegExp {
  return new RegExp(`(?:^| )(?:${list.join("|")})(?= |$)`, "u");
}

const JEANS = phrases(`jeans${LETTERS}`, "denims?", "jeggings?");

const SMART_BOTTOM_WORDS = phrases(
  `chino${LETTERS}`,
  "trousers?",
  "slacks",
  "(?:dress|suit|tailored|pleated|wool) pants",
  "pencil skirts?",
  "pantalon(?:e|i)",
  "anzughosen?",
  "stoffhosen?",
  "bundfaltenhosen?",
);

/** Words that keep "trousers" from reading smart: track, cargo and rain trousers are not. */
const CASUAL_BOTTOM_WORDS = phrases(
  "track",
  `tracksuit${LETTERS}`,
  "joggers?",
  `jogging${LETTERS}`,
  `sweat${LETTERS}`,
  "cargos?",
  "rain",
  "waterproof",
  "over ?trousers?",
  "skis?",
  "snow",
  "hiking",
  "trekking",
  "running",
  "training",
  "tuta",
  `regen${LETTERS}`,
  `trainings${LETTERS}`,
);

/** "pumps" is left out: in British English it also means canvas gym shoes. */
const SMART_SHOE_WORDS = phrases(
  "loafers?",
  "derby",
  "derbys",
  "derbies",
  "oxfords?",
  "brogues?",
  "chelseas?",
  "monks?",
  "monk ?straps?",
  "dress shoes?",
  "court shoes?",
  "heels?",
  "mocassin[oi]",
  "stringat[ei]",
  "francesin[ei]",
  "budapester",
  "anzugschuhe?",
);

/** Outerwear that is worn as tailoring: a blazer filed as outerwear still makes a tailored look. */
const TAILORED_OUTER_WORDS = phrases("blazers?", "sports? ?coats?", "sports? jackets?", "suit jackets?", "sakkos?");

/**
 * Materials with a visible surface, matched in folded material names
 * ("lambswool", "boiled wool", "bouclé", "stretch denim"). Denim counts, as
 * the prompt and the texture_play brief say.
 */
const TEXTURED_MATERIAL = /wool|tweed|corduroy|(?:^| )cord(?: |$)|cable|suede|leather|mohair|boucle|shearling|velvet|velour|denim/u;

/** The warmth from which unflagged outerwear counts as insulated: the tagging rubric's 4 is a wool coat. */
const INSULATED_WARMTH = 4;

const SMART_RANK = FORMALITIES.indexOf("smart_casual");

function atLeastSmart(formality: Formality | null): boolean {
  return formality !== null && FORMALITIES.indexOf(formality) >= SMART_RANK;
}

function says(item: Pick<StyleItem, "subcategory" | "name">, pattern: RegExp): boolean {
  return pattern.test(foldText(item.subcategory)) || pattern.test(foldText(item.name));
}

function isJeans(item: StyleItem): boolean {
  return says(item, JEANS) || JEANS.test(foldText(item.materials[0] ?? null));
}

function isSmartBottom(item: StyleItem): boolean {
  if (atLeastSmart(item.formality)) return true;
  return item.formality !== "athletic" && says(item, SMART_BOTTOM_WORDS) && !says(item, CASUAL_BOTTOM_WORDS);
}

function isSmartShoe(item: StyleItem): boolean {
  if (atLeastSmart(item.formality)) return true;
  return item.formality !== "athletic" && says(item, SMART_SHOE_WORDS);
}

function isTextured(item: StyleItem): boolean {
  return (
    patternClass(item.pattern) === "texture" ||
    item.materials.some((material) => TEXTURED_MATERIAL.test(foldText(material)))
  );
}

export function emptyWardrobeProfile(): WardrobeProfile {
  return {
    tops: 0,
    tees: 0,
    shirts: 0,
    knits: 0,
    sweats: 0,
    tailored: 0,
    dresses: 0,
    bottoms: 0,
    jeans: 0,
    smartBottoms: 0,
    outerwear: 0,
    waterproofOuter: 0,
    insulatedOuter: 0,
    windproofOuter: 0,
    shoes: 0,
    closedShoes: 0,
    smartShoes: 0,
    sneakers: 0,
    waterproofShoes: 0,
    athleticPieces: 0,
    neutralPieces: 0,
    neutralUpper: 0,
    neutralLower: 0,
    darkNeutralPieces: 0,
    darkUpper: 0,
    darkLower: 0,
    lightPieces: 0,
    lightUpper: 0,
    lightLower: 0,
    earthPieces: 0,
    accentPieces: 0,
    patterned: 0,
    textured: 0,
    texturedUpper: 0,
    texturedLowerOrOuter: 0,
    hats: 0,
    scarves: 0,
    gloves: 0,
  };
}

type CountField = keyof WardrobeProfile;

/** The count each category adds to, item for item. */
const CATEGORY_FIELD: Readonly<Partial<Record<ItemCategory, CountField>>> = {
  top: "tops",
  dress: "dresses",
  bottom: "bottoms",
  outerwear: "outerwear",
  shoes: "shoes",
  hat_beanie: "hats",
  scarf: "scarves",
  gloves: "gloves",
};

/** The count each top kind adds to; unknown kinds add to none. */
const TOP_KIND_FIELD: Readonly<Partial<Record<TopKind, CountField>>> = {
  tee: "tees",
  shirt: "shirts",
  knit: "knits",
  sweat: "sweats",
  tailored: "tailored",
};

/** The finer counts of a category: which fields one item adds to. */
const DETAIL_FIELDS: Readonly<Partial<Record<ItemCategory, (item: StyleItem) => (CountField | null)[]>>> = {
  top: (item) => [TOP_KIND_FIELD[topKind(item)] ?? null],
  bottom: (item) => [isJeans(item) ? "jeans" : null, isSmartBottom(item) ? "smartBottoms" : null],
  outerwear: (item) => [
    item.waterproof === true ? "waterproofOuter" : null,
    item.insulated === true || (item.warmthLevel ?? 0) >= INSULATED_WARMTH ? "insulatedOuter" : null,
    item.windproof === true ? "windproofOuter" : null,
    says(item, TAILORED_OUTER_WORDS) ? "tailored" : null,
  ],
  shoes: (item) => [
    footwearKind(item) === "closed" ? "closedShoes" : null,
    isSmartShoe(item) ? "smartShoes" : null,
    item.formality === "athletic" || isSneaker(item) ? "sneakers" : null,
    item.waterproof === true ? "waterproofShoes" : null,
  ],
};

/** The pieces the Upper counts take: tops (in either top slot) and dresses. */
const UPPER: ReadonlySet<ItemCategory> = new Set<ItemCategory>(["top", "dress"]);
/** The pieces the Lower counts take: bottoms and dresses. */
const LOWER: ReadonlySet<ItemCategory> = new Set<ItemCategory>(["bottom", "dress"]);
/** What a textured top plays against: bottoms, dresses and outerwear. */
const LOWER_OR_OUTER: ReadonlySet<ItemCategory> = new Set<ItemCategory>(["bottom", "dress", "outerwear"]);

/** A total and its Upper and Lower parts, with the categories the Lower part takes. */
type SplitCount = { total: CountField; upper: CountField; lower: CountField; lowerTakes: ReadonlySet<ItemCategory> };

const NEUTRAL_COUNT: SplitCount = { total: "neutralPieces", upper: "neutralUpper", lower: "neutralLower", lowerTakes: LOWER };
const DARK_COUNT: SplitCount = { total: "darkNeutralPieces", upper: "darkUpper", lower: "darkLower", lowerTakes: LOWER };
const LIGHT_COUNT: SplitCount = { total: "lightPieces", upper: "lightUpper", lower: "lightLower", lowerTakes: LOWER };
const TEXTURED_COUNT: SplitCount = {
  total: "textured",
  upper: "texturedUpper",
  lower: "texturedLowerOrOuter",
  lowerTakes: LOWER_OR_OUTER,
};

/** Adds one to the count's total, and to its Upper and Lower parts when the item is such a piece. */
function countSplit(profile: WardrobeProfile, item: StyleItem, count: SplitCount): void {
  profile[count.total] += 1;
  if (UPPER.has(item.category)) profile[count.upper] += 1;
  if (count.lowerTakes.has(item.category)) profile[count.lower] += 1;
}

/** Categories, top kinds, and the finer bottom, outerwear and shoe counts. */
function countPiece(profile: WardrobeProfile, item: StyleItem): void {
  const fields = [CATEGORY_FIELD[item.category] ?? null, ...(DETAIL_FIELDS[item.category]?.(item) ?? [])];
  if (GARMENTS.has(item.category) && item.formality === "athletic") fields.push("athleticPieces");
  for (const field of fields) {
    if (field !== null) profile[field] += 1;
  }
}

/** Colours, patterns and textures, from the dominant colour (itemColors) and the pattern and material tags. */
function countLook(profile: WardrobeProfile, item: StyleItem): void {
  const piece = OUTFIT_PIECES.has(item.category);
  if (!piece && !STATEMENT_EXTRAS.has(item.category)) return;
  const [dominant] = itemColors(item);
  if (dominant !== undefined && !dominant.neutral) profile.accentPieces += 1;
  if (patternClass(item.pattern) === "bold") profile.patterned += 1;
  if (!piece) return;
  if (isTextured(item)) countSplit(profile, item, TEXTURED_COUNT);
  if (dominant === undefined) return;
  if (dominant.neutral) countSplit(profile, item, NEUTRAL_COUNT);
  if (dominant.neutral && dominant.lightness < DARK_LIGHTNESS) countSplit(profile, item, DARK_COUNT);
  if (dominant.lightness >= LIGHT_LIGHTNESS) countSplit(profile, item, LIGHT_COUNT);
  if (dominant.earth) profile.earthPieces += 1;
}

/**
 * The wardrobe's profile: see WardrobeProfile for what each count reads.
 * Socks, base layers, accessories, bags and other items count nowhere.
 */
export function wardrobeProfile(items: Iterable<StyleItem>): WardrobeProfile {
  const profile = emptyWardrobeProfile();
  for (const item of items) {
    countPiece(profile, item);
    countLook(profile, item);
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Feasibility
// ---------------------------------------------------------------------------

/** The thresholds the direction rules read. Temperatures are the feels-like (apparent) ones, °C. */
export const DIRECTION_THRESHOLDS = {
  /** Neutral pieces for a tonal outfit: top, bottom, and outerwear or shoes. */
  tonalNeutralPieces: 4,
  darkNeutralPieces: 3,
  lightPieces: 2,
  /** Below this mean, light and airy is out: pale linen-weight dressing on a cold day reads wrong. */
  lightMinC: 12,
  /** From this mean, light and airy is favoured. */
  lightFavouredFromC: 20,
  /** Neutrals for an accent to sit against. */
  accentNeutralPieces: 3,
  /** Above this mean, a knit over a tee or shirt is too warm. */
  knitMaxC: 18,
  /** Knit layers are favoured between these means, inclusive. */
  knitFavouredC: [5, 15] as const,
  earthPieces: 3,
  texturedPieces: 3,
  /** Neutrals for one bold pattern to sit against. */
  patternNeutralPieces: 2,
  /** From these gusts (km/h) the day is windy: weather.ts's threshold. */
  gustKmh: WEATHER_THRESHOLDS.gustKmh,
  /** At or below this minimum the day is freezing. */
  freezingMinC: 0,
  /** At or below this mean, cosy winter is feasible (with a knit or a warm coat) and favoured. */
  cosyMaxC: 5,
} as const;

const T = DIRECTION_THRESHOLDS;

/** What the rules read from the weather. */
type Day = {
  meanC: number;
  /** isRainyDay. */
  rainy: boolean;
  /** Gusts from T.gustKmh. */
  windy: boolean;
  /** A minimum at or below T.freezingMinC. */
  freezing: boolean;
  /** Rainy, windy or freezing. */
  rough: boolean;
};

function dayOf(weather: WeatherSnapshot): Day {
  const rainy = isRainyDay(weather);
  const windy = weather.windGustMaxKmh >= T.gustKmh;
  const freezing = weather.apparentMinC <= T.freezingMinC;
  return {
    meanC: (weather.apparentMinC + weather.apparentMaxC) / 2,
    rainy,
    windy,
    freezing,
    rough: rainy || windy || freezing,
  };
}

/**
 * Whether the wardrobe has gear for the day's roughest weather: rain needs
 * what keepsDry needs, waterproof outerwear or waterproof shoes with some
 * outerwear to go over them; frost (without rain) insulated outerwear; wind
 * alone windproof or waterproof outerwear. A calm, dry, mild day has nothing
 * to be ready for.
 */
function hasGearFor(p: WardrobeProfile, day: Day): boolean {
  if (day.rainy) return p.waterproofOuter >= 1 || (p.waterproofShoes >= 1 && p.outerwear >= 1);
  if (day.freezing) return p.insulatedOuter >= 1;
  if (day.windy) return p.windproofOuter + p.waterproofOuter >= 1;
  return false;
}

type Rule = (profile: WardrobeProfile, day: Day) => boolean;

/**
 * Whether the wardrobe can build each direction today. Generous but honest:
 * each rule asks for the pieces the look cannot do without, and the dress-or-
 * top-and-bottom check (canDress) comes first. A palette or texture look also
 * needs a top or dress and a bottom or dress of its own (the Upper and Lower
 * counts), so shoes alone never make one.
 */
const RULES: Readonly<Record<DirectionKey, Rule>> = {
  /** Enough neutrals for a top, a bottom and outerwear or shoes in one quiet palette. */
  tonal_neutrals: (p) => p.neutralPieces >= T.tonalNeutralPieces && p.neutralUpper >= 1 && p.neutralLower >= 1,
  /** Black, charcoal, navy or dark brown from top to toe. */
  dark_monochrome: (p) => p.darkNeutralPieces >= T.darkNeutralPieces && p.darkUpper >= 1 && p.darkLower >= 1,
  /** Pale pieces, top and bottom, on a day mild enough for them. */
  light_and_airy: (p, day) =>
    p.lightPieces >= T.lightPieces && p.lightUpper >= 1 && p.lightLower >= 1 && day.meanC >= T.lightMinC,
  /** Neutrals plus one piece of colour. */
  neutral_with_accent: (p) => p.accentPieces >= 1 && p.neutralPieces >= T.accentNeutralPieces,
  /** A button shirt with trousers or chinos. */
  smart_collar: (p) => p.shirts >= 1 && p.smartBottoms >= 1,
  /** A knit over a tee or shirt, on a day cool enough for two layers. */
  knit_layers: (p, day) => p.knits >= 1 && p.tees + p.shirts >= 1 && day.meanC <= T.knitMaxC,
  /** Jeans dressed up: a shirt, knit or blazer, and proper shoes. */
  elevated_denim: (p) => p.jeans >= 1 && p.shirts + p.knits + p.tailored >= 1 && p.smartShoes + p.closedShoes >= 1,
  /** Camel, brown, olive, rust. */
  earth_tones: (p) => p.earthPieces >= T.earthPieces,
  /** A collar under a knit, with smart trousers. */
  preppy_layers: (p) => p.shirts >= 1 && p.knits >= 1 && p.smartBottoms >= 1,
  /** A sweat or athletic piece kept clean, with sneakers. */
  sporty_clean: (p) => p.sneakers >= 1 && p.sweats + p.athleticPieces >= 1,
  /**
   * Wool, tweed, corduroy, suede, leather, denim, cable and rib together: a textured
   * top or dress against a textured bottom, dress or coat (shoes add to the
   * total but never make the look alone).
   */
  texture_play: (p) => p.textured >= T.texturedPieces && p.texturedUpper >= 1 && p.texturedLowerOrOuter >= 1,
  /** A blazer with smart trousers and smart shoes. */
  sharp_tailoring: (p) => p.tailored >= 1 && p.smartBottoms >= 1 && p.smartShoes >= 1,
  /** One bold pattern against neutrals. */
  pattern_anchor: (p) => p.patterned >= 1 && p.neutralPieces >= T.patternNeutralPieces,
  /** Rain, wind or frost, and gear for it (hasGearFor). */
  weather_ready: (p, day) => hasGearFor(p, day),
  /** A cold day, and a knit or a warm coat. */
  cosy_winter: (p, day) => day.meanC <= T.cosyMaxC && p.knits + p.insulatedOuter >= 1,
  /** A dress as the centre of the outfit. */
  dress_led: (p) => p.dresses >= 1,
  /** Always possible. */
  classic_balanced: () => true,
};

/** Every outfit needs a top and a bottom, or a dress. */
function canDress(profile: WardrobeProfile): boolean {
  return (profile.tops >= 1 && profile.bottoms >= 1) || profile.dresses >= 1;
}

/**
 * The directions the wardrobe and today's weather support, in DIRECTION_KEYS
 * order; FALLBACK_DIRECTION is always among them. A wardrobe that cannot make
 * an outfit at all (canDress) supports the fallback only.
 */
export function feasibleDirections(profile: WardrobeProfile, weather: WeatherSnapshot): DirectionKey[] {
  if (!canDress(profile)) return [FALLBACK_DIRECTION];
  const day = dayOf(weather);
  return DIRECTION_KEYS.filter((key) => RULES[key](profile, day));
}

// ---------------------------------------------------------------------------
// Weights and assignment
// ---------------------------------------------------------------------------

/** How likely a feasible direction is drawn, relative to the others. */
export const DIRECTION_WEIGHTS = {
  base: 1,
  /** Multiplier when today's weather suits the direction (weatherFavoured). */
  weatherFavoured: 2,
  /** Multiplier per use in today's suggestions (ageDays 0). */
  usedToday: 0.2,
  /** Multiplier per use in yesterday's suggestions (ageDays 1). */
  usedYesterday: 0.5,
  /** The recency multipliers together never go below this. */
  minRecency: 0.05,
} as const;

/**
 * Whether today's weather favours a direction: weather_ready on a rainy,
 * windy or freezing day, cosy_winter at a mean of T.cosyMaxC or less,
 * light_and_airy from T.lightFavouredFromC, knit_layers within T.knitFavouredC.
 */
export function weatherFavoured(key: DirectionKey, weather: WeatherSnapshot): boolean {
  const day = dayOf(weather);
  switch (key) {
    case "weather_ready":
      return day.rough;
    case "cosy_winter":
      return day.meanC <= T.cosyMaxC;
    case "light_and_airy":
      return day.meanC >= T.lightFavouredFromC;
    case "knit_layers":
      return day.meanC >= T.knitFavouredC[0] && day.meanC <= T.knitFavouredC[1];
    default:
      return false;
  }
}

/**
 * The recency multiplier: DIRECTION_WEIGHTS.usedToday per use today (ageDays
 * 0 or less), usedYesterday per use yesterday, nothing for older uses; the
 * product is floored at minRecency. Unknown keys in `recent` are ignored.
 */
function recencyFactor(key: DirectionKey, recent: VarietyHistory["recentDirections"]): number {
  let factor = 1;
  for (const entry of recent) {
    if (entry.key !== key) continue;
    if (entry.ageDays <= 0) factor *= DIRECTION_WEIGHTS.usedToday;
    else if (entry.ageDays === 1) factor *= DIRECTION_WEIGHTS.usedYesterday;
  }
  return Math.max(DIRECTION_WEIGHTS.minRecency, factor);
}

/** A direction's draw weight: base, times weatherFavoured when it applies, times the recency multiplier. */
export function directionWeight(
  key: DirectionKey,
  weather: WeatherSnapshot,
  recent: VarietyHistory["recentDirections"],
): number {
  const favoured = weatherFavoured(key, weather) ? DIRECTION_WEIGHTS.weatherFavoured : 1;
  return DIRECTION_WEIGHTS.base * favoured * recencyFactor(key, recent);
}

type Weighted = { key: DirectionKey; weight: number };

/** The index `u` (in [0, 1)) lands on when the pool's weights are laid end to end. */
function weightedIndex(pool: readonly Weighted[], u: number): number {
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
  let target = u * total;
  for (let index = 0; index < pool.length; index += 1) {
    target -= pool[index].weight;
    if (target < 0) return index;
  }
  return pool.length - 1;
}

export type AssignDirectionsInput = {
  profile: WardrobeProfile;
  weather: WeatherSnapshot;
  /** seedFrom of the day, the home city and the run index, so "Suggest again" rotates. */
  seed: number;
  recent: VarietyHistory["recentDirections"];
  /** How many candidates to assign a direction to. */
  count: number;
};

/**
 * One direction per candidate, `count` of them (floored; none for a count
 * that is not a positive finite number). The candidates are the feasible
 * directions except the fallback, drawn by seeded weighted sampling without
 * replacement (seededRandom(seed), directionWeight), so the draw order is the
 * result's order. When fewer than `count` are feasible, every one of them is
 * drawn, then FALLBACK_DIRECTION is added, and if still short the drawn keys
 * repeat, highest weight first (ties in DIRECTION_KEYS order), cycling: keys
 * are distinct while enough exist, and the result always has `count` keys.
 * The same input gives the same output.
 */
export function assignDirections(input: AssignDirectionsInput): DirectionKey[] {
  const { profile, weather, seed, recent } = input;
  const count = Number.isFinite(input.count) ? Math.max(0, Math.floor(input.count)) : 0;
  if (count === 0) return [];

  const pool: Weighted[] = feasibleDirections(profile, weather)
    .filter((key) => key !== FALLBACK_DIRECTION)
    .map((key) => ({ key, weight: directionWeight(key, weather, recent) }));
  const random = seededRandom(seed);
  const chosen: DirectionKey[] = [];
  while (chosen.length < count && pool.length > 0) {
    const [picked] = pool.splice(weightedIndex(pool, random()), 1);
    chosen.push(picked.key);
  }
  if (chosen.length === count) return chosen;

  chosen.push(FALLBACK_DIRECTION);
  const repeats = chosen
    .map((key) => ({ key, weight: directionWeight(key, weather, recent) }))
    .sort((a, b) => b.weight - a.weight || DIRECTION_KEYS.indexOf(a.key) - DIRECTION_KEYS.indexOf(b.key));
  const missing = count - chosen.length;
  for (let index = 0; index < missing; index += 1) {
    chosen.push(repeats[index % repeats.length].key);
  }
  return chosen;
}
