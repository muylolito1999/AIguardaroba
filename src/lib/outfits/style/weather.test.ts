import { describe, expect, it } from "vitest";

import { SEASONS, type ItemCategory, type OutfitSlot } from "@/lib/db/enums";
import { seededRandom, seedFrom } from "@/lib/outfits/style/random";
import type { StyleEntry, StyleItem } from "@/lib/outfits/style/types";
import {
  BASE_LAYER_WARMTH,
  idealWarmth,
  isRainyDay,
  keepsDry,
  LAYERING_BONUS,
  outfitWarmth,
  RAINY_DAY,
  seasonOf,
  UNKNOWN_WARMTH,
  WEATHER_PENALTIES as P,
  weatherFit,
} from "@/lib/outfits/style/weather";
// The originals, imported only here to prove the copies behave the same.
import {
  idealWarmth as originalIdealWarmth,
  isRainyDay as originalIsRainyDay,
  RAINY_DAY as ORIGINAL_RAINY_DAY,
  weatherFitScore,
} from "@/lib/outfits/suggestion";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";

import { makeWeatherSnapshot } from "../../../../test/outfit-fixtures";
import { entriesOf, makeStyleItem, styleMap } from "../../../../test/style-fixtures";

/** A piece with no season tags, so only what the test is about can cost points. */
const piece = (category: ItemCategory, warmthLevel: number | null, overrides: Partial<StyleItem> = {}): StyleItem =>
  makeStyleItem({ category, warmthLevel, seasons: [], ...overrides });

/** A dry, calm day in early November that feels like minC to maxC. */
function day(minC: number, maxC: number, overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return makeWeatherSnapshot({
    apparentMinC: minC,
    apparentMaxC: maxC,
    precipProbMax: 0,
    precipSumMm: 0,
    windGustMaxKmh: 10,
    weatherCode: 3,
    label: "Overcast",
    ...overrides,
  });
}

const rainy = { precipProbMax: 80, precipSumMm: 5 } as const;

/** weatherFit of [slot, item] pairs, with the map built from the same items. */
function fit(weather: WeatherSnapshot, ...pairs: (readonly [OutfitSlot, StyleItem])[]) {
  return weatherFit(entriesOf(...pairs), styleMap(...pairs.map(([, item]) => item)), weather);
}

function warmthOfPairs(...pairs: (readonly [OutfitSlot, StyleItem])[]): number {
  return outfitWarmth(entriesOf(...pairs), styleMap(...pairs.map(([, item]) => item)));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

describe("helpers shared with suggestion.ts", () => {
  it("RAINY_DAY has the same thresholds", () => {
    expect(RAINY_DAY).toEqual(ORIGINAL_RAINY_DAY);
  });

  it.each([
    [null, 0],
    [null, 1.99],
    [null, 2],
    [0, 0],
    [49, 0],
    [49.9, 1.9],
    [50, 0],
    [100, 0],
    [0, 5],
    [30, 2],
  ])("isRainyDay(prob %s, sum %s) agrees", (precipProbMax, precipSumMm) => {
    const weather = { precipProbMax, precipSumMm };
    expect(isRainyDay(weather)).toBe(originalIsRainyDay(weather));
  });

  it.each([-30, -0.1, 0, 2.9, 3, 9.9, 10, 15.9, 16, 21.9, 22, 40])("idealWarmth(%s) agrees", (feelsLikeC) => {
    expect(idealWarmth(feelsLikeC)).toBe(originalIdealWarmth(feelsLikeC));
  });

  it.each([
    ["2026-01-01", "winter"],
    ["2026-02-28", "winter"],
    ["2028-02-29", "winter"],
    ["2026-03-01", "spring"],
    ["2026-05-31", "spring"],
    ["2026-06-01", "summer"],
    ["2026-08-31", "summer"],
    ["2026-09-01", "autumn"],
    ["2026-11-30", "autumn"],
    ["2026-12-01", "winter"],
    ["2026-12-31", "winter"],
  ])("seasonOf(%s) is %s, as suggestion.ts reads it", (date, expected) => {
    expect(seasonOf(date)).toBe(expected);
    // suggestion.ts keeps its seasonOf private; weatherFitScore adds 1 exactly when
    // the item's seasons leave out the date's season, which exposes it.
    const weather = day(12, 12, { date });
    for (const season of SEASONS) {
      const score = weatherFitScore({ warmthLevel: idealWarmth(12), seasons: [season], category: "top", waterproof: false }, weather);
      expect(score === 0).toBe(seasonOf(date) === season);
    }
  });
});

// ---------------------------------------------------------------------------
// outfitWarmth
// ---------------------------------------------------------------------------

describe("outfitWarmth", () => {
  const jeans = piece("bottom", 2);
  const knit = piece("top", 3, { subcategory: "sweater" });

  it("adds top, bottom and outerwear", () => {
    expect(warmthOfPairs(["top", knit], ["bottom", jeans])).toBe(5);
    expect(warmthOfPairs(["top", knit], ["bottom", jeans], ["outerwear", piece("outerwear", 4)])).toBe(9);
  });

  it("counts a layered tee under a knit above the knit alone but below the sum", () => {
    const tee = piece("top", 2, { subcategory: "long-sleeve t-shirt" });
    const layered = warmthOfPairs(["top", tee], ["mid_layer", knit], ["bottom", jeans]);
    expect(layered).toBe(3 + LAYERING_BONUS + 2);
    expect(layered).toBeGreaterThan(warmthOfPairs(["top", knit], ["bottom", jeans]));
    expect(layered).toBeLessThan(2 + 3 + 2);
  });

  it("gives no layering bonus for a summer-weight tee", () => {
    const tee = piece("top", 1, { subcategory: "t-shirt" });
    expect(warmthOfPairs(["top", tee], ["mid_layer", knit], ["bottom", jeans])).toBe(5);
  });

  it("uses the warmer layer whichever slot it is in", () => {
    const shirt = piece("top", 2);
    expect(warmthOfPairs(["top", knit], ["mid_layer", shirt], ["bottom", jeans])).toBe(
      warmthOfPairs(["top", shirt], ["mid_layer", knit], ["bottom", jeans]),
    );
  });

  it("adds one for a base layer, whatever its own warmth", () => {
    const thermal = piece("base_layer", 4);
    expect(warmthOfPairs(["base_layer", thermal], ["top", knit], ["bottom", jeans])).toBe(5 + BASE_LAYER_WARMTH);
  });

  it("counts a dress twice alone, once with a bottom", () => {
    const dress = piece("dress", 3);
    const tights = piece("bottom", 1, { subcategory: "tights" });
    expect(warmthOfPairs(["top", dress])).toBe(6);
    expect(warmthOfPairs(["top", dress], ["bottom", tights])).toBe(4);
    expect(warmthOfPairs(["top", dress], ["mid_layer", piece("top", 3)], ["bottom", tights])).toBe(3 + LAYERING_BONUS + 1);
  });

  it("leaves out hats, gloves, scarves, socks, shoes and accessories", () => {
    const base = warmthOfPairs(["top", knit], ["bottom", jeans]);
    const dressedUp = warmthOfPairs(
      ["top", knit],
      ["bottom", jeans],
      ["hat", piece("hat_beanie", 5)],
      ["gloves", piece("gloves", 5)],
      ["scarf", piece("scarf", 5)],
      ["socks", piece("socks", 5)],
      ["shoes", piece("shoes", 5)],
      ["accessory", piece("accessory", 5)],
    );
    expect(dressedUp).toBe(base);
  });

  it("counts an unknown warmth as UNKNOWN_WARMTH", () => {
    expect(warmthOfPairs(["top", piece("top", null)], ["bottom", piece("bottom", null)])).toBe(2 * UNKNOWN_WARMTH);
  });

  it("ignores entries whose item is not in the map", () => {
    const entries: StyleEntry[] = [
      ...entriesOf(["top", knit], ["bottom", jeans]),
      { slot: "outerwear", itemId: "missing-coat" },
      { slot: "mid_layer", itemId: "missing-knit" },
    ];
    expect(outfitWarmth(entries, styleMap(knit, jeans))).toBe(5);
    expect(outfitWarmth([], styleMap(knit, jeans))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// weatherFit
// ---------------------------------------------------------------------------

describe("weatherFit", () => {
  const jeans = piece("bottom", 2, { subcategory: "jeans" });
  const knit = piece("top", 3, { subcategory: "sweater" });
  const sneakers = piece("shoes", 2, { subcategory: "sneakers" });

  it("scores a well-chosen outfit 1 with no notes", () => {
    expect(fit(day(10, 14), ["top", knit], ["bottom", jeans], ["shoes", sneakers])).toEqual({ score: 1, notes: [] });
  });

  describe("freezing", () => {
    const winterDay = day(-8, -2, { date: "2026-01-15" });
    const shirt = piece("top", 2);
    const thermal = piece("base_layer", 2);
    const puffer = piece("outerwear", 5, { subcategory: "puffer jacket" });
    const boots = piece("shoes", 3, { subcategory: "boots" });
    const beanie = piece("hat_beanie", 3);
    const core = [
      ["base_layer", thermal],
      ["top", shirt],
      ["mid_layer", knit],
      ["bottom", jeans],
      ["shoes", boots],
    ] as const;

    it("a coat beats no coat", () => {
      const withCoat = fit(winterDay, ...core, ["outerwear", puffer], ["hat", beanie]);
      const withoutCoat = fit(winterDay, ...core, ["hat", beanie]);
      expect(withCoat).toEqual({ score: 1, notes: [] });
      // Warmth 7 against 10-15 (3 points) and no outerwear.
      expect(withoutCoat.score).toBeCloseTo(1 - 3 * P.warmthPerPoint - P.noOuterwear, 6);
      expect(withoutCoat.notes).toEqual([
        expect.stringMatching(/^too cool: warmth 7, the freezing band wants 10-15/),
        expect.stringMatching(/^no outerwear for a freezing day/),
      ]);
      expect(withCoat.score).toBeGreaterThan(withoutCoat.score);
    });

    it("nudges for a hat, gloves or scarf, and any one of them is enough", () => {
      const bare = fit(winterDay, ...core, ["outerwear", puffer]);
      expect(bare.score).toBeCloseTo(1 - P.freezingNoExtras, 6);
      expect(bare.notes).toEqual([expect.stringMatching(/no hat, gloves or scarf below freezing/)]);
      expect(fit(winterDay, ...core, ["outerwear", puffer], ["scarf", piece("scarf", 3)]).score).toBe(1);
      expect(fit(winterDay, ...core, ["outerwear", puffer], ["gloves", piece("gloves", 3)]).score).toBe(1);
    });

    it("caps the warmth penalty", () => {
      const result = fit(winterDay, ["top", piece("top", 1)], ["bottom", piece("bottom", 2)], ["outerwear", piece("outerwear", 1)], ["hat", beanie]);
      // Warmth 4 is 6 points short; the cap holds it at warmthMax.
      expect(result.score).toBeCloseTo(1 - P.warmthMax, 6);
    });

    it("counts a missing outerwear item as no outerwear", () => {
      const entries: StyleEntry[] = [...entriesOf(...core, ["hat", beanie]), { slot: "outerwear", itemId: "gone" }];
      const result = weatherFit(entries, styleMap(thermal, shirt, knit, jeans, boots, beanie), winterDay);
      expect(result.notes).toContainEqual(expect.stringMatching(/^no outerwear/));
    });
  });

  describe("rain", () => {
    const wetDay = day(8, 12, rainy);
    const shell = piece("outerwear", 2, { subcategory: "rain jacket", waterproof: true });
    const jacket = piece("outerwear", 2, { subcategory: "denim jacket", waterproof: false });

    it("a waterproof shell beats a jacket that is not", () => {
      const dry = fit(wetDay, ["top", knit], ["bottom", jeans], ["outerwear", shell], ["shoes", sneakers]);
      const wet = fit(wetDay, ["top", knit], ["bottom", jeans], ["outerwear", jacket], ["shoes", sneakers]);
      expect(dry).toEqual({ score: 1, notes: [] });
      expect(wet.score).toBeCloseTo(1 - P.rainNoGear, 6);
      expect(wet.notes).toEqual([expect.stringMatching(/^rain without waterproof outerwear, or waterproof shoes under outerwear/)]);
    });

    it("waterproof shoes count as rain gear under a layer that sheds a shower, not alone", () => {
      const boots = piece("shoes", 3, { subcategory: "boots", waterproof: true });
      expect(fit(wetDay, ["top", knit], ["bottom", jeans], ["outerwear", jacket], ["shoes", boots]).score).toBe(1);
      const alone = fit(wetDay, ["top", knit], ["bottom", jeans], ["shoes", boots]);
      expect(alone.score).toBeCloseTo(1 - P.rainNoGear, 6);
      expect(alone.notes).toEqual([expect.stringMatching(/^rain without waterproof outerwear, or waterproof shoes under outerwear/)]);
    });

    it("charges the rain penalty exactly when the outfit does not keep the wearer dry (keepsDry)", () => {
      const outers = [null, shell, jacket, piece("outerwear", 2, { waterproof: null })];
      const shoes = [true, false, null].map((waterproof) => piece("shoes", 2, { subcategory: "boots", waterproof }));
      for (const outer of outers) {
        for (const shoe of shoes) {
          const pairs: [OutfitSlot, StyleItem][] = [["top", knit], ["bottom", jeans], ["shoes", shoe]];
          if (outer !== null) pairs.push(["outerwear", outer]);
          const entries = entriesOf(...pairs);
          const items = styleMap(...pairs.map(([, item]) => item));
          const charged = weatherFit(entries, items, wetDay).notes.some((note) => note.startsWith("rain without"));
          expect(charged).toBe(!keepsDry(entries, items));
          // A dry day charges nothing for rain.
          expect(weatherFit(entries, items, day(8, 12)).notes).toEqual([]);
        }
      }
    });

    it("an unknown waterproof flag is not rain gear", () => {
      const unknown = piece("outerwear", 2, { waterproof: null });
      expect(fit(wetDay, ["top", knit], ["bottom", jeans], ["outerwear", unknown], ["shoes", sneakers]).score).toBeCloseTo(
        1 - P.rainNoGear,
        6,
      );
    });

    it("rain from the sum alone counts", () => {
      const result = fit(day(8, 12, { precipProbMax: null, precipSumMm: 2.5 }), ["top", knit], ["bottom", jeans], ["shoes", sneakers]);
      expect(result.notes).toContainEqual(expect.stringMatching(/^rain without/));
    });

    it("no rain gear is needed on a dry day", () => {
      expect(fit(day(8, 12), ["top", knit], ["bottom", jeans], ["outerwear", jacket], ["shoes", sneakers]).score).toBe(1);
    });

    it("penalises open shoes in the rain even with a shell", () => {
      const slides = piece("shoes", 1, { subcategory: null, name: "Black pool slides" });
      const tee = piece("top", 1);
      const result = fit(day(16, 20, rainy), ["top", tee], ["bottom", jeans], ["outerwear", shell], ["shoes", slides]);
      expect(result.score).toBeCloseTo(1 - P.rainOpenShoes, 6);
      expect(result.notes).toEqual([expect.stringMatching(/^open shoes in the rain/)]);
    });

    it.each([
      ["Sandalen", null],
      ["sandali", null],
      ["infradito", null],
      ["ciabatte", null],
      ["Zehentrenner", null],
      ["sliders", null],
      ["thongs", null],
      ["Birkenstock", null],
      [null, "Trekkingsandalen"],
    ])("reads %s / %s as open shoes in the rain, as footwearKind does", (subcategory, name) => {
      const open = piece("shoes", 1, { subcategory, name });
      const result = fit(day(16, 20, rainy), ["top", piece("top", 1)], ["bottom", jeans], ["outerwear", shell], ["shoes", open]);
      expect(result.score).toBeCloseTo(1 - P.rainOpenShoes, 6);
      expect(result.notes).toEqual([expect.stringMatching(/^open shoes in the rain/)]);
    });
  });

  describe("open shoes", () => {
    const jacket = piece("outerwear", 2);

    it.each([
      ["sandals", null],
      [null, "Brown leather sandal"],
      ["slides", null],
      [null, "Flip-flops"],
      ["flip flops", null],
      // German and Italian, and the words footwearKind knows beyond these.
      ["Sandalen", null],
      ["sandali", null],
      ["infradito", null],
      ["ciabatte", null],
      ["Zehentrenner", null],
      ["Badelatschen", null],
      ["sliders", null],
      ["thongs", null],
      ["Birkenstock", null],
      [null, "Trekkingsandalen"],
    ])("penalises %s / %s at 8 °C", (subcategory, name) => {
      const open = piece("shoes", 1, { subcategory, name });
      const result = fit(day(6, 10), ["top", knit], ["bottom", jeans], ["outerwear", jacket], ["shoes", open]);
      expect(result.score).toBeCloseTo(1 - P.coldOpenShoes, 6);
      expect(result.notes).toEqual([expect.stringMatching(/^open shoes at 8\.0 °C feels-like/)]);
    });

    it("does not mistake closed shoes for open ones", () => {
      for (const subcategory of ["sneakers", "loafers", "chelsea boots", "slip-ons", "espadrilles"]) {
        const shoes = piece("shoes", 2, { subcategory });
        expect(fit(day(6, 10), ["top", knit], ["bottom", jeans], ["outerwear", jacket], ["shoes", shoes]).score).toBe(1);
      }
    });

    it("leaves sandals alone on a warm dry day", () => {
      const sandals = piece("shoes", 1, { subcategory: "sandals" });
      const result = fit(day(22, 26), ["top", piece("top", 1)], ["bottom", piece("bottom", 1)], ["shoes", sandals]);
      expect(result).toEqual({ score: 1, notes: [] });
    });
  });

  describe("summer-weight pieces", () => {
    // 2 to 8 °C: a chilly day (warmth 6-11) that needs no outerwear by the band.
    const coldDay = day(2, 8);
    const linenShorts = piece("bottom", 1, { subcategory: "shorts", name: "White linen shorts" });
    const parka = piece("outerwear", 5, { subcategory: "parka", name: "Down parka" });
    const summerDress = piece("dress", 1, { subcategory: "sundress", name: "Cotton sundress" });
    const coat = piece("outerwear", 4, { subcategory: "wool coat" });
    const boots = piece("shoes", 3, { subcategory: "boots" });
    const tights = piece("base_layer", 2, { subcategory: "tights" });

    it("penalises linen shorts under a down parka, though the total is warm enough", () => {
      // Knit 3 + shorts 1 + parka 5 = 9, inside the chilly band's 6-11.
      const result = fit(coldDay, ["top", knit], ["bottom", linenShorts], ["outerwear", parka], ["shoes", boots]);
      expect(result.score).toBeCloseTo(1 - P.summerPiece, 6);
      expect(result.notes).toEqual([expect.stringMatching(/^1 summer-weight piece at 5\.0 °C feels-like \(-0\.25\)$/)]);
      expect(fit(coldDay, ["top", knit], ["bottom", jeans], ["outerwear", parka], ["shoes", boots])).toEqual({ score: 1, notes: [] });
    });

    it("penalises a summer dress under a coat, and summer-weight closed shoes", () => {
      // Dress 1 twice + coat 4 = 6.
      const dress = fit(coldDay, ["top", summerDress], ["outerwear", coat], ["shoes", boots]);
      expect(dress.score).toBeCloseTo(1 - P.summerPiece, 6);
      expect(dress.notes).toEqual([expect.stringMatching(/^1 summer-weight piece at 5\.0 °C/)]);
      const canvas = piece("shoes", 1, { subcategory: "sneakers", name: "White canvas sneakers" });
      expect(fit(coldDay, ["top", knit], ["bottom", jeans], ["outerwear", coat], ["shoes", canvas]).score).toBeCloseTo(
        1 - P.summerPiece,
        6,
      );
    });

    it("lets tights under the dress rescue it", () => {
      expect(fit(coldDay, ["base_layer", tights], ["top", summerDress], ["outerwear", coat], ["shoes", boots])).toEqual({
        score: 1,
        notes: [],
      });
    });

    it("leaves summer-weight pieces alone from 15 °C, and an unknown warmth always", () => {
      const tee = piece("top", 1);
      const sneakers1 = piece("shoes", 1, { subcategory: "sneakers" });
      const warm = day(18, 22);
      expect(fit(warm, ["top", tee], ["bottom", linenShorts], ["shoes", sneakers1])).toEqual({ score: 1, notes: [] });
      expect(fit(warm, ["top", summerDress], ["shoes", sneakers1])).toEqual({ score: 1, notes: [] });
      // The edge: a mean of exactly 15 °C is mild, just below is cool.
      const jacket = piece("outerwear", 2);
      expect(fit(day(13, 17), ["top", knit], ["bottom", linenShorts], ["outerwear", jacket], ["shoes", boots]).score).toBe(1);
      expect(fit(day(12.8, 17), ["top", knit], ["bottom", linenShorts], ["outerwear", jacket], ["shoes", boots]).score).toBeCloseTo(
        1 - P.summerPiece,
        6,
      );
      const unknown = piece("bottom", null, { subcategory: "shorts" });
      expect(fit(coldDay, ["top", knit], ["bottom", unknown], ["outerwear", parka], ["shoes", boots]).score).toBe(1);
    });

    it("charges open shoes once, as open shoes", () => {
      const sandals = piece("shoes", 1, { subcategory: "sandals" });
      const result = fit(coldDay, ["top", knit], ["bottom", jeans], ["outerwear", coat], ["shoes", sandals]);
      expect(result.score).toBeCloseTo(1 - P.coldOpenShoes, 6);
      expect(result.notes).toEqual([expect.stringMatching(/^open shoes at 5\.0 °C feels-like/)]);
    });

    it("caps the penalty", () => {
      const canvas = piece("shoes", 1, { subcategory: "sneakers" });
      // Dress 1 + shorts 1 + parka 5 = 7: warm enough, three summer pieces.
      const result = fit(coldDay, ["top", summerDress], ["bottom", linenShorts], ["outerwear", parka], ["shoes", canvas]);
      expect(3 * P.summerPiece).toBeGreaterThan(P.summerPieceMax);
      expect(result.score).toBeCloseTo(1 - P.summerPieceMax, 6);
      expect(result.notes).toEqual([expect.stringMatching(/^3 summer-weight pieces at 5\.0 °C feels-like \(-0\.50\)$/)]);
    });
  });

  describe("heavy outerwear", () => {
    const tee = piece("top", 1);
    const shorts = piece("bottom", 1, { subcategory: "shorts" });
    const parka = piece("outerwear", 5, { subcategory: "parka" });

    it("penalises a parka at 22 °C, twice: too warm and too heavy", () => {
      const hot = day(20, 24);
      const result = fit(hot, ["top", tee], ["bottom", shorts], ["outerwear", parka]);
      expect(result.score).toBeCloseTo(1 - 2 * P.warmthPerPoint - P.heavyOuterwear, 6);
      expect(result.notes).toEqual([
        expect.stringMatching(/^too warm: warmth 7, the warm band wants 2-5/),
        expect.stringMatching(/^heavy outerwear \(warmth 5\) for a warm day/),
      ]);
      expect(fit(hot, ["top", tee], ["bottom", shorts]).score).toBe(1);
      expect(fit(hot, ["top", tee], ["bottom", shorts], ["outerwear", piece("outerwear", 2)]).score).toBe(1);
    });

    it("lets heavy outerwear be on a cool day", () => {
      expect(fit(day(10, 14), ["top", tee], ["bottom", jeans], ["outerwear", piece("outerwear", 4)]).score).toBe(1);
    });
  });

  describe("wind", () => {
    const outfit = (windproof: boolean | null) =>
      [["top", knit], ["bottom", jeans], ["outerwear", piece("outerwear", 2, { windproof })]] as const;

    it("nudges for outerwear known not to be windproof in gusts of 40 km/h or more", () => {
      const result = fit(day(8, 12, { windGustMaxKmh: 52.9 }), ...outfit(false));
      expect(result.score).toBeCloseTo(1 - P.notWindproof, 6);
      expect(result.notes).toEqual([expect.stringMatching(/^outerwear not windproof in 53 km\/h gusts/)]);
      expect(fit(day(8, 12, { windGustMaxKmh: 40 }), ...outfit(false)).score).toBeCloseTo(1 - P.notWindproof, 6);
    });

    it("leaves windproof, unknown and calm alone", () => {
      expect(fit(day(8, 12, { windGustMaxKmh: 60 }), ...outfit(true)).score).toBe(1);
      expect(fit(day(8, 12, { windGustMaxKmh: 60 }), ...outfit(null)).score).toBe(1);
      expect(fit(day(8, 12, { windGustMaxKmh: 39 }), ...outfit(false)).score).toBe(1);
    });
  });

  describe("seasons", () => {
    const summerDay = day(16, 20, { date: "2026-07-10" });
    const tee = (seasons: string[]) => piece("top", 1, { seasons });

    it("costs offSeasonEach per piece tagged for other seasons", () => {
      const result = fit(summerDay, ["top", tee(["winter"])], ["bottom", jeans], ["shoes", sneakers]);
      expect(result.score).toBeCloseTo(1 - P.offSeasonEach, 6);
      expect(result.notes).toEqual([expect.stringMatching(/^1 piece out of season for summer/)]);
    });

    it("caps the season penalty", () => {
      const winterOnly = { seasons: ["winter", "autumn"] };
      const result = fit(
        summerDay,
        ["top", tee(["winter"])],
        ["bottom", piece("bottom", 2, winterOnly)],
        ["shoes", piece("shoes", 2, winterOnly)],
        ["accessory", piece("accessory", 1, winterOnly)],
        ["accessory", piece("bag", 1, winterOnly)],
      );
      expect(result.score).toBeCloseTo(1 - P.offSeasonMax, 6);
      expect(result.notes).toEqual([expect.stringMatching(/^5 pieces out of season for summer/)]);
    });

    it("treats empty seasons as any season and counts a piece once", () => {
      const summerTee = tee(["summer"]);
      expect(fit(summerDay, ["top", tee([])], ["bottom", jeans], ["shoes", sneakers]).score).toBe(1);
      expect(fit(summerDay, ["top", summerTee], ["bottom", jeans], ["shoes", sneakers]).score).toBe(1);
      const winterBelt = piece("accessory", 1, { seasons: ["winter"] });
      const doubled = weatherFit(
        [...entriesOf(["top", summerTee], ["bottom", jeans], ["accessory", winterBelt]), { slot: "accessory", itemId: winterBelt.id }],
        styleMap(summerTee, jeans, winterBelt),
        summerDay,
      );
      expect(doubled.score).toBeCloseTo(1 - P.offSeasonEach, 6);
    });
  });

  it("costs needsRepair once, however many pieces need it", () => {
    const worn = { condition: "needs_repair" } as const;
    const result = fit(day(10, 14), ["top", piece("top", 3, worn)], ["bottom", piece("bottom", 2, worn)], ["shoes", sneakers]);
    expect(result.score).toBeCloseTo(1 - P.needsRepair, 6);
    expect(result.notes).toEqual([expect.stringMatching(/^a piece needs repair/)]);
  });

  describe("a wide range", () => {
    const shirt = piece("top", 2);

    it("requires outerwear when the commute is cold, though the mean is not", () => {
      const outfit = [["top", shirt], ["mid_layer", knit], ["bottom", jeans], ["shoes", sneakers]] as const;
      // 2 to 14: mean 8 (chilly, no outerwear needed), commute 4 (cold, outerwear needed).
      const wide = fit(day(2, 14), ...outfit);
      expect(wide.score).toBeCloseTo(1 - P.noOuterwear, 6);
      expect(wide.notes).toEqual([expect.stringMatching(/^no outerwear for the 4\.0 °C commute/)]);
      // The same mean on a narrow day needs none.
      expect(fit(day(6, 10), ...outfit).score).toBe(1);
    });

    it("does not count carried outerwear as too warm on a mild day", () => {
      const outfit = [["top", knit], ["bottom", jeans], ["outerwear", piece("outerwear", 3)], ["shoes", sneakers]] as const;
      // Warmth 8 against the mild band's 3-7: too warm all day, fine when the jacket comes off.
      expect(fit(day(12, 26), ...outfit)).toEqual({ score: 1, notes: [] });
      const narrow = fit(day(17, 21), ...outfit);
      expect(narrow.score).toBeCloseTo(1 - P.warmthPerPoint, 6);
      expect(narrow.notes).toEqual([expect.stringMatching(/^too warm: warmth 8, the mild band wants 3-7/)]);
    });

    it("judges how heavy the outerwear may be at the commute", () => {
      const tee = piece("top", 1);
      const coat = piece("outerwear", 4, { subcategory: "wool coat" });
      const outfit = [["top", tee], ["bottom", jeans], ["outerwear", coat], ["shoes", sneakers]] as const;
      // 12 to 26: a 14 °C commute is cool, so a wool coat is fine.
      expect(fit(day(12, 26), ...outfit).score).toBe(1);
      // 17 to 21: mild all day, so it is too heavy.
      expect(fit(day(17, 21), ...outfit).score).toBeCloseTo(1 - P.heavyOuterwear, 6);
      // 16 to 30: even the commute (18 °C) is mild.
      const hot = fit(day(16, 30), ...outfit);
      expect(hot.notes).toEqual([expect.stringMatching(/^heavy outerwear \(warmth 4\) for the 18\.0 °C commute/)]);
    });

    it("still counts the outerwear against being too cool", () => {
      const puffer = piece("outerwear", 5);
      // -4 to 6: mean 1 (cold, 7-13). Knit, jeans and puffer make 10.
      expect(fit(day(-4, 6), ["top", knit], ["bottom", jeans], ["outerwear", puffer], ["shoes", sneakers]).score).toBe(1);
    });
  });

  it("clamps the worst case to 0 and notes every penalty", () => {
    const summerOnly = { seasons: ["summer"], condition: "needs_repair" } as const;
    const result = fit(
      day(-10, -4, { ...rainy, windGustMaxKmh: 80, date: "2026-01-20" }),
      ["top", piece("top", 1, summerOnly)],
      ["bottom", piece("bottom", 1, summerOnly)],
      ["shoes", piece("shoes", 1, { ...summerOnly, subcategory: "sandals" })],
    );
    expect(result.score).toBe(0);
    expect(result.notes).toEqual([
      expect.stringMatching(/^too cool/),
      expect.stringMatching(/^no outerwear/),
      expect.stringMatching(/^rain without/),
      expect.stringMatching(/^open shoes in the rain/),
      expect.stringMatching(/^open shoes at/),
      // The bottom; the sandals are charged as open shoes, the top is not a legs or feet piece.
      expect.stringMatching(/^1 summer-weight piece at -7\.0 °C feels-like/),
      expect.stringMatching(/^3 pieces out of season for winter/),
      expect.stringMatching(/^no hat, gloves or scarf/),
      expect.stringMatching(/^a piece needs repair/),
    ]);
  });

  it("keeps every score in [0, 1], and 1 exactly when nothing is noted", () => {
    const random = seededRandom(seedFrom("weather-fit"));
    const between = (low: number, high: number) => low + random() * (high - low);
    const warmth = () => (random() < 0.1 ? null : 1 + Math.floor(random() * 5));
    const maybe = <T>(value: T): T | null => (random() < 0.5 ? value : null);
    const shoeNames = ["sneakers", "sandals", "boots", "slides", null];
    for (let run = 0; run < 500; run += 1) {
      const minC = between(-20, 30);
      const weather = day(minC, minC + between(0, 15), {
        precipProbMax: maybe(Math.round(between(0, 100))),
        precipSumMm: between(0, 8),
        windGustMaxKmh: between(0, 90),
        date: `2026-${String(1 + Math.floor(random() * 12)).padStart(2, "0")}-15`,
      });
      const pairs: [OutfitSlot, StyleItem][] = [];
      const dress = random() < 0.2;
      pairs.push(["top", makeStyleItem({ category: dress ? "dress" : "top", warmthLevel: warmth() })]);
      if (!dress || random() < 0.5) pairs.push(["bottom", makeStyleItem({ category: "bottom", warmthLevel: warmth() })]);
      if (random() < 0.4) pairs.push(["mid_layer", makeStyleItem({ category: "top", warmthLevel: warmth() })]);
      if (random() < 0.2) pairs.push(["base_layer", makeStyleItem({ category: "base_layer", warmthLevel: warmth() })]);
      if (random() < 0.6) {
        const flag = () => (random() < 0.2 ? null : random() < 0.5);
        pairs.push(["outerwear", makeStyleItem({ category: "outerwear", warmthLevel: warmth(), waterproof: flag(), windproof: flag() })]);
      }
      const shoe = shoeNames[Math.floor(random() * shoeNames.length)] ?? null;
      pairs.push(["shoes", makeStyleItem({ category: "shoes", subcategory: shoe, waterproof: random() < 0.3 })]);
      if (random() < 0.3) pairs.push(["hat", makeStyleItem({ category: "hat_beanie" })]);
      if (random() < 0.1) pairs.push(["accessory", makeStyleItem({ category: "accessory", condition: "needs_repair" })]);

      const result = fit(weather, ...pairs);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.score === 1).toBe(result.notes.length === 0);
    }
  });
});
