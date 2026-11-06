import { describe, expect, it } from "vitest";

import type { Formality, OutfitSlot } from "@/lib/db/enums";
import { patternScore } from "@/lib/outfits/style/color";
import { assessLayering, sockStyle, topKind, wardrobeCounts, type LayerVerdict } from "@/lib/outfits/style/layering";
import { seededRandom } from "@/lib/outfits/style/random";
import {
  bestCompanion,
  CORE_SLOTS,
  coreItems,
  DIVERSITY_PENALTY,
  formalityScore,
  jaccard,
  noveltyScore,
  repairOutfit,
  SAME_DIRECTION_PENALTY,
  scoreOutfit,
  SELECTION_WEIGHTS,
  tasteScore,
} from "@/lib/outfits/style/score";
import {
  EMPTY_HISTORY,
  type ScoreContext,
  type StyleEntry,
  type StyleItem,
  type VarietyHistory,
} from "@/lib/outfits/style/types";
import { weatherFit } from "@/lib/outfits/style/weather";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";

import { entriesOf, makeStyleItem, styleMap } from "../../../../test/style-fixtures";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A dry, calm November day that feels like minC to maxC. */
function day(minC: number, maxC: number, overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    date: "2026-11-06",
    timezone: "Europe/Berlin",
    currentC: (minC + maxC) / 2,
    tminC: minC,
    tmaxC: maxC,
    apparentMinC: minC,
    apparentMaxC: maxC,
    precipSumMm: 0,
    precipProbMax: 0,
    windGustMaxKmh: 10,
    weatherCode: 3,
    label: "Overcast",
    fetchedAt: "2026-11-06T07:00:00.000Z",
    ...overrides,
  };
}

const RAIN = { precipProbMax: 80, precipSumMm: 5, weatherCode: 61, label: "Rain" } as const;

/** A realistic wardrobe of 23 pieces; no season tags except the sandals, so off-season costs stay out of the way. */
function wardrobe() {
  const item = (id: string, overrides: Partial<StyleItem>) => makeStyleItem({ id, seasons: [], ...overrides });
  return {
    teeWhite: item("tee-white", { subcategory: "t-shirt", name: "White tee", colors: ["white"], colorHex: ["#f5f5f2"], warmthLevel: 1 }),
    teeNavy: item("tee-navy", { subcategory: "t-shirt", colors: ["navy"], colorHex: ["#1f2a44"], warmthLevel: 1 }),
    teeRed: item("tee-red", { subcategory: "t-shirt", colors: ["red"], colorHex: ["#b3261e"], warmthLevel: 1 }),
    longSleeve: item("tee-long-grey", { subcategory: "long sleeve", colors: ["grey"], colorHex: ["#8a8d91"], warmthLevel: 2 }),
    oxford: item("shirt-oxford", {
      subcategory: "oxford shirt",
      colors: ["light blue"],
      colorHex: ["#a7c7e7"],
      formality: "smart_casual",
      warmthLevel: 2,
    }),
    hoodie: item("hoodie-grey", { subcategory: "hoodie", colors: ["heather grey"], colorHex: ["#a7a9ac"], warmthLevel: 3 }),
    sweater: item("sweater-navy", {
      subcategory: "crew neck sweater",
      colors: ["navy"],
      colorHex: ["#1f2a44"],
      formality: "smart_casual",
      warmthLevel: 3,
      materials: ["wool"],
    }),
    jeans: item("jeans", { category: "bottom", subcategory: "jeans", colors: ["denim"], colorHex: ["#3d5a80"], warmthLevel: 2 }),
    chinos: item("chinos", {
      category: "bottom",
      subcategory: "chinos",
      colors: ["beige"],
      colorHex: ["#d8c3a5"],
      formality: "smart_casual",
      warmthLevel: 2,
    }),
    trousers: item("trousers-wool", {
      category: "bottom",
      subcategory: "wool trousers",
      colors: ["charcoal"],
      colorHex: ["#3b3e42"],
      formality: "business",
      warmthLevel: 3,
    }),
    dress: item("dress-midi", {
      category: "dress",
      subcategory: "midi dress",
      colors: ["olive"],
      colorHex: ["#556b2f"],
      formality: "smart_casual",
      warmthLevel: 2,
    }),
    sneakers: item("sneakers", { category: "shoes", subcategory: "sneakers", colors: ["white"], colorHex: ["#f5f5f2"], warmthLevel: 2 }),
    chelsea: item("boots-chelsea", {
      category: "shoes",
      subcategory: "chelsea boots",
      colors: ["brown"],
      colorHex: ["#6b4a2f"],
      formality: "smart_casual",
      warmthLevel: 3,
    }),
    rainBoots: item("boots-rain", {
      category: "shoes",
      subcategory: "rain boots",
      colors: ["black"],
      colorHex: ["#111111"],
      warmthLevel: 3,
      waterproof: true,
    }),
    derbies: item("derbies", {
      category: "shoes",
      subcategory: "derby shoes",
      colors: ["black"],
      colorHex: ["#111111"],
      formality: "business",
      warmthLevel: 2,
    }),
    sandals: item("sandals", {
      category: "shoes",
      subcategory: "sandals",
      colors: ["tan"],
      colorHex: ["#d2b48c"],
      warmthLevel: 1,
      seasons: ["summer"],
    }),
    woolSocks: item("socks-wool", {
      category: "socks",
      subcategory: "wool socks",
      colors: ["grey"],
      colorHex: ["#8a8d91"],
      warmthLevel: 3,
      materials: ["wool"],
    }),
    dressSocks: item("socks-dress", {
      category: "socks",
      subcategory: "dress socks",
      colors: ["navy"],
      colorHex: ["#1f2a44"],
      formality: "business",
      warmthLevel: 1,
    }),
    runSocks: item("socks-run", {
      category: "socks",
      subcategory: "running socks",
      colors: ["white"],
      colorHex: ["#f5f5f2"],
      formality: "athletic",
      warmthLevel: 1,
    }),
    cottonSocks: item("socks-cotton", { category: "socks", subcategory: "socks", colors: ["black"], colorHex: ["#111111"], warmthLevel: 1 }),
    shell: item("jacket-rain", {
      category: "outerwear",
      subcategory: "rain jacket",
      colors: ["olive"],
      colorHex: ["#556b2f"],
      warmthLevel: 2,
      waterproof: true,
      windproof: true,
    }),
    coat: item("coat-wool", {
      category: "outerwear",
      subcategory: "wool coat",
      colors: ["camel"],
      colorHex: ["#c19a6b"],
      formality: "smart_casual",
      warmthLevel: 4,
      materials: ["wool"],
    }),
    scarf: item("scarf-wool", { category: "scarf", subcategory: "scarf", colors: ["grey"], colorHex: ["#8a8d91"], warmthLevel: 3 }),
  };
}

type Wardrobe = ReturnType<typeof wardrobe>;

function context(
  items: readonly StyleItem[],
  weather: WeatherSnapshot = day(6, 12),
  history: VarietyHistory = EMPTY_HISTORY,
): ScoreContext {
  return { items: styleMap(...items), weather, history };
}

function allOf(w: Wardrobe): StyleItem[] {
  return Object.values(w);
}

function history(overrides: Partial<VarietyHistory>): VarietyHistory {
  return { ...EMPTY_HISTORY, ...overrides };
}

const ids = (...items: readonly StyleItem[]) => items.map((item) => item.id);

// ---------------------------------------------------------------------------
// Constants and similarity
// ---------------------------------------------------------------------------

describe("weights", () => {
  it("sum to 1 and rank a repeat outfit's diversity cost above a same-direction nudge", () => {
    const sum = Object.values(SELECTION_WEIGHTS).reduce((total, weight) => total + weight, 0);
    expect(sum).toBeCloseTo(1, 12);
    expect(DIVERSITY_PENALTY).toBeGreaterThan(SAME_DIRECTION_PENALTY);
  });
});

describe("coreItems", () => {
  it("returns the sorted ids in the core slots only", () => {
    const w = wardrobe();
    const base = makeStyleItem({ id: "base-thermal", category: "base_layer" });
    const entries = entriesOf(
      ["top", w.teeWhite],
      ["shoes", w.sneakers],
      ["socks", w.runSocks],
      ["outerwear", w.coat],
      ["mid_layer", w.hoodie],
      ["base_layer", base],
      ["bottom", w.jeans],
      ["scarf", w.scarf],
    );
    expect(CORE_SLOTS).toEqual(["outerwear", "mid_layer", "top", "bottom", "shoes"]);
    expect(coreItems(entries)).toEqual(["coat-wool", "hoodie-grey", "jeans", "sneakers", "tee-white"]);
  });
});

describe("jaccard", () => {
  it.each<[string[], string[], number]>([
    [[], [], 0],
    [["a"], ["a"], 1],
    [["a", "b"], ["b", "c"], 1 / 3],
    [["a", "a", "b"], ["b", "a"], 1],
    [["a"], ["b"], 0],
    [["a", "b", "c", "d"], ["a"], 1 / 4],
  ])("%j vs %j is %d", (a, b, expected) => {
    expect(jaccard(a, b)).toBeCloseTo(expected, 12);
    expect(jaccard(b, a)).toBeCloseTo(expected, 12);
  });
});

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

describe("formalityScore", () => {
  const slots: OutfitSlot[] = ["top", "bottom", "shoes"];
  const categories = { top: "top", bottom: "bottom", shoes: "shoes" } as const;

  it.each<[(Formality | null)[], number]>([
    [[], 1],
    [["formal"], 1],
    [["casual", "casual"], 1],
    [["casual", "smart_casual"], 1],
    [["athletic", "casual", "casual"], 1],
    [["casual", "business"], 0.5],
    [["athletic", "smart_casual"], 0.5],
    [["athletic", "casual", "smart_casual"], 0.5],
    [["casual", "formal"], 0],
    [["athletic", "business"], 0],
    [["athletic", "casual", "formal"], 0],
    [[null, "formal"], 1],
    [[null, "casual", "business"], 0.5],
    [[null, null, null], 1],
  ])("%j scores %d", (formalities, expected) => {
    const items = formalities.map((formality, index) => {
      const slot = slots[index] as "top" | "bottom" | "shoes";
      return makeStyleItem({ category: categories[slot], formality });
    });
    const entries = items.map((item, index): StyleEntry => ({ slot: slots[index] as OutfitSlot, itemId: item.id }));
    expect(formalityScore(entries, styleMap(...items))).toBe(expected);
  });

  it("leaves socks and accessories out but counts outerwear", () => {
    const top = makeStyleItem({ category: "top", formality: "casual" });
    const bottom = makeStyleItem({ category: "bottom", formality: "casual" });
    const socks = makeStyleItem({ category: "socks", formality: "business" });
    const bag = makeStyleItem({ category: "bag", formality: "formal" });
    const coat = makeStyleItem({ category: "outerwear", formality: "formal" });
    const items = styleMap(top, bottom, socks, bag, coat);
    const outfit = entriesOf(["top", top], ["bottom", bottom], ["socks", socks], ["accessory", bag]);
    expect(formalityScore(outfit, items)).toBe(1);
    expect(formalityScore([...outfit, { slot: "outerwear", itemId: coat.id }], items)).toBe(0);
  });

  it("ignores entries whose item is unknown", () => {
    const top = makeStyleItem({ category: "top", formality: "casual" });
    expect(formalityScore([{ slot: "top", itemId: top.id }, { slot: "bottom", itemId: "gone" }], styleMap(top))).toBe(1);
  });
});

describe("noveltyScore", () => {
  const w = wardrobe();
  const outfit = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.sneakers], ["socks", w.runSocks]);

  it("is 1 for a fresh outfit of never-worn pieces", () => {
    expect(noveltyScore(outfit, context(allOf(w)))).toBe(1);
  });

  it("costs 1 x 0.6 x 1.5 for the identical core suggested today; socks do not make it different", () => {
    const today = history({
      suggested: [{ itemIds: ids(w.teeWhite, w.jeans, w.sneakers, w.woolSocks), ageDays: 0, direction: null }],
    });
    // 1 - 0.9 + 0.1 x mean rest (1, never worn)
    expect(noveltyScore(outfit, context(allOf(w), day(6, 12), today))).toBeCloseTo(0.2, 6);
  });

  it("counts the share of core pieces in a partial echo, without the identical factor", () => {
    const today = history({ worn: [{ itemIds: ids(w.teeWhite, w.jeans, w.chelsea), ageDays: 0 }] });
    // 1 - 1 x 0.6 x 2/3 + 0.1
    expect(noveltyScore(outfit, context(allOf(w), day(6, 12), today))).toBeCloseTo(0.7, 6);
  });

  it("does not take a past outfit with an unknown piece for an identical one", () => {
    const past = history({ worn: [{ itemIds: [...ids(w.teeWhite, w.jeans, w.sneakers), "jacket-in-hamburg"], ageDays: 0 }] });
    // 1 - 0.6 x 1 (all three core pieces shared, but not confirmed identical) + 0.1
    expect(noveltyScore(outfit, context(allOf(w), day(6, 12), past))).toBeCloseTo(0.5, 6);
  });

  it("forgives older echoes: novelty never falls as the echo ages, and is flat from day 6", () => {
    const at = (ageDays: number) =>
      noveltyScore(
        outfit,
        context(allOf(w), day(6, 12), history({ suggested: [{ itemIds: ids(w.teeWhite, w.jeans, w.sneakers), ageDays, direction: null }] })),
      );
    const scores = [0, 1, 2, 3, 4, 5, 6, 7, 10].map(at);
    for (let index = 1; index < scores.length; index += 1) {
      expect(scores[index]).toBeGreaterThanOrEqual(scores[index - 1] as number);
    }
    // 1 - 0.7 x 0.9 + 0.1; from day 6 the weight is 0.15: 1 - 0.135 + 0.1
    expect(at(1)).toBeCloseTo(0.47, 6);
    expect(at(6)).toBeCloseTo(0.965, 6);
    expect(at(10)).toBeCloseTo(0.965, 6);
  });

  it("takes the largest echo in full and a quarter of the others", () => {
    const echoes = history({
      suggested: [{ itemIds: ids(w.teeWhite, w.jeans, w.sneakers), ageDays: 0, direction: "classic_balanced" }],
      worn: [{ itemIds: ids(w.teeWhite), ageDays: 2 }],
    });
    // largest 0.9; other 0.5 x 0.6 x 1/3 = 0.1, a quarter of it 0.025
    expect(noveltyScore(outfit, context(allOf(w), day(6, 12), echoes))).toBeCloseTo(1 - 0.925 + 0.1, 6);
  });

  it("tires core pieces worn in the last days and rewards rested ones", () => {
    const tired = { ...w, jeans: { ...w.jeans, daysSinceWorn: 1 } };
    // -0.15; rest mean (1 + 1/30 + 1) / 3
    expect(noveltyScore(outfit, context(allOf(tired)))).toBeCloseTo(1 - 0.15 + 0.1 * ((2 + 1 / 30) / 3), 6);

    const near = { ...w, jeans: { ...w.jeans, daysSinceWorn: 3 } };
    expect(noveltyScore(outfit, context(allOf(near)))).toBe(1);
    const nearAndToday = { ...w, jeans: { ...w.jeans, daysSinceWorn: 3 }, teeWhite: { ...w.teeWhite, daysSinceWorn: 0 } };
    // -0.15 - 0.05; rest mean (0 + 0.1 + 1) / 3
    expect(noveltyScore(outfit, context(allOf(nearAndToday)))).toBeCloseTo(1 - 0.2 + 0.1 * (1.1 / 3), 6);

    // Rest only matters once something costs: a half-rested outfit softens an echo less.
    const echo = history({ suggested: [{ itemIds: ids(w.teeWhite, w.jeans, w.sneakers), ageDays: 0, direction: null }] });
    const halfRested = Object.fromEntries(Object.entries(w).map(([key, item]) => [key, { ...item, daysSinceWorn: 15 }]));
    expect(noveltyScore(outfit, context(Object.values(halfRested), day(6, 12), echo))).toBeCloseTo(0.15, 6);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "treats a daysSinceWorn of %s as never worn, and no part of the score turns NaN",
    (days) => {
      const odd = { ...w, jeans: { ...w.jeans, daysSinceWorn: days } };
      expect(noveltyScore(outfit, context(allOf(odd)))).toBe(noveltyScore(outfit, context(allOf(w))));
      const score = scoreOutfit(outfit, context(allOf(odd)));
      for (const value of Object.values(score)) expect(Number.isFinite(value)).toBe(true);
      expect(score).toEqual(scoreOutfit(outfit, context(allOf(w))));
    },
  );

  it("stays within [0, 1]", () => {
    const many = history({
      suggested: [0, 0, 1, 1].map((ageDays) => ({ itemIds: ids(w.teeWhite, w.jeans, w.sneakers), ageDays, direction: null })),
    });
    const worn = { ...w, jeans: { ...w.jeans, daysSinceWorn: 0 }, teeWhite: { ...w.teeWhite, daysSinceWorn: 0 } };
    expect(noveltyScore(outfit, context(allOf(worn), day(6, 12), many))).toBe(0);
  });
});

describe("tasteScore", () => {
  const w = wardrobe();
  const outfit = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.sneakers], ["socks", w.runSocks]);
  const core = ids(w.teeWhite, w.jeans, w.sneakers);
  const taste = (overrides: Partial<VarietyHistory>) => tasteScore(outfit, context(allOf(w), day(6, 12), history(overrides)));

  it("is neutral without ratings", () => {
    expect(taste({})).toBe(0.5);
  });

  it("rises towards a liked outfit, socks aside, rated 4-5 in full and otherwise at 0.6", () => {
    expect(taste({ liked: [{ itemIds: [...core, w.woolSocks.id], rating: 5, timesWorn: 1, source: "user" }] })).toBeCloseTo(0.9, 6);
    expect(taste({ liked: [{ itemIds: core, rating: 4, timesWorn: 0, source: "ai" }] })).toBeCloseTo(0.9, 6);
    expect(taste({ liked: [{ itemIds: core, rating: null, timesWorn: 3, source: "user" }] })).toBeCloseTo(0.74, 6);
    expect(taste({ liked: [{ itemIds: core, rating: 3, timesWorn: 2, source: "user" }] })).toBeCloseTo(0.74, 6);
    // Shares the tee and jeans, of four core pieces between them: Jaccard 2/4
    expect(taste({ liked: [{ itemIds: ids(w.teeWhite, w.jeans, w.chelsea), rating: 5, timesWorn: 0, source: "user" }] })).toBeCloseTo(
      0.7,
      6,
    );
  });

  it("falls towards a disliked outfit, and takes the closest of each", () => {
    expect(taste({ disliked: [{ itemIds: core, rating: 1, timesWorn: 0, source: "ai" }] })).toBeCloseTo(0.1, 6);
    expect(
      taste({
        liked: [
          { itemIds: ids(w.teeWhite), rating: 5, timesWorn: 0, source: "user" },
          { itemIds: core, rating: 5, timesWorn: 0, source: "user" },
        ],
        disliked: [{ itemIds: core, rating: 2, timesWorn: 0, source: "ai" }],
      }),
    ).toBeCloseTo(0.5, 6);
  });
});

describe("scoreOutfit", () => {
  const w = wardrobe();

  it("keeps every part in [0, 1] and the total the weighted sum (300 random outfits and histories)", () => {
    const random = seededRandom(20261106);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const tops = [w.teeWhite, w.teeNavy, w.teeRed, w.longSleeve, w.oxford, w.hoodie, w.sweater, w.dress];
    const items = allOf(w).map((item) => ({ ...item, daysSinceWorn: random() < 0.3 ? null : Math.floor(random() * 40) }));
    const byId = styleMap(...items);
    const all = [...byId.keys()];

    for (let run = 0; run < 300; run += 1) {
      const outfit: StyleEntry[] = [{ slot: "top", itemId: pick(tops).id }];
      if (random() < 0.5) outfit.push({ slot: "mid_layer", itemId: pick([w.hoodie, w.sweater, w.oxford]).id });
      outfit.push({ slot: "bottom", itemId: pick([w.jeans, w.chinos, w.trousers]).id });
      if (random() < 0.9) outfit.push({ slot: "shoes", itemId: pick([w.sneakers, w.chelsea, w.rainBoots, w.derbies, w.sandals]).id });
      if (random() < 0.6) outfit.push({ slot: "socks", itemId: pick([w.woolSocks, w.dressSocks, w.runSocks, w.cottonSocks]).id });
      if (random() < 0.5) outfit.push({ slot: "outerwear", itemId: pick([w.shell, w.coat]).id });
      const randomIds = () => all.filter(() => random() < 0.25);
      const past = history({
        suggested: [{ itemIds: randomIds(), ageDays: Math.floor(random() * 8), direction: null }],
        worn: [{ itemIds: randomIds(), ageDays: Math.floor(random() * 14) }],
        liked: [{ itemIds: randomIds(), rating: pick([null, 3, 4, 5]), timesWorn: 2, source: "user" }],
        disliked: [{ itemIds: randomIds(), rating: 1, timesWorn: 0, source: "ai" }],
      });
      const weather = pick([day(-4, 2), day(6, 12), day(14, 26), day(8, 13, RAIN)]);
      const score = scoreOutfit(outfit, { items: byId, weather, history: past });

      const { total, ...parts } = score;
      for (const value of Object.values(parts)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      const weighted = (Object.keys(SELECTION_WEIGHTS) as (keyof typeof SELECTION_WEIGHTS)[]).reduce(
        (sum, key) => sum + SELECTION_WEIGHTS[key] * parts[key],
        0,
      );
      // The total is rounded to six decimals, so it can sit up to 5e-7 off the raw sum.
      expect(total).toBeCloseTo(weighted, 5);
      expect(score.weather).toBe(weatherFit(outfit, byId, weather).score);
    }
  });

  it("reads colour and pattern from the visible pieces only", () => {
    const red = { colors: ["red"], colorHex: ["#b3261e"], pattern: "floral" } as const;
    const base = makeStyleItem({ id: "thermal-red", category: "base_layer", ...red });
    const socks = makeStyleItem({ id: "socks-red", category: "socks", ...red });
    const gloves = makeStyleItem({ id: "gloves-red", category: "gloves", ...red });
    const scarf = makeStyleItem({ id: "scarf-red", category: "scarf", ...red });
    const shirt = { ...w.oxford, pattern: "striped" };
    const ctx = context([...allOf(w), base, socks, gloves, scarf, shirt]);
    const outfit = entriesOf(["top", shirt], ["bottom", w.jeans], ["shoes", w.sneakers]);
    const plain = scoreOutfit(outfit, ctx);
    const hidden = scoreOutfit(
      [...outfit, ...entriesOf(["base_layer", base], ["socks", socks], ["gloves", gloves])],
      ctx,
    );
    expect(hidden.color).toBe(plain.color);
    expect(hidden.pattern).toBe(1);
    const withScarf = scoreOutfit([...outfit, ...entriesOf(["scarf", scarf])], ctx);
    expect(withScarf.color).not.toBe(plain.color);
    expect(withScarf.pattern).toBe(patternScore(["striped", "floral"]));
  });
});

// ---------------------------------------------------------------------------
// Companions
// ---------------------------------------------------------------------------

describe("bestCompanion", () => {
  const w = wardrobe();
  const byId = styleMap(...allOf(w));

  it("puts warm socks into sneakers on a cold day", () => {
    const outfit = entriesOf(["outerwear", w.coat], ["mid_layer", w.hoodie], ["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.sneakers]);
    expect(bestCompanion("socks", outfit, context(allOf(w), day(-3, 4)))).toBe(w.woolSocks.id);
    // The cold rule, not the running socks' athletic tag, decides: tagged casual or untagged they still lose.
    for (const formality of ["casual", null] as const) {
      const pool = [...allOf(w).filter((item) => item.id !== w.runSocks.id), { ...w.runSocks, formality }];
      expect(bestCompanion("socks", outfit, context(pool, day(-3, 4)))).toBe(w.woolSocks.id);
    }
    // On a mild day the same casual-tagged running socks win in sneakers.
    const casualRun = [...allOf(w).filter((item) => item.id !== w.runSocks.id), { ...w.runSocks, formality: "casual" as const }];
    expect(bestCompanion("socks", outfit, context(casualRun, day(10, 16)))).toBe(w.runSocks.id);
  });

  it("puts athletic socks into sneakers on a mild day", () => {
    const outfit = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.sneakers]);
    expect(bestCompanion("socks", outfit, context(allOf(w), day(10, 16)))).toBe(w.runSocks.id);
  });

  it("puts dress socks into smart shoes, even on a cold day", () => {
    const outfit = entriesOf(["outerwear", w.coat], ["mid_layer", w.sweater], ["top", w.oxford], ["bottom", w.trousers], ["shoes", w.derbies]);
    expect(bestCompanion("socks", outfit, context(allOf(w), day(10, 16)))).toBe(w.dressSocks.id);
    expect(bestCompanion("socks", outfit, context(allOf(w), day(-3, 4)))).toBe(w.dressSocks.id);
  });

  it("puts warm socks into casual boots on a cold day and light ones on a hot day", () => {
    const outfit = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.rainBoots]);
    expect(bestCompanion("socks", outfit, context(allOf(w), day(-3, 4)))).toBe(w.woolSocks.id);
    const hot = byId.get(bestCompanion("socks", outfit, context(allOf(w), day(22, 30))) ?? "");
    expect(hot === undefined ? null : sockStyle(hot)).toBe("everyday");
  });

  it("puts a neutral tee, not a red one or a shirt, under a hoodie", () => {
    const outfit = entriesOf(["mid_layer", w.hoodie], ["bottom", w.jeans], ["shoes", w.sneakers]);
    const pool = [w.hoodie, w.jeans, w.sneakers, w.teeRed, w.teeWhite, w.oxford];
    expect(bestCompanion("base_top", outfit, context(pool), ["tee", "shirt"])).toBe(w.teeWhite.id);

    // With the whole wardrobe: a tee still, and on a 9 °C day the warmer long-sleeve one.
    const chosen = byId.get(bestCompanion("base_top", outfit, context(allOf(w)), ["tee", "shirt"]) ?? "");
    expect(chosen === undefined ? null : topKind(chosen)).toBe("tee");
    expect(chosen?.id).toBe(w.longSleeve.id);
  });

  it("puts a shirt under a knit when the preference says so, and never a mid-layer top", () => {
    const outfit = entriesOf(["mid_layer", w.sweater], ["bottom", w.chinos], ["shoes", w.chelsea]);
    expect(bestCompanion("base_top", outfit, context(allOf(w)), ["shirt", "tee"])).toBe(w.oxford.id);
    const onlyLayers = [w.sweater, w.chinos, w.chelsea, w.hoodie];
    expect(bestCompanion("base_top", outfit, context(onlyLayers), ["shirt", "tee"])).toBeNull();
  });

  it("never puts a top of unplaced kind under a layer, even when every tee needs repair", () => {
    const outfit = entriesOf(["mid_layer", w.hoodie], ["bottom", w.jeans], ["shoes", w.sneakers]);
    const torn = { ...w.teeWhite, condition: "needs_repair" as const };
    const puffer = makeStyleItem({ id: "top-puffer", category: "top", subcategory: "puffer jacket", seasons: [] });
    const turtleneck = makeStyleItem({ id: "top-turtleneck", category: "top", subcategory: "turtleneck", seasons: [] });
    const pool = [w.hoodie, w.jeans, w.sneakers, torn, puffer, turtleneck];
    expect(bestCompanion("base_top", outfit, context(pool), ["tee", "shirt"])).toBe(torn.id);
    expect(bestCompanion("base_top", outfit, context([w.hoodie, w.jeans, w.sneakers, puffer, turtleneck]), ["tee", "shirt"])).toBeNull();
  });

  it("chooses closed waterproof shoes on a rainy day and closed shoes on a cold dry one", () => {
    const outfit = entriesOf(["outerwear", w.coat], ["top", w.oxford], ["bottom", w.jeans]);
    expect(bestCompanion("shoes", outfit, context(allOf(w), day(8, 13, RAIN)))).toBe(w.rainBoots.id);
    const pool = [w.coat, w.oxford, w.jeans, w.sandals, w.sneakers];
    expect(bestCompanion("shoes", outfit, context(pool, day(2, 8)))).toBe(w.sneakers.id);
  });

  it("leaves out pieces that need repair unless nothing else is left, and the outfit's own pieces", () => {
    const outfit = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.sneakers], ["socks", w.cottonSocks]);
    const torn = { ...w.runSocks, condition: "needs_repair" as const };
    expect(bestCompanion("socks", outfit, context([w.teeWhite, w.jeans, w.sneakers, torn, w.cottonSocks, w.woolSocks]))).toBe(
      w.woolSocks.id,
    );
    expect(bestCompanion("socks", outfit, context([w.teeWhite, w.jeans, w.sneakers, torn, w.cottonSocks]))).toBe(torn.id);
    expect(bestCompanion("socks", outfit, context([w.teeWhite, w.jeans, w.sneakers, w.cottonSocks]))).toBeNull();
  });

  it("ranks socks with a non-finite daysSinceWorn as never worn", () => {
    const outfit = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.chelsea]);
    // Equal but for wear: "socks-a" was worn today, "socks-b" carries a NaN (read as never worn, so rested).
    const wornToday = { ...w.cottonSocks, id: "socks-a", daysSinceWorn: 0 };
    const unknown = { ...w.cottonSocks, id: "socks-b", daysSinceWorn: Number.NaN };
    expect(bestCompanion("socks", outfit, context([w.teeWhite, w.jeans, w.chelsea, wornToday, unknown]))).toBe("socks-b");
  });

  it("reads plimsolls and Italian sneakers as sport shoes, which call for athletic socks", () => {
    for (const subcategory of ["plimsolls", "scarpe da ginnastica", "Sportschuhe", "gym shoes"]) {
      const shoes = { ...w.sneakers, id: "shoes-sport", subcategory, name: null };
      const outfit = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", shoes]);
      expect(bestCompanion("socks", outfit, context([...allOf(w), shoes], day(10, 16))), subcategory).toBe(w.runSocks.id);
    }
  });

  it("breaks ties by item id, whatever the map order", () => {
    const outfit = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.chelsea]);
    const twinA = { ...w.cottonSocks, id: "socks-a" };
    const twinB = { ...w.cottonSocks, id: "socks-b" };
    expect(bestCompanion("socks", outfit, context([w.teeWhite, w.jeans, w.chelsea, twinB, twinA]))).toBe("socks-a");
    expect(bestCompanion("socks", outfit, context([w.teeWhite, w.jeans, w.chelsea, twinA, twinB]))).toBe("socks-a");
  });

  it("prefers another companion that fits about as well to one to avoid, never a clash", () => {
    const outfit = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.chelsea]);
    const twinA = { ...w.cottonSocks, id: "socks-a" };
    const twinB = { ...w.cottonSocks, id: "socks-b" };
    const both = context([w.teeWhite, w.jeans, w.chelsea, twinA, twinB]);
    expect(bestCompanion("socks", outfit, both, [], new Set(["socks-a"]))).toBe("socks-b");
    expect(bestCompanion("socks", outfit, both, [], new Set(["socks-a", "socks-b"]))).toBe("socks-a");
    expect(bestCompanion("socks", outfit, context([w.teeWhite, w.jeans, w.chelsea, twinA]), [], new Set(["socks-a"]))).toBe("socks-a");

    // Under a hoodie, the white tee to avoid gives way to the navy one, another neutral...
    const hoodie = entriesOf(["mid_layer", w.hoodie], ["bottom", w.jeans], ["shoes", w.sneakers]);
    const neutrals = context([w.hoodie, w.jeans, w.sneakers, w.teeRed, w.teeWhite, w.teeNavy, w.oxford]);
    const first = bestCompanion("base_top", hoodie, neutrals, ["tee", "shirt"]);
    expect([w.teeWhite.id, w.teeNavy.id]).toContain(first);
    const other = first === w.teeWhite.id ? w.teeNavy : w.teeWhite;
    expect(bestCompanion("base_top", hoodie, neutrals, ["tee", "shirt"], new Set([first ?? ""]))).toBe(other.id);
    // ...but variety never buys a clash: with only a red tee left, the neutral one repeats.
    const firstItem = first === w.teeWhite.id ? w.teeWhite : w.teeNavy;
    const redOnly = context([w.hoodie, w.jeans, w.sneakers, w.teeRed, firstItem, w.oxford]);
    expect(bestCompanion("base_top", hoodie, redOnly, ["tee", "shirt"], new Set([firstItem.id]))).toBe(firstItem.id);

    // The tier still comes first: waterproof boots to avoid beat dry-weather shoes on a rainy day.
    const bare = entriesOf(["outerwear", w.coat], ["top", w.oxford], ["bottom", w.jeans]);
    expect(bestCompanion("shoes", bare, context(allOf(w), day(8, 13, RAIN)), [], new Set([w.rainBoots.id]))).toBe(w.rainBoots.id);
  });
});

// ---------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------

describe("repairOutfit", () => {
  const w = wardrobe();
  const verdictFor = (entries: readonly StyleEntry[], ctx: ScoreContext): LayerVerdict =>
    assessLayering(entries, ctx.items, wardrobeCounts(ctx.items.values()));

  it("moves a lone hoodie to the mid layer and puts a neutral tee under it", () => {
    const ctx = context(allOf(w));
    const entries = entriesOf(["top", w.hoodie], ["bottom", w.jeans], ["shoes", w.sneakers], ["socks", w.runSocks]);
    const result = repairOutfit(entries, verdictFor(entries, ctx), ctx);
    expect(result.repairs).toEqual(["moved_to_mid", "base_top_added"]);
    expect(result.entries.find((entry) => entry.slot === "mid_layer")?.itemId).toBe(w.hoodie.id);
    const top = ctx.items.get(result.entries.find((entry) => entry.slot === "top")?.itemId ?? "");
    expect(top === undefined ? null : topKind(top)).toBe("tee");
    expect(top?.id).not.toBe(w.teeRed.id);
    expect(result.entries.map((entry) => entry.slot)).toEqual(["mid_layer", "top", "bottom", "shoes", "socks"]);
    // The input is left alone.
    expect(entries[0]).toEqual({ slot: "top", itemId: w.hoodie.id });
  });

  it("swaps a tee worn over a sweater", () => {
    const ctx = context(allOf(w));
    const entries = entriesOf(["top", w.sweater], ["mid_layer", w.teeWhite], ["bottom", w.chinos], ["shoes", w.chelsea], ["socks", w.dressSocks]);
    const result = repairOutfit(entries, verdictFor(entries, ctx), ctx);
    expect(result.repairs).toEqual(["swapped_top_mid"]);
    expect(result.entries.slice(0, 2)).toEqual([
      { slot: "mid_layer", itemId: w.sweater.id },
      { slot: "top", itemId: w.teeWhite.id },
    ]);
  });

  it("adds socks to closed shoes and removes them from sandals", () => {
    const ctx = context(allOf(w), day(-3, 4));
    const boots = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.rainBoots]);
    expect(repairOutfit(boots, verdictFor(boots, ctx), ctx)).toEqual({
      entries: [...boots, { slot: "socks", itemId: w.woolSocks.id }],
      repairs: ["socks_added"],
    });
    const sandals = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.sandals], ["socks", w.runSocks]);
    expect(repairOutfit(sandals, verdictFor(sandals, ctx), ctx)).toEqual({
      entries: sandals.slice(0, 3),
      repairs: ["socks_removed"],
    });
  });

  it("adds shoes and then socks once, for shoes and socks both missing", () => {
    const ctx = context(allOf(w), day(8, 13, RAIN));
    const bare = entriesOf(["outerwear", w.shell], ["top", w.teeWhite], ["bottom", w.jeans]);
    const verdict = verdictFor(bare, ctx);
    expect(verdict.fixes.map((fix) => fix.kind)).toEqual(["add_shoes", "add_socks"]);
    const result = repairOutfit(bare, verdict, ctx);
    expect(result.repairs).toEqual(["shoes_added", "socks_added"]);
    expect(result.entries.filter((entry) => entry.slot === "socks")).toHaveLength(1);
    expect(result.entries.find((entry) => entry.slot === "shoes")?.itemId).toBe(w.rainBoots.id);
  });

  it("re-checks socks after add_shoes alone: closed shoes get socks, open shoes lose them", () => {
    const ctx = context(allOf(w), day(2, 8));
    const bare = entriesOf(["top", w.teeWhite], ["bottom", w.jeans]);
    const result = repairOutfit(bare, { drop: false, fixes: [{ kind: "add_shoes" }], note: null }, ctx);
    expect(result.repairs).toEqual(["shoes_added", "socks_added"]);

    const summer = context([w.teeWhite, w.jeans, w.sandals, w.runSocks], day(24, 30));
    const withSocks = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["socks", w.runSocks]);
    expect(repairOutfit(withSocks, { drop: false, fixes: [{ kind: "add_shoes" }], note: null }, summer)).toEqual({
      entries: entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.sandals]),
      repairs: ["shoes_added", "socks_removed"],
    });
  });

  it("does not add socks to open shoes chosen for an add_shoes + add_socks verdict", () => {
    const summer = context([w.teeWhite, w.jeans, w.sandals, w.runSocks], day(24, 30));
    const bare = entriesOf(["top", w.teeWhite], ["bottom", w.jeans]);
    const verdict = verdictFor(bare, summer);
    expect(verdict.fixes.map((fix) => fix.kind)).toEqual(["add_shoes", "add_socks"]);
    expect(repairOutfit(bare, verdict, summer).repairs).toEqual(["shoes_added"]);
  });

  it("skips a fix whose companion is missing and reports nothing for it", () => {
    const noSocks = context([w.teeWhite, w.jeans, w.sneakers]);
    const entries = entriesOf(["top", w.teeWhite], ["bottom", w.jeans], ["shoes", w.sneakers]);
    expect(repairOutfit(entries, { drop: false, fixes: [{ kind: "add_socks" }], note: null }, noSocks)).toEqual({
      entries,
      repairs: [],
    });

    // No base top to put under the hoodie: the hoodie stays in `top`.
    const noBase = context([w.hoodie, w.sweater, w.jeans, w.sneakers]);
    const hoodie = entriesOf(["top", w.hoodie], ["bottom", w.jeans], ["shoes", w.sneakers]);
    const fixes: LayerVerdict = {
      drop: false,
      fixes: [{ kind: "move_top_to_mid" }, { kind: "add_base_top", prefer: ["tee", "shirt"] }],
      note: null,
    };
    expect(repairOutfit(hoodie, fixes, noBase)).toEqual({ entries: hoodie, repairs: [] });
  });

  it("takes companions other than those to avoid when the wardrobe has another of the tier", () => {
    const ctx = context(allOf(w));
    const hoodie = entriesOf(["top", w.hoodie], ["bottom", w.jeans], ["shoes", w.chelsea]);
    const plain = repairOutfit(hoodie, verdictFor(hoodie, ctx), ctx);
    const tee = plain.entries.find((entry) => entry.slot === "top")?.itemId ?? "";
    const socks = plain.entries.find((entry) => entry.slot === "socks")?.itemId ?? "";
    expect(plain.repairs).toEqual(["moved_to_mid", "base_top_added", "socks_added"]);

    const other = repairOutfit(hoodie, verdictFor(hoodie, ctx), ctx, new Set([tee, socks]));
    expect(other.repairs).toEqual(plain.repairs);
    const otherTee = ctx.items.get(other.entries.find((entry) => entry.slot === "top")?.itemId ?? "");
    expect(otherTee?.id).not.toBe(tee);
    expect(otherTee === undefined ? null : topKind(otherTee)).toBe("tee");
    expect(other.entries.find((entry) => entry.slot === "socks")?.itemId).not.toBe(socks);
  });

  it("changes nothing for a dropped verdict", () => {
    const ctx = context(allOf(w));
    const entries = entriesOf(["mid_layer", w.teeNavy], ["top", w.teeWhite], ["bottom", w.jeans]);
    const verdict = verdictFor(entries, ctx);
    expect(verdict.drop).toBe(true);
    expect(repairOutfit(entries, verdict, ctx)).toEqual({ entries, repairs: [] });
  });
});
