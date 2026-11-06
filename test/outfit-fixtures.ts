import { randomUUID } from "node:crypto";

import type { ItemCategory, ItemDecision, OutfitSlot } from "@/lib/db/enums";
import { slotForCategory } from "@/lib/outfits/contracts";
import { EMPTY_HISTORY, type DirectionKey, type VarietyHistory } from "@/lib/outfits/style/types";
import {
  buildSuggestionSnapshot,
  makeOutfitSuggestionStrictSchema,
  OUTFIT_CALL_PARAMS,
  OUTFIT_CANDIDATE_COUNT,
  OUTFIT_PROMPT_VERSION,
  OUTFIT_SUGGESTION_COUNT,
  toCheckItems,
  type OutfitSuggestionResult,
  type OutfitSuggestionWire,
  type SuggestionItemInput,
  type SuggestionLine,
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
 * one item, and the keys name them for readable tests. The tops cover the
 * layering roles (a tee and an oxford to wear underneath, a crew-neck sweater
 * and a hoodie to wear over them), and two pairs of socks go with the closed
 * shoes. Each template also satisfies items_tagged_complete_check once
 * `condition` is added (the builders add "good").
 */
export const OUTFIT_TEMPLATES = {
  shell: { name: "Navy waterproof shell jacket", category: "outerwear", subcategory: "rain jacket", colors: ["navy"], materials: ["polyester"], warmthLevel: 2, waterproof: true, windproof: true, insulated: false, breathable: true, seasons: ["spring", "autumn"], formality: "casual" },
  coat: { name: "Charcoal wool overcoat", category: "outerwear", subcategory: "overcoat", colors: ["charcoal"], materials: ["wool", "polyamide"], warmthLevel: 4, waterproof: false, windproof: true, insulated: true, breathable: null, seasons: ["winter", "autumn"], formality: "smart_casual" },
  puffer: { name: "Black down puffer jacket", category: "outerwear", subcategory: "puffer jacket", colors: ["black"], materials: ["down", "nylon"], warmthLevel: 5, waterproof: false, windproof: true, insulated: true, breathable: null, seasons: ["winter"], formality: "casual" },
  thermal: { name: "Merino thermal long-sleeve", category: "base_layer", subcategory: "thermal top", colors: ["black"], materials: ["merino"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["winter", "autumn"], formality: "athletic" },
  tee: { name: "White cotton t-shirt", category: "top", subcategory: "t-shirt", colors: ["white"], materials: ["cotton"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["spring", "summer"], formality: "casual" },
  oxford: { name: "Light blue oxford shirt", category: "top", subcategory: "shirt", colors: ["light blue"], materials: ["cotton"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["spring", "summer", "autumn"], formality: "smart_casual" },
  sweater: { name: "Grey merino crew-neck sweater", category: "top", subcategory: "sweater", colors: ["grey"], materials: ["merino"], warmthLevel: 3, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["winter", "spring", "autumn"], formality: "smart_casual" },
  // A light cotton hoodie (w2): worn over the tee, never alone on bare skin.
  hoodie: { name: "Grey lightweight cotton hoodie", category: "top", subcategory: "hoodie", colors: ["grey"], materials: ["cotton"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["spring", "autumn"], formality: "casual" },
  dress: { name: "Black wool shift dress", category: "dress", subcategory: "shift dress", colors: ["black"], materials: ["wool"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: null, seasons: ["winter", "autumn"], formality: "business" },
  jeans: { name: "Dark blue slim jeans", category: "bottom", subcategory: "jeans", colors: ["dark blue"], materials: ["denim", "elastane"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: null, seasons: ["winter", "spring", "autumn"], formality: "casual" },
  chinos: { name: "Stone cotton chinos", category: "bottom", subcategory: "chinos", colors: ["stone"], materials: ["cotton"], warmthLevel: 2, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["spring", "summer", "autumn"], formality: "smart_casual" },
  boots: { name: "Brown waterproof leather boots", category: "shoes", subcategory: "chelsea boots", colors: ["brown"], materials: ["leather", "rubber"], warmthLevel: 3, waterproof: true, windproof: true, insulated: false, breathable: null, seasons: ["winter", "spring", "autumn"], formality: "smart_casual" },
  sneakers: { name: "White canvas sneakers", category: "shoes", subcategory: "sneakers", colors: ["white"], materials: ["canvas", "rubber"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["spring", "summer"], formality: "casual" },
  woolSocks: { name: "Charcoal merino wool socks", category: "socks", subcategory: "wool socks", colors: ["charcoal"], materials: ["merino", "polyamide"], warmthLevel: 3, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["winter", "autumn"], formality: "casual" },
  dressSocks: { name: "Navy cotton dress socks", category: "socks", subcategory: "dress socks", colors: ["navy"], materials: ["cotton", "elastane"], warmthLevel: 1, waterproof: false, windproof: false, insulated: false, breathable: true, seasons: ["winter", "spring", "summer", "autumn"], formality: "business" },
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
    colorHex: [],
    pattern: null,
    fit: null,
    condition: "good",
    status: "confirmed",
    location: "hamburg",
    collection: "clothing",
    decision: "bring",
    aiConfidence: null,
    userEditedFields: [],
    wearCount: 0,
    lastWornAt: null,
    ...overrides,
  };
}

/**
 * Running gear that is otherwise eligible for today (confirmed, at home in
 * Hamburg, bring, a category a slot takes): a running shirt in the top slot
 * unless the overrides say otherwise. Outfits leave it out (D-249, D-250).
 */
export function makeRunningItem(overrides: Partial<OutfitFixtureItem> = {}): OutfitFixtureItem {
  return makeOutfitItem({
    name: "Neon running shirt",
    category: "top",
    subcategory: "running shirt",
    colors: ["neon yellow"],
    materials: ["polyester"],
    warmthLevel: 1,
    waterproof: false,
    windproof: false,
    insulated: false,
    breathable: true,
    seasons: ["spring", "summer", "autumn"],
    formality: "athletic",
    collection: "running",
    ...overrides,
  });
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

/** An outfit as Claude names it: aliases by slot. */
export type PickedOutfit = { slot: OutfitSlot; alias: string }[];

/** The directions fakeOutfitSuggestionReply follows unless told otherwise, one per candidate pickCandidateOutfits builds. */
export const FAKE_DIRECTIONS: readonly DirectionKey[] = [
  "knit_layers",
  "smart_collar",
  "sporty_clean",
  "dress_led",
  "classic_balanced",
];

const FAKE_TITLES = ["Layered for drizzle", "Smart and dry", "Light and quick", "Dress for a grey day", "Clean and simple"];

/** The candidate pickCandidateOutfits leaves for the selection to repair: a hoodie alone in top, closed shoes without socks. */
export const REPAIR_CANDIDATE_INDEX = 2;

/**
 * Up to `count` different outfits from a snapshot's lines, built the way a
 * stylist would, in this order when the wardrobe allows:
 * 0. a knit (the hoodie when there is no other mid top) over the second base
 *    top (the oxford in the fixture wardrobe), or a mid top alone when there
 *    is no base top, with the first outerwear, bottom and shoes;
 * 1. a base top alone with the second outerwear, bottom and shoes;
 * 2. (REPAIR_CANDIDATE_INDEX) a hoodie or sweatshirt ALONE in the top slot
 *    with the first bottom, closed shoes and no socks, under the third
 *    outerwear: the selection moves the hoodie to mid_layer, puts a tee under
 *    it and adds socks;
 * 3. the first dress with the second outerwear and the first shoes;
 * 4. the first base top with the second bottom, the second shoes and the
 *    first outerwear.
 * Then base tops with bottoms, and dresses, under no outerwear and then each
 * outerwear, until `count` distinct item sets exist. Closed shoes get socks
 * (except in the repair candidate), others none. Throws when the lines cannot
 * make OUTFIT_SUGGESTION_COUNT different outfits.
 */
export function pickCandidateOutfits(
  snapshot: Pick<SuggestionSnapshot, "lines">,
  count: number = OUTFIT_CANDIDATE_COUNT,
): PickedOutfit[] {
  const kit = fixtureKit(snapshot.lines);
  const picks: PickedOutfit[] = [];
  const seen = new Set<string>();
  for (const outfit of [...designedOutfits(kit), ...fallbackOutfits(kit)]) {
    if (picks.length >= count) break;
    const key = outfit
      .map((entry) => entry.alias)
      .sort((a, b) => a.localeCompare(b))
      .join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(outfit);
  }
  if (picks.length < Math.min(count, OUTFIT_SUGGESTION_COUNT)) {
    throw new Error(`pickCandidateOutfits: the snapshot cannot make ${OUTFIT_SUGGESTION_COUNT} outfits`);
  }
  return picks;
}

/** The lines by what an outfit does with them. */
type FixtureKit = {
  /** Tops whose layer role is base or either. */
  bases: SuggestionLine[];
  /** Tops whose layer role is mid. */
  mids: SuggestionLine[];
  /** The first mid top whose subcategory says hoodie or sweatshirt. */
  hoodie: SuggestionLine | undefined;
  /** The other mid tops. */
  knits: SuggestionLine[];
  bottoms: SuggestionLine[];
  dresses: SuggestionLine[];
  shoes: SuggestionLine[];
  socks: SuggestionLine[];
  outers: SuggestionLine[];
};

function fixtureKit(lines: readonly SuggestionLine[]): FixtureKit {
  const of = (category: ItemCategory) => lines.filter((line) => line.category === category);
  const tops = of("top");
  const mids = tops.filter((line) => line.role === "mid");
  // By subcategory: "sweater" must not read as a sweatshirt.
  const hoodie = mids.find((line) => /^i\d+\|top\/[^|]*(?:hood|sweat ?shirt)/i.test(line.text));
  return {
    bases: tops.filter((line) => line.role !== "mid"),
    mids,
    hoodie,
    knits: mids.filter((line) => line !== hoodie),
    bottoms: of("bottom"),
    dresses: of("dress"),
    shoes: of("shoes"),
    socks: of("socks"),
    outers: of("outerwear"),
  };
}

/** The line at `index`, wrapping around; undefined for an empty list. */
function at(list: readonly SuggestionLine[], index: number): SuggestionLine | undefined {
  return list.length === 0 ? undefined : list[index % list.length];
}

function put(slot: OutfitSlot, line: SuggestionLine | undefined): PickedOutfit {
  return line === undefined ? [] : [{ slot, alias: line.alias }];
}

/** Shoes number `index`, with socks number `index` when they are closed. */
function feet(kit: FixtureKit, index: number): PickedOutfit {
  const shoe = at(kit.shoes, index);
  const sock = shoe?.feet === "closed" ? at(kit.socks, index) : undefined;
  return [...put("shoes", shoe), ...put("socks", sock)];
}

/** The five outfits pickCandidateOutfits describes, those the wardrobe allows. */
function designedOutfits(kit: FixtureKit): PickedOutfit[] {
  const { bases, mids, hoodie, knits, bottoms, dresses, shoes, outers } = kit;
  const outfits: PickedOutfit[] = [];
  if (bottoms.length > 0 && bases.length + mids.length > 0) {
    // A knit over a base top; a mid top alone only when there is no base top.
    const torso =
      bases.length === 0 ? put("top", at(mids, 0)) : [...put("mid_layer", knits[0] ?? hoodie), ...put("top", at(bases, 1))];
    outfits.push([...put("outerwear", at(outers, 0)), ...torso, ...put("bottom", at(bottoms, 0)), ...feet(kit, 0)]);
  }
  if (bottoms.length > 0 && bases.length > 0) {
    outfits.push([...put("outerwear", at(outers, 1)), ...put("top", at(bases, 1)), ...put("bottom", at(bottoms, 1)), ...feet(kit, 1)]);
  }
  if (hoodie !== undefined && bottoms.length > 0) {
    outfits.push([
      ...put("outerwear", at(outers, 2)),
      ...put("top", hoodie),
      ...put("bottom", at(bottoms, 0)),
      ...put("shoes", shoes.find((line) => line.feet === "closed") ?? at(shoes, 0)),
    ]);
  }
  if (dresses.length > 0) {
    outfits.push([...put("outerwear", at(outers, 1)), ...put("top", at(dresses, 0)), ...feet(kit, 0)]);
  }
  if (bottoms.length > 0 && bases.length > 0) {
    outfits.push([...put("outerwear", at(outers, 0)), ...put("top", at(bases, 0)), ...put("bottom", at(bottoms, 1)), ...feet(kit, 1)]);
  }
  return outfits;
}

/** Base tops with bottoms, then dresses, under no outerwear and then under each outerwear, with the first shoes. */
function fallbackOutfits(kit: FixtureKit): PickedOutfit[] {
  const outfits: PickedOutfit[] = [];
  for (const outer of [undefined, ...kit.outers]) {
    for (const base of kit.bases) {
      for (const bottom of kit.bottoms) {
        outfits.push([...put("outerwear", outer), ...put("top", base), ...put("bottom", bottom), ...feet(kit, 0)]);
      }
    }
    for (const dress of kit.dresses) outfits.push([...put("outerwear", outer), ...put("top", dress), ...feet(kit, 0)]);
  }
  return outfits;
}

/**
 * A wire reply for a snapshot: pickCandidateOutfits (5 candidates unless
 * `count` says otherwise), each following directions[index] (FAKE_DIRECTIONS
 * by default), rain_ok when its outerwear is waterproof or waterproof shoes
 * go with outerwear. The strict adapter keeps at least
 * OUTFIT_SUGGESTION_COUNT of them on the fixture wardrobe. Change the
 * returned object to test failures.
 */
export function fakeOutfitSuggestionReply(
  snapshot: Pick<SuggestionSnapshot, "lines">,
  options: { directions?: readonly DirectionKey[]; count?: number } = {},
): OutfitSuggestionWire {
  const directions = options.directions ?? FAKE_DIRECTIONS;
  const lineOf = new Map(snapshot.lines.map((line) => [line.alias, line]));
  const waterproof = (entry: PickedOutfit[number] | undefined) =>
    entry !== undefined && /\|wp1 /.test(lineOf.get(entry.alias)?.text ?? "");
  return {
    outfits: pickCandidateOutfits(snapshot, options.count ?? OUTFIT_CANDIDATE_COUNT).map((items, index) => {
      const outer = items.find((entry) => entry.slot === "outerwear");
      const shoes = items.find((entry) => entry.slot === "shoes");
      return {
        direction: directions[index] ?? directions[index % Math.max(directions.length, 1)] ?? "classic_balanced",
        title: FAKE_TITLES[index] ?? `Outfit ${index + 1}`,
        items: items.map(({ slot, alias }) => ({ slot, item: alias })),
        why: "Feels like 2 to 8 °C with an 80 % chance of rain: a waterproof layer over a warm mid layer, and boots that stay dry.",
        rain_ok: waterproof(outer) || (outer !== undefined && waterproof(shoes)),
      };
    }),
  };
}

/**
 * A stored suggestion result for these items and this weather: the snapshot,
 * a fake reply and the strict adapter with the given history (none by
 * default), exactly as the service would build it, the selection's numbers
 * and the reply's directions included.
 */
export function makeOutfitSuggestionResult(
  items: readonly OutfitFixtureItem[],
  weather: WeatherSnapshot = makeWeatherSnapshot(),
  model = "claude-sonnet-5-5",
  options: { history?: VarietyHistory; directions?: readonly DirectionKey[] } = {},
): OutfitSuggestionResult {
  const snapshot = buildSuggestionSnapshot(items, weather);
  const reply = fakeOutfitSuggestionReply(snapshot, options.directions === undefined ? {} : { directions: options.directions });
  const strict = makeOutfitSuggestionStrictSchema(snapshot, toCheckItems(items), {
    weather,
    history: options.history ?? EMPTY_HISTORY,
  });
  const parsed = strict.parse(reply);
  return {
    outfits: parsed.outfits,
    weather,
    meta: {
      prompt_version: OUTFIT_PROMPT_VERSION,
      model,
      effort: OUTFIT_CALL_PARAMS.effort,
      item_count: snapshot.itemCount,
      dropped_count: snapshot.droppedCount,
      candidate_count: parsed.report.received,
      dropped_candidates: Object.values(parsed.report.dropped).reduce((sum, count) => sum + (count ?? 0), 0),
      repaired_candidates: parsed.report.repaired,
      directions: reply.outfits.map((outfit) => outfit.direction),
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
