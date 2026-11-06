// Colour and pattern knowledge for the outfit scorer (D-256). Reads an item's
// colour tags as hue, saturation and lightness, decides which colours behave
// as neutrals, and judges how an outfit's palette and patterns sit together.
// Pure and client-safe, so the scorer, the UI and the tests share one set of
// rules.
//
// Hue relationships are measured on the painter's (red-yellow-blue) colour
// wheel, not the screen's RGB one: the pairs fashion calls complementary
// (red/green, blue/orange, yellow/purple) sit opposite each other there,
// while RGB puts red opposite cyan and green opposite magenta.

import type { StyleItem } from "./types";

// ---------------------------------------------------------------------------
// Colour info
// ---------------------------------------------------------------------------

export type ColorInfo = {
  /** Normalised lowercase name when one was given ("gray" reads "grey"). */
  name: string | null;
  /** 0-360 (HSL), null for achromatic colours. */
  hue: number | null;
  /** 0-1 (HSL). */
  saturation: number;
  /** 0-1 (HSL). */
  lightness: number;
  /** Goes with anything: black, white, greys, navy, denim, beige/camel/khaki/stone/cream/brown/tan/taupe, olive. */
  neutral: boolean;
  /** Warm, muted naturals: beige, camel, khaki, tan, brown, rust, olive, terracotta, muted mustard. */
  earth: boolean;
  /** 0-11 position on the 12-step painter's wheel (0 red, 2 orange, 4 yellow, 6 green, 8 blue, 10 violet) for non-neutral colours; null when neutral. */
  family: number | null;
};

type Rgb = { r: number; g: number; b: number };
type Hsl = { hue: number | null; saturation: number; lightness: number };

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#1f2a44" as 0-255 channels; also accepts upper case, a missing "#" and the 3-digit short form. */
export function parseHex(hex: string): Rgb | null {
  const match = HEX_PATTERN.exec(hex.trim());
  if (match === null) return null;
  let digits = match[1];
  if (digits.length === 3) digits = [...digits].map((digit) => digit + digit).join("");
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  const lightness = (max + min) / 2;
  if (chroma === 0) return { hue: null, saturation: 0, lightness };
  const saturation = Math.min(1, chroma / (1 - Math.abs(2 * lightness - 1)));
  let sector: number;
  if (max === red) sector = (green - blue) / chroma;
  else if (max === green) sector = (blue - red) / chroma + 2;
  else sector = (red - green) / chroma + 4;
  return { hue: (sector * 60 + 360) % 360, saturation, lightness };
}

/** HSL chroma, 0-1: how far from grey a colour really is. HSL saturation exaggerates it near black and white. */
function chromaOf(saturation: number, lightness: number): number {
  return (1 - Math.abs(2 * lightness - 1)) * saturation;
}

/** HSV value, 0-1: the brightest channel. Separates muted mustard and rust from bright yellow and orange. */
function valueOf(saturation: number, lightness: number): number {
  return lightness + saturation * Math.min(lightness, 1 - lightness);
}

// Below this chroma (about 5 of 255 between the strongest and weakest
// channel) a colour has no meaningful hue: photo noise on a grey garment.
const ACHROMATIC_CHROMA = 0.02;

// Greys: low HSL saturation, or low chroma, which also catches the tinted
// near-blacks and near-whites whose HSL saturation runs high (charcoal with a
// blue cast, a barely-there blush). Very dark and very light colours read as
// black and white whatever their hue.
const GREY_SATURATION = 0.15;
const GREY_CHROMA = 0.1;
const NEAR_BLACK = 0.15;
const NEAR_WHITE = 0.92;

// Navy, indigo and denim behave as neutrals. Very dark blues read navy even
// when strongly saturated (#000080); mid-dark ones only when muted, so a clear
// cobalt or royal blue stays a colour; washed denim and chambray stay neutral
// up to a fairly light wash while staying greyish.
const BLUE_HUE: readonly [number, number] = [195, 255];
const NAVY_LIGHTNESS = 0.3;
const MID_BLUE_LIGHTNESS = 0.45;
const MID_BLUE_SATURATION = 0.5;
const WASHED_BLUE_LIGHTNESS = 0.7;
const WASHED_BLUE_SATURATION = 0.4;

// Beige, camel, khaki, tan, cream, cognac and brown: warm hues of limited
// chroma. Chroma rather than saturation, because cream and dark leather
// browns have high HSL saturation yet read as quiet naturals; the saturation
// cap keeps peach and bright tangerine out, except in the dark browns.
const WARM_HUE: readonly [number, number] = [15, 62];
const WARM_CHROMA = 0.5;
const WARM_SATURATION = 0.8;
const DARK_BROWN_LIGHTNESS = 0.3;

// Olive and army green: yellow-greens that are muted and dark, or very dark
// whatever their saturation (#808000).
const OLIVE_HUE: readonly [number, number] = [55, 100];
const OLIVE_SATURATION = 0.5;
const OLIVE_LIGHTNESS = 0.5;
const DARK_OLIVE_LIGHTNESS = 0.3;

// Earth tones: warm neutrals between near-black and pale cream (cream and
// ivory are too pale to read earthy), olive, and the saturated warm naturals
// (rust, terracotta, burnt orange, muted mustard): red-orange to yellow hues,
// mid lightness, not bright. Pure reds sit below the hue range, bright orange
// and yellow above the value cap.
const EARTH_NEUTRAL_LIGHTNESS: readonly [number, number] = [0.2, 0.85];
const EARTH_HUE: readonly [number, number] = [10, 65];
const EARTH_LIGHTNESS: readonly [number, number] = [0.2, 0.6];
const EARTH_MAX_VALUE = 0.85;

type NeutralKind = "grey" | "blue" | "warm" | "olive";

function within(value: number, [low, high]: readonly [number, number]): boolean {
  return value >= low && value <= high;
}

/** Which kind of neutral a colour is, or null for a colour that counts as a hue of its own. */
function neutralKind(hue: number | null, saturation: number, lightness: number): NeutralKind | null {
  const chroma = chromaOf(saturation, lightness);
  if (
    hue === null ||
    saturation < GREY_SATURATION ||
    chroma < GREY_CHROMA ||
    lightness < NEAR_BLACK ||
    lightness > NEAR_WHITE
  ) {
    return "grey";
  }
  if (
    within(hue, BLUE_HUE) &&
    (lightness < NAVY_LIGHTNESS ||
      (lightness < MID_BLUE_LIGHTNESS && saturation <= MID_BLUE_SATURATION) ||
      (lightness <= WASHED_BLUE_LIGHTNESS && saturation < WASHED_BLUE_SATURATION))
  ) {
    return "blue";
  }
  if (
    within(hue, WARM_HUE) &&
    chroma <= WARM_CHROMA &&
    (saturation <= WARM_SATURATION || lightness < DARK_BROWN_LIGHTNESS)
  ) {
    return "warm";
  }
  if (
    within(hue, OLIVE_HUE) &&
    ((saturation < OLIVE_SATURATION && lightness < OLIVE_LIGHTNESS) || lightness < DARK_OLIVE_LIGHTNESS)
  ) {
    return "olive";
  }
  return null;
}

function isEarth(kind: NeutralKind | null, hue: number | null, saturation: number, lightness: number): boolean {
  if (kind === "olive") return true;
  if (kind === "warm") return within(lightness, EARTH_NEUTRAL_LIGHTNESS);
  if (kind !== null || hue === null) return false;
  return (
    within(hue, EARTH_HUE) &&
    within(lightness, EARTH_LIGHTNESS) &&
    valueOf(saturation, lightness) <= EARTH_MAX_VALUE
  );
}

// RGB hue -> painter's wheel hue, piecewise linear. RGB crowds red, orange and
// yellow into 60 degrees and spreads green and cyan over 120; the painter's
// wheel gives each of red, orange, yellow, green, blue and violet about 60.
const RYB_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 0], // red
  [30, 60], // orange
  [60, 120], // yellow
  [120, 180], // green
  [240, 240], // blue
  [280, 300], // violet
  [360, 360], // back to red
];

function rybHue(hue: number): number {
  const h = ((hue % 360) + 360) % 360;
  for (let i = 1; i < RYB_ANCHORS.length; i += 1) {
    const [rgbEnd, rybEnd] = RYB_ANCHORS[i];
    if (h <= rgbEnd) {
      const [rgbStart, rybStart] = RYB_ANCHORS[i - 1];
      return (rybStart + ((h - rgbStart) / (rgbEnd - rgbStart)) * (rybEnd - rybStart)) % 360;
    }
  }
  return 0;
}

/** 30-degree steps centred on red, so red is one family instead of straddling 0/360. */
function hueFamily(hue: number): number {
  return Math.floor(((rybHue(hue) + 15) % 360) / 30);
}

function toColorInfo(name: string | null, { hue, saturation, lightness }: Hsl): ColorInfo {
  const chromatic = hue !== null && chromaOf(saturation, lightness) >= ACHROMATIC_CHROMA ? hue : null;
  const kind = neutralKind(chromatic, saturation, lightness);
  const neutral = kind !== null;
  return {
    name,
    hue: chromatic,
    saturation,
    lightness,
    neutral,
    earth: isEarth(kind, chromatic, saturation, lightness),
    family: neutral || chromatic === null ? null : hueFamily(chromatic),
  };
}

// ---------------------------------------------------------------------------
// Colour names
// ---------------------------------------------------------------------------

// Common clothing colour names and a representative hex for each, used when
// an item has a name but no usable hex (hand-entered items, older tags).
const NAMED_COLOR_HEX: Readonly<Record<string, string>> = {
  // Blacks, whites and greys
  black: "#111111",
  white: "#f5f5f2",
  "off white": "#f2efe6",
  ivory: "#f6f1e1",
  cream: "#f3ead8",
  ecru: "#ece3cf",
  bone: "#e3dac9",
  natural: "#e9e0cc",
  grey: "#8a8d91",
  "light grey": "#c8c9cb",
  "dark grey": "#4a4c4f",
  charcoal: "#3b3e42",
  "charcoal grey": "#3b3e42",
  "heather grey": "#a7a9ac",
  silver: "#c0c0c0",
  slate: "#5a6470",
  stone: "#b9b1a3",
  taupe: "#8b7d6b",
  // Blues
  navy: "#1f2a44",
  "navy blue": "#1f2a44",
  "midnight blue": "#1c2340",
  indigo: "#2e3a6e",
  denim: "#3d5a80",
  "light denim": "#8fa9c9",
  chambray: "#8ea4c2",
  blue: "#2f5d9e",
  "light blue": "#a7c7e7",
  "sky blue": "#87ceeb",
  "baby blue": "#bcd4e6",
  "powder blue": "#b0c4de",
  "royal blue": "#4169e1",
  cobalt: "#0047ab",
  "cobalt blue": "#0047ab",
  petrol: "#1d5c6b",
  teal: "#1c6e6e",
  turquoise: "#3fc1c0",
  aqua: "#7fd6d0",
  // Greens
  mint: "#a8e6cf",
  sage: "#9caf88",
  olive: "#556b2f",
  "olive green": "#556b2f",
  "army green": "#4b5320",
  "military green": "#4b5320",
  "forest green": "#228b22",
  "bottle green": "#12543a",
  "hunter green": "#355e3b",
  emerald: "#1e8f5e",
  green: "#2e7d4f",
  lime: "#9acd32",
  // Warm neutrals and browns
  beige: "#d8c3a5",
  oatmeal: "#d9cdb8",
  sand: "#c2b280",
  khaki: "#c3b091",
  nude: "#e3bc9a",
  camel: "#c19a6b",
  tan: "#d2b48c",
  cognac: "#9a5b2c",
  brown: "#6b4a2f",
  mocha: "#6f4e37",
  chocolate: "#4a2c1d",
  // Earth reds and oranges
  rust: "#b7410e",
  terracotta: "#c35a3b",
  brick: "#a0412d",
  "burnt orange": "#c0581f",
  copper: "#b87333",
  ochre: "#c8952c",
  mustard: "#c9a227",
  // Reds and pinks
  red: "#b3261e",
  burgundy: "#6d1a2b",
  wine: "#722f37",
  maroon: "#6e1e24",
  oxblood: "#4a0f15",
  pink: "#e8a0b4",
  "hot pink": "#e75480",
  fuchsia: "#c2185b",
  blush: "#f0d5dc",
  "dusty pink": "#d4a5a5",
  rose: "#c77d8e",
  coral: "#f0805e",
  salmon: "#f4a08c",
  peach: "#f5c6a5",
  // Oranges and yellows
  orange: "#f28c28",
  gold: "#d4af37",
  yellow: "#e3b505",
  // Purples
  lilac: "#b19cd9",
  lavender: "#b57edc",
  mauve: "#b784a7",
  purple: "#6a3d9a",
  violet: "#7f4fc9",
  plum: "#8e4585",
  aubergine: "#3d1f3a",
};

// A Map, so a name such as "constructor" never reaches Object.prototype.
const NAMED_COLORS: ReadonlyMap<string, string> = new Map(Object.entries(NAMED_COLOR_HEX));

// Leading words that shift a known colour: "dark green", "pale pink",
// "dusty blue". Rough by design; the AI tags carry a hex, names are the fallback.
const MODIFIERS: ReadonlyMap<string, (color: Hsl) => Hsl> = new Map<string, (color: Hsl) => Hsl>([
  ["dark", (color) => ({ ...color, lightness: color.lightness * 0.6 })],
  ["deep", (color) => ({ ...color, lightness: color.lightness * 0.6 })],
  ["light", (color) => ({ ...color, lightness: color.lightness + (1 - color.lightness) * 0.45 })],
  ["pale", (color) => ({ ...color, lightness: color.lightness + (1 - color.lightness) * 0.45 })],
  ["bright", (color) => ({ ...color, saturation: Math.min(1, color.saturation + 0.25) })],
  ["vivid", (color) => ({ ...color, saturation: Math.min(1, color.saturation + 0.25) })],
  ["muted", (color) => ({ ...color, saturation: color.saturation * 0.6 })],
  ["dusty", (color) => ({ ...color, saturation: color.saturation * 0.6 })],
  ["soft", (color) => ({ ...color, saturation: color.saturation * 0.6 })],
  ["faded", (color) => ({ ...color, saturation: color.saturation * 0.6 })],
  ["washed", (color) => ({ ...color, saturation: color.saturation * 0.6 })],
  ["mid", (color) => color],
  ["medium", (color) => color],
]);

/** Lowercase, accents and hyphens dropped, single spaces, "gray" spelled "grey". */
function normaliseText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\bgray\b/g, "grey")
    .replace(/\s+/g, " ")
    .trim();
}

function hslOfHex(hex: string): Hsl | null {
  const rgb = parseHex(hex);
  return rgb === null ? null : rgbToHsl(rgb);
}

// Neutral colour names a tag can carry, by the kind of neutral each names. A
// photo can make a navy coat read royal blue, or a camel one orange: when the
// hex says "colour" but its hue sits in the named neutral's range, the name is
// trusted (namedNeutral).
const NEUTRAL_NAME_KIND: ReadonlyMap<string, NeutralKind> = new Map<string, NeutralKind>([
  ["navy", "blue"],
  ["denim", "blue"],
  ["indigo", "blue"],
  ["charcoal", "grey"],
  ["black", "grey"],
  ["grey", "grey"],
  ["white", "grey"],
  ["cream", "warm"],
  ["beige", "warm"],
  ["camel", "warm"],
  ["khaki", "warm"],
  ["brown", "warm"],
  ["tan", "warm"],
  ["stone", "warm"],
  ["olive", "olive"],
]);

// The hues (HSL degrees) a hex may have and still be the named neutral: a
// little wider than the ranges neutralKind reads by hex alone, since the name
// already says which neutral it is.
const NAMED_HUE: Readonly<Record<Exclude<NeutralKind, "grey">, readonly [number, number]>> = {
  blue: [190, 265],
  warm: [10, 65],
  olive: [50, 110],
};
// Black, white, greys and charcoal have no hue of their own: a hex agrees with
// them while it stays muted, a tinted grey rather than a clear colour.
const NAMED_GREY_MAX_CHROMA = 0.25;

/** The kind of the last neutral word in a colour name ("navy blue" -> blue, "blue grey" -> grey), or null. */
function neutralNameKind(name: string): NeutralKind | null {
  const words = name.split(" ");
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const kind = NEUTRAL_NAME_KIND.get(words[index]);
    if (kind !== undefined) return kind;
  }
  return null;
}

/** Whether a hex reading fits a neutral of `kind`: its hue in NAMED_HUE, or muted for the greys. */
function hexFitsNeutral(kind: NeutralKind, { hue, saturation, lightness }: Hsl): boolean {
  if (kind === "grey") return chromaOf(saturation, lightness) <= NAMED_GREY_MAX_CHROMA;
  return hue !== null && within(hue, NAMED_HUE[kind]);
}

/**
 * The tag as the neutral its name says, keeping the hex's hue and lightness,
 * when the hex alone would read as a colour of the same family; null when the
 * name names no neutral or the hex disagrees with it ("navy" on a red hex).
 */
function namedNeutral(label: string, hsl: Hsl): ColorInfo | null {
  const first = firstColorName(label);
  const kind = first === undefined ? null : neutralNameKind(first);
  if (kind === null || !hexFitsNeutral(kind, hsl)) return null;
  const hue = hsl.hue !== null && chromaOf(hsl.saturation, hsl.lightness) >= ACHROMATIC_CHROMA ? hsl.hue : null;
  return {
    name: label,
    hue,
    saturation: hsl.saturation,
    lightness: hsl.lightness,
    neutral: true,
    earth: isEarth(kind, hue, hsl.saturation, hsl.lightness),
    family: null,
  };
}

/** "navy/white", "black and white": the first colour named, the dominant one. */
function firstColorName(label: string): string | undefined {
  return label.split(/\s*(?:\/|&|,|\band\b)\s*/).find((part) => part !== "");
}

/**
 * A normalised name as HSL: the exact name, then a modifier plus a known
 * colour ("dark green"), then the longest known ending ("petrol blue" ->
 * "blue"), then any known word from the right ("grey marl" -> "grey").
 */
function resolveName(name: string): Hsl | null {
  const exact = NAMED_COLORS.get(name);
  if (exact !== undefined) return hslOfHex(exact);
  const words = name.split(" ");
  const modifier = MODIFIERS.get(words[0]);
  if (modifier !== undefined && words.length > 1) {
    const base = resolveName(words.slice(1).join(" "));
    if (base !== null) return modifier(base);
  }
  for (let start = 1; start < words.length; start += 1) {
    const tail = NAMED_COLORS.get(words.slice(start).join(" "));
    if (tail !== undefined) return hslOfHex(tail);
  }
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = NAMED_COLORS.get(words[index]);
    if (word !== undefined) return hslOfHex(word);
  }
  return null;
}

/**
 * What a colour tag means: the hex wins when valid (it is the more precise
 * reading of the photo), else the name dictionary; null when neither is usable.
 * One exception: a neutral name (navy, denim, charcoal, camel, olive...) wins
 * over a hex that would read as a colour when the hex's hue agrees with it
 * (namedNeutral), so a navy photographed bright stays navy. A hex that
 * disagrees ("navy" on a red hex) still wins.
 */
export function colorInfo(name: string | null, hex: string | null): ColorInfo | null {
  const normalised = name === null ? "" : normaliseText(name);
  const label = normalised === "" ? null : normalised;
  const rgb = hex === null ? null : parseHex(hex);
  if (rgb !== null) {
    const hsl = rgbToHsl(rgb);
    const fromHex = toColorInfo(label, hsl);
    if (fromHex.neutral || label === null) return fromHex;
    return namedNeutral(label, hsl) ?? fromHex;
  }
  if (label === null) return null;
  const first = firstColorName(label);
  const hsl = first === undefined ? null : resolveName(first);
  return hsl === null ? null : toColorInfo(label, hsl);
}

/** An outfit's palette is set by each piece's main colours; the third and fourth are details. */
const ITEM_COLOR_LIMIT = 2;

/**
 * An item's usable colours, dominant first, at most two. Pairs colors[i] with
 * colorHex[i]; a position with neither a known name nor a valid hex is
 * skipped, so the next usable colour moves up.
 */
export function itemColors(item: Pick<StyleItem, "colors" | "colorHex">): ColorInfo[] {
  const result: ColorInfo[] = [];
  const positions = Math.max(item.colors.length, item.colorHex.length);
  for (let index = 0; index < positions && result.length < ITEM_COLOR_LIMIT; index += 1) {
    const info = colorInfo(item.colors[index] ?? null, item.colorHex[index] ?? null);
    if (info !== null) result.push(info);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Palette harmony
// ---------------------------------------------------------------------------

export type Harmony = {
  /** 0-1, higher is better. */
  score: number;
  /** Distinct non-neutral hue families across the pieces' dominant colours. */
  saturatedFamilies: number;
  /** Max minus min lightness of the pieces' dominant colours, 0-1. */
  contrast: number;
  scheme: "neutral" | "tonal" | "accent" | "analogous" | "complementary" | "busy";
};

// Unknown colours neither reward nor punish much.
const UNKNOWN_HARMONY: Harmony = { score: 0.7, saturatedFamilies: 0, contrast: 0, scheme: "neutral" };

// All neutrals: safe, but flat unless light and dark pieces play off each other.
const NEUTRAL_FLAT_SCORE = 0.85;
const NEUTRAL_CONTRAST_SCORE = 0.95;
const NEUTRAL_CONTRAST_MIN = 0.3;
// All neutrals of one kind within a narrow lightness band (head-to-toe camel,
// all black): deliberate tonal dressing, a notch above a flat mix of unrelated
// neutrals at one lightness, below a contrasted outfit.
const TONAL_NEUTRAL_SCORE = 0.9;
const TONAL_NEUTRAL_SPREAD = 0.15;

/**
 * A neutral darker than this (HSL lightness) reads dark: navy (0.19),
 * charcoal (0.25), dark brown (0.30), not mid denim (0.37). Dark neutrals of
 * any mix of kinds (navy, charcoal and black) read as one dark tonal look.
 */
export const DARK_NEUTRAL_LIGHTNESS = 0.35;
// One colour family: every piece in it is tonal dressing; neutrals plus one
// accent is the classic.
const TONAL_SCORE = 0.95;
const ACCENT_SCORE = 1;
// Two families. Analogous: within two steps of the 12-step wheel. Complementary:
// near-opposite, wearable when one side is muted (burgundy with forest green),
// loud when both are saturated. Anything between clashes.
const ANALOGOUS_MAX_DEGREES = 60;
const ANALOGOUS_SCORE = 0.85;
const COMPLEMENTARY_MIN_DEGREES = 150;
const COMPLEMENTARY_MUTED_SCORE = 0.7;
const COMPLEMENTARY_SCORE = 0.5;
const MUTED_SATURATION = 0.5;
const MUTED_LIGHTNESS = 0.3;
const CLASH_SCORE = 0.4;
// Three or more families.
const BUSY_SCORE = 0.2;
// Hues this close count as one family even across a 30-degree boundary, so two
// near-identical reds are never scored as two colours.
const FAMILY_MERGE_DEGREES = 15;
// A piece's second colour (a stripe, a print) moves the score only this share
// of the way towards what it would be if the colour were a whole piece.
const SECONDARY_WEIGHT = 0.3;

type Verdict = { score: number; scheme: Harmony["scheme"]; families: number };

function isChromatic(color: ColorInfo): boolean {
  return !color.neutral && color.hue !== null && color.family !== null;
}

function isMuted(color: ColorInfo): boolean {
  return color.saturation < MUTED_SATURATION || color.lightness < MUTED_LIGHTNESS;
}

function wheelHue(color: ColorInfo): number {
  return rybHue(color.hue ?? 0);
}

function hueDistance(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return Math.min(difference, 360 - difference);
}

function meanWheelHue(colors: readonly ColorInfo[]): number {
  let x = 0;
  let y = 0;
  for (const color of colors) {
    const radians = (wheelHue(color) * Math.PI) / 180;
    x += Math.cos(radians);
    y += Math.sin(radians);
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Chromatic colours grouped by family, merging families whose members sit within FAMILY_MERGE_DEGREES. */
function hueGroups(colors: readonly ColorInfo[]): ColorInfo[][] {
  let groups: ColorInfo[][] = [];
  for (const color of colors) {
    const joins = (member: ColorInfo) =>
      member.family === color.family || hueDistance(wheelHue(member), wheelHue(color)) <= FAMILY_MERGE_DEGREES;
    const matching = groups.filter((group) => group.some(joins));
    if (matching.length === 0) {
      groups.push([color]);
      continue;
    }
    const merged = [...matching.flat(), color];
    const first = matching[0];
    groups = groups.flatMap((group) => {
      if (group === first) return [merged];
      return matching.includes(group) ? [] : [group];
    });
  }
  return groups;
}

/** A neutral's kind: read from its colour, else (a neutral its name made one, namedNeutral) from its name. */
function kindOf(color: ColorInfo): NeutralKind | "other" {
  const kind = neutralKind(color.hue, color.saturation, color.lightness);
  if (kind !== null) return kind;
  const first = color.neutral && color.name !== null ? firstColorName(color.name) : undefined;
  return (first === undefined ? null : neutralNameKind(first)) ?? "other";
}

/**
 * All neutrals: tonal when every piece is one kind within a narrow lightness
 * band, contrasted when light and dark play off each other, tonal again when
 * every piece is dark (DARK_NEUTRAL_LIGHTNESS) whatever its kind, flat
 * otherwise.
 */
function neutralVerdict(dominant: readonly ColorInfo[], contrast: number): Verdict {
  const tonal: Verdict = { score: TONAL_NEUTRAL_SCORE, scheme: "tonal", families: 0 };
  if (dominant.length >= 2 && contrast <= TONAL_NEUTRAL_SPREAD && new Set(dominant.map(kindOf)).size === 1) {
    return tonal;
  }
  if (contrast >= NEUTRAL_CONTRAST_MIN) return { score: NEUTRAL_CONTRAST_SCORE, scheme: "neutral", families: 0 };
  if (dominant.length >= 2 && dominant.every((color) => color.lightness < DARK_NEUTRAL_LIGHTNESS)) return tonal;
  return { score: NEUTRAL_FLAT_SCORE, scheme: "neutral", families: 0 };
}

function judge(dominant: readonly ColorInfo[], accents: readonly ColorInfo[], contrast: number): Verdict {
  const chromatic = [...dominant, ...accents].filter(isChromatic);
  const groups = hueGroups(chromatic);
  const families = groups.length;
  if (families === 0) return neutralVerdict(dominant, contrast);
  if (families === 1) {
    return dominant.every(isChromatic)
      ? { score: TONAL_SCORE, scheme: "tonal", families }
      : { score: ACCENT_SCORE, scheme: "accent", families };
  }
  // Rust, terracotta and muted mustard are desaturated and warm: together
  // they read as one earthy palette, however far apart their hues.
  if (chromatic.every((color) => color.earth)) return { score: ANALOGOUS_SCORE, scheme: "analogous", families };
  if (families >= 3) return { score: BUSY_SCORE, scheme: "busy", families };
  const [a, b] = groups;
  const distance = hueDistance(meanWheelHue(a), meanWheelHue(b));
  if (distance <= ANALOGOUS_MAX_DEGREES) return { score: ANALOGOUS_SCORE, scheme: "analogous", families };
  if (distance >= COMPLEMENTARY_MIN_DEGREES) {
    const muted = a.every(isMuted) || b.every(isMuted);
    return { score: muted ? COMPLEMENTARY_MUTED_SCORE : COMPLEMENTARY_SCORE, scheme: "complementary", families };
  }
  return { score: CLASH_SCORE, scheme: "busy", families };
}

/**
 * How well an outfit's colours sit together. One ColorInfo[] per visible
 * piece, dominant first. The scheme, family count and contrast come from each
 * piece's dominant colour; a second colour only nudges the score
 * (SECONDARY_WEIGHT): a red stripe on a white tee is an accent, not a red piece.
 */
export function paletteHarmony(pieces: readonly ColorInfo[][]): Harmony {
  const dominant: ColorInfo[] = [];
  const secondary: ColorInfo[] = [];
  for (const piece of pieces) {
    const [first, second] = piece;
    if (first !== undefined) dominant.push(first);
    if (second !== undefined) secondary.push(second);
  }
  if (dominant.length === 0) return { ...UNKNOWN_HARMONY };

  const lightness = dominant.map((color) => color.lightness);
  const contrast = Math.max(...lightness) - Math.min(...lightness);
  const base = judge(dominant, [], contrast);
  const accents = secondary.filter(isChromatic);
  let score = base.score;
  if (accents.length > 0) score += SECONDARY_WEIGHT * (judge(dominant, accents, contrast).score - base.score);
  return { score: Math.min(1, Math.max(0, score)), saturatedFamilies: base.families, contrast, scheme: base.scheme };
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export type PatternClass = "solid" | "texture" | "bold" | "unknown";

const SOLID_PATTERNS: ReadonlySet<string> = new Set([
  "",
  "solid",
  "plain",
  "none",
  "no pattern",
  "solid colour",
  "solid color",
]);

// Patterns that make a statement. Checked before textures: a striped rib knit
// still reads striped.
const BOLD_PATTERN =
  /\b(?:pin ?stripe[sd]?|stripe[sd]?|breton|check(?:s|ed)?|checkered|chequered|plaid|tartan|gingham|houndstooth|hounds tooth|dogtooth|polka|dots?|dotted|spots?|spotted|floral|flowers?|print(?:s|ed)?|graphic|camo|camouflage|colou?r ?block(?:ed|ing)?|animal|leopard|zebra|snake ?skin|paisley|logos?|argyle|fair ?isle|tie ?dyed?|windowpane|chevron)\b/;

// Surface interest that reads as solid from a distance and never clashes.
const TEXTURE_PATTERN =
  /\b(?:herringbone|cable(?: knit)?|ribbed|rib(?: knit)?|waffle|quilted|textured?|melange|marl(?:ed)?|heather(?:ed)?|twill|corduroy|tweed|boucle|pique|slub|seersucker|honeycomb|pointelle|knit(?:ted)?)\b/;

/** What a pattern tag means for mixing: solid, texture, bold, or unknown (scored as solid). */
export function patternClass(pattern: string | null): PatternClass {
  const text = pattern === null ? "" : normaliseText(pattern);
  if (SOLID_PATTERNS.has(text)) return "solid";
  if (BOLD_PATTERN.test(text)) return "bold";
  if (TEXTURE_PATTERN.test(text)) return "texture";
  return "unknown";
}

// One statement pattern anchors an outfit; two compete; three are noise.
// Textures and unknown patterns never count.
const TWO_BOLD_SCORE = 0.3;

/** 0-1 for the visible pieces' pattern tags. */
export function patternScore(patterns: readonly (string | null)[]): number {
  const bold = patterns.filter((pattern) => patternClass(pattern) === "bold").length;
  if (bold <= 1) return 1;
  return bold === 2 ? TWO_BOLD_SCORE : 0;
}
