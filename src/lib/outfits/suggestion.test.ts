import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { readStructuredReply } from "@/lib/ai/call";
import { estimateTextTokens } from "@/lib/ai/cost";
import { countSchemaComplexity, FORBIDDEN_KEY, SCHEMA_LIMITS, toJsonSchema, toJsonSchemaFormat, type JsonSchema } from "@/lib/ai/json-schema";
import {
  AI_PURPOSES,
  ITEM_COLLECTIONS,
  ITEM_DECISIONS,
  ITEM_LOCATIONS,
  ITEM_STATUSES,
  OUTFIT_SLOTS,
  type OutfitSlot,
} from "@/lib/db/enums";
import { MAX_ACCESSORIES, SLOT_CATEGORIES, sortBySlot } from "@/lib/outfits/contracts";
import { assignDirections, DIRECTION_LABELS, wardrobeProfile } from "@/lib/outfits/style/directions";
import { seedFrom } from "@/lib/outfits/style/random";
import { selectSuggestions } from "@/lib/outfits/style/select";
import {
  DIRECTION_KEYS,
  EMPTY_HISTORY,
  type Candidate,
  type DirectionKey,
  type StyleEntry,
  type StyleItem,
  type VarietyHistory,
} from "@/lib/outfits/style/types";
import * as styleWeather from "@/lib/outfits/style/weather";
import {
  buildSuggestionInstruction,
  buildSuggestionSnapshot,
  canSuggestOutfits,
  countPossibleOutfits,
  DIRECTION_BRIEFS,
  estimateOutfitInputTokens,
  estimateOutfitSuggestionUsd,
  FIRST_TOKEN_MARGIN_MS,
  homeLocationOf,
  idealWarmth,
  isEligibleForToday,
  isRainyDay,
  makeOutfitSuggestionStrictSchema,
  MAX_REPLY_CANDIDATES,
  MAX_SUGGESTION_ITEMS,
  MIN_KEPT_PER_CATEGORY,
  OUTFIT_CALL_PARAMS,
  OUTFIT_CANDIDATE_COUNT,
  OUTFIT_DEADLINE_MS,
  OUTFIT_ESTIMATE,
  OUTFIT_PROMPT_VERSION,
  OUTFIT_SUGGESTION_COUNT,
  OUTFIT_SYSTEM_PROMPT,
  OutfitSuggestionResultSchema,
  OutfitSuggestionWireSchema,
  planVariety,
  RAINY_DAY,
  SLOWEST_TOKENS_PER_SECOND,
  SUGGESTION_LIMITS,
  toCheckItems,
  VARIETY_LIMITS,
  weatherFitScore,
  type CountableLine,
  type OutfitSuggestionStrict,
  type SuggestedOutfit,
  type SuggestionLine,
  type VarietyPrompt,
} from "@/lib/outfits/suggestion";
import { SuggestedOutfitSchema } from "@/lib/outfits/suggestion-result";
import { canonicalJson, itemLineBody } from "@/lib/relocation/payload";
import { AppError } from "@/lib/result";

import { fakeMessage } from "../../../test/fakes/anthropic";
import {
  FAKE_DIRECTIONS,
  fakeOutfitSuggestionReply,
  makeOutfitItem,
  makeOutfitSuggestionResult,
  makeOutfitWardrobe,
  makeRunningItem,
  makeWeatherSnapshot,
  OUTFIT_TEMPLATES,
  pickCandidateOutfits,
  REPAIR_CANDIDATE_INDEX,
  type OutfitFixtureItem,
} from "../../../test/outfit-fixtures";

const weather = makeWeatherSnapshot();

/** Directions only: the history blocks are left out. */
const NO_HISTORY: VarietyPrompt = { directions: FAKE_DIRECTIONS, recent: [], liked: [], disliked: [] };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Every property name anywhere in a JSON Schema. */
function propertyNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(propertyNames);
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as JsonSchema;
  const own = typeof node.properties === "object" && node.properties !== null ? Object.keys(node.properties as JsonSchema) : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe("homeLocationOf", () => {
  it("maps the two home profiles to their item location", () => {
    expect(homeLocationOf("bologna")).toBe("bologna");
    expect(homeLocationOf("hamburg")).toBe("hamburg");
  });

  it.each(["berlin", "unknown", "in_transit", "Hamburg", ""])("refuses %j with VALIDATION", (slug) => {
    expect(() => homeLocationOf(slug)).toThrow(AppError);
    try {
      homeLocationOf(slug);
    } catch (error) {
      expect(error).toMatchObject({ code: "VALIDATION", message: "Choose Bologna or Hamburg as the home city in Settings." });
    }
  });
});

describe("isEligibleForToday", () => {
  const base = { status: "confirmed", location: "hamburg", decision: "bring", category: "top", collection: "clothing" } as const;

  it("takes tagged and confirmed items only", () => {
    const eligible = ITEM_STATUSES.filter((status) => isEligibleForToday({ ...base, status }, "hamburg"));
    expect(eligible).toEqual(["tagged", "confirmed"]);
  });

  it("takes items at home or of unknown location", () => {
    expect(ITEM_LOCATIONS.filter((location) => isEligibleForToday({ ...base, location }, "hamburg"))).toEqual([
      "hamburg",
      "unknown",
    ]);
    expect(ITEM_LOCATIONS.filter((location) => isEligibleForToday({ ...base, location }, "bologna"))).toEqual([
      "bologna",
      "unknown",
    ]);
  });

  it("leaves out items on their way out", () => {
    expect(ITEM_DECISIONS.filter((decision) => isEligibleForToday({ ...base, decision }, "hamburg"))).toEqual([
      "bring",
      "leave",
      "undecided",
    ]);
  });

  it("leaves out items no slot can hold", () => {
    expect(isEligibleForToday({ ...base, category: null }, "hamburg")).toBe(false);
    expect(isEligibleForToday({ ...base, category: "other" }, "hamburg")).toBe(false);
    expect(isEligibleForToday({ ...base, category: "bag" }, "hamburg")).toBe(true);
    expect(isEligibleForToday({ ...base, category: "socks" }, "hamburg")).toBe(true);
  });

  it("takes clothing only: running gear that is otherwise eligible is left out (D-249)", () => {
    expect(isEligibleForToday(base, "hamburg")).toBe(true);
    expect(isEligibleForToday({ ...base, collection: "running" }, "hamburg")).toBe(false);
    expect(isEligibleForToday(makeRunningItem(), "hamburg")).toBe(false);
    expect(ITEM_COLLECTIONS.filter((collection) => isEligibleForToday({ ...base, collection }, "hamburg"))).toEqual([
      "clothing",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

describe("buildSuggestionSnapshot", () => {
  it("lists items by slot category, never worn first and the most recently worn last", () => {
    const shoesWorn = makeOutfitItem({ ...OUTFIT_TEMPLATES.boots, wearCount: 4, lastWornAt: new Date("2026-11-02T11:00:00Z") });
    const topYesterday = makeOutfitItem({ name: "Worn yesterday", wearCount: 9, lastWornAt: new Date("2026-11-02T11:00:00Z") });
    const topLastWeek = makeOutfitItem({ name: "Worn last week", wearCount: 2, lastWornAt: "2026-10-27T11:00:00.000Z" });
    const topNever = makeOutfitItem({ name: "Never worn" });
    const coat = makeOutfitItem({ ...OUTFIT_TEMPLATES.coat });
    const dress = makeOutfitItem({ ...OUTFIT_TEMPLATES.dress });
    const socks = makeOutfitItem({ ...OUTFIT_TEMPLATES.woolSocks });
    const snapshot = buildSuggestionSnapshot([socks, shoesWorn, topYesterday, topLastWeek, topNever, coat, dress], weather);
    expect(snapshot.lines.map((line) => [line.alias, line.itemId])).toEqual([
      ["i1", coat.id],
      ["i2", topNever.id],
      ["i3", topLastWeek.id],
      ["i4", topYesterday.id],
      ["i5", dress.id],
      ["i6", shoesWorn.id],
      ["i7", socks.id],
    ]);
    expect(snapshot.itemCount).toBe(7);
    expect(snapshot.droppedCount).toBe(0);
  });

  it("writes the relocation line body, the style fields, then worn:N and last:day or last:never", () => {
    const worn = makeOutfitItem({ wearCount: 3, lastWornAt: new Date("2026-10-30T11:00:00Z") });
    const fresh = makeOutfitItem({ ...OUTFIT_TEMPLATES.jeans });
    const snapshot = buildSuggestionSnapshot([worn, fresh], weather);
    const [first, second] = snapshot.lines;
    expect(first?.text).toBe(`i1|${itemLineBody(worn, null)}|lay:mid|worn:3|last:2026-10-30`);
    expect(second?.text).toBe(`i2|${itemLineBody(fresh, null)}|worn:0|last:never`);
    expect(first?.text).toBe(
      "i1|top/sweater|grey|merino|w3|wp0 wd0 ins0 br1|winter,spring,autumn|smart_casual|good|confirmed|Grey merino crew-neck sweater|lay:mid|worn:3|last:2026-10-30",
    );
    expect(first?.text).not.toContain("now:");
    expect(first).toMatchObject({ role: "mid", feet: null });
    expect(second).toMatchObject({ role: null, feet: null });
  });

  describe("style fields", () => {
    /** The line of one item, alone in a snapshot. */
    function lineOf(overrides: Partial<OutfitFixtureItem>): { item: OutfitFixtureItem; line: SuggestionLine } {
      const item = makeOutfitItem(overrides);
      const line = buildSuggestionSnapshot([item], weather).lines[0];
      if (line === undefined) throw new Error("no line");
      return { item, line };
    }

    /** What follows the relocation body, before worn:N. */
    function suffixOf(overrides: Partial<OutfitFixtureItem>): string {
      const { item, line } = lineOf(overrides);
      const head = `i1|${itemLineBody(item, null)}`;
      expect(line.text.startsWith(head)).toBe(true);
      return line.text.slice(head.length, line.text.lastIndexOf("|worn:"));
    }

    it.each([
      ["a tee", { ...OUTFIT_TEMPLATES.tee }, "|lay:base", "base"],
      ["a shirt", { ...OUTFIT_TEMPLATES.oxford }, "|lay:base", "base"],
      ["a sweater", { ...OUTFIT_TEMPLATES.sweater }, "|lay:mid", "mid"],
      ["a hoodie", { ...OUTFIT_TEMPLATES.hoodie }, "|lay:mid", "mid"],
      ["a turtleneck", { subcategory: "turtleneck", name: "Black turtleneck" }, "|lay:either", "either"],
      ["a dress", { ...OUTFIT_TEMPLATES.dress }, "", null],
    ] as const)("gives %s its layer role", (_label, overrides, suffix, role) => {
      expect(suffixOf(overrides)).toBe(suffix);
      expect(lineOf(overrides).line.role).toBe(role);
    });

    it.each([
      ["boots", { ...OUTFIT_TEMPLATES.boots }, "|feet:closed", "closed"],
      ["sneakers", { ...OUTFIT_TEMPLATES.sneakers }, "|feet:closed", "closed"],
      ["sandals", { ...OUTFIT_TEMPLATES.sneakers, subcategory: "sandals", name: "Tan leather sandals" }, "|feet:open", "open"],
      ["loafers", { ...OUTFIT_TEMPLATES.boots, subcategory: "loafers", name: "Brown suede loafers" }, "|feet:sockless", "sockless"],
      ["socks", { ...OUTFIT_TEMPLATES.woolSocks }, "", null],
    ] as const)("gives %s their kind of shoe", (_label, overrides, suffix, feet) => {
      expect(suffixOf(overrides)).toBe(suffix);
      expect(lineOf(overrides).line.feet).toBe(feet);
    });

    it.each([
      [null, ""],
      ["", ""],
      ["solid", ""],
      ["Plain", ""],
      ["none", ""],
      // Patterns patternClass does not place are still patterns.
      ["abstract", "|pat:abstract"],
      ["Jacquard", "|pat:Jacquard"],
      ["Breton stripes", "|pat:Breton stripes"],
      ["cable knit", "|pat:cable knit"],
      ["herringbone", "|pat:herringbone"],
      ["large red and green tartan check", "|pat:large red and green"],
      ["stripes|wide\nnavy", "|pat:stripes wide navy"],
    ] as const)("writes pattern %j as %j: any pattern that is not plain, sanitised, at most 20 characters", (pattern, suffix) => {
      expect(suffixOf({ ...OUTFIT_TEMPLATES.jeans, pattern })).toBe(suffix);
    });

    it.each([
      [null, ""],
      ["", ""],
      ["   ", ""],
      ["relaxed", "|fit:relaxed"],
      ["slim | tapered", "|fit:slim tapered"],
      ["slightly oversized and boxy", "|fit:slightly oversiz"],
    ] as const)("writes fit %j as %j: a known cut only, sanitised, at most 16 characters", (fit, suffix) => {
      expect(suffixOf({ ...OUTFIT_TEMPLATES.jeans, fit })).toBe(suffix);
    });

    it("writes lay:, feet:, pat: and fit: in that order, before worn:N", () => {
      const { item, line } = lineOf({ ...OUTFIT_TEMPLATES.tee, pattern: "navy stripes", fit: "oversized", wearCount: 2 });
      expect(line.text).toBe(`i1|${itemLineBody(item, null)}|lay:base|pat:navy stripes|fit:oversized|worn:2|last:never`);
    });
  });

  it("keeps a style item for every listed item, with whole days since the last wear in the forecast's time zone", () => {
    // The forecast is for Tuesday 2026-11-03 in Berlin.
    const cases: [Date | null, number | null][] = [
      [null, null],
      [new Date("2026-11-03T08:00:00Z"), 0],
      // 23:30 UTC is already 2026-11-03 in Berlin.
      [new Date("2026-11-02T23:30:00Z"), 0],
      [new Date("2026-11-02T11:00:00Z"), 1],
      [new Date("2026-10-27T11:00:00Z"), 7],
      // A wear logged for a later day than the forecast's counts as today.
      [new Date("2026-11-05T11:00:00Z"), 0],
    ];
    const items = cases.map(([lastWornAt]) => makeOutfitItem({ lastWornAt, wearCount: lastWornAt === null ? 0 : 1 }));
    const running = makeRunningItem();
    const snapshot = buildSuggestionSnapshot([...items, running], weather);
    expect(snapshot.styleItems.size).toBe(items.length);
    expect(snapshot.styleItems.has(running.id)).toBe(false);
    items.forEach((item, index) => {
      expect(snapshot.styleItems.get(item.id)?.daysSinceWorn).toBe(cases[index]?.[1]);
    });
  });

  it("copies the style fields of the row into its style item", () => {
    const tee = makeOutfitItem({
      ...OUTFIT_TEMPLATES.tee,
      colorHex: ["#f5f5f2"],
      pattern: "Breton stripes",
      fit: "relaxed",
      wearCount: 4,
      lastWornAt: new Date("2026-11-01T11:00:00Z"),
    });
    const expected: StyleItem = {
      id: tee.id,
      category: "top",
      subcategory: "t-shirt",
      name: "White cotton t-shirt",
      colors: ["white"],
      colorHex: ["#f5f5f2"],
      pattern: "Breton stripes",
      fit: "relaxed",
      materials: ["cotton"],
      formality: "casual",
      warmthLevel: 1,
      waterproof: false,
      windproof: false,
      insulated: false,
      seasons: ["spring", "summer"],
      condition: "good",
      wearCount: 4,
      daysSinceWorn: 2,
    };
    expect(buildSuggestionSnapshot([tee], weather).styleItems.get(tee.id)).toEqual(expected);
  });

  it("never lists running gear, and leaves the clothing's lines and hash as they were (D-249)", () => {
    const wardrobe = Object.values(makeOutfitWardrobe());
    const runningTop = makeRunningItem();
    const runningShoes = makeRunningItem({ ...OUTFIT_TEMPLATES.sneakers, name: "Neon trail running shoes", collection: "running" });
    const clothingOnly = buildSuggestionSnapshot(wardrobe, weather);

    const snapshot = buildSuggestionSnapshot([runningTop, ...wardrobe, runningShoes], weather);

    const listed = snapshot.lines.map((line) => line.itemId);
    expect(listed).not.toContain(runningTop.id);
    expect(listed).not.toContain(runningShoes.id);
    expect(snapshot.aliasOfId.has(runningTop.id) || snapshot.aliasOfId.has(runningShoes.id)).toBe(false);
    expect(snapshot.lines).toEqual(clothingOnly.lines);
    expect(snapshot.snapshotHash).toBe(clothingOnly.snapshotHash);
    expect(snapshot).toMatchObject({ itemCount: wardrobe.length, droppedCount: 0 });
    const prompt = buildSuggestionInstruction({ weather, place: "Hamburg, Germany", lines: snapshot.lines, variety: NO_HISTORY });
    expect(prompt).not.toContain("Neon running shirt");
    expect(prompt).not.toContain("Neon trail running shoes");
  });

  it("maps aliases and item ids both ways", () => {
    const wardrobe = Object.values(makeOutfitWardrobe());
    const snapshot = buildSuggestionSnapshot(wardrobe, weather);
    expect(snapshot.itemCount).toBe(wardrobe.length);
    for (const line of snapshot.lines) {
      expect(snapshot.byAlias.get(line.alias)).toBe(line.itemId);
      expect(snapshot.aliasOfId.get(line.itemId)).toBe(line.alias);
      expect(snapshot.styleItems.get(line.itemId)?.category).toBe(line.category);
    }
    expect(snapshot.lines.map((line) => line.alias)).toEqual(wardrobe.map((_, index) => `i${index + 1}`));
  });

  it("hashes the same wardrobe the same in any input order, and differently after a wear or a new cut", () => {
    const wardrobe = Object.values(makeOutfitWardrobe());
    const hash = buildSuggestionSnapshot(wardrobe, weather).snapshotHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(buildSuggestionSnapshot([...wardrobe].reverse(), weather).snapshotHash).toBe(hash);
    const [first, ...rest] = wardrobe;
    if (first === undefined) throw new Error("empty wardrobe");
    const worn = { ...first, wearCount: 1, lastWornAt: new Date("2026-11-03T11:00:00Z") };
    expect(buildSuggestionSnapshot([worn, ...rest], weather).snapshotHash).not.toBe(hash);
    expect(buildSuggestionSnapshot(rest, weather).snapshotHash).not.toBe(hash);
    expect(buildSuggestionSnapshot([{ ...first, fit: "relaxed" }, ...rest], weather).snapshotHash).not.toBe(hash);
    // The hex codes are not part of a line.
    expect(buildSuggestionSnapshot([{ ...first, colorHex: ["#1f2a44"] }, ...rest], weather).snapshotHash).toBe(hash);
  });

  describe(`over ${MAX_SUGGESTION_ITEMS} items`, () => {
    // Feels like 2.1 to 7.6 °C in November: warmth 4 is ideal, summer-only light items fit worst.
    const warmTop = () => makeOutfitItem({ warmthLevel: 4, seasons: ["autumn", "winter"] });
    const summerTop = () => makeOutfitItem({ ...OUTFIT_TEMPLATES.tee, seasons: ["summer"] });
    const summerBottom = () => makeOutfitItem({ ...OUTFIT_TEMPLATES.chinos, warmthLevel: 1, seasons: ["summer"] });
    const warmShoes = () => makeOutfitItem({ ...OUTFIT_TEMPLATES.boots, warmthLevel: 4, seasons: ["autumn"] });

    it("drops the items least suited to the weather and counts them", () => {
      const bottoms = Array.from({ length: 20 }, summerBottom);
      const items = [...bottoms, ...Array.from({ length: 300 }, warmTop), ...Array.from({ length: 30 }, warmShoes)];
      const summerTops = Array.from({ length: 100 }, summerTop);
      const snapshot = buildSuggestionSnapshot([...items, ...summerTops], weather);
      expect(snapshot.itemCount).toBe(MAX_SUGGESTION_ITEMS);
      expect(snapshot.droppedCount).toBe(50);
      expect(snapshot.styleItems.size).toBe(MAX_SUGGESTION_ITEMS);
      const kept = new Set(snapshot.lines.map((line) => line.itemId));
      for (const item of items) expect(kept.has(item.id)).toBe(true);
      // Equal scores go to the oldest first, so the 50 newest summer tops are dropped.
      expect(summerTops.filter((item) => !kept.has(item.id))).toEqual(summerTops.slice(50));
      expect(snapshot.lines.at(-1)?.alias).toBe(`i${MAX_SUGGESTION_ITEMS}`);
    });

    it(`keeps up to ${MIN_KEPT_PER_CATEGORY} items of every category, however badly they fit`, () => {
      const tops = Array.from({ length: 395 }, warmTop);
      const shoes = Array.from({ length: 10 }, warmShoes);
      const bottoms = Array.from({ length: 5 }, summerBottom);
      const snapshot = buildSuggestionSnapshot([...tops, ...shoes, ...bottoms], weather);
      const kept = new Set(snapshot.lines.map((line) => line.itemId));
      expect(snapshot.droppedCount).toBe(10);
      expect(bottoms.every((item) => kept.has(item.id))).toBe(true);
      expect(shoes.every((item) => kept.has(item.id))).toBe(true);
      expect(tops.filter((item) => !kept.has(item.id))).toEqual(tops.slice(385));
    });

    it("is deterministic", () => {
      const items = [...Array.from({ length: 380 }, warmTop), ...Array.from({ length: 40 }, summerTop), ...Array.from({ length: 12 }, summerBottom)];
      const a = buildSuggestionSnapshot(items, weather);
      const b = buildSuggestionSnapshot([...items].reverse(), weather);
      expect(b.snapshotHash).toBe(a.snapshotHash);
      expect(a.droppedCount).toBe(items.length - MAX_SUGGESTION_ITEMS);
    });
  });
});

describe("weather fit", () => {
  it("uses the style library's weather helpers, re-exported for existing importers", () => {
    expect(isRainyDay).toBe(styleWeather.isRainyDay);
    expect(idealWarmth).toBe(styleWeather.idealWarmth);
    expect(RAINY_DAY).toBe(styleWeather.RAINY_DAY);
  });

  it("maps the feels-like mean to an ideal warmth", () => {
    expect([30, 22, 21.9, 16, 15.9, 10, 9.9, 3, 2.9, -10].map(idealWarmth)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("counts rain from a 50 % chance or 2 mm", () => {
    expect(isRainyDay({ precipProbMax: 50, precipSumMm: 0 })).toBe(true);
    expect(isRainyDay({ precipProbMax: 49, precipSumMm: 1.9 })).toBe(false);
    expect(isRainyDay({ precipProbMax: null, precipSumMm: 2 })).toBe(true);
  });

  it("scores warmth distance, an off-season item and rain gear", () => {
    // Ideal warmth 4 on the fixture day (feels like 2.1 to 7.6 °C), autumn, rainy.
    const score = (overrides: Partial<OutfitFixtureItem>) => weatherFitScore(makeOutfitItem(overrides), weather);
    expect(score({ warmthLevel: 4, seasons: ["autumn"] })).toBe(0);
    expect(score({ warmthLevel: 1, seasons: ["autumn"] })).toBe(3);
    expect(score({ warmthLevel: null, seasons: [] })).toBe(2);
    expect(score({ warmthLevel: 4, seasons: ["summer"] })).toBe(1);
    expect(score({ ...OUTFIT_TEMPLATES.shell })).toBe(1);
    expect(weatherFitScore(makeOutfitItem({ ...OUTFIT_TEMPLATES.shell }), makeWeatherSnapshot({ precipProbMax: 10, precipSumMm: 0 }))).toBe(2);
  });
});

describe("countPossibleOutfits", () => {
  type Spec = SuggestionLine["category"] | readonly [SuggestionLine["category"], SuggestionLine["role"]];
  const lines = (...specs: Spec[]): CountableLine[] =>
    specs.map((spec) => (typeof spec === "string" ? { category: spec } : { category: spec[0], role: spec[1] }));
  const tee = ["top", "base"] as const;
  const hoodie = ["top", "mid"] as const;
  const turtleneck = ["top", "either"] as const;

  it.each([
    ["nothing", lines(), 0],
    ["a top alone", lines(tee), 0],
    ["a top and a bottom", lines(tee, "bottom"), 1],
    ["a top without a role, as either", lines("top", "bottom"), 1],
    ["plus shoes, which are always added", lines(tee, "bottom", "shoes"), 1],
    ["plus a second pair of shoes", lines(tee, "bottom", "shoes", "shoes"), 2],
    ["plus a jacket", lines(tee, "bottom", "shoes", "outerwear"), 2],
    ["plus socks, which come with closed shoes", lines(tee, "bottom", "shoes", "socks", "socks"), 1],
    ["plus a base layer, which leaves the core as it is", lines(tee, "bottom", "base_layer"), 1],
    ["two tops, two bottoms", lines(tee, turtleneck, "bottom", "bottom"), 4],
    ["a tee and a hoodie: the tee alone or under the hoodie", lines(tee, hoodie, "bottom"), 2],
    ["a hoodie with no base top: alone in top", lines(hoodie, "bottom"), 1],
    ["two hoodies with no base top", lines(hoodie, hoodie, "bottom"), 2],
    ["two base tops and two mid tops", lines(tee, turtleneck, hoodie, hoodie, "bottom"), 6],
    ["a dress alone", lines("dress"), 1],
    ["a dress and a bottom", lines("dress", "bottom"), 2],
    ["a dress and a cardigan", lines("dress", hoodie), 2],
    ["a dress and two accessories, which leave the core as it is", lines("dress", "accessory", "bag"), 1],
    ["a top, a bottom and five accessories", lines(tee, "bottom", ...Array.from({ length: 5 }, () => "accessory" as const)), 1],
    ["two hats, which leave the core as it is", lines(tee, "bottom", "hat_beanie", "hat_beanie"), 1],
    ["a top and a bottom with a hat, scarf and gloves", lines(tee, "bottom", "hat_beanie", "scarf", "gloves"), 1],
  ])("counts %s", (_label, input, expected) => {
    expect(countPossibleOutfits(input)).toBe(expected);
  });

  it("counts the fixture wardrobe by hand", () => {
    const snapshot = buildSuggestionSnapshot(Object.values(makeOutfitWardrobe()), weather);
    // Tb 2 (tee, oxford), Tm 2 (sweater, hoodie): torso 2 + 4 = 6; B 2, D 1: 6 x 2 + 1 x 3 x 3 = 21;
    // S 2: 42; outerwear 3 + 1: x 4. The base layer, hat, gloves, scarf, socks and accessories count as 1.
    expect(countPossibleOutfits(snapshot.lines)).toBe(168);
  });

  it(`allows a suggestion only when ${OUTFIT_SUGGESTION_COUNT} different outfits exist`, () => {
    const full = (input: CountableLine[]): SuggestionLine[] =>
      input.map((line, index) => ({ alias: `i${index + 1}`, itemId: "", text: "", category: line.category, role: line.role ?? null, feet: null }));
    expect(canSuggestOutfits({ lines: full(lines(tee, "bottom", "shoes", "outerwear")) })).toBe(false);
    // A hat makes no other core: still only the tee with or without the jacket.
    expect(canSuggestOutfits({ lines: full(lines(tee, "bottom", "shoes", "outerwear", "hat_beanie")) })).toBe(false);
    expect(canSuggestOutfits({ lines: full(lines(tee, "bottom", "hat_beanie", "scarf", "gloves")) })).toBe(false);
    expect(canSuggestOutfits({ lines: full(lines(tee, "bottom", "shoes", "outerwear", "outerwear")) })).toBe(true);
    expect(canSuggestOutfits({ lines: full(lines(tee, hoodie, "bottom", "shoes", "outerwear")) })).toBe(true);
  });
});

describe("countPossibleOutfits against the selection", () => {
  /** The slots a candidate may fill besides top: each is left empty or given one item it takes. */
  const OPTIONAL_SLOTS = [
    "mid_layer",
    "base_layer",
    "bottom",
    "shoes",
    "outerwear",
    "socks",
    "hat",
    "gloves",
    "scarf",
    "accessory",
  ] as const satisfies readonly OutfitSlot[];

  /** Every outfit the items can be written as: each top or dress in top, each optional slot empty or holding one item. */
  function everyCandidate(items: readonly OutfitFixtureItem[]): Candidate[] {
    let outfits: StyleEntry[][] = items
      .filter((item) => item.category === "top" || item.category === "dress")
      .map((item) => [{ slot: "top", itemId: item.id }]);
    for (const slot of OPTIONAL_SLOTS) {
      const fits = items.filter((item) => item.category !== null && SLOT_CATEGORIES[slot].includes(item.category));
      outfits = outfits.flatMap((entries) => [
        entries,
        ...fits
          .filter((item) => !entries.some((entry) => entry.itemId === item.id))
          .map((item) => [...entries, { slot, itemId: item.id }]),
      ]);
    }
    return outfits.map((entries, index) => ({
      index,
      direction: null,
      title: `Outfit ${index + 1}`,
      why: "One of every combination.",
      rain_ok: false,
      entries,
    }));
  }

  // [wardrobe, the count, the distinct cores the selection keeps from every combination]
  it.each([
    ["a tee and jeans with a hat, scarf and gloves", ["tee", "jeans", "beanie", "scarf", "gloves"], 1, 1],
    ["a tee, jeans, boots and a shell, with a hat", ["tee", "jeans", "boots", "shell", "beanie"], 2, 2],
    ["the same with a thermal, socks and two accessories", ["tee", "jeans", "boots", "shell", "thermal", "woolSocks", "belt", "tote"], 2, 2],
    ["a dress, jeans and sneakers", ["dress", "jeans", "sneakers"], 2, 2],
    ["a tee alone or under a hoodie, with or without a shell", ["tee", "hoodie", "jeans", "boots", "shell"], 4, 4],
    ["a dress and a sweater, no base top", ["dress", "sweater", "jeans", "boots"], 5, 5],
    ["two tops, bottoms, shoes and outerwear, with socks and a scarf", ["tee", "sweater", "jeans", "chinos", "boots", "sneakers", "shell", "coat", "woolSocks", "scarf"], 24, 24],
    // Floors: pairs the check lets through that the count leaves out.
    ["an open shirt over a tee, which the count leaves out", ["tee", "oxford", "jeans", "boots"], 2, 3],
    ["a knit alone over a thermal, which the count leaves out", ["tee", "sweater", "jeans", "boots", "thermal"], 2, 3],
  ] as const)("%s: the count is a floor of what the selection keeps", (_label, keys, count, usable) => {
    const all = makeOutfitWardrobe();
    const items = keys.map((key) => all[key]);
    const snapshot = buildSuggestionSnapshot(items, weather);
    const result = selectSuggestions(everyCandidate(items), {
      items: snapshot.styleItems,
      checkItems: toCheckItems(items),
      weather,
      history: EMPTY_HISTORY,
      count: OUTFIT_SUGGESTION_COUNT,
    });

    expect(countPossibleOutfits(snapshot.lines)).toBe(count);
    expect(result.report.usable).toBe(usable);
    expect(count).toBeLessThanOrEqual(usable);
    expect(canSuggestOutfits(snapshot)).toBe(count >= OUTFIT_SUGGESTION_COUNT);
    expect(result.ok).toBe(usable >= OUTFIT_SUGGESTION_COUNT);
    // Never pay for a call the selection could not pass.
    if (canSuggestOutfits(snapshot)) expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe("OutfitSuggestionWireSchema", () => {
  const schema = toJsonSchema(OutfitSuggestionWireSchema);

  it("converts within the structured-output limits with no reserved keys", () => {
    const complexity = countSchemaComplexity(schema);
    expect(complexity.unions).toBeLessThanOrEqual(SCHEMA_LIMITS.unions);
    expect(complexity.optionals).toBe(0);
    expect(toJsonSchemaFormat(OutfitSuggestionWireSchema).schema).toEqual(schema);
    const names = propertyNames(schema);
    expect(names).toEqual(expect.arrayContaining(["outfits", "direction", "title", "items", "slot", "item", "why", "rain_ok"]));
    expect(names.filter((name) => FORBIDDEN_KEY.test(name))).toEqual([]);
    expect(JSON.stringify(schema)).not.toMatch(/reasoning|thinking|thought/i);
  });

  it("asks for the direction first, from the direction keys", () => {
    const outfit = (schema.properties as JsonSchema).outfits as JsonSchema;
    const properties = (outfit.items as JsonSchema).properties as JsonSchema;
    expect(Object.keys(properties)).toEqual(["direction", "title", "items", "why", "rain_ok"]);
    expect((properties.direction as JsonSchema).enum).toEqual([...DIRECTION_KEYS]);
  });

  it("keeps every slot in the slot enum and states every rule and limit", () => {
    const text = JSON.stringify(schema);
    expect(text).toContain(JSON.stringify([...OUTFIT_SLOTS]));
    for (const slot of OUTFIT_SLOTS) expect(text).toContain(`"${slot}"`);
    expect(text).toContain(`at most ${SUGGESTION_LIMITS.titleMax} characters`);
    expect(text).toContain(`at most ${SUGGESTION_LIMITS.whyMax} characters`);
    expect(text).toContain(`Exactly ${OUTFIT_CANDIDATE_COUNT} outfits, one for each direction in <directions>, in that order`);
    expect(text).toContain(`up to ${MAX_ACCESSORIES} in accessory`);
    expect(text).toContain("a mid layer goes over the top; socks with closed shoes");
  });
});

describe("makeOutfitSuggestionStrictSchema", () => {
  const wardrobe = makeOutfitWardrobe();
  const items = Object.values(wardrobe);
  const snapshot = buildSuggestionSnapshot(items, weather);
  const selection = { weather, history: EMPTY_HISTORY };
  const strict = makeOutfitSuggestionStrictSchema(snapshot, toCheckItems(items), selection);
  const alias = (item: OutfitFixtureItem) => snapshot.aliasOfId.get(item.id) ?? "?";
  const valid = fakeOutfitSuggestionReply(snapshot);
  type Reply = { outfits: unknown[] };
  type WireOutfit = (typeof valid.outfits)[number];

  /** Parses a reply as callStructured does: JSON text, then the strict schema. */
  const run = (reply: unknown, schema = strict) => schema.safeParse(JSON.parse(JSON.stringify(reply)));
  const messages = (result: ReturnType<typeof run>) =>
    result.success ? "" : result.error.issues.map((issue) => issue.message).join("\n");
  const parsedOf = (result: ReturnType<typeof run>): OutfitSuggestionStrict => {
    if (!result.success) throw new Error(`rejected: ${messages(result)}`);
    return result.data;
  };
  const candidate = (index: number): WireOutfit => {
    const outfit = valid.outfits[index];
    if (outfit === undefined) throw new Error(`no candidate ${index}`);
    return outfit;
  };
  /** The fake reply with candidate `index` changed. */
  const withCandidate = (index: number, change: Record<string, unknown>): Reply => ({
    outfits: valid.outfits.map((outfit, i) => (i === index ? { ...outfit, ...change } : outfit)),
  });
  /** Only these candidates of the fake reply, so each usable one must be picked. */
  const only = (...indexes: number[]): Reply => ({ outfits: indexes.map(candidate) });
  const slotOf = (outfit: SuggestedOutfit, item: OutfitFixtureItem) => outfit.items.find((entry) => entry.itemId === item.id)?.slot;
  const byTitle = (outfits: readonly SuggestedOutfit[], title: string) => outfits.find((outfit) => outfit.title === title);
  const socks = [wardrobe.woolSocks.id, wardrobe.dressSocks.id];

  /** The hoodie candidate after the selection: the hoodie over a tee, the boots with socks. */
  function expectRepairedHoodie(outfit: SuggestedOutfit | undefined): void {
    expect(outfit).toBeDefined();
    if (outfit === undefined) return;
    expect(slotOf(outfit, wardrobe.hoodie)).toBe("mid_layer");
    expect(slotOf(outfit, wardrobe.tee)).toBe("top");
    expect(slotOf(outfit, wardrobe.boots)).toBe("shoes");
    expect(outfit.items.filter((entry) => entry.slot === "socks").map((entry) => socks.includes(entry.itemId))).toEqual([true]);
  }

  it("builds the fake reply as described: five candidates, one a hoodie alone with boots and no socks", () => {
    expect(OutfitSuggestionWireSchema.safeParse(valid).success).toBe(true);
    expect(valid.outfits.map((outfit) => outfit.direction)).toEqual(FAKE_DIRECTIONS);
    expect(pickCandidateOutfits(snapshot)).toHaveLength(OUTFIT_CANDIDATE_COUNT);
    const repair = candidate(REPAIR_CANDIDATE_INDEX).items;
    expect(repair).toContainEqual({ slot: "top", item: alias(wardrobe.hoodie) });
    expect(repair).toContainEqual({ slot: "shoes", item: alias(wardrobe.boots) });
    expect(repair.some((entry) => entry.slot === "socks" || entry.slot === "mid_layer")).toBe(false);
  });

  it("keeps three outfits of a good reply, in slot order, with their directions and a report", () => {
    const { outfits, report } = parsedOf(run(valid));
    expect(outfits).toHaveLength(OUTFIT_SUGGESTION_COUNT);
    expect(report).toEqual({ received: OUTFIT_CANDIDATE_COUNT, usable: OUTFIT_CANDIDATE_COUNT, repaired: 1, dropped: {} });
    for (const outfit of outfits) {
      expect(SuggestedOutfitSchema.parse(outfit)).toEqual(outfit);
      expect(outfit.items).toEqual(sortBySlot(outfit.items));
      for (const entry of outfit.items) expect(snapshot.styleItems.has(entry.itemId)).toBe(true);
      const source = valid.outfits.find((wire) => wire.direction === outfit.direction);
      expect(outfit).toMatchObject({ title: source?.title, why: source?.why });
    }
    const sets = outfits.map((outfit) => outfit.items.map((entry) => entry.itemId).sort((a, b) => a.localeCompare(b)).join(","));
    expect(new Set(sets).size).toBe(OUTFIT_SUGGESTION_COUNT);
    // The hoodie candidate, when picked, comes back repaired.
    const repaired = byTitle(outfits, candidate(REPAIR_CANDIDATE_INDEX).title);
    if (repaired !== undefined) expectRepairedHoodie(repaired);
  });

  it("puts a tee under a hoodie worn alone in top, and socks into the boots", () => {
    const { outfits, report } = parsedOf(run(only(0, REPAIR_CANDIDATE_INDEX, 3)));
    expect(report).toEqual({ received: 3, usable: 3, repaired: 1, dropped: {} });
    const repaired = byTitle(outfits, candidate(REPAIR_CANDIDATE_INDEX).title);
    expectRepairedHoodie(repaired);
    expect(repaired?.items).toEqual(sortBySlot(repaired?.items ?? []));
    expect(repaired?.direction).toBe(candidate(REPAIR_CANDIDATE_INDEX).direction);
  });

  it("drops a candidate with an unknown alias and a malformed one, counts them and keeps the rest", () => {
    const reply = withCandidate(1, { items: [{ slot: "top", item: "i999" }, { slot: "bottom", item: alias(wardrobe.jeans) }] });
    reply.outfits[4] = { ...candidate(4), title: "x".repeat(61) };
    const { outfits, report } = parsedOf(run(reply));
    expect(report).toEqual({ received: 5, usable: 3, repaired: 1, dropped: { malformed: 1, unknown_alias: 1 } });
    expect(outfits.map((outfit) => outfit.title).sort((a, b) => a.localeCompare(b))).toEqual(
      [candidate(0).title, candidate(2).title, candidate(3).title].sort((a, b) => a.localeCompare(b)),
    );
  });

  const withoutWhy = Object.fromEntries(Object.entries(candidate(4)).filter(([key]) => key !== "why"));

  it.each([
    ["a 61-character title", { ...candidate(4), title: "x".repeat(61) }],
    ["a blank title", { ...candidate(4), title: "  " }],
    ["a 301-character why", { ...candidate(4), why: "x".repeat(301) }],
    ["an empty why", { ...candidate(4), why: "" }],
    ["a missing why", withoutWhy],
    ["an unknown slot", { ...candidate(4), items: [{ slot: "belt", item: "i1" }] }],
    ["rain_ok as text", { ...candidate(4), rain_ok: "yes" }],
    ["a direction that is not text", { ...candidate(4), direction: 3 }],
    ["an extra key", { ...candidate(4), colour: "navy" }],
    ["text instead of an outfit", "a navy outfit"],
  ])("drops %s as malformed", (_label, broken) => {
    const reply: Reply = { outfits: [...valid.outfits.slice(0, 4), broken] };
    const { report } = parsedOf(run(reply));
    expect(report).toMatchObject({ received: 5, usable: 4, dropped: { malformed: 1 } });
  });

  it("drops what the selection rejects (an invalid outfit, a layering error, a duplicate) and counts it with the rest", () => {
    const invalid = { ...candidate(0), title: "No bottom", items: candidate(0).items.filter((entry) => entry.slot !== "bottom") };
    const layering = {
      ...candidate(4),
      title: "Tee over a shirt",
      items: [
        { slot: "mid_layer", item: alias(wardrobe.tee) },
        { slot: "top", item: alias(wardrobe.oxford) },
        { slot: "bottom", item: alias(wardrobe.chinos) },
        { slot: "shoes", item: alias(wardrobe.sneakers) },
        { slot: "socks", item: alias(wardrobe.dressSocks) },
      ],
    };
    const duplicate = { ...candidate(1), title: "Again", items: [...candidate(1).items].reverse() };
    const reply: Reply = { outfits: [...valid.outfits, invalid, layering, duplicate] };
    expect(reply.outfits).toHaveLength(MAX_REPLY_CANDIDATES);
    const { outfits, report } = parsedOf(run(reply));
    expect(outfits).toHaveLength(OUTFIT_SUGGESTION_COUNT);
    expect(report).toEqual({ received: 8, usable: 5, repaired: 1, dropped: { invalid_outfit: 1, layering: 1, duplicate: 1 } });
  });

  it("trims titles and whys, and folds the case of slots, aliases and directions (D-165)", () => {
    const reply = only(0, 2, 3);
    reply.outfits[0] = {
      ...candidate(0),
      direction: " Knit_Layers ",
      title: "  Layered  ",
      why: " Warm and dry. ",
      items: candidate(0).items.map((entry) => ({ slot: ` ${entry.slot.toUpperCase()} `, item: ` ${entry.item.toUpperCase()}` })),
    };
    const { outfits } = parsedOf(run(reply));
    const layered = byTitle(outfits, "Layered");
    expect(layered).toMatchObject({ direction: "knit_layers", why: "Warm and dry." });
    expect(layered?.items.map((entry) => entry.itemId).sort((a, b) => a.localeCompare(b))).toEqual(
      candidate(0)
        .items.map((entry) => snapshot.byAlias.get(entry.item))
        .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    );
  });

  it("keeps an outfit whose direction is not a known key, without a direction", () => {
    const reply = only(0, 2, 3);
    reply.outfits[1] = { ...candidate(2), direction: "boho" };
    const { outfits } = parsedOf(run(reply));
    const outfit = byTitle(outfits, candidate(2).title);
    expect(outfit).toBeDefined();
    expect(outfit !== undefined && "direction" in outfit).toBe(false);
  });

  it("accepts a dress without a bottom", () => {
    const { outfits } = parsedOf(run(only(0, 1, 3)));
    const dress = outfits.find((outfit) => slotOf(outfit, wardrobe.dress) === "top");
    expect(dress?.items.some((entry) => entry.slot === "bottom")).toBe(false);
  });

  it("rejects a reply with too few usable candidates, with a message that names the counts", () => {
    const reply: Reply = {
      outfits: [
        candidate(0),
        { ...candidate(1), items: [{ slot: "top", item: "i999" }, { slot: "bottom", item: alias(wardrobe.chinos) }] },
        { ...candidate(2), title: "   " },
        candidate(3),
        { ...candidate(4), items: candidate(4).items.filter((entry) => entry.slot !== "bottom") },
      ],
    };
    const result = run(reply);
    expect(result.success).toBe(false);
    expect(messages(result)).toBe(
      "2 of 5 candidates usable, 3 needed: 1 malformed, 1 unknown_alias, 1 invalid_outfit " +
        "(outfit 2: unknown alias i999; outfit 3: title: Too small: expected string to have >=1 characters)",
    );
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path)).toEqual([[]]);
    // What callStructured logs for the retry.
    const read = readStructuredReply(fakeMessage({ json: reply }), strict);
    expect(read).toEqual({ kind: "invalid_output", detail: `<root>: ${messages(result)}` });
  });

  it.each([
    ["no outfits", { outfits: [] }],
    [`${MAX_REPLY_CANDIDATES + 1} outfits`, { outfits: Array.from({ length: MAX_REPLY_CANDIDATES + 1 }, () => candidate(0)) }],
    ["no outfits key", {}],
    ["an extra key", { ...valid, note: "x" }],
    ["outfits that are not a list", { outfits: candidate(0) }],
  ])("rejects a reply with %s as a whole", (_label, reply) => {
    expect(run(reply).success).toBe(false);
  });

  it("drops a candidate with an item archived since the snapshot", () => {
    const archived = new Map(toCheckItems(items));
    archived.set(wardrobe.boots.id, { id: wardrobe.boots.id, category: "shoes", status: "archived", collection: "clothing" });
    const result = run(valid, makeOutfitSuggestionStrictSchema(snapshot, archived, selection));
    // The boots are in candidates 0, 2 and 3.
    expect(messages(result)).toBe("2 of 5 candidates usable, 3 needed: 3 invalid_outfit");
  });

  it("drops a candidate with an item moved to running gear since the snapshot (not_clothing, D-250)", () => {
    const moved = new Map(toCheckItems(items));
    moved.set(wardrobe.jeans.id, { id: wardrobe.jeans.id, category: "bottom", status: "confirmed", collection: "running" });
    const { outfits, report } = parsedOf(run(valid, makeOutfitSuggestionStrictSchema(snapshot, moved, selection)));
    // The jeans are in candidates 0 and 2.
    expect(report).toMatchObject({ received: 5, usable: 3, dropped: { invalid_outfit: 2 } });
    for (const outfit of outfits) expect(slotOf(outfit, wardrobe.jeans)).toBeUndefined();
  });

  it("checks each item with its collection", () => {
    const running = makeRunningItem();
    expect(toCheckItems([running, wardrobe.tee]).get(running.id)).toEqual({
      id: running.id,
      category: "top",
      status: "confirmed",
      collection: "running",
    });
    expect(toCheckItems([wardrobe.tee]).get(wardrobe.tee.id)?.collection).toBe("clothing");
  });

  it("reads the variety history: an outfit worn yesterday and suggested again today loses to a fresh one", () => {
    const usedIds = (index: number) => candidate(index).items.map((entry) => snapshot.byAlias.get(entry.item) ?? "");
    // Both echoes: the fresh alternatives wear canvas sneakers on a cold, wet day, which costs them too.
    const history: VarietyHistory = {
      ...EMPTY_HISTORY,
      worn: [{ itemIds: usedIds(0), ageDays: 1 }],
      suggested: [{ itemIds: usedIds(0), ageDays: 0, direction: candidate(0).direction }],
    };
    const fresh = parsedOf(run(valid));
    const tired = parsedOf(run(valid, makeOutfitSuggestionStrictSchema(snapshot, toCheckItems(items), { weather, history })));
    expect(byTitle(fresh.outfits, candidate(0).title)).toBeDefined();
    expect(byTitle(tired.outfits, candidate(0).title)).toBeUndefined();
  });
});

describe("OutfitSuggestionResultSchema", () => {
  it("accepts the stored result the service builds, with the selection's numbers", () => {
    const result = makeOutfitSuggestionResult(Object.values(makeOutfitWardrobe()));
    expect(OutfitSuggestionResultSchema.parse(result)).toEqual(result);
    expect(result.meta).toEqual({
      prompt_version: OUTFIT_PROMPT_VERSION,
      model: "claude-sonnet-5-5",
      effort: "medium",
      item_count: Object.keys(OUTFIT_TEMPLATES).length,
      dropped_count: 0,
      candidate_count: OUTFIT_CANDIDATE_COUNT,
      dropped_candidates: 0,
      repaired_candidates: 1,
      directions: [...FAKE_DIRECTIONS],
    });
    for (const outfit of result.outfits) expect(FAKE_DIRECTIONS).toContain(outfit.direction);
  });

  it("requires exactly three outfits with uuid items", () => {
    const result = makeOutfitSuggestionResult(Object.values(makeOutfitWardrobe()));
    expect(OutfitSuggestionResultSchema.safeParse({ ...result, outfits: result.outfits.slice(1) }).success).toBe(false);
    const [first, ...rest] = result.outfits;
    if (first === undefined) throw new Error("no outfit");
    const aliased = { ...first, items: [{ slot: "top", itemId: "i1" }] };
    expect(OutfitSuggestionResultSchema.safeParse({ ...result, outfits: [aliased, ...rest] }).success).toBe(false);
  });

  it("still reads a result stored by outfit-v2: no directions, no selection numbers", () => {
    const outfit = (title: string) => ({
      title,
      why: "Feels like 2 to 8 °C with an 80 % chance of rain.",
      rain_ok: false,
      items: [
        { slot: "top", itemId: randomUUID() },
        { slot: "bottom", itemId: randomUUID() },
        { slot: "shoes", itemId: randomUUID() },
      ],
    });
    const stored = {
      outfits: [outfit("One"), outfit("Two"), outfit("Three")],
      weather,
      meta: { prompt_version: "outfit-v2", model: "claude-sonnet-5-5", effort: "low", item_count: 17, dropped_count: 0 },
    };
    expect(OutfitSuggestionResultSchema.parse(stored)).toEqual(stored);
  });

  it.each([
    ["a negative candidate count", { candidate_count: -1 }],
    ["a fractional repair count", { repaired_candidates: 1.5 }],
    ["nine directions", { directions: Array.from({ length: 9 }, () => "classic_balanced") }],
    ["an empty direction", { directions: [""] }],
  ])("rejects meta with %s", (_label, meta) => {
    const result = makeOutfitSuggestionResult(Object.values(makeOutfitWardrobe()));
    expect(OutfitSuggestionResultSchema.safeParse({ ...result, meta: { ...result.meta, ...meta } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

// The system prompt and one hash over the instruction template (direction
// briefs and labels included) and the wire schema, rendered on fixed input,
// pinned per version. The service's reuse check sees the prompt only through
// OUTFIT_PROMPT_VERSION, so an edit to any of them must bump the version and
// record the new hashes here.
const PINNED = {
  "outfit-v1": {
    system: "acd272845d9aaf59633d87565e35eea5075bfbb4c53f58b91549bda0f6b2b3a3",
    templates: "3d1327bafeba411951f44ecfb4f5ce1ae353c967af79d9749b4af559d31636c0",
  },
  // worn:N is a count of logs, not of days.
  "outfit-v2": {
    system: "d24c1b1c50a800ab48b4301d89e8cbd932731680fe12888989c272e5cc23c1ed",
    templates: "3d1327bafeba411951f44ecfb4f5ce1ae353c967af79d9749b4af559d31636c0",
  },
  // Five candidates with style directions, layering, socks, colour and
  // proportion; lay:/feet:/pat:/fit: line fields; recent outfits labelled
  // with their direction, liked and disliked ones with who made them
  // (D-256, D-257). Re-pinned before it shipped: a repeat's core names the
  // shoes too, and the fixed input carries the new labels and notes.
  "outfit-v3": {
    system: "1cc5f5bbdf3059bca8eb567eefbd20b852f781ad0dbab742d4993d9a4da09790",
    templates: "943ce64259736fc02d388a538734c158433799ad68b6fa508c8c227430ee27cf",
  },
} as const;

const PIN_LINES = [
  { text: "i1|outerwear/rain jacket|navy|polyester|w2|wp1 wd1 ins0 br1|spring,autumn|casual|good|confirmed|Navy shell|worn:3|last:2026-10-30" },
  { text: "i2|top/sweater|grey|merino|w3|wp0 wd0 ins0 br1|winter,spring,autumn|smart_casual|good|tagged|Grey sweater|lc:w|lay:mid|pat:cable knit|fit:relaxed|worn:0|last:never" },
  { text: "i3|shoes/chelsea boots|brown|leather|w3|wp1 wd1 ins0 br?|all|smart_casual|good|confirmed|Brown boots|feet:closed|worn:1|last:2026-11-01" },
];

const PIN_VARIETY: VarietyPrompt = {
  directions: ["knit_layers", "weather_ready", "smart_collar", "dress_led", "texture_play"],
  recent: [
    { label: "today, suggested (Knit layers)", aliases: ["i1", "i2", "i3"] },
    { label: "yesterday, worn", aliases: ["i2", "i3"] },
  ],
  liked: [{ note: "built by the owner, rated 5, worn 3 times", aliases: ["i1", "i2"] }],
  disliked: [{ note: "saved suggestion, rated 1", aliases: ["i2", "i3"] }],
};

function renderTemplates(): string {
  return canonicalJson([
    buildSuggestionInstruction({ weather: makeWeatherSnapshot(), place: "Hamburg, Germany", lines: PIN_LINES, variety: PIN_VARIETY }),
    buildSuggestionInstruction({
      weather: makeWeatherSnapshot({ currentC: null, precipProbMax: null }),
      place: "Bologna, Italy",
      lines: PIN_LINES.slice(0, 1),
      variety: { ...PIN_VARIETY, recent: [], liked: [], disliked: [] },
    }),
    toJsonSchemaFormat(OutfitSuggestionWireSchema),
  ]);
}

describe("OUTFIT_PROMPT_VERSION", () => {
  it("pins the system prompt for its version", () => {
    expect(OUTFIT_PROMPT_VERSION).toBe("outfit-v3");
    expect(sha256(OUTFIT_SYSTEM_PROMPT)).toBe(PINNED[OUTFIT_PROMPT_VERSION].system);
  });

  it("pins the instruction template, the direction briefs and the wire schema for its version", () => {
    expect(sha256(renderTemplates())).toBe(PINNED[OUTFIT_PROMPT_VERSION].templates);
  });
});

/** Every text the model reads that this module writes: the system prompt, briefs, labels and a full instruction. */
function promptTexts(): string[] {
  const snapshot = buildSuggestionSnapshot(Object.values(makeOutfitWardrobe()), weather);
  return [
    OUTFIT_SYSTEM_PROMPT,
    ...Object.values(DIRECTION_BRIEFS),
    ...Object.values(DIRECTION_LABELS),
    buildSuggestionInstruction({ weather, place: "Hamburg, Germany", lines: snapshot.lines, variety: PIN_VARIETY }),
    buildSuggestionInstruction({
      weather,
      place: "Hamburg, Germany",
      lines: snapshot.lines,
      variety: { ...PIN_VARIETY, directions: DIRECTION_KEYS },
    }),
  ];
}

describe("OUTFIT_SYSTEM_PROMPT", () => {
  it("is long enough to cache and stays within its budget", () => {
    const tokens = estimateTextTokens(OUTFIT_SYSTEM_PROMPT);
    expect(tokens).toBeGreaterThanOrEqual(2000);
    expect(tokens).toBeLessThanOrEqual(4500);
  });

  it("is static text: no dates, ids, template leftovers or CR characters", () => {
    expect(OUTFIT_SYSTEM_PROMPT).not.toMatch(/\$\{|\r|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}-|undefined|null,/);
    expect(OUTFIT_SYSTEM_PROMPT).toBe(OUTFIT_SYSTEM_PROMPT.trim());
  });

  it("dresses for the feels-like range, rain and gusts, in layers", () => {
    for (const phrase of [
      "Dress for how the day feels",
      "feels-like (apparent) temperature",
      "low end describes the morning and evening commute",
      "50 % or higher chance of precipitation",
      "2 mm or more",
      "waterproof outer layer",
      "gusts of about 40 km/h",
      "layers that come off",
      "below 0 °C, freezing",
      "above 20 °C, warm",
    ]) {
      expect(OUTFIT_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it("states the slot rules the strict check enforces", () => {
    for (const phrase of [
      "Slots: outerwear, mid_layer, base_layer, top, bottom, socks, shoes, hat, gloves, scarf and accessory.",
      "Each slot takes one item, except accessory, which takes up to 3",
      "Every outfit has exactly one item in the top slot",
      "A dress goes in the top slot and needs no bottom",
      "top in mid_layer",
      "top and dress in top",
      "socks in socks",
      "accessory and bag in accessory",
      "hat_beanie in hat",
      "No two outfits may use exactly the same items",
      "Use only the aliases listed. Never invent items, aliases or attributes.",
      "exactly 5 outfits",
      "the best 3",
    ]) {
      expect(OUTFIT_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it("names every slot", () => {
    for (const slot of OUTFIT_SLOTS) expect(OUTFIT_SYSTEM_PROMPT).toContain(slot);
  });

  it("explains layering, feet, directions and the history blocks", () => {
    for (const phrase of [
      "put it in mid_layer over a t-shirt, shirt or other base top in top",
      "Closed shoes (trainers, boots, derbies, brogues) always get socks",
      "Never put socks with sandals or slides",
      "The lay: field gives each top's role",
      "The feet: field gives each shoe's kind",
      "optional lay:, feet:, pat: and fit:",
      "<directions> assigns one direction to each outfit, in order",
      "<recent>, when present",
      // The core the selection's duplicate check reads (CORE_SLOTS).
      "the same top, mid layer, bottom, outerwear and shoes together",
      "<liked>, when present",
      "<disliked>",
      "direction: the key <directions> assigns to the outfit.",
    ]) {
      expect(OUTFIT_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it("calls worn:N a count of logs, never of days", () => {
    expect(OUTFIT_SYSTEM_PROMPT).toContain("one day can count more than once");
    expect(OUTFIT_SYSTEM_PROMPT).not.toContain("number of days");
  });

  it("prefers rested items, explains each outfit and states the text limits", () => {
    for (const phrase of [
      "Prefer items that have rested",
      "worn:N, how many times the item was logged as worn",
      "last:",
      "The weather comes first",
      "title: a short, specific name, at most 60 characters",
      "why: at most 300 characters",
      "rain_ok: true only when",
    ]) {
      expect(OUTFIT_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it("never names the keys the API reserves, in any text the model reads", () => {
    for (const text of promptTexts()) expect(text).not.toMatch(/reasoning|thinking|thought/i);
  });
});

describe("DIRECTION_BRIEFS", () => {
  it("briefs every direction in one short lower-case clause", () => {
    expect(Object.keys(DIRECTION_BRIEFS).sort((a, b) => a.localeCompare(b))).toEqual(
      [...DIRECTION_KEYS].sort((a, b) => a.localeCompare(b)),
    );
    for (const brief of Object.values(DIRECTION_BRIEFS)) {
      expect(brief).toMatch(/^[a-z].*\.$/);
      expect(brief.length).toBeLessThanOrEqual(140);
      expect(brief).not.toMatch(/[\r\n|<>]/);
    }
  });
});

// ---------------------------------------------------------------------------
// Variety
// ---------------------------------------------------------------------------

describe("planVariety", () => {
  const wardrobe = makeOutfitWardrobe();
  const snapshot = buildSuggestionSnapshot(Object.values(wardrobe), weather);
  const aliasOf = (item: OutfitFixtureItem) => snapshot.aliasOfId.get(item.id) ?? "?";
  const plan = (history: VarietyHistory = EMPTY_HISTORY, profileId = "hamburg-profile") =>
    planVariety({ snapshot, weather, history, profileId });

  it("assigns five distinct directions the wardrobe and the weather support, from the day, city and run", () => {
    const history: VarietyHistory = { ...EMPTY_HISTORY, runIndex: 2, recentDirections: [{ key: "weather_ready", ageDays: 0 }] };
    const { directions } = plan(history);
    expect(directions).toHaveLength(OUTFIT_CANDIDATE_COUNT);
    expect(new Set(directions).size).toBe(OUTFIT_CANDIDATE_COUNT);
    expect(directions).toEqual(
      assignDirections({
        profile: wardrobeProfile(snapshot.styleItems.values()),
        weather,
        seed: seedFrom(`${weather.date}|hamburg-profile|2`),
        recent: history.recentDirections,
        count: OUTFIT_CANDIDATE_COUNT,
      }),
    );
  });

  it("is deterministic, and rotates the directions with the run", () => {
    expect(plan()).toEqual(plan());
    const runs = [0, 1, 2, 3].map((runIndex) => plan({ ...EMPTY_HISTORY, runIndex }).directions.join(","));
    expect(runs[1]).not.toBe(runs[0]);
    expect(new Set(runs).size).toBeGreaterThan(2);
    expect(plan(EMPTY_HISTORY, "bologna-profile").directions).not.toEqual(plan().directions);
  });

  it("names past outfits by today's aliases in line order, newest first, leaving out what today does not list", () => {
    const gone = randomUUID();
    const ids = (...items: OutfitFixtureItem[]) => items.map((item) => item.id);
    const history: VarietyHistory = {
      ...EMPTY_HISTORY,
      suggested: [
        { itemIds: [...ids(wardrobe.boots, wardrobe.jeans), gone, wardrobe.tee.id], ageDays: 0, direction: "knit_layers" },
        // One of today's items left: not worth naming.
        { itemIds: [wardrobe.tee.id, gone], ageDays: 1, direction: null },
        // A key this build does not know: no label.
        { itemIds: ids(wardrobe.chinos, wardrobe.oxford, wardrobe.coat), ageDays: 3, direction: "retro_glam" },
        { itemIds: ids(wardrobe.puffer, wardrobe.jeans), ageDays: 4, direction: null },
      ],
      worn: [
        { itemIds: ids(wardrobe.jeans, wardrobe.sweater), ageDays: 1 },
        { itemIds: [gone, randomUUID()], ageDays: 0 },
      ],
      liked: [
        { itemIds: ids(wardrobe.jeans, wardrobe.shell, wardrobe.sweater), rating: 5, timesWorn: 3, source: "user" },
        { itemIds: ids(wardrobe.chinos, wardrobe.tee), rating: null, timesWorn: 2, source: "ai" },
        { itemIds: [gone, wardrobe.tee.id], rating: 4, timesWorn: 0, source: "user" },
        { itemIds: ids(wardrobe.dress, wardrobe.boots), rating: 4, timesWorn: 1, source: "ai" },
      ],
      disliked: [
        { itemIds: ids(wardrobe.puffer, wardrobe.hoodie), rating: 1, timesWorn: 0, source: "ai" },
        { itemIds: ids(wardrobe.sneakers, wardrobe.oxford), rating: 2, timesWorn: 1, source: "user" },
      ],
    };
    const variety = plan(history);
    const named = (...items: OutfitFixtureItem[]) => items.map(aliasOf);
    expect(variety.recent).toEqual([
      { label: "today, suggested (Knit layers)", aliases: named(wardrobe.tee, wardrobe.jeans, wardrobe.boots) },
      { label: "yesterday, worn", aliases: named(wardrobe.sweater, wardrobe.jeans) },
      { label: "3 days ago, suggested", aliases: named(wardrobe.coat, wardrobe.oxford, wardrobe.chinos) },
      { label: "4 days ago, suggested", aliases: named(wardrobe.puffer, wardrobe.jeans) },
    ]);
    expect(variety.liked).toEqual([
      { note: "built by the owner, rated 5, worn 3 times", aliases: named(wardrobe.shell, wardrobe.sweater, wardrobe.jeans) },
      { note: "saved suggestion, worn twice", aliases: named(wardrobe.tee, wardrobe.chinos) },
      { note: "saved suggestion, rated 4, worn once", aliases: named(wardrobe.dress, wardrobe.boots) },
    ]);
    expect(variety.disliked).toEqual([
      { note: "saved suggestion, rated 1", aliases: named(wardrobe.puffer, wardrobe.hoodie) },
      { note: "built by the owner, rated 2, worn once", aliases: named(wardrobe.oxford, wardrobe.sneakers) },
    ]);
  });

  it("keeps each block within its cap and each line within nine aliases", () => {
    const all = snapshot.lines.map((line) => line.itemId);
    const pair = (index: number, step: number) => [all[index % all.length] ?? "", all[(index + step) % all.length] ?? ""];
    const history: VarietyHistory = {
      ...EMPTY_HISTORY,
      suggested: [
        { itemIds: [...all].reverse(), ageDays: 0, direction: null },
        ...Array.from({ length: 19 }, (_, index) => ({ itemIds: pair(index, 1), ageDays: Math.floor(index / 3), direction: null })),
      ],
      worn: Array.from({ length: 15 }, (_, index) => ({ itemIds: pair(index, 2), ageDays: 14 - index })),
      liked: Array.from({ length: 10 }, (_, index) => ({ itemIds: pair(index, 3), rating: 5, timesWorn: index, source: "user" as const })),
      disliked: Array.from({ length: 6 }, (_, index) => ({ itemIds: pair(index, 4), rating: 1, timesWorn: 0, source: "ai" as const })),
    };
    const variety = plan(history);
    expect(variety.recent.filter((entry) => entry.label.endsWith("suggested"))).toHaveLength(VARIETY_LIMITS.suggested);
    expect(variety.recent.filter((entry) => entry.label.endsWith("worn"))).toHaveLength(VARIETY_LIMITS.worn);
    expect(variety.liked).toHaveLength(VARIETY_LIMITS.liked);
    expect(variety.disliked).toHaveLength(VARIETY_LIMITS.disliked);
    // The whole wardrobe at once: the first nine aliases in line order.
    expect(variety.recent[0]).toEqual({
      label: "today, suggested",
      aliases: snapshot.lines.slice(0, VARIETY_LIMITS.aliasesPerLine).map((line) => line.alias),
    });
    const age = (label: string) => {
      if (label.startsWith("today")) return 0;
      if (label.startsWith("yesterday")) return 1;
      return Number(label.split(" ")[0]);
    };
    const ages = variety.recent.map((entry) => age(entry.label));
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
    // The newest worn outfits are kept: 13 days ago and older are cut.
    expect(variety.recent.some((entry) => entry.label === "5 days ago, worn")).toBe(true);
    expect(variety.recent.some((entry) => entry.label === "13 days ago, worn")).toBe(false);
  });

  it("names an outfit suggested twice on one day once, with the newer run's direction", () => {
    const itemIds = [wardrobe.tee.id, wardrobe.jeans.id];
    const twice = plan({
      ...EMPTY_HISTORY,
      suggested: [
        { itemIds, ageDays: 0, direction: "sporty_clean" },
        { itemIds: [...itemIds].reverse(), ageDays: 0, direction: "earth_tones" },
        { itemIds, ageDays: 2, direction: null },
      ],
    });
    expect(twice.recent.map((entry) => entry.label)).toEqual(["today, suggested (Clean and sporty)", "2 days ago, suggested"]);
  });
});

// ---------------------------------------------------------------------------
// The instruction
// ---------------------------------------------------------------------------

describe("buildSuggestionInstruction", () => {
  const wardrobe = Object.values(makeOutfitWardrobe());
  const snapshot = buildSuggestionSnapshot(wardrobe, weather);
  const text = buildSuggestionInstruction({ weather, place: "Hamburg, Germany", lines: snapshot.lines, variety: PIN_VARIETY });

  it("gives the weather, every line, the history, the directions and the task, in that order", () => {
    expect(text).toContain('<weather place="Hamburg, Germany">\nDate: Tuesday 2026-11-03 (Europe/Berlin)');
    expect(text).toContain(`<items count="${wardrobe.length}">`);
    for (const line of snapshot.lines) expect(text).toContain(line.text);
    const order = ["</weather>", "</items>", "<recent>", "<liked>", "<disliked>", "<directions>", "</directions>", "Suggest exactly"];
    const positions = order.map((marker) => text.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("writes one line per past outfit and one per direction", () => {
    expect(text).toContain("<recent>\n- today, suggested (Knit layers): i1 i2 i3\n- yesterday, worn: i2 i3\n</recent>\n\n");
    expect(text).toContain("<liked>\n- built by the owner, rated 5, worn 3 times: i1 i2\n</liked>\n\n");
    expect(text).toContain("<disliked>\n- saved suggestion, rated 1: i2 i3\n</disliked>\n\n");
    expect(text).toContain(
      [
        "<directions>",
        `Outfit 1: knit_layers (Knit layers): ${DIRECTION_BRIEFS.knit_layers}`,
        `Outfit 2: weather_ready (Weather-ready): ${DIRECTION_BRIEFS.weather_ready}`,
        `Outfit 3: smart_collar (Smart collar): ${DIRECTION_BRIEFS.smart_collar}`,
        `Outfit 4: dress_led (Dress-led): ${DIRECTION_BRIEFS.dress_led}`,
        `Outfit 5: texture_play (Mixed textures): ${DIRECTION_BRIEFS.texture_play}`,
        "</directions>",
      ].join("\n"),
    );
  });

  it("states the task with today's numbers and the slot rules", () => {
    expect(text).toContain(
      "\n\nSuggest exactly 5 different outfits for today in Hamburg, Germany, using only the items above, " +
        "one for each direction in <directions>, in that order.\n",
    );
    expect(text).toContain(
      "- Dress for a feels-like range of 2.1 to 7.6 °C, 3.4 mm of precipitation with a chance of up to 80 %, and gusts up to 53 km/h.",
    );
    expect(text).toContain(
      "- Each outfit: exactly one item in top (a top or a dress), a bottom unless that item is a dress, shoes, " +
        "socks with closed shoes, a mid layer over the top when the look or the weather wants one, " +
        "and only the layers and accessories the weather calls for; at most 3 accessories.",
    );
    expect(text).toContain("- Prefer items that have rested (a low worn: count, an old or never last:) when they suit the weather.");
    expect(text.endsWith("- title: at most 60 characters. why: at most 300 characters.")).toBe(true);
  });

  it("leaves out the history blocks that are empty", () => {
    const quiet = buildSuggestionInstruction({ weather, place: "Hamburg, Germany", lines: snapshot.lines, variety: NO_HISTORY });
    for (const tag of ["<recent>", "<liked>", "<disliked>"]) expect(quiet).not.toContain(tag);
    expect(quiet).toContain("</items>\n\n<directions>\nOutfit 1: knit_layers");
    const likedOnly = buildSuggestionInstruction({
      weather,
      place: "Hamburg, Germany",
      lines: [],
      variety: { ...NO_HISTORY, liked: PIN_VARIETY.liked },
    });
    expect(likedOnly).toContain("</items>\n\n<liked>\n- built by the owner, rated 5, worn 3 times: i1 i2\n</liked>\n\n<directions>");
  });

  it("says when the rain chance is unknown and keeps the place on one line", () => {
    const unknown = buildSuggestionInstruction({
      weather: makeWeatherSnapshot({ precipProbMax: null }),
      place: 'Ham"burg\n<x>',
      lines: [],
      variety: NO_HISTORY,
    });
    expect(unknown).toContain("3.4 mm of precipitation (chance unknown)");
    expect(unknown).toContain('<weather place="Ham burg x">');
  });
});

// ---------------------------------------------------------------------------
// Parameters and estimate
// ---------------------------------------------------------------------------

describe("OUTFIT_CALL_PARAMS", () => {
  it("uses the outfit purpose at effort medium (D-258)", () => {
    expect(AI_PURPOSES).toContain(OUTFIT_CALL_PARAMS.purpose);
    expect(OUTFIT_CALL_PARAMS).toEqual({ purpose: "outfit_suggestion", effort: "medium", maxTokens: 8800, maxTokensCeiling: 8800 });
  });

  it("caps the reply at what can be written before the deadline, with no doubled retry (D-164)", () => {
    expect(SLOWEST_TOKENS_PER_SECOND).toBe(110);
    expect(FIRST_TOKEN_MARGIN_MS).toBe(30_000);
    expect(OUTFIT_DEADLINE_MS).toBe(110_000);
    expect(OUTFIT_CALL_PARAMS.maxTokens).toBe(((OUTFIT_DEADLINE_MS - FIRST_TOKEN_MARGIN_MS) / 1000) * SLOWEST_TOKENS_PER_SECOND);
    expect(OUTFIT_CALL_PARAMS.maxTokensCeiling).toBe(OUTFIT_CALL_PARAMS.maxTokens);
    expect((OUTFIT_CALL_PARAMS.maxTokens / SLOWEST_TOKENS_PER_SECOND) * 1000 + FIRST_TOKEN_MARGIN_MS).toBeLessThanOrEqual(
      OUTFIT_DEADLINE_MS,
    );
    expect(OUTFIT_DEADLINE_MS).toBeLessThan(120_000);
  });
});

describe("estimateOutfitSuggestionUsd", () => {
  const lines = (count: number) =>
    buildSuggestionSnapshot(
      Array.from({ length: count }, () => makeOutfitItem({ id: randomUUID(), wearCount: 12, lastWornAt: new Date("2026-10-30T11:00:00Z") })),
      weather,
    ).lines;

  it("leaves a fifth of the output cap for longer replies", () => {
    expect(OUTFIT_ESTIMATE.visibleOutputTokens + OUTFIT_ESTIMATE.thinkingTokens).toBeLessThanOrEqual(0.8 * OUTFIT_CALL_PARAMS.maxTokens);
  });

  it("grows with the lines and does not depend on today's weather", () => {
    const small = estimateOutfitSuggestionUsd("claude-sonnet-5-5", lines(20));
    const large = estimateOutfitSuggestionUsd("claude-sonnet-5-5", lines(200));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
    expect(estimateOutfitInputTokens(lines(20))).toBeGreaterThan(
      estimateTextTokens(OUTFIT_SYSTEM_PROMPT) + OUTFIT_ESTIMATE.varietyTokens + OUTFIT_ESTIMATE.formatOverheadTokens,
    );
  });

  it("counts a full block of five directions with the longest briefs", () => {
    const lineSet = lines(20);
    const longest = [...DIRECTION_KEYS]
      .sort((a, b) => DIRECTION_BRIEFS[b].length + DIRECTION_LABELS[b].length + b.length - (DIRECTION_BRIEFS[a].length + DIRECTION_LABELS[a].length + a.length))
      .slice(0, OUTFIT_CANDIDATE_COUNT);
    // The estimate's own forecast: full-length numbers on a snowy, stormy day.
    const forecast = makeWeatherSnapshot({
      currentC: -10.5,
      tminC: -12.5,
      tmaxC: -10.5,
      apparentMinC: -18.5,
      apparentMaxC: -14.5,
      precipSumMm: 12.5,
      precipProbMax: 100,
      windGustMaxKmh: 100,
      weatherCode: 86,
      label: "Heavy snow showers",
      fetchedAt: "2026-11-03T06:00:00.000Z",
    });
    const instruction = buildSuggestionInstruction({
      weather: forecast,
      place: "Hamburg, Germany",
      lines: lineSet,
      variety: { directions: longest, recent: [], liked: [], disliked: [] },
    });
    expect(estimateOutfitInputTokens(lineSet)).toBe(
      estimateTextTokens(OUTFIT_SYSTEM_PROMPT) +
        estimateTextTokens(instruction) +
        OUTFIT_ESTIMATE.varietyTokens +
        OUTFIT_ESTIMATE.formatOverheadTokens,
    );
  });

  it("puts 200 items at about a dime on Sonnet and less on Haiku", () => {
    const items = lines(200);
    const sonnet = estimateOutfitSuggestionUsd("claude-sonnet-5-5", items);
    expect(sonnet).toBeGreaterThan(0.05);
    expect(sonnet).toBeLessThan(0.15);
    const haiku = estimateOutfitSuggestionUsd("claude-haiku-5-5", items);
    expect(haiku).toBeLessThan(sonnet);
    expect(haiku).toBeLessThan(0.01);
  });

  it(`keeps a full ${MAX_SUGGESTION_ITEMS}-item request far below Haiku's long-context tier`, () => {
    expect(estimateOutfitInputTokens(lines(MAX_SUGGESTION_ITEMS))).toBeLessThan(100_000);
  });

  it("fits the history blocks at their caps within varietyTokens", () => {
    // Four-character aliases (i100 to i400), on the longest labels and notes each block can have: a
    // suggestion with the longest direction label, an outfit the owner built.
    const aliases = Array.from({ length: VARIETY_LIMITS.aliasesPerLine }, (_, index) => `i${391 + index}`);
    const directions: readonly DirectionKey[] = FAKE_DIRECTIONS;
    const longestLabel = Object.values(DIRECTION_LABELS).reduce((longest, label) => (label.length > longest.length ? label : longest));
    const full: VarietyPrompt = {
      directions,
      recent: [
        ...Array.from({ length: VARIETY_LIMITS.suggested }, () => ({ label: `6 days ago, suggested (${longestLabel})`, aliases })),
        ...Array.from({ length: VARIETY_LIMITS.worn }, () => ({ label: "13 days ago, worn", aliases })),
      ],
      liked: Array.from({ length: VARIETY_LIMITS.liked }, () => ({ note: "built by the owner, rated 5, worn 12 times", aliases })),
      disliked: Array.from({ length: VARIETY_LIMITS.disliked }, () => ({ note: "built by the owner, rated 2, worn 12 times", aliases })),
    };
    const render = (variety: VarietyPrompt) => buildSuggestionInstruction({ weather, place: "Hamburg, Germany", lines: [], variety });
    const added = estimateTextTokens(render(full)) - estimateTextTokens(render({ ...full, recent: [], liked: [], disliked: [] }));
    expect(added).toBeGreaterThan(0.8 * OUTFIT_ESTIMATE.varietyTokens);
    expect(added).toBeLessThanOrEqual(OUTFIT_ESTIMATE.varietyTokens);
  });
});
