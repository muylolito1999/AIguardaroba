import { describe, expect, it } from "vitest";

import { makeStyleItem } from "../../../../test/style-fixtures";
import {
  colorInfo,
  itemColors,
  paletteHarmony,
  parseHex,
  patternClass,
  patternScore,
  type ColorInfo,
  type PatternClass,
} from "./color";

/** A piece's colours from names alone (the name dictionary path). */
function piece(...colors: string[]): ColorInfo[] {
  return itemColors(makeStyleItem({ colors, colorHex: [] }));
}

/** A piece's colours from hexes alone. */
function hexPiece(...colorHex: string[]): ColorInfo[] {
  return itemColors(makeStyleItem({ colors: [], colorHex }));
}

function info(name: string | null, hex: string | null): ColorInfo {
  const result = colorInfo(name, hex);
  if (result === null) throw new Error(`no colour for ${name ?? "-"} / ${hex ?? "-"}`);
  return result;
}

describe("parseHex", () => {
  it("reads #rrggbb into channels", () => {
    expect(parseHex("#1f2a44")).toEqual({ r: 31, g: 42, b: 68 });
  });

  it("accepts upper case, a missing # and the short form", () => {
    expect(parseHex("#1F2A44")).toEqual({ r: 31, g: 42, b: 68 });
    expect(parseHex(" 1f2a44 ")).toEqual({ r: 31, g: 42, b: 68 });
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it.each(["", "#", "#12345", "#1234567", "navy", "#gggggg", "rgb(1,2,3)"])("rejects %j", (hex) => {
    expect(parseHex(hex)).toBeNull();
  });
});

describe("colorInfo", () => {
  it("reads navy as a neutral with a hue but no family", () => {
    const navy = info("navy", "#1f2a44");
    expect(navy).toMatchObject({ name: "navy", neutral: true, earth: false, family: null });
    expect(navy.hue).toBeCloseTo(222, 0);
    expect(navy.lightness).toBeLessThan(0.25);
    // Even fully saturated HTML navy reads navy.
    expect(info(null, "#000080").neutral).toBe(true);
  });

  it("reads raw, mid and light-wash denim and charcoal as neutrals", () => {
    for (const hex of ["#3d5a80", "#5b7ea6", "#8fa9c9", "#36454f"]) {
      expect(info("denim", hex).neutral, hex).toBe(true);
    }
    expect(info("denim", null).neutral).toBe(true);
  });

  it("keeps clear blues as colours", () => {
    for (const name of ["royal blue", "cobalt", "light blue", "sky blue"]) {
      const blue = info(name, null);
      expect(blue.neutral, name).toBe(false);
      expect(blue.family, name).not.toBeNull();
    }
  });

  it("reads olive as neutral and earth", () => {
    expect(info("olive", "#556b2f")).toMatchObject({ neutral: true, earth: true, family: null });
    expect(info("army green", null)).toMatchObject({ neutral: true, earth: true });
  });

  it("reads rust, terracotta and muted mustard as earth but not neutral", () => {
    for (const name of ["rust", "terracotta", "mustard"]) {
      const color = info(name, null);
      expect(color.earth, name).toBe(true);
      expect(color.neutral, name).toBe(false);
      expect(color.family, name).not.toBeNull();
    }
    expect(info(null, "#b7410e")).toMatchObject({ earth: true, neutral: false });
  });

  it("reads the warm naturals as neutral, earthy unless very pale", () => {
    for (const name of ["beige", "camel", "khaki", "tan", "brown", "cognac", "sand"]) {
      expect(info(name, null), name).toMatchObject({ neutral: true, earth: true, family: null });
    }
    expect(info("cream", "#f3ead8")).toMatchObject({ neutral: true, earth: false });
    // Dark saddle-brown leather is a neutral, not an orange.
    expect(info(null, "#8b4513")).toMatchObject({ neutral: true, earth: true });
  });

  it("reads black, white and greys as neutral; pure greys have no hue", () => {
    for (const name of ["black", "white", "off white", "grey", "charcoal", "heather grey", "stone", "taupe"]) {
      expect(info(name, null).neutral, name).toBe(true);
    }
    expect(info(null, "#808080")).toMatchObject({ hue: null, neutral: true, family: null });
  });

  it("keeps bright colours out of neutral and earth", () => {
    for (const name of ["red", "pink", "forest green", "burgundy", "orange", "yellow", "purple"]) {
      const color = info(name, null);
      expect(color.neutral, name).toBe(false);
      expect(color.earth, name).toBe(false);
      expect(color.family, name).toBeGreaterThanOrEqual(0);
      expect(color.family, name).toBeLessThanOrEqual(11);
    }
  });

  it("puts reds, burgundy and pink in the red family and greens opposite", () => {
    expect(info("red", null).family).toBe(0);
    expect(info("burgundy", null).family).toBe(0);
    expect(info("pink", null).family).toBe(0);
    expect(info("forest green", null).family).toBe(6);
    expect(info("royal blue", null).family).toBe(8);
  });

  it("falls back to the name when the hex is missing, empty or invalid", () => {
    const fromName = info("navy", null);
    expect(info("navy", "")).toEqual(fromName);
    expect(info("navy", "not-a-hex")).toEqual(fromName);
    expect(fromName.neutral).toBe(true);
  });

  it("lets a valid hex win over the name", () => {
    const red = info("navy", "#b3261e");
    expect(red.name).toBe("navy");
    expect(red.neutral).toBe(false);
    expect(red.family).toBe(0);
  });

  it("lets a neutral name win over a hex of the same family that would read as a colour", () => {
    // A navy photographed bright: hue 224, too saturated for the hex alone to read navy.
    expect(info(null, "#1e3a8a")).toMatchObject({ neutral: false, family: 8 });
    const navy = info("navy", "#1e3a8a");
    expect(navy).toMatchObject({ name: "navy", neutral: true, earth: false, family: null });
    // The photo's reading is kept: the hue and the lightness are the hex's.
    expect(navy.hue).toBeCloseTo(224, 0);
    expect(navy.lightness).toBeCloseTo(0.33, 2);

    expect(info("Navy Blue", "#1e3a8a").neutral).toBe(true);
    expect(info("dark denim", "#2f6fd6").neutral).toBe(true);
    expect(info("indigo", "#3b2fd6").neutral).toBe(true);
    expect(info(null, "#c8873a").neutral).toBe(false);
    expect(info("camel", "#c8873a")).toMatchObject({ neutral: true, earth: true, family: null });
    expect(info(null, "#6b8e23").neutral).toBe(false);
    expect(info("olive", "#6b8e23")).toMatchObject({ neutral: true, earth: true, family: null });
    // Achromatic names take a muted hex of any hue.
    expect(info(null, "#4a3f5c").neutral).toBe(false);
    expect(info("charcoal", "#4a3f5c")).toMatchObject({ neutral: true, earth: false, family: null });
  });

  it("keeps the hex when it disagrees with the neutral name", () => {
    expect(info("beige", "#2f5d9e")).toMatchObject({ neutral: false, family: 8 });
    expect(info("black", "#e3b505")).toMatchObject({ neutral: false });
    expect(info("grey", "#b3261e")).toMatchObject({ neutral: false, family: 0 });
    expect(info("olive", "#b3261e")).toMatchObject({ neutral: false, family: 0 });
    // Not a neutral name: the hex decides as before.
    expect(info("royal blue", "#1e3a8a").neutral).toBe(false);
  });

  it("normalises names: case, spaces, hyphens, gray and multi-word names", () => {
    expect(info("  Heather Gray ", null)).toMatchObject({ name: "heather grey", neutral: true });
    expect(info("Off-White", null)).toMatchObject({ name: "off white", neutral: true });
    expect(info("Navy Blue", null).neutral).toBe(true);
    expect(info("forest green", null).family).toBe(6);
  });

  it("shifts known colours by leading modifiers", () => {
    expect(info("dark green", null).lightness).toBeLessThan(info("green", null).lightness);
    expect(info("pale pink", null).lightness).toBeGreaterThan(info("pink", null).lightness);
    expect(info("dusty blue", null).saturation).toBeLessThan(info("blue", null).saturation);
  });

  it("finds a known colour inside a longer name", () => {
    expect(info("grey marl", null).neutral).toBe(true);
    expect(info("petrol blue", null).family).toBe(8);
    expect(info("navy/white", null).hue).toBeCloseTo(info("navy", null).hue ?? 0, 5);
  });

  it("returns null when neither the name nor the hex is usable", () => {
    expect(colorInfo(null, null)).toBeNull();
    expect(colorInfo("", "")).toBeNull();
    expect(colorInfo("multicolour", null)).toBeNull();
    expect(colorInfo("constructor", "zzz")).toBeNull();
  });

  it("keeps a given name with a hex-only reading", () => {
    expect(info(null, "#1f2a44").name).toBeNull();
    expect(info("Petrol", "#1d5c6b").name).toBe("petrol");
  });
});

describe("itemColors", () => {
  it("pairs colors[i] with colorHex[i], dominant first, at most two", () => {
    const item = makeStyleItem({ colors: ["navy", "white", "red"], colorHex: ["#1f2a44", "#f4f4f2", "#b3261e"] });
    const colors = itemColors(item);
    expect(colors).toHaveLength(2);
    expect(colors.map((color) => color.name)).toEqual(["navy", "white"]);
    expect(colors[0]).toEqual(colorInfo("navy", "#1f2a44"));
  });

  it("uses the name where the hex list is shorter", () => {
    const colors = itemColors(makeStyleItem({ colors: ["red", "navy"], colorHex: ["#b3261e"] }));
    expect(colors).toEqual([colorInfo("red", "#b3261e"), colorInfo("navy", null)]);
  });

  it("skips unusable positions so the next colour moves up", () => {
    const colors = itemColors(makeStyleItem({ colors: ["multicolour", "red", "white"], colorHex: [] }));
    expect(colors.map((color) => color.name)).toEqual(["red", "white"]);
  });

  it("returns nothing for an item without colours", () => {
    expect(itemColors(makeStyleItem({ colors: [], colorHex: [] }))).toEqual([]);
  });
});

describe("paletteHarmony", () => {
  it("is mildly positive about unknown colours", () => {
    const unknown = { score: 0.7, saturatedFamilies: 0, contrast: 0, scheme: "neutral" };
    expect(paletteHarmony([])).toEqual(unknown);
    expect(paletteHarmony([[], []])).toEqual(unknown);
  });

  it("scores neutrals plus one accent as the classic", () => {
    const harmony = paletteHarmony([piece("navy"), piece("white"), piece("red")]);
    expect(harmony).toMatchObject({ score: 1, scheme: "accent", saturatedFamilies: 1 });
  });

  it("scores all neutrals with light-dark contrast at 0.95", () => {
    const harmony = paletteHarmony([piece("navy"), piece("grey"), piece("white")]);
    expect(harmony).toMatchObject({ score: 0.95, scheme: "neutral", saturatedFamilies: 0 });
    expect(harmony.contrast).toBeGreaterThanOrEqual(0.3);
  });

  it("scores flat neutrals at one lightness at 0.85", () => {
    const harmony = paletteHarmony([piece("grey"), piece("camel"), piece("taupe")]);
    expect(harmony).toMatchObject({ score: 0.85, scheme: "neutral" });
    expect(harmony.contrast).toBeLessThan(0.3);
  });

  it("scores head-to-toe tonal neutrals of one kind at 0.9", () => {
    expect(paletteHarmony([piece("beige"), piece("sand"), piece("tan")])).toMatchObject({
      score: 0.9,
      scheme: "tonal",
    });
    expect(paletteHarmony([piece("black"), piece("black"), piece("black")])).toMatchObject({
      score: 0.9,
      scheme: "tonal",
      contrast: 0,
    });
  });

  it("scores an all-dark outfit of mixed neutral kinds as tonal", () => {
    const dark = paletteHarmony([piece("navy"), piece("charcoal"), piece("black")]);
    expect(dark).toMatchObject({ score: 0.9, scheme: "tonal", saturatedFamilies: 0 });
    // Wider than the one-kind spread, so it is the darkness that makes it tonal.
    expect(dark.contrast).toBeGreaterThan(0.15);
    // One mid-tone piece makes it a flat mix again.
    expect(paletteHarmony([piece("navy"), piece("charcoal"), piece("taupe")])).toMatchObject({
      score: 0.85,
      scheme: "neutral",
    });
  });

  it("scores one colour family across every piece as tonal", () => {
    expect(paletteHarmony([piece("light blue"), piece("royal blue")])).toMatchObject({
      score: 0.95,
      scheme: "tonal",
      saturatedFamilies: 1,
    });
  });

  it("scores neighbouring hues as analogous", () => {
    expect(paletteHarmony([piece("white"), piece("red"), piece("orange")])).toMatchObject({
      score: 0.85,
      scheme: "analogous",
      saturatedFamilies: 2,
    });
    expect(paletteHarmony([piece("blue"), piece("green"), piece("white")])).toMatchObject({
      score: 0.85,
      scheme: "analogous",
    });
  });

  it("scores a saturated red top with saturated green trousers as loud complementary", () => {
    const harmony = paletteHarmony([hexPiece("#b3261e"), hexPiece("#228b22"), piece("white")]);
    expect(harmony).toMatchObject({ score: 0.5, scheme: "complementary", saturatedFamilies: 2 });
  });

  it("scores complementary colours higher when one side is muted", () => {
    expect(paletteHarmony([piece("burgundy"), piece("forest green")])).toMatchObject({
      score: 0.7,
      scheme: "complementary",
    });
  });

  it("scores two unrelated hues as busy", () => {
    expect(paletteHarmony([piece("red"), piece("yellow"), piece("white")])).toMatchObject({
      score: 0.4,
      scheme: "busy",
      saturatedFamilies: 2,
    });
  });

  it("scores three colour families at 0.2", () => {
    expect(paletteHarmony([piece("red"), piece("royal blue"), piece("yellow")])).toMatchObject({
      score: 0.2,
      scheme: "busy",
      saturatedFamilies: 3,
    });
  });

  it("treats an all-earth palette as analogous however far apart the hues", () => {
    expect(paletteHarmony([piece("terracotta"), piece("mustard"), piece("cream")])).toMatchObject({
      score: 0.85,
      scheme: "analogous",
      saturatedFamilies: 2,
    });
  });

  it("ranks accent > contrasted neutrals > analogous > complementary > busy", () => {
    const accent = paletteHarmony([piece("navy"), piece("white"), piece("red")]).score;
    const neutral = paletteHarmony([piece("navy"), piece("grey"), piece("white")]).score;
    const analogous = paletteHarmony([piece("white"), piece("red"), piece("orange")]).score;
    const complementary = paletteHarmony([piece("burgundy"), piece("forest green")]).score;
    const busy = paletteHarmony([piece("red"), piece("yellow"), piece("white")]).score;
    expect(accent).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(analogous);
    expect(analogous).toBeGreaterThan(complementary);
    expect(complementary).toBeLessThanOrEqual(0.7);
    expect(complementary).toBeGreaterThan(busy);
    expect(busy).toBeLessThanOrEqual(0.4);
  });

  it("treats two near-identical reds across a family boundary as one family", () => {
    const [redA] = hexPiece("#c33522");
    const [redB] = hexPiece("#c33822");
    expect(redA.family).not.toBe(redB.family);
    expect(paletteHarmony([[redA], [redB], piece("white")])).toMatchObject({
      score: 1,
      scheme: "accent",
      saturatedFamilies: 1,
    });
  });

  it("measures contrast on the dominant colours", () => {
    const harmony = paletteHarmony([piece("black", "white"), piece("black")]);
    expect(harmony.contrast).toBe(0);
    expect(paletteHarmony([piece("black"), piece("white")]).contrast).toBeGreaterThan(0.8);
  });

  it("lets a second colour nudge the score without changing the scheme", () => {
    const plain = paletteHarmony([piece("white"), piece("navy"), piece("grey")]);
    const withStripe = paletteHarmony([piece("white", "red"), piece("navy"), piece("grey")]);
    expect(withStripe.scheme).toBe("neutral");
    expect(withStripe.saturatedFamilies).toBe(0);
    expect(withStripe.score).toBeGreaterThan(plain.score);
    expect(withStripe.score).toBeLessThan(1);

    const clashingPrint = paletteHarmony([hexPiece("#f5f5f2", "#228b22"), piece("navy"), hexPiece("#b3261e")]);
    expect(clashingPrint.scheme).toBe("accent");
    expect(clashingPrint.score).toBeLessThan(1);
    // Far gentler than the same green as a whole piece.
    expect(clashingPrint.score).toBeGreaterThan(0.8);
  });

  it("ignores a second colour already in the palette", () => {
    const base = paletteHarmony([piece("white"), piece("navy"), piece("red")]);
    expect(paletteHarmony([piece("white", "red"), piece("navy", "white"), piece("red")])).toEqual(base);
  });

  it("does not depend on piece order and is deterministic", () => {
    const pieces = [piece("burgundy"), piece("navy", "white"), piece("forest green"), piece("camel")];
    const first = paletteHarmony(pieces);
    expect(paletteHarmony(pieces)).toEqual(first);
    const reversed = paletteHarmony([...pieces].reverse());
    expect(reversed.scheme).toBe(first.scheme);
    expect(reversed.saturatedFamilies).toBe(first.saturatedFamilies);
    expect(reversed.score).toBeCloseTo(first.score, 10);
    expect(reversed.contrast).toBeCloseTo(first.contrast, 10);
  });
});

describe("patternClass", () => {
  const table: [string | null, PatternClass][] = [
    [null, "solid"],
    ["", "solid"],
    ["solid", "solid"],
    [" Plain ", "solid"],
    ["none", "solid"],
    ["herringbone", "texture"],
    ["cable knit", "texture"],
    ["ribbed", "texture"],
    ["waffle", "texture"],
    ["quilted", "texture"],
    ["textured", "texture"],
    ["melange", "texture"],
    ["heather", "texture"],
    ["twill", "texture"],
    ["corduroy", "texture"],
    ["bouclé", "texture"],
    ["striped", "bold"],
    ["stripes", "bold"],
    ["pinstripe", "bold"],
    ["checked", "bold"],
    ["checks", "bold"],
    ["plaid", "bold"],
    ["tartan", "bold"],
    ["gingham", "bold"],
    ["houndstooth", "bold"],
    ["polka dot", "bold"],
    ["dots", "bold"],
    ["floral", "bold"],
    ["print", "bold"],
    ["printed", "bold"],
    ["graphic print", "bold"],
    ["camo", "bold"],
    ["camouflage", "bold"],
    ["colour block", "bold"],
    ["Color-Block", "bold"],
    ["animal print", "bold"],
    ["leopard", "bold"],
    ["paisley", "bold"],
    ["logo", "bold"],
    ["striped rib knit", "bold"],
    ["jacquard", "unknown"],
    ["embroidered", "unknown"],
  ];

  it.each(table)("classes %j as %s", (pattern, expected) => {
    expect(patternClass(pattern)).toBe(expected);
  });
});

describe("patternScore", () => {
  it("is 1 with no patterns or one bold pattern", () => {
    expect(patternScore([])).toBe(1);
    expect(patternScore([null, "solid", "plain"])).toBe(1);
    expect(patternScore(["striped", null, "solid"])).toBe(1);
  });

  it("drops to 0.3 for two bold patterns and 0 for three", () => {
    expect(patternScore(["striped", "plaid", null])).toBe(0.3);
    expect(patternScore(["striped", "plaid", "floral"])).toBe(0);
    expect(patternScore(["striped", "plaid", "floral", "camo"])).toBe(0);
  });

  it("never penalises textures or unknown patterns", () => {
    expect(patternScore(["herringbone", "cable knit", "ribbed", "corduroy"])).toBe(1);
    expect(patternScore(["herringbone", "cable knit", "striped"])).toBe(1);
    expect(patternScore(["jacquard", "embroidered", "striped"])).toBe(1);
  });

  it("is deterministic", () => {
    const patterns = ["striped", "houndstooth", null, "twill"];
    expect(patternScore(patterns)).toBe(patternScore(patterns));
  });
});
