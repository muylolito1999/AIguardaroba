import { describe, expect, it } from "vitest";

import type { ItemCategory } from "@/lib/db/enums";
import { seedFrom } from "@/lib/outfits/style/random";
import { DIRECTION_KEYS, type DirectionKey, type StyleItem } from "@/lib/outfits/style/types";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";

import { makeWeatherSnapshot } from "../../../../test/outfit-fixtures";
import { makeStyleItem } from "../../../../test/style-fixtures";
import {
  assignDirections,
  DIRECTION_LABELS,
  DIRECTION_THRESHOLDS,
  DIRECTION_WEIGHTS,
  directionLabel,
  directionWeight,
  emptyWardrobeProfile,
  FALLBACK_DIRECTION,
  feasibleDirections,
  wardrobeProfile,
  weatherFavoured,
  type WardrobeProfile,
} from "./directions";

/** An item with no season tags; colours and everything else as given. */
function piece(category: ItemCategory, subcategory: string | null, overrides: Partial<StyleItem> = {}): StyleItem {
  return makeStyleItem({ category, subcategory, seasons: [], pattern: "solid", ...overrides });
}

/** A colour by name and hex. */
const color = (name: string, hex: string): Pick<StyleItem, "colors" | "colorHex"> => ({ colors: [name], colorHex: [hex] });

const WHITE = color("white", "#f5f5f2");
const BLACK = color("black", "#111111");
const NAVY = color("navy", "#1f2a44");
const GREY = color("grey", "#8a8d91");
const CHARCOAL = color("charcoal", "#3b3e42");
const DENIM = color("denim", "#3d5a80");
const CAMEL = color("camel", "#c19a6b");
const BEIGE = color("beige", "#d8c3a5");
const BROWN = color("brown", "#6b4a2f");
const TAN = color("tan", "#d2b48c");
const OLIVE = color("olive", "#556b2f");
const RUST = color("rust", "#b7410e");
const RED = color("red", "#b3261e");
const BLUE = color("blue", "#2f5d9e");
const LIGHT_BLUE = color("light blue", "#a7c7e7");

/** A dry, calm November day that feels like minC to maxC. */
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

/** Feels like 8 to 14 °C (mean 11): cool, dry and calm. */
const COOL_DRY = day(8, 14);
const RAINY = day(6, 12, { precipProbMax: 85, precipSumMm: 6, weatherCode: 63, label: "Rain" });
const WINDY = day(6, 12, { windGustMaxKmh: 55 });
const FREEZING = day(-4, 3);
const WARM = day(18, 26);

/** A profile that can dress (one top, one bottom) plus the counts given. */
function profileWith(overrides: Partial<WardrobeProfile>): WardrobeProfile {
  return { ...emptyWardrobeProfile(), tops: 1, bottoms: 1, ...overrides };
}

// ---------------------------------------------------------------------------
// Wardrobes
// ---------------------------------------------------------------------------

/** A varied wardrobe; the profile test below spells out what each item counts as. */
function richWardrobe(): StyleItem[] {
  return [
    // Tops and a dress
    piece("top", "t-shirt", { ...WHITE }),
    piece("top", "oxford shirt", { ...LIGHT_BLUE, formality: "smart_casual" }),
    piece("top", "sweater", { ...NAVY, materials: ["wool"] }),
    piece("top", "hoodie", { ...GREY, pattern: null }),
    piece("top", "blazer", { ...NAVY, materials: ["wool"], pattern: "herringbone", formality: "smart_casual" }),
    piece("top", "turtleneck", { ...BLACK, materials: ["merino"] }),
    piece("top", "tank top", { colors: [], colorHex: [] }),
    piece("dress", "midi dress", { ...OLIVE, materials: ["viscose"], pattern: "floral" }),
    // Bottoms
    piece("bottom", "jeans", { ...DENIM, materials: ["denim"] }),
    piece("bottom", "chinos", { ...BEIGE }),
    piece("bottom", "track pants", { ...BLACK, formality: "athletic", materials: ["polyester"] }),
    piece("bottom", "wool trousers", { ...CHARCOAL, formality: "business", materials: ["wool"] }),
    piece("bottom", "rain trousers", { ...BLACK, waterproof: true, materials: ["nylon"] }),
    // Outerwear
    piece("outerwear", "rain jacket", { ...BLACK, waterproof: true, materials: ["nylon"] }),
    piece("outerwear", "parka", { ...RUST, insulated: true, warmthLevel: 5, materials: ["nylon", "down"] }),
    piece("outerwear", "coat", { ...CAMEL, warmthLevel: 4, materials: ["wool"] }),
    piece("outerwear", "blazer", { ...GREY, formality: "smart_casual" }),
    // Shoes
    piece("shoes", "sneakers", { ...WHITE, materials: ["leather"] }),
    piece("shoes", "loafers", { ...BROWN, materials: ["suede"], formality: "smart_casual" }),
    piece("shoes", "chelsea boots", { ...BLACK, materials: ["leather"], waterproof: true }),
    piece("shoes", "running shoes", { ...BLUE, formality: "athletic", materials: ["mesh"] }),
    piece("shoes", "sandals", { ...TAN, materials: ["leather"] }),
    // Extras, and items that count nowhere
    piece("scarf", "scarf", { ...RED, pattern: "tartan", materials: ["wool"] }),
    piece("hat_beanie", "beanie", { ...GREY, materials: ["wool"] }),
    piece("gloves", "gloves", { ...BLACK }),
    piece("socks", "wool socks", { ...RED, pattern: "striped" }),
    piece("base_layer", "thermal top", { ...BLACK, formality: "athletic" }),
    piece("bag", "tote", { ...color("yellow", "#e3b505"), pattern: "graphic print" }),
  ];
}

/** Tees, a hoodie, jeans and sneakers: nothing with a collar, nothing tailored. */
function casualWardrobe(): StyleItem[] {
  return [
    piece("top", "t-shirt", { ...WHITE }),
    piece("top", "t-shirt", { ...BLACK }),
    piece("top", "hoodie", { ...GREY }),
    piece("top", "sweatshirt", { ...NAVY }),
    piece("bottom", "jeans", { ...DENIM, materials: ["denim"] }),
    piece("bottom", "joggers", { ...GREY, formality: "athletic" }),
    piece("outerwear", "puffer jacket", { ...BLACK, insulated: true, warmthLevel: 5, waterproof: true }),
    piece("shoes", "sneakers", { ...WHITE }),
  ];
}

/** Four pieces: two candidate directions on a cool dry day (tonal neutrals, sporty clean). */
function tinyWardrobe(): StyleItem[] {
  return [
    piece("top", "t-shirt", { ...WHITE }),
    piece("top", "hoodie", { ...GREY }),
    piece("bottom", "jeans", { ...DENIM, materials: ["denim"] }),
    piece("shoes", "sneakers", { ...WHITE }),
  ];
}

const RICH = wardrobeProfile(richWardrobe());

/** How often each key appears across `seeds` assignments. */
function tally(
  seeds: number,
  input: Omit<Parameters<typeof assignDirections>[0], "seed">,
): Map<DirectionKey, number> {
  const counts = new Map<DirectionKey, number>();
  for (let seed = 0; seed < seeds; seed += 1) {
    for (const key of assignDirections({ ...input, seed })) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe("DIRECTION_LABELS", () => {
  it("labels every key and nothing else", () => {
    expect(Object.keys(DIRECTION_LABELS).sort()).toEqual([...DIRECTION_KEYS].sort());
  });

  it.each(DIRECTION_KEYS)("labels %s in sentence case, at most 24 characters", (key) => {
    const label = DIRECTION_LABELS[key];
    expect(label.length).toBeGreaterThan(0);
    expect(label.length).toBeLessThanOrEqual(24);
    expect(label).toMatch(/^[A-Z][a-z]*(?:[ -][a-z]+)*$/);
  });

  it("gives every key a different label", () => {
    const labels = Object.values(DIRECTION_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("uses no word the prompt rules forbid, and UK spelling", () => {
    for (const label of Object.values(DIRECTION_LABELS)) {
      expect(label).not.toMatch(/reasoning|thinking|thought/i);
      expect(label).not.toMatch(/cozy|color/i);
    }
    expect(DIRECTION_LABELS.cosy_winter).toBe("Cosy winter");
  });
});

describe("directionLabel", () => {
  it("labels a known key", () => {
    expect(directionLabel("smart_collar")).toBe("Smart collar");
    expect(directionLabel("classic_balanced")).toBe("Classic and balanced");
  });

  it.each([["retro_glam"], [""], ["Smart_collar"], ["constructor"], ["toString"], [null], [undefined]])(
    "is null for %j",
    (key) => {
      expect(directionLabel(key)).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

describe("wardrobeProfile", () => {
  it("counts a hand-built wardrobe", () => {
    expect(RICH).toEqual<WardrobeProfile>({
      tops: 7, // the tank top has no colour and the turtleneck no kind, but both are tops
      tees: 2, // t-shirt, tank top
      shirts: 1, // oxford shirt
      knits: 1, // sweater
      sweats: 1, // hoodie
      tailored: 2, // the blazer top and the blazer filed as outerwear
      dresses: 1,
      bottoms: 5,
      jeans: 1,
      smartBottoms: 2, // chinos (by name), wool trousers (business); not track pants (athletic) or rain trousers
      outerwear: 4,
      waterproofOuter: 1, // rain jacket
      insulatedOuter: 2, // parka (insulated), wool coat (warmth 4)
      windproofOuter: 0, // nothing is tagged windproof
      shoes: 5,
      closedShoes: 3, // sneakers, chelsea boots, running shoes; not loafers or sandals
      smartShoes: 2, // loafers (smart casual), chelsea boots (by name)
      sneakers: 2, // sneakers, running shoes (athletic and by name)
      waterproofShoes: 1, // chelsea boots
      athleticPieces: 1, // track pants; not the running shoes (shoes) or the thermal (base layer)
      // white tee, sweater, hoodie, blazer, turtleneck, dress, jeans, chinos, track pants, wool trousers,
      // rain trousers, rain jacket, coat, outer blazer, sneakers, loafers, chelsea boots, sandals
      neutralPieces: 18,
      neutralUpper: 6, // white tee, sweater, hoodie, blazer, turtleneck, dress
      neutralLower: 6, // the five bottoms and the dress
      // sweater, blazer, turtleneck, olive dress, track pants, wool trousers, rain trousers, rain jacket,
      // brown loafers, chelsea boots
      darkNeutralPieces: 10,
      darkUpper: 4, // sweater, blazer, turtleneck, olive dress
      darkLower: 4, // track pants, wool trousers, rain trousers, olive dress
      lightPieces: 5, // white tee, light blue shirt, beige chinos, white sneakers, tan sandals
      lightUpper: 2, // white tee, light blue shirt
      lightLower: 1, // beige chinos
      earthPieces: 6, // olive dress, beige chinos, rust parka, camel coat, brown loafers, tan sandals
      accentPieces: 4, // light blue shirt, rust parka, blue running shoes, red scarf; not the grey beanie
      patterned: 2, // floral dress, tartan scarf; not the socks or the bag
      // sweater, blazer (herringbone and wool, once), jeans (denim), wool trousers, coat, sneakers, loafers,
      // chelsea boots, sandals; not the merino turtleneck, the scarf or the beanie
      textured: 9,
      texturedUpper: 2, // sweater, blazer
      texturedLowerOrOuter: 3, // jeans, wool trousers, coat
      hats: 1,
      scarves: 1,
      gloves: 1,
    });
  });

  it("is all zeros for an empty wardrobe", () => {
    expect(wardrobeProfile([])).toEqual(emptyWardrobeProfile());
  });

  it("accepts any iterable", () => {
    const items = new Map(tinyWardrobe().map((item) => [item.id, item]));
    expect(wardrobeProfile(items.values())).toEqual(wardrobeProfile(tinyWardrobe()));
  });

  it.each<[string, StyleItem, Partial<WardrobeProfile>]>([
    ["denim by material", piece("bottom", "skirt", { ...DENIM, materials: ["stretch denim"] }), { jeans: 1 }],
    ["German jeans", piece("bottom", null, { name: "Jeanshose" }), { jeans: 1 }],
    ["pleated trousers", piece("bottom", "pleated trousers"), { smartBottoms: 1 }],
    ["Italian trousers", piece("bottom", "pantaloni"), { smartBottoms: 1 }],
    ["cargo trousers", piece("bottom", "cargo trousers"), { smartBottoms: 0 }],
    ["smart-casual jeans", piece("bottom", "jeans", { formality: "smart_casual" }), { jeans: 1, smartBottoms: 1 }],
    ["athletic chinos", piece("bottom", "chinos", { formality: "athletic" }), { smartBottoms: 0, athleticPieces: 1 }],
    ["derbies", piece("shoes", "derbies"), { smartShoes: 1, closedShoes: 1 }],
    ["athletic oxfords", piece("shoes", "oxfords", { formality: "athletic" }), { smartShoes: 0, sneakers: 1 }],
    ["trainers", piece("shoes", "trainers"), { sneakers: 1, closedShoes: 1 }],
    ["German sneakers", piece("shoes", null, { name: "Turnschuhe" }), { sneakers: 1 }],
    ["sport shoes", piece("shoes", "sport shoes"), { sneakers: 1 }],
    ["gym shoes", piece("shoes", "gym shoes"), { sneakers: 1 }],
    ["cross trainers in one word", piece("shoes", "Crosstrainers"), { sneakers: 1 }],
    ["Italian sneakers", piece("shoes", "scarpe da ginnastica"), { sneakers: 1 }],
    ["sneaker socks", piece("socks", "sneaker socks"), { sneakers: 0 }],
    ["a windproof jacket", piece("outerwear", "windbreaker", { windproof: true }), { windproofOuter: 1, waterproofOuter: 0 }],
    ["a black tee", piece("top", "t-shirt", { ...BLACK }), { neutralUpper: 1, darkUpper: 1, neutralLower: 0, darkLower: 0 }],
    ["white jeans", piece("bottom", "jeans", { ...WHITE }), { lightLower: 1, lightUpper: 0, neutralLower: 1 }],
    [
      "a wool knit dress, upper and lower at once",
      piece("dress", "knit dress", { ...CHARCOAL, materials: ["wool"] }),
      { textured: 1, texturedUpper: 1, texturedLowerOrOuter: 1, darkUpper: 1, darkLower: 1 },
    ],
    ["a wool coat", piece("outerwear", "coat", { materials: ["wool"] }), { textured: 1, texturedUpper: 0, texturedLowerOrOuter: 1 }],
    ["leather shoes", piece("shoes", "derbies", { ...BLACK, materials: ["leather"] }), { textured: 1, texturedLowerOrOuter: 0, darkLower: 0 }],
    ["a sport coat filed as outerwear", piece("outerwear", "sport coat"), { tailored: 1 }],
    ["a rain jacket", piece("outerwear", "rain jacket"), { tailored: 0 }],
    ["a corduroy shirt", piece("top", "shirt", { materials: ["cotton corduroy"] }), { textured: 1 }],
    ["denim jeans", piece("bottom", "jeans", { ...DENIM, materials: ["denim"] }), { jeans: 1, textured: 1, texturedLowerOrOuter: 1 }],
    ["a stretch denim jacket", piece("outerwear", "jacket", { materials: ["Stretch-Denim"] }), { textured: 1, texturedLowerOrOuter: 1 }],
    ["a denim shirt", piece("top", "shirt", { materials: ["cotton", "denim"] }), { textured: 1, texturedUpper: 1 }],
    ["a cable knit", piece("top", "cardigan", { pattern: "cable knit" }), { textured: 1, knits: 1 }],
    ["a ripstop jacket", piece("outerwear", "shell", { materials: ["cordura nylon"] }), { textured: 0 }],
  ])("reads %s", (_, item, expected) => {
    expect(wardrobeProfile([item])).toMatchObject(expected);
  });
});

// ---------------------------------------------------------------------------
// Feasibility
// ---------------------------------------------------------------------------

describe("feasibleDirections", () => {
  it("lists the rich wardrobe's directions on a cool dry day, in key order", () => {
    expect(feasibleDirections(RICH, COOL_DRY)).toEqual([
      "tonal_neutrals",
      "dark_monochrome",
      // light_and_airy: a mean of 11 °C is below 12
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
      // weather_ready: dry, calm, above freezing; cosy_winter: too mild
      "dress_led",
      "classic_balanced",
    ]);
  });

  it("always includes the fallback, and keeps DIRECTION_KEYS order", () => {
    for (const weather of [COOL_DRY, RAINY, WINDY, FREEZING, WARM]) {
      for (const profile of [RICH, wardrobeProfile(casualWardrobe()), wardrobeProfile(tinyWardrobe())]) {
        const keys = feasibleDirections(profile, weather);
        expect(keys).toContain(FALLBACK_DIRECTION);
        expect(keys).toEqual(DIRECTION_KEYS.filter((key) => keys.includes(key)));
      }
    }
  });

  it("offers only the fallback to a wardrobe that cannot make an outfit", () => {
    expect(feasibleDirections(wardrobeProfile([]), COOL_DRY)).toEqual(["classic_balanced"]);
    // Plenty of neutrals, gear and smart shoes, but no top and bottom and no dress.
    const noOutfit = richWardrobe().filter((item) => !["top", "bottom", "dress"].includes(item.category));
    expect(feasibleDirections(wardrobeProfile(noOutfit), RAINY)).toEqual(["classic_balanced"]);
    // Tops without bottoms.
    const topsOnly = richWardrobe().filter((item) => item.category === "top");
    expect(feasibleDirections(wardrobeProfile(topsOnly), COOL_DRY)).toEqual(["classic_balanced"]);
  });

  it("lets a dress alone make an outfit", () => {
    const keys = feasibleDirections(wardrobeProfile([piece("dress", "wrap dress", { ...RED })]), COOL_DRY);
    expect(keys).toEqual(["dress_led", "classic_balanced"]);
  });

  it("never offers collar or tailoring looks to a wardrobe without shirts or tailoring", () => {
    const casual = wardrobeProfile(casualWardrobe());
    expect(casual.shirts).toBe(0);
    expect(casual.tailored).toBe(0);
    for (const weather of [COOL_DRY, RAINY, WINDY, FREEZING, WARM]) {
      const keys = feasibleDirections(casual, weather);
      expect(keys).not.toContain("smart_collar");
      expect(keys).not.toContain("preppy_layers");
      expect(keys).not.toContain("sharp_tailoring");
      expect(keys).toContain("sporty_clean");
    }
  });

  it("needs smart trousers as well as a shirt for a smart collar", () => {
    const withShirt = wardrobeProfile([...casualWardrobe(), piece("top", "shirt", { ...WHITE })]);
    expect(feasibleDirections(withShirt, COOL_DRY)).not.toContain("smart_collar");
    const withChinos = wardrobeProfile([...casualWardrobe(), piece("top", "shirt"), piece("bottom", "chinos")]);
    expect(feasibleDirections(withChinos, COOL_DRY)).toContain("smart_collar");
  });

  it("keeps light and airy off a cold day", () => {
    expect(RICH.lightPieces).toBeGreaterThanOrEqual(DIRECTION_THRESHOLDS.lightPieces);
    expect(feasibleDirections(RICH, day(2, 8))).not.toContain("light_and_airy");
    expect(feasibleDirections(RICH, day(9, 14))).not.toContain("light_and_airy");
    expect(feasibleDirections(RICH, day(10, 14))).toContain("light_and_airy");
    expect(feasibleDirections(RICH, WARM)).toContain("light_and_airy");
  });

  it("keeps knit layers off a warm day", () => {
    expect(feasibleDirections(RICH, day(14, 22))).toContain("knit_layers");
    expect(feasibleDirections(RICH, day(15, 23))).not.toContain("knit_layers");
  });

  it("offers cosy winter only when it is cold, and only with a knit or a warm coat", () => {
    expect(feasibleDirections(RICH, FREEZING)).toContain("cosy_winter");
    expect(feasibleDirections(RICH, day(2, 8))).toContain("cosy_winter");
    expect(feasibleDirections(RICH, day(3, 8))).not.toContain("cosy_winter");
    expect(feasibleDirections(RICH, COOL_DRY)).not.toContain("cosy_winter");
    expect(feasibleDirections(RICH, WARM)).not.toContain("cosy_winter");
    // Tees, a hoodie and an unlined jacket: nothing cosy to wear.
    const thin = wardrobeProfile([
      piece("top", "t-shirt"),
      piece("top", "hoodie"),
      piece("bottom", "jeans"),
      piece("outerwear", "denim jacket", { warmthLevel: 2 }),
    ]);
    expect(feasibleDirections(thin, FREEZING)).not.toContain("cosy_winter");
  });

  it("offers weather-ready only on a rainy, windy or freezing day, and only with gear", () => {
    expect(feasibleDirections(RICH, COOL_DRY)).not.toContain("weather_ready");
    expect(feasibleDirections(RICH, WARM)).not.toContain("weather_ready");
    expect(feasibleDirections(RICH, RAINY)).toContain("weather_ready");
    expect(feasibleDirections(RICH, day(6, 12, { precipSumMm: 2 }))).toContain("weather_ready");
    expect(feasibleDirections(RICH, WINDY)).toContain("weather_ready");
    expect(feasibleDirections(RICH, day(6, 12, { windGustMaxKmh: 39 }))).not.toContain("weather_ready");
    expect(feasibleDirections(RICH, FREEZING)).toContain("weather_ready");
    expect(feasibleDirections(RICH, day(0, 8))).toContain("weather_ready");
    expect(feasibleDirections(RICH, day(0.5, 8))).not.toContain("weather_ready");

    const noGear = wardrobeProfile(tinyWardrobe());
    for (const weather of [RAINY, WINDY, FREEZING]) {
      expect(feasibleDirections(noGear, weather)).not.toContain("weather_ready");
    }
    // Rain boots keep the wearer dry only under some outerwear (keepsDry).
    const rainBoots = piece("shoes", "rain boots", { waterproof: true });
    const bootsOnly = wardrobeProfile([...tinyWardrobe(), rainBoots]);
    expect(feasibleDirections(bootsOnly, RAINY)).not.toContain("weather_ready");
    const bootsAndCoat = wardrobeProfile([...tinyWardrobe(), rainBoots, piece("outerwear", "wool coat", { waterproof: false })]);
    expect(feasibleDirections(bootsAndCoat, RAINY)).toContain("weather_ready");
    const shellOnly = wardrobeProfile([...tinyWardrobe(), piece("outerwear", "rain jacket", { waterproof: true })]);
    expect(feasibleDirections(shellOnly, RAINY)).toContain("weather_ready");
  });

  it.each<[DirectionKey, Partial<WardrobeProfile>, Partial<WardrobeProfile>]>([
    ["tonal_neutrals", { neutralPieces: 4, neutralUpper: 1, neutralLower: 1 }, { neutralPieces: 3, neutralUpper: 1, neutralLower: 1 }],
    ["tonal_neutrals", { neutralPieces: 4, neutralUpper: 1, neutralLower: 1 }, { neutralPieces: 9, neutralUpper: 0, neutralLower: 3 }],
    ["tonal_neutrals", { neutralPieces: 4, neutralUpper: 1, neutralLower: 1 }, { neutralPieces: 9, neutralUpper: 3, neutralLower: 0 }],
    ["dark_monochrome", { darkNeutralPieces: 3, darkUpper: 1, darkLower: 1 }, { darkNeutralPieces: 2, darkUpper: 1, darkLower: 1 }],
    ["dark_monochrome", { darkNeutralPieces: 3, darkUpper: 1, darkLower: 1 }, { darkNeutralPieces: 9, darkUpper: 0, darkLower: 3 }],
    ["dark_monochrome", { darkNeutralPieces: 3, darkUpper: 1, darkLower: 1 }, { darkNeutralPieces: 9, darkUpper: 3, darkLower: 0 }],
    ["neutral_with_accent", { accentPieces: 1, neutralPieces: 3 }, { accentPieces: 0, neutralPieces: 9 }],
    ["neutral_with_accent", { accentPieces: 1, neutralPieces: 3 }, { accentPieces: 5, neutralPieces: 2 }],
    ["smart_collar", { shirts: 1, smartBottoms: 1 }, { shirts: 0, smartBottoms: 3 }],
    ["elevated_denim", { jeans: 1, knits: 1, closedShoes: 1 }, { jeans: 1, knits: 1 }],
    ["elevated_denim", { jeans: 1, tailored: 1, smartShoes: 1 }, { jeans: 0, tailored: 1, smartShoes: 1 }],
    ["elevated_denim", { jeans: 1, shirts: 1, smartShoes: 1 }, { jeans: 1, tees: 3, sweats: 2, smartShoes: 1 }],
    ["earth_tones", { earthPieces: 3 }, { earthPieces: 2 }],
    ["preppy_layers", { shirts: 1, knits: 1, smartBottoms: 1 }, { shirts: 1, knits: 0, smartBottoms: 1 }],
    ["sporty_clean", { sneakers: 1, sweats: 1 }, { sneakers: 0, sweats: 2 }],
    ["sporty_clean", { sneakers: 1, athleticPieces: 1 }, { sneakers: 1 }],
    ["texture_play", { textured: 3, texturedUpper: 1, texturedLowerOrOuter: 1 }, { textured: 2, texturedUpper: 1, texturedLowerOrOuter: 1 }],
    ["texture_play", { textured: 3, texturedUpper: 1, texturedLowerOrOuter: 1 }, { textured: 9, texturedUpper: 0, texturedLowerOrOuter: 3 }],
    ["texture_play", { textured: 3, texturedUpper: 1, texturedLowerOrOuter: 1 }, { textured: 9, texturedUpper: 3, texturedLowerOrOuter: 0 }],
    ["sharp_tailoring", { tailored: 1, smartBottoms: 1, smartShoes: 1 }, { tailored: 1, smartBottoms: 1 }],
    ["pattern_anchor", { patterned: 1, neutralPieces: 2 }, { patterned: 1, neutralPieces: 1 }],
    ["knit_layers", { knits: 1, tees: 1 }, { knits: 1, sweats: 1 }],
    ["dress_led", { dresses: 1 }, { dresses: 0 }],
  ])("decides %s on its counts", (key, enough, short) => {
    expect(feasibleDirections(profileWith(enough), COOL_DRY)).toContain(key);
    expect(feasibleDirections(profileWith(short), COOL_DRY)).not.toContain(key);
  });

  it("decides light and airy on its counts, on a warm day", () => {
    const enough = { lightPieces: 2, lightUpper: 1, lightLower: 1 };
    expect(feasibleDirections(profileWith(enough), WARM)).toContain("light_and_airy");
    for (const short of [
      { lightPieces: 1, lightUpper: 1, lightLower: 1 },
      { lightPieces: 9, lightUpper: 0, lightLower: 3 },
      { lightPieces: 9, lightUpper: 3, lightLower: 0 },
    ]) {
      expect(feasibleDirections(profileWith(short), WARM)).not.toContain("light_and_airy");
    }
  });

  describe("looks that need a top and a bottom of their own", () => {
    /** A red tee and blue chinos: neither neutral, dark, light nor textured. */
    const plain = () => [piece("top", "t-shirt", { ...RED }), piece("bottom", "chinos", { ...BLUE })];
    const blackLeatherShoes = () => [1, 2, 3, 4].map(() => piece("shoes", "derbies", { ...BLACK, materials: ["leather"] }));

    it("are never made by shoes alone", () => {
      const shoesOnly = wardrobeProfile([...plain(), ...blackLeatherShoes()]);
      expect(shoesOnly).toMatchObject({ neutralPieces: 4, darkNeutralPieces: 4, textured: 4 });
      for (const weather of [COOL_DRY, WARM]) {
        const keys = feasibleDirections(shoesOnly, weather);
        expect(keys).not.toContain("tonal_neutrals");
        expect(keys).not.toContain("dark_monochrome");
        expect(keys).not.toContain("texture_play");
      }
      const whiteSneakers = wardrobeProfile([...plain(), piece("shoes", "sneakers", { ...WHITE }), piece("shoes", "sneakers", { ...WHITE })]);
      expect(whiteSneakers.lightPieces).toBe(2);
      expect(feasibleDirections(whiteSneakers, WARM)).not.toContain("light_and_airy");
    });

    it("are made once a top and a bottom (or a dress) join in", () => {
      const dressed = wardrobeProfile([
        ...plain(),
        ...blackLeatherShoes(),
        piece("top", "sweater", { ...BLACK, materials: ["wool"] }),
        piece("bottom", "trousers", { ...CHARCOAL, materials: ["wool"] }),
      ]);
      expect(feasibleDirections(dressed, COOL_DRY)).toEqual(
        expect.arrayContaining(["tonal_neutrals", "dark_monochrome", "texture_play"]),
      );
      const knitDress = wardrobeProfile([...plain(), ...blackLeatherShoes(), piece("dress", "knit dress", { ...BLACK, materials: ["wool"] })]);
      expect(feasibleDirections(knitDress, COOL_DRY)).toEqual(
        expect.arrayContaining(["tonal_neutrals", "dark_monochrome", "texture_play"]),
      );
      const light = wardrobeProfile([...plain(), piece("top", "t-shirt", { ...WHITE }), piece("bottom", "jeans", { ...WHITE })]);
      expect(feasibleDirections(light, WARM)).toContain("light_and_airy");
    });

    it("lets textured outerwear stand in for the bottom in mixed textures", () => {
      const coat = wardrobeProfile([
        ...plain(),
        ...blackLeatherShoes(),
        piece("top", "cardigan", { pattern: "cable knit" }),
        piece("outerwear", "coat", { materials: ["wool", "tweed"] }),
      ]);
      expect(coat).toMatchObject({ texturedUpper: 1, texturedLowerOrOuter: 1 });
      expect(feasibleDirections(coat, COOL_DRY)).toContain("texture_play");
    });
  });

  it("asks for weather gear that fits the day: rain, then frost, then wind", () => {
    // Rain boots under a light jacket that is neither waterproof, insulated nor windproof.
    const boots = wardrobeProfile([
      ...tinyWardrobe(),
      piece("shoes", "rain boots", { waterproof: true }),
      piece("outerwear", "denim jacket", { warmthLevel: 2, waterproof: false, insulated: false, windproof: false }),
    ]);
    expect(feasibleDirections(boots, RAINY)).toContain("weather_ready");
    expect(feasibleDirections(boots, FREEZING)).not.toContain("weather_ready");
    expect(feasibleDirections(boots, WINDY)).not.toContain("weather_ready");

    const warmCoat = wardrobeProfile([...tinyWardrobe(), piece("outerwear", "wool coat", { warmthLevel: 4 })]);
    expect(feasibleDirections(warmCoat, FREEZING)).toContain("weather_ready");
    expect(feasibleDirections(warmCoat, RAINY)).not.toContain("weather_ready");
    expect(feasibleDirections(warmCoat, WINDY)).not.toContain("weather_ready");

    const windbreaker = wardrobeProfile([...tinyWardrobe(), piece("outerwear", "windbreaker", { windproof: true })]);
    expect(feasibleDirections(windbreaker, WINDY)).toContain("weather_ready");
    expect(feasibleDirections(windbreaker, RAINY)).not.toContain("weather_ready");
    expect(feasibleDirections(windbreaker, FREEZING)).not.toContain("weather_ready");

    // A waterproof shell keeps the wind out too.
    const shell = wardrobeProfile([...tinyWardrobe(), piece("outerwear", "rain jacket", { waterproof: true })]);
    expect(feasibleDirections(shell, WINDY)).toContain("weather_ready");
    expect(feasibleDirections(shell, RAINY)).toContain("weather_ready");

    // Rain on a freezing day: the rain decides.
    const freezingRain = day(-4, 3, { precipProbMax: 90, precipSumMm: 8 });
    expect(feasibleDirections(boots, freezingRain)).toContain("weather_ready");
    expect(feasibleDirections(warmCoat, freezingRain)).not.toContain("weather_ready");
  });
});

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

describe("weatherFavoured", () => {
  it.each<[DirectionKey, WeatherSnapshot, boolean]>([
    ["weather_ready", RAINY, true],
    ["weather_ready", WINDY, true],
    ["weather_ready", FREEZING, true],
    ["weather_ready", COOL_DRY, false],
    ["cosy_winter", day(0, 10), true],
    ["cosy_winter", day(1, 10), false],
    ["light_and_airy", day(16, 24), true],
    ["light_and_airy", day(15, 24), false],
    ["knit_layers", day(2, 8), true],
    ["knit_layers", COOL_DRY, true],
    ["knit_layers", day(12, 18), true],
    ["knit_layers", day(12, 19), false],
    ["knit_layers", day(0, 9), false],
    ["smart_collar", RAINY, false],
    ["classic_balanced", FREEZING, false],
  ])("%s, case %#", (key, weather, favoured) => {
    expect(weatherFavoured(key, weather)).toBe(favoured);
  });
});

describe("directionWeight", () => {
  const W = DIRECTION_WEIGHTS;

  it("is the base weight with nothing to say", () => {
    expect(directionWeight("smart_collar", COOL_DRY, [])).toBe(W.base);
  });

  it("doubles a weather-favoured direction", () => {
    expect(directionWeight("knit_layers", COOL_DRY, [])).toBe(W.base * W.weatherFavoured);
    expect(directionWeight("weather_ready", RAINY, [])).toBe(2);
  });

  it("cuts a direction used today or yesterday", () => {
    expect(directionWeight("smart_collar", COOL_DRY, [{ key: "smart_collar", ageDays: 0 }])).toBeCloseTo(0.2);
    expect(directionWeight("smart_collar", COOL_DRY, [{ key: "smart_collar", ageDays: 1 }])).toBeCloseTo(0.5);
    expect(directionWeight("knit_layers", COOL_DRY, [{ key: "knit_layers", ageDays: 0 }])).toBeCloseTo(0.4);
  });

  it("multiplies repeated uses, down to the floor", () => {
    const today = { key: "smart_collar", ageDays: 0 };
    const yesterday = { key: "smart_collar", ageDays: 1 };
    expect(directionWeight("smart_collar", COOL_DRY, [today, yesterday])).toBeCloseTo(0.1);
    expect(directionWeight("smart_collar", COOL_DRY, [yesterday, yesterday])).toBeCloseTo(0.25);
    expect(directionWeight("smart_collar", COOL_DRY, [today, today])).toBeCloseTo(W.minRecency);
    expect(directionWeight("smart_collar", COOL_DRY, [today, today, today, today])).toBeCloseTo(W.minRecency);
  });

  it("ignores other keys, unknown keys and older uses", () => {
    const recent = [
      { key: "knit_layers", ageDays: 0 },
      { key: "retro_glam", ageDays: 0 },
      { key: "smart_collar", ageDays: 2 },
    ];
    expect(directionWeight("smart_collar", COOL_DRY, recent)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe("assignDirections", () => {
  const base = { profile: RICH, weather: COOL_DRY, recent: [], count: 5 } as const;
  const candidates = feasibleDirections(RICH, COOL_DRY).filter((key) => key !== FALLBACK_DIRECTION);

  it("assigns exactly `count` distinct feasible directions, never the fallback while others remain", () => {
    expect(candidates).toHaveLength(13);
    for (const count of [1, 3, 5, 13]) {
      for (let seed = 0; seed < 20; seed += 1) {
        const keys = assignDirections({ ...base, count, seed });
        expect(keys).toHaveLength(count);
        expect(new Set(keys).size).toBe(count);
        for (const key of keys) expect(candidates).toContain(key);
      }
    }
  });

  it("is deterministic", () => {
    const seed = seedFrom("2026-11-06|hamburg|0");
    expect(assignDirections({ ...base, seed })).toEqual(assignDirections({ ...base, seed }));
    const recent = [{ key: "smart_collar", ageDays: 0 }];
    expect(assignDirections({ ...base, recent, seed })).toEqual(assignDirections({ ...base, recent, seed }));
  });

  it("rotates between seeds", () => {
    const sets = new Set<string>();
    const firsts = new Set<DirectionKey>();
    for (let run = 0; run < 20; run += 1) {
      const keys = assignDirections({ ...base, seed: seedFrom(`2026-11-06|hamburg|${run}`) });
      sets.add([...keys].sort().join(","));
      firsts.add(keys[0]);
    }
    expect(sets.size).toBeGreaterThanOrEqual(15);
    expect(firsts.size).toBeGreaterThanOrEqual(6);
  });

  it("reaches every candidate over enough seeds", () => {
    const counts = tally(200, base);
    expect([...counts.keys()].sort()).toEqual([...candidates].sort());
  });

  it("draws a direction used today much less often, and one used yesterday less often", () => {
    const without = tally(200, base).get("smart_collar") ?? 0;
    const today = tally(200, { ...base, recent: [{ key: "smart_collar", ageDays: 0 }] }).get("smart_collar") ?? 0;
    const yesterday = tally(200, { ...base, recent: [{ key: "smart_collar", ageDays: 1 }] }).get("smart_collar") ?? 0;
    expect(without).toBeGreaterThan(40);
    expect(today).toBeLessThan(without * 0.5);
    expect(yesterday).toBeLessThan(without);
    expect(yesterday).toBeGreaterThan(today);
  });

  it("draws a weather-favoured direction more often", () => {
    // Knit layers is favoured at a mean of 11 °C, not at 17 °C; both days offer it.
    const favoured = tally(200, base);
    const knit = favoured.get("knit_layers") ?? 0;
    const others = candidates.filter((key) => key !== "knit_layers").map((key) => favoured.get(key) ?? 0);
    expect(knit).toBeGreaterThan(Math.max(...others));
    const mild = tally(200, { ...base, weather: day(14, 20) });
    expect(knit).toBeGreaterThan((mild.get("knit_layers") ?? 0) * 1.3);

    // Weather-ready on a rainy day, against the average direction.
    const rainy = tally(200, { ...base, weather: RAINY });
    const pool = feasibleDirections(RICH, RAINY).filter((key) => key !== FALLBACK_DIRECTION);
    const mean = (200 * base.count) / pool.length;
    expect(rainy.get("weather_ready") ?? 0).toBeGreaterThan(mean * 1.3);
  });

  it("pads a tiny wardrobe with the fallback, then repeats the highest-weight keys", () => {
    const tiny = wardrobeProfile(tinyWardrobe());
    expect(feasibleDirections(tiny, COOL_DRY)).toEqual(["tonal_neutrals", "sporty_clean", "classic_balanced"]);
    for (let seed = 0; seed < 10; seed += 1) {
      const keys = assignDirections({ profile: tiny, weather: COOL_DRY, recent: [], count: 5, seed });
      expect(keys).toHaveLength(5);
      expect([...keys.slice(0, 2)].sort()).toEqual(["sporty_clean", "tonal_neutrals"]);
      // All weights equal: ties in key order.
      expect(keys.slice(2)).toEqual(["classic_balanced", "tonal_neutrals", "sporty_clean"]);
    }
    // Tonal neutrals used today now weighs least, so it repeats last.
    const recent = [{ key: "tonal_neutrals", ageDays: 0 }];
    const keys = assignDirections({ profile: tiny, weather: COOL_DRY, recent, count: 6, seed: 3 });
    expect(keys.slice(2)).toEqual(["classic_balanced", "sporty_clean", "classic_balanced", "tonal_neutrals"]);
  });

  it("puts the fallback right after the feasible directions run out", () => {
    const fourteen = assignDirections({ ...base, count: 14, seed: 7 });
    expect(new Set(fourteen.slice(0, 13))).toEqual(new Set(candidates));
    expect(fourteen[13]).toBe(FALLBACK_DIRECTION);
    // Then the favoured knit layers (weight 2) repeats first.
    expect(assignDirections({ ...base, count: 15, seed: 7 })[14]).toBe("knit_layers");
  });

  it("fills every slot with the fallback when nothing else is feasible", () => {
    const empty = wardrobeProfile([]);
    expect(assignDirections({ profile: empty, weather: RAINY, recent: [], count: 3, seed: 1 })).toEqual([
      "classic_balanced",
      "classic_balanced",
      "classic_balanced",
    ]);
  });

  it.each([
    [0, 0],
    [-2, 0],
    [2.7, 2],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])("assigns %d candidates as %d", (count, length) => {
    expect(assignDirections({ ...base, count, seed: 1 })).toHaveLength(length);
  });
});
