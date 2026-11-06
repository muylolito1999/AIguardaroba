import { describe, expect, it } from "vitest";

import { BOLOGNA } from "@/lib/climate/bologna";
import { HAMBURG } from "@/lib/climate/hamburg";
import { FORMALITIES, type Formality, type ItemCategory } from "@/lib/db/enums";
import { AppError } from "@/lib/result";
import {
  candidateFromShoppingRow,
  countOutfits,
  DEFAULT_COMBINATION_CAP,
  RAINY_MONTH_DAYS,
  scenariosFromProfile,
  unlockCount,
  warmthBand,
  type ComboItem,
  type Scenario,
} from "@/lib/shopping/combinatorics";

import { HAMBURG_SCENARIOS, makeComboItem, makeOutfitWardrobe } from "../../../test/outfit-fixtures";

const scenario = (tmeanC: number, rainy = false): Scenario => ({ key: "s", label: "Scenario", tmeanC, rainy });

const top = (warmthLevel: number | null, formality: Formality | null = "casual") => makeComboItem({ category: "top", warmthLevel, formality });
const bottom = (warmthLevel: number | null, formality: Formality | null = "casual") =>
  makeComboItem({ category: "bottom", warmthLevel, formality });
const shoes = (formality: Formality | null = "casual", waterproof: boolean | null = false) =>
  makeComboItem({ category: "shoes", warmthLevel: 2, formality, waterproof });
const outer = (warmthLevel: number | null, formality: Formality | null = "casual", waterproof: boolean | null = false) =>
  makeComboItem({ category: "outerwear", warmthLevel, formality, waterproof });
const dress = (warmthLevel: number | null, formality: Formality | null = "smart_casual") =>
  makeComboItem({ category: "dress", warmthLevel, formality });

describe("warmthBand", () => {
  it.each([
    [-5, "freezing", 10, 15],
    [-0.1, "freezing", 10, 15],
    [0, "cold", 7, 13],
    [2.1, "cold", 7, 13],
    [5, "chilly", 6, 11],
    [9.1, "chilly", 6, 11],
    [10, "cool", 5, 10],
    [15, "mild", 3, 7],
    [18.3, "mild", 3, 7],
    [20, "warm", 2, 5],
    [31, "warm", 2, 5],
  ])("puts a mean of %s °C in the %s band (%i to %i)", (tmean, label, min, max) => {
    expect(warmthBand(tmean)).toMatchObject({ label, min, max });
  });

  it("asks for more warmth the colder it is", () => {
    const means = [-5, 2, 7, 12, 17, 25];
    const mins = means.map((tmean) => warmthBand(tmean).min);
    expect([...mins].sort((a, b) => b - a)).toEqual(mins);
  });

  it("rejects a non-finite mean", () => {
    expect(() => warmthBand(Number.NaN)).toThrow(RangeError);
  });
});

describe("countOutfits", () => {
  it("counts every combination of a small mild-weather wardrobe (hand-computed: 16)", () => {
    // Mild, dry, band 3..7. Bases: tee+jeans 3, tee+chinos 3, oxford+jeans 4, oxford+chinos 4;
    // with the trench (+2): 5, 5, 6, 6. All in band, all within one formality step.
    // 4 bases x 2 shoes x (no outerwear or the trench) = 16.
    const items = [
      top(1, "casual"),
      top(2, "smart_casual"),
      bottom(2, "casual"),
      bottom(2, "smart_casual"),
      shoes("casual"),
      shoes("smart_casual"),
      outer(2, "smart_casual"),
    ];
    expect(countOutfits(items, scenario(18))).toEqual({ count: 16, capped: false });
  });

  it("needs a top, a bottom and shoes", () => {
    expect(countOutfits([top(2), bottom(2)], scenario(18)).count).toBe(0);
    expect(countOutfits([top(2), shoes()], scenario(18)).count).toBe(0);
    expect(countOutfits([bottom(2), shoes(), outer(2)], scenario(18)).count).toBe(0);
    expect(countOutfits([top(2), bottom(2), shoes()], scenario(18)).count).toBe(1);
  });

  it("keeps formality within one step, and lets an unknown formality match any", () => {
    // casual top and bottom: business shoes are two steps away, smart_casual ones one.
    expect(countOutfits([top(1), bottom(2), shoes("business")], scenario(18)).count).toBe(0);
    expect(countOutfits([top(1), bottom(2), shoes("smart_casual")], scenario(18)).count).toBe(1);
    expect(countOutfits([top(1, "athletic"), bottom(2, "smart_casual"), shoes(null)], scenario(18)).count).toBe(0);
    expect(countOutfits([top(1, null), bottom(2, "formal"), shoes("business")], scenario(18)).count).toBe(1);
    // A formal coat cannot go over a casual outfit, so only the outfit without it counts.
    expect(countOutfits([top(1), bottom(2), shoes(), outer(2, "formal")], scenario(18)).count).toBe(1);
    for (const formality of FORMALITIES) {
      expect(countOutfits([top(1, formality), bottom(2, formality), shoes(formality)], scenario(18)).count).toBe(1);
    }
  });

  it("keeps the summed warmth in the scenario's band", () => {
    const items = [top(3), bottom(2), shoes(), outer(4), outer(5)];
    // Freezing (10..15): 3+2 = 5 no; +4 = 9 no; +5 = 10 yes.
    expect(countOutfits(items, scenario(-3)).count).toBe(1);
    // Cold (8..13): +4 = 9 and +5 = 10 both fit.
    expect(countOutfits(items, scenario(2)).count).toBe(2);
    // Cool (5..10): 5 alone, 9 and 10 all fit.
    expect(countOutfits(items, scenario(12)).count).toBe(3);
    // Warm (2..5): only the knit and jeans without outerwear.
    expect(countOutfits(items, scenario(25)).count).toBe(1);
  });

  it("counts a dress twice for warmth and with no bottom", () => {
    // Warm (2..5): a w2 dress is 4, a w3 dress 6 (too warm); bottoms never pair with a dress.
    expect(countOutfits([dress(2), shoes("smart_casual")], scenario(25)).count).toBe(1);
    expect(countOutfits([dress(3), shoes("smart_casual")], scenario(25)).count).toBe(0);
    expect(countOutfits([dress(2), bottom(1), shoes("smart_casual")], scenario(25)).count).toBe(1);
    // Cold (8..13): the w2 dress (4) needs a w4 or w5 coat.
    expect(countOutfits([dress(2), shoes("smart_casual"), outer(4, "smart_casual"), outer(2, "smart_casual")], scenario(2)).count).toBe(1);
  });

  it("lets an unknown warmth be whatever level would fit", () => {
    // Cold (8..13): an unknown top with jeans and a wool coat spans 7..11.
    expect(countOutfits([top(null), bottom(2), shoes(), outer(4)], scenario(2)).count).toBe(1);
    // Freezing (10..15) needs outerwear; with an unknown one, an unknown top and bottom span 4..15, so they fit.
    expect(countOutfits([top(null), bottom(null), shoes()], scenario(-3)).count).toBe(0);
    expect(countOutfits([top(null), bottom(null), shoes(), outer(null)], scenario(-3)).count).toBe(1);
    // Warm (2..5): a w4 coat never counts, so only the outfit without it.
    expect(countOutfits([top(null), bottom(null), shoes(), outer(4)], scenario(25)).count).toBe(1);
  });

  it("needs waterproof outerwear or shoes in a rainy scenario; unknown is not waterproof", () => {
    const base = [top(3), bottom(2), outer(4)];
    expect(countOutfits([...base, shoes()], scenario(2, true)).count).toBe(0);
    expect(countOutfits([...base, shoes("casual", null)], scenario(2, true)).count).toBe(0);
    expect(countOutfits([...base, shoes("casual", true)], scenario(2, true)).count).toBe(1);
    // Waterproof shoes make the outfit without outerwear count too in a warm, rainy month.
    expect(countOutfits([top(1), bottom(2), shoes("casual", true)], scenario(25, true)).count).toBe(1);
    expect(countOutfits([top(3), bottom(2), shoes(), outer(4, "casual", true)], scenario(2, true)).count).toBe(1);
  });

  it("multiplies interchangeable items instead of enumerating them", () => {
    const many = (count: number, make: () => ComboItem) => Array.from({ length: count }, make);
    const items = [...many(200, () => top(2)), ...many(100, () => bottom(2)), ...many(50, () => shoes()), ...many(20, () => outer(2))];
    // Mild (3..7): 4 without outerwear, 6 with: every combination fits.
    const result = countOutfits(items, scenario(18), 10);
    expect(result).toEqual({ count: 200 * 100 * 50 * 21, capped: false });
  });

  it("stops at the cap and says the count is a lower bound", () => {
    // Four distinct classes per slot (formality x waterproof), all valid: 64 combinations of size 1.
    const variants = (category: ItemCategory) =>
      (["casual", "smart_casual"] as const).flatMap((formality) =>
        [false, true].map((waterproof) => makeComboItem({ category, warmthLevel: 1, formality, waterproof })),
      );
    const items = [...variants("top"), ...variants("bottom"), ...variants("shoes")];
    const warm = scenario(25);
    expect(countOutfits(items, warm)).toEqual({ count: 64, capped: false });
    expect(countOutfits(items, warm, 64)).toEqual({ count: 64, capped: false });
    expect(countOutfits(items, warm, 10)).toEqual({ count: 10, capped: true });
    expect(countOutfits(items, warm, 0)).toEqual({ count: 0, capped: true });
    expect(DEFAULT_COMBINATION_CAP).toBe(50_000);
    expect(() => countOutfits(items, warm, -1)).toThrow(RangeError);
  });
});

describe("unlockCount", () => {
  // A cold Hamburg January wardrobe with nothing waterproof.
  const wardrobe = [
    top(4, "casual"), // chunky knit
    top(2, "smart_casual"), // oxford shirt
    bottom(2, "casual"), // jeans
    bottom(2, "smart_casual"), // chinos
    shoes("casual"), // sneakers
    shoes("smart_casual"), // chelsea boots, not waterproof
    outer(4, "smart_casual"), // wool coat, not waterproof
  ];
  const janRainy = scenario(2.1, true);
  const janDry = scenario(2.1, false);
  const shell = makeComboItem({ id: "shell", category: "outerwear", warmthLevel: 2, formality: "casual", waterproof: true });

  it("gives a waterproof shell its unlocked outfits in a cold, rainy month (hand-computed: 4)", () => {
    expect(countOutfits(wardrobe, janRainy).count).toBe(0);
    // Knit (4) + either bottom (2) + shell (2) = 8, in the cold band; the oxford (2) makes only 6.
    // 2 bases x 2 shoes = 4.
    expect(unlockCount(wardrobe, shell, janRainy)).toBe(4);
    expect(countOutfits([...wardrobe, shell], janRainy).count).toBe(4);
  });

  it("adds the shell's outfits on top of the coat's in a dry month", () => {
    // Coat: 4 bases (9, 9, 8, 8 with the coat) x 2 shoes = 8; the shell adds the same 4 as above.
    expect(countOutfits(wardrobe, janDry).count).toBe(8);
    expect(unlockCount(wardrobe, shell, janDry)).toBe(4);
  });

  it("gives waterproof boots the coat's outfits in the rain", () => {
    const boots = makeComboItem({ id: "boots", category: "shoes", warmthLevel: 3, formality: "smart_casual", waterproof: true });
    expect(unlockCount(wardrobe, boots, janRainy)).toBe(4);
  });

  it("is zero for a shell whose waterproofing is unknown, and for categories outside the count", () => {
    expect(unlockCount(wardrobe, { ...shell, waterproof: null }, janRainy)).toBe(0);
    for (const category of ["socks", "gloves", "hat_beanie", "scarf", "base_layer", "accessory", "bag", "other"] as const) {
      expect(unlockCount(wardrobe, makeComboItem({ category, warmthLevel: 3 }), janRainy)).toBe(0);
    }
  });

  it("sets aside an owned item with the candidate's id", () => {
    expect(unlockCount([...wardrobe, shell], shell, janRainy)).toBe(4);
  });

  it("equals countOutfits with the candidate minus without it, on random wardrobes", () => {
    // A small linear congruential generator keeps the cases the same on every run.
    let seed = 42;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const categories: ItemCategory[] = ["top", "bottom", "dress", "shoes", "outerwear", "gloves"];
    const formalities: (Formality | null)[] = [...FORMALITIES, null];
    const randomItem = (id: string): ComboItem => ({
      id,
      category: categories[next(categories.length)] ?? "top",
      warmthLevel: next(6) === 0 ? null : next(5) + 1,
      formality: formalities[next(formalities.length)] ?? null,
      waterproof: [true, false, null][next(3)] ?? null,
    });
    for (let round = 0; round < 60; round += 1) {
      const items = Array.from({ length: 4 + next(10) }, (_, index) => randomItem(`r${round}-${index}`));
      const candidate = randomItem(`candidate-${round}`);
      for (const entry of HAMBURG_SCENARIOS) {
        const before = countOutfits(items, entry).count;
        const after = countOutfits([...items, candidate], entry).count;
        expect(unlockCount(items, candidate, entry), `round ${round} ${entry.key}`).toBe(after - before);
      }
    }
  });
});

describe("scenariosFromProfile", () => {
  it("takes January, April, July and October from the Hamburg normals", () => {
    expect(scenariosFromProfile(HAMBURG)).toEqual(HAMBURG_SCENARIOS);
  });

  it(`calls a month rainy from ${RAINY_MONTH_DAYS} rain days`, () => {
    const months = HAMBURG.months.map((month) => ({ ...month, precip_days: month.month === 4 ? RAINY_MONTH_DAYS : RAINY_MONTH_DAYS - 0.1 }));
    expect(scenariosFromProfile({ city: "Test", months }).map((entry) => entry.rainy)).toEqual([false, true, false, false]);
  });

  it("refuses a placeholder profile instead of guessing", () => {
    expect(() => scenariosFromProfile(BOLOGNA)).toThrow(AppError);
    try {
      scenariosFromProfile(BOLOGNA);
    } catch (error) {
      expect(error).toMatchObject({
        code: "VALIDATION",
        message:
          "The Bologna climate profile has no mean temperature or rain days for January, April, July, October. Fill them in under Settings > Climate.",
      });
    }
  });

  it("names only the months that are missing", () => {
    const months = HAMBURG.months.map((month) => (month.month === 7 ? { ...month, precip_days: null } : month));
    expect(() => scenariosFromProfile({ city: "Hamburg", months })).toThrow(/for July\./);
  });
});

describe("candidateFromShoppingRow", () => {
  const row = (itemType: string, category: ItemCategory | null = null, specs: string[] = []) => ({ id: "row-1", itemType, category, specs });

  it.each([
    [
      "a waterproof shell from a relocation gap",
      row("Waterproof breathable shell jacket", "outerwear", ["hood and taped seams", "at least 10,000 mm water column"]),
      { category: "outerwear", warmthLevel: 2, waterproof: true, formality: null },
    ],
    [
      "insulated boots",
      row("Insulated waterproof winter boots", null, ["grippy sole"]),
      { category: "shoes", warmthLevel: 4, waterproof: true, formality: null },
    ],
    ["a down parka", row("Down parka"), { category: "outerwear", warmthLevel: 5, waterproof: null, formality: "casual" }],
    ["a merino base layer", row("Merino base layer top", null, ["150-250 g/m²"]), { category: "base_layer", warmthLevel: 3, waterproof: null }],
    ["a lined beanie", row("Wool or fleece-lined beanie", "hat_beanie"), { category: "hat_beanie", warmthLevel: 3, formality: "casual" }],
    ["a dress shirt", row("White dress shirt"), { category: "top", warmthLevel: 2, formality: "business" }],
    ["a shirt dress", row("Navy shirt dress"), { category: "dress" }],
    ["rain trousers", row("Rain trousers"), { category: "bottom", waterproof: true }],
    ["a water-resistant softshell", row("Water-resistant softshell jacket"), { category: "outerwear", warmthLevel: 2, waterproof: null }],
    ["hiking boots", row("Hiking boots"), { category: "shoes", formality: "athletic" }],
    ["windproof gloves", row("Windproof gloves"), { category: "gloves", warmthLevel: null }],
    ["a linen shirt", row("Linen shirt"), { category: "top", warmthLevel: 1 }],
    ["something unknown", row("Something nice"), { category: "other", warmthLevel: null, formality: null, waterproof: null }],
  ] as const)("reads %s", (_label, input, expected) => {
    expect(candidateFromShoppingRow(input)).toMatchObject({ id: "row-1", ...expected });
  });

  it.each([
    ["Merino dress socks", 3],
    ["Wool boot socks", 3],
    ["Thermal ski socks", 3],
    ["Sock liners", null],
    ["Running sock", null],
  ] as const)("reads %s as socks before any other category", (itemType, warmthLevel) => {
    expect(candidateFromShoppingRow(row(itemType))).toMatchObject({ category: "socks", warmthLevel });
  });

  it("keeps the row's own category over the keywords", () => {
    expect(candidateFromShoppingRow(row("Rain jacket", "accessory")).category).toBe("accessory");
  });

  it("feeds unlockCount: the gap's shell unlocks the January outfits", () => {
    const wardrobe = [top(4), top(2, "smart_casual"), bottom(2), bottom(2, "smart_casual"), shoes(), shoes("smart_casual"), outer(4, "smart_casual")];
    const candidate = candidateFromShoppingRow(
      row("Waterproof breathable shell jacket", "outerwear", ["hood and taped seams", "at least 10,000 mm water column"]),
    );
    expect(unlockCount(wardrobe, candidate, HAMBURG_SCENARIOS[0] ?? scenario(2.1, true))).toBe(4);
  });
});

describe("each piece suits the month on its own", () => {
  // The fixture wardrobe for a Hamburg autumn as the counts see it: shell (w2,
  // waterproof), wool coat (w4), puffer (w5); tee (1), oxford (2), sweater (3);
  // a w2 dress; jeans and chinos (2); waterproof boots (3), canvas sneakers (1).
  const fixture: ComboItem[] = Object.values(makeOutfitWardrobe()).flatMap((item) =>
    item.category === null
      ? []
      : [{ id: item.id, category: item.category, warmthLevel: item.warmthLevel, formality: item.formality, waterproof: item.waterproof }],
  );
  const [jan, , jul, oct] = HAMBURG_SCENARIOS;
  if (jan === undefined || jul === undefined || oct === undefined) throw new Error("scenarios missing");
  const row = (itemType: string, category: ItemCategory | null = null, specs: string[] = []) =>
    candidateFromShoppingRow({ id: `row-${itemType}`, itemType, category, specs });
  const shell = row("Waterproof breathable shell jacket", "outerwear", ["hood and taped seams", "at least 10,000 mm water column"]);

  it("never lets a heavy coat make up for summer-weight shorts or sandals in January", () => {
    expect(unlockCount(fixture, row("Linen shorts"), jan)).toBe(0);
    expect(unlockCount(fixture, row("Sandals"), jan)).toBe(0);
    expect(unlockCount(fixture, row("Linen shorts"), oct)).toBe(0);
  });

  it("counts a waterproof shell over a mid-layer knit in January (hand-computed: 2)", () => {
    // Sweater (3) + jeans or chinos (2) + the new shell (2) = 7, with the waterproof boots (3);
    // the oxford (2) makes only 6, the w2 dress 6, and the sneakers (1) are too light.
    expect(unlockCount(fixture, shell, jan)).toBe(2);
  });

  it("counts a shell over a w3 knit with w2 jeans and waterproof boots in the cold band (hand-computed: 1)", () => {
    const boots = makeComboItem({ category: "shoes", warmthLevel: 3, waterproof: true });
    expect(countOutfits([top(3), bottom(2), boots, outer(2)], scenario(2.1, true)).count).toBe(1);
    // Without outerwear it does not count near freezing, however warm the rest.
    expect(countOutfits([top(5), bottom(5), boots], scenario(2.1)).count).toBe(0);
  });

  it("leaves out heavy outerwear in mild and warm months", () => {
    expect(unlockCount(fixture, row("Down parka"), jul)).toBe(0);
    expect(countOutfits([top(1), bottom(2), shoes(), outer(4)], scenario(18)).count).toBe(1);
    expect(countOutfits([top(1), bottom(2), shoes(), outer(3)], scenario(18)).count).toBe(2);
  });

  it("keeps an unknown warmth wherever some allowed level would fit", () => {
    // Cold: an unknown bottom is at least 2, and unknown shoes may be warm enough.
    const unknownShoes = makeComboItem({ category: "shoes", warmthLevel: null });
    expect(countOutfits([top(3), bottom(null), unknownShoes, outer(2)], scenario(2.1)).count).toBe(1);
    // Mild: an unknown coat may be light enough.
    expect(countOutfits([top(1), bottom(2), shoes(), outer(null)], scenario(18)).count).toBe(2);
  });
});
