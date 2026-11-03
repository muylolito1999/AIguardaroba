import { randomUUID } from "node:crypto";

import type { ItemCategory, ItemDecision, OutfitSlot } from "@/lib/db/enums";
import { slotForCategory } from "@/lib/outfits/contracts";
import {
  buildSuggestionSnapshot,
  makeOutfitSuggestionStrictSchema,
  OUTFIT_CALL_PARAMS,
  OUTFIT_PROMPT_VERSION,
  toCheckItems,
  type OutfitSuggestionResult,
  type OutfitSuggestionWire,
  type SuggestionItemInput,
  type SuggestionSnapshot,
} from "@/lib/outfits/suggestion";
import type { ShoppingAdviceWire } from "@/lib/shopping/advice";
import type { ComboItem, Scenario } from "@/lib/shopping/combinatorics";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";

import forecastHamburg from "../src/lib/weather/fixtures/forecast-hamburg.json";

// Builders for the Phase 6 tests: wardrobe items as the suggestion payload and
// the outfit check see them, a realistic forecast, Claude replies (the wire
// data; wrap them in fakeMessage({ json }) from test/fakes/anthropic.ts for the
// fake client) and stored results. Every builder returns data that passes the
// matching strict schema unless the overrides say otherwise. No SDK or
// database imports, so DB tests can spread OUTFIT_TEMPLATES into
// makeTaggedItem(db, ...) and Playwright seeds can use the same shapes.

/** An item as buildSuggestionSnapshot and isEligibleForToday take it; a drizzle Item row has every field. */
export type OutfitFixtureItem = SuggestionItemInput & { decision: ItemDecision };

type Template = Pick<
  OutfitFixtureItem,
  | "name"
  | "category"
  | "subcategory"
  | "colors"
  | "materials"
  | "warmthLevel"
  | "waterproof"
  | "windproof"
  | "insulated"
  | "breathable"
  | "seasons"
  | "formality"
>;

/**
 * A small, complete wardrobe for a Hamburg autumn: every slot has at least
 * one item, and the keys name them for readable tests. Each template also
 * satisfies items_tagged_complete_check once `condition` is added (the
 * builders add "good").
 */
export const OUTFIT_TEMPLATES = {
  shell: { name: "Navy waterproof shell jacket", category: "outerwear", subcategory: "rain jacket", colors: ["navy"], materials: ["polyester"], warmthLevel: 2, waterproof: true, windproof: true, insulated: false, breathable: true, seasons: ["spring", "autumn"], formality: "casual" },
  coat: { name: "Charcoal wool overcoat", category: "outerwear", subcategory: "overcoat", colors: ["charcoal"], materials: ["wool", "polyamide"], warmthLevel: 4, waterproof: false, windproof: true, insulated: true, breathable: null, seasons: ["winter", "autumn"], formality: "smart_casual" },
  puffer: { name: "Black down puffer jacket", category: "outerwear", subcategory: "puffer jacket", colors: ["black"], materials: ["down", "nylon"], warmthLevel: 5, waterproof: false, windproof: true, insulated: true, breathable: null, seasons: ["winter"], formality: "casual" },
  thermal: { name: "Merino thermal long-sleeve", category: "base_layer", subcategory: "thermal top", colors: ["black"], materials: ["merino"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["winter", "autumn"], formality: "athletic" },
  tee: { name: "White cotton t-shirt", category: "top", subcategory: "t-shirt", colors: ["white"], materials: ["cotton"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["spring", "summer"], formality: "casual" },
  oxford: { name: "Light blue oxford shirt", category: "top", subcategory: "shirt", colors: ["light blue"], materials: ["cotton"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["spring", "summer", "autumn"], formality: "smart_casual" },
  sweater: { name: "Grey merino crew-neck sweater", category: "top", subcategory: "sweater", colors: ["grey"], materials: ["merino"], warmthLevel: 3, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["winter", "spring", "autumn"], formality: "smart_casual" },
  dress: { name: "Black wool shift dress", category: "dress", subcategory: "shift dress", colors: ["black"], materials: ["wool"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: null, seasons: ["winter", "autumn"], formality: "business" },
  jeans: { name: "Dark blue slim jeans", category: "bottom", subcategory: "jeans", colors: ["dark blue"], materials: ["denim", "elastane"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: null, seasons: ["winter", "spring", "autumn"], formality: "casual" },
  chinos: { name: "Stone cotton chinos", category: "bottom", subcategory: "chinos", colors: ["stone"], materials: ["cotton"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["spring", "summer", "autumn"], formality: "smart_casual" },
  boots: { name: "Brown waterproof leather boots", category: "shoes", subcategory: "chelsea boots", colors: ["brown"], materials: ["leather", "rubber"], warmthLevel: 3, waterproof: true, windproof: true, insulated: false, breathable: null, seasons: ["winter", "spring", "autumn"], formality: "smart_casual" },
  sneakers: { name: "White canvas sneakers", category: "shoes", subcategory: "sneakers", colors: ["white"], materials: ["canvas", "rubber"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["spring", "summer"], formality: "casual" },
  beanie: { name: "Charcoal ribbed wool beanie", category: "hat_beanie", subcategory: "beanie", colors: ["charcoal"], materials: ["wool"], warmthLevel: 3, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["winter", "autumn"], formality: "casual" },
  gloves: { name: "Black leather gloves", category: "gloves", subcategory: "gloves", colors: ["black"], materials: ["leather", "wool"], warmthLevel: 3, waterproof: false, windproof: true, insulated: true, breathable: null, seasons: ["winter"], formality: "smart_casual" },
  scarf: { name: "Camel wool scarf", category: "scarf", subcategory: "scarf", colors: ["camel"], materials: ["wool"], warmthLevel: 3, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["winter", "autumn"], formality: "smart_casual" },
  belt: { name: "Brown leather belt", category: "accessory", subcategory: "belt", colors: ["brown"], materials: ["leather"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, breathable: null, seasons: ["winter", "spring", "summer", "autumn"], formality: "smart_casual" },
  tote: { name: "Black canvas tote bag", category: "bag", subcategory: "tote", colors: ["black"], materials: ["canvas"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, breathable: null, seasons: ["winter", "spring", "summer", "autumn"], formality: "casual" },
} as const satisfies Record<string, Template>;

export type OutfitTemplateKey = keyof typeof OUTFIT_TEMPLATES;

let itemSeq = 0;

/**
 * A confirmed, never-worn item at home in Hamburg: a grey merino sweater
 * unless the overrides say otherwise. Ids are random uuids; createdAt is one
 * minute apart per call.
 */
export function makeOutfitItem(overrides: Partial<OutfitFixtureItem> = {}): OutfitFixtureItem {
  itemSeq += 1;
  const template: Template = OUTFIT_TEMPLATES.sweater;
  return {
    id: randomUUID(),
    createdAt: new Date(Date.UTC(2026, 0, 1) + itemSeq * 60_000),
    ...template,
    colors: [...template.colors],
    materials: [...template.materials],
    seasons: [...template.seasons],
    materialGuess: null,
    condition: "good",
    status: "confirmed",
    location: "hamburg",
    decision: "bring",
    aiConfidence: null,
    userEditedFields: [],
    wearCount: 0,
    lastWornAt: null,
    ...overrides,
  };
}

/** One item per template key, in OUTFIT_TEMPLATES order, with per-key overrides. */
export function makeOutfitWardrobe(
  overrides: Partial<Record<OutfitTemplateKey, Partial<OutfitFixtureItem>>> = {},
): Record<OutfitTemplateKey, OutfitFixtureItem> {
  const keys = Object.keys(OUTFIT_TEMPLATES) as OutfitTemplateKey[];
  return Object.fromEntries(
    keys.map((key) => {
      const template: Template = OUTFIT_TEMPLATES[key];
      return [
        key,
        makeOutfitItem({
          ...template,
          colors: [...template.colors],
          materials: [...template.materials],
          seasons: [...template.seasons],
          ...overrides[key],
        }),
      ];
    }),
  ) as Record<OutfitTemplateKey, OutfitFixtureItem>;
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

/** The saved Open-Meteo response for Hamburg on 2026-11-03 (src/lib/weather/fixtures). */
export function hamburgForecastResponse(): typeof forecastHamburg {
  return structuredClone(forecastHamburg);
}

/** What toWeatherSnapshot makes of hamburgForecastResponse() fetched at 2026-11-03 13:20 UTC. */
export function makeWeatherSnapshot(overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    date: "2026-11-03",
    timezone: "Europe/Berlin",
    currentC: 9.4,
    tminC: 5.9,
    tmaxC: 10.8,
    apparentMinC: 2.1,
    apparentMaxC: 7.6,
    precipSumMm: 3.4,
    precipProbMax: 80,
    windGustMaxKmh: 52.9,
    weatherCode: 61,
    label: "Light rain",
    fetchedAt: "2026-11-03T13:20:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Outfit suggestions
// ---------------------------------------------------------------------------

type PickedOutfit = { slot: OutfitSlot; alias: string }[];

/**
 * Three different valid outfits from a snapshot's lines: tops with bottoms
 * and dresses (alone), each with the first shoes, then with each outerwear,
 * taken in that order until three distinct sets exist. Throws when the lines
 * cannot make three.
 */
export function pickThreeOutfits(snapshot: Pick<SuggestionSnapshot, "lines">): PickedOutfit[] {
  const by = (category: ItemCategory) => snapshot.lines.filter((line) => line.category === category).map((line) => line.alias);
  const bases: PickedOutfit[] = [
    ...by("top").flatMap((top) =>
      by("bottom").map((bottom) => [
        { slot: "top" as const, alias: top },
        { slot: "bottom" as const, alias: bottom },
      ]),
    ),
    ...by("dress").map((dress) => [{ slot: "top" as const, alias: dress }]),
  ];
  const shoes = by("shoes").slice(0, 1).map((alias) => ({ slot: "shoes" as const, alias }));
  const outers: (PickedOutfit[number] | null)[] = [null, ...by("outerwear").map((alias) => ({ slot: "outerwear" as const, alias }))];
  const picks: PickedOutfit[] = [];
  for (const outer of outers) {
    for (const base of bases) {
      if (picks.length === 3) return picks;
      picks.push([...(outer === null ? [] : [outer]), ...base, ...shoes]);
    }
  }
  if (picks.length < 3) throw new Error("pickThreeOutfits: the snapshot cannot make three outfits");
  return picks;
}

/** A valid wire reply for a snapshot (3 distinct outfits). Change the returned object to test failures. */
export function fakeOutfitSuggestionReply(snapshot: Pick<SuggestionSnapshot, "lines">): OutfitSuggestionWire {
  return {
    outfits: pickThreeOutfits(snapshot).map((items, index) => ({
      title: ["Layered for drizzle", "Smart and dry", "Light and quick"][index] ?? `Outfit ${index + 1}`,
      items: items.map(({ slot, alias }) => ({ slot, item: alias })),
      why: "Feels like 2 to 8 °C with an 80 % chance of rain: a waterproof layer over a warm mid layer, and boots that stay dry.",
      rain_ok: index === 0,
    })),
  };
}

/**
 * A stored suggestion result for these items and this weather: the snapshot,
 * a fake reply and the strict schema, exactly as the service would build it.
 */
export function makeOutfitSuggestionResult(
  items: readonly OutfitFixtureItem[],
  weather: WeatherSnapshot = makeWeatherSnapshot(),
  model = "claude-sonnet-5-5",
): OutfitSuggestionResult {
  const snapshot = buildSuggestionSnapshot(items, weather);
  const strict = makeOutfitSuggestionStrictSchema(snapshot, toCheckItems(items));
  const parsed = strict.parse(fakeOutfitSuggestionReply(snapshot));
  return {
    outfits: parsed.outfits,
    weather,
    meta: {
      prompt_version: OUTFIT_PROMPT_VERSION,
      model,
      effort: OUTFIT_CALL_PARAMS.effort,
      item_count: snapshot.itemCount,
      dropped_count: snapshot.droppedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Shopping
// ---------------------------------------------------------------------------

let comboSeq = 0;

/** A combinatorics item: a casual w2 top unless the overrides say otherwise; ids are readable and unique. */
export function makeComboItem(overrides: Partial<ComboItem> = {}): ComboItem {
  comboSeq += 1;
  return {
    id: `combo-${comboSeq}`,
    category: "top",
    warmthLevel: 2,
    formality: "casual",
    waterproof: false,
    ...overrides,
  };
}

/** Hamburg's four scenarios as scenariosFromProfile(HAMBURG) gives them. */
export const HAMBURG_SCENARIOS: readonly Scenario[] = [
  { key: "jan", label: "January", tmeanC: 2.1, rainy: true },
  { key: "apr", label: "April", tmeanC: 9.1, rainy: false },
  { key: "jul", label: "July", tmeanC: 18.3, rainy: true },
  { key: "oct", label: "October", tmeanC: 10.0, rainy: true },
];

/** A valid advice reply: the keys ranked in the order given, each with `budgetEur` (default 50). */
export function fakeShoppingAdviceReply(keys: readonly string[], budgetEur = 50): ShoppingAdviceWire {
  return {
    recommendations: keys.map((key, index) => ({
      key,
      rank: index + 1,
      why: "Unlocks 6 outfits in January, where the wardrobe makes only 2; 18 rain days a month.",
      budget_eur: budgetEur,
    })),
  };
}

/** The slot an item of `category` goes in; throws for "other". */
export function slotOf(category: ItemCategory): OutfitSlot {
  const slot = slotForCategory(category);
  if (slot === null) throw new Error(`No slot takes ${category}`);
  return slot;
}
