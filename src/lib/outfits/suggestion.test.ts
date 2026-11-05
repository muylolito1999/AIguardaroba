import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { estimateTextTokens } from "@/lib/ai/cost";
import { countSchemaComplexity, FORBIDDEN_KEY, SCHEMA_LIMITS, toJsonSchema, toJsonSchemaFormat, type JsonSchema } from "@/lib/ai/json-schema";
import { AI_PURPOSES, ITEM_COLLECTIONS, ITEM_DECISIONS, ITEM_LOCATIONS, ITEM_STATUSES, OUTFIT_SLOTS } from "@/lib/db/enums";
import { MAX_ACCESSORIES } from "@/lib/outfits/contracts";
import {
  buildSuggestionInstruction,
  buildSuggestionSnapshot,
  canSuggestOutfits,
  countPossibleOutfits,
  estimateOutfitInputTokens,
  estimateOutfitSuggestionUsd,
  homeLocationOf,
  idealWarmth,
  isEligibleForToday,
  isRainyDay,
  makeOutfitSuggestionStrictSchema,
  MAX_SUGGESTION_ITEMS,
  MIN_KEPT_PER_CATEGORY,
  OUTFIT_CALL_PARAMS,
  OUTFIT_DEADLINE_MS,
  OUTFIT_PROMPT_VERSION,
  OUTFIT_SUGGESTION_COUNT,
  OUTFIT_SYSTEM_PROMPT,
  OutfitSuggestionResultSchema,
  OutfitSuggestionWireSchema,
  SUGGESTION_LIMITS,
  toCheckItems,
  weatherFitScore,
  type OutfitSuggestionWire,
  type SuggestionLine,
} from "@/lib/outfits/suggestion";
import { canonicalJson, itemLineBody } from "@/lib/relocation/payload";
import { AppError } from "@/lib/result";

import {
  fakeOutfitSuggestionReply,
  makeOutfitItem,
  makeOutfitSuggestionResult,
  makeOutfitWardrobe,
  makeRunningItem,
  makeWeatherSnapshot,
  OUTFIT_TEMPLATES,
  type OutfitFixtureItem,
} from "../../../test/outfit-fixtures";

const weather = makeWeatherSnapshot();

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
    const snapshot = buildSuggestionSnapshot([shoesWorn, topYesterday, topLastWeek, topNever, coat, dress], weather);
    expect(snapshot.lines.map((line) => [line.alias, line.itemId])).toEqual([
      ["i1", coat.id],
      ["i2", topNever.id],
      ["i3", topLastWeek.id],
      ["i4", topYesterday.id],
      ["i5", dress.id],
      ["i6", shoesWorn.id],
    ]);
    expect(snapshot.itemCount).toBe(6);
    expect(snapshot.droppedCount).toBe(0);
  });

  it("writes the relocation line body plus worn:N and last:day or last:never", () => {
    const worn = makeOutfitItem({ wearCount: 3, lastWornAt: new Date("2026-10-30T11:00:00Z") });
    const fresh = makeOutfitItem({ ...OUTFIT_TEMPLATES.jeans });
    const snapshot = buildSuggestionSnapshot([worn, fresh], weather);
    const [first, second] = snapshot.lines;
    expect(first?.text).toBe(`i1|${itemLineBody(worn, null)}|worn:3|last:2026-10-30`);
    expect(second?.text).toBe(`i2|${itemLineBody(fresh, null)}|worn:0|last:never`);
    expect(first?.text).toBe("i1|top/sweater|grey|merino|w3|wp0 wd0 ins0 br1|winter,spring,autumn|smart_casual|good|confirmed|Grey merino crew-neck sweater|worn:3|last:2026-10-30");
    expect(first?.text).not.toContain("now:");
  });

  it("dates the last wear in the forecast's time zone", () => {
    // 23:30 UTC is already the next day in Berlin.
    const item = makeOutfitItem({ wearCount: 1, lastWornAt: new Date("2026-11-02T23:30:00Z") });
    expect(buildSuggestionSnapshot([item], weather).lines[0]?.text).toMatch(/\|last:2026-11-03$/);
    expect(buildSuggestionSnapshot([item], makeWeatherSnapshot({ timezone: "UTC" })).lines[0]?.text).toMatch(/\|last:2026-11-02$/);
  });

  it("skips items no slot can hold", () => {
    const other = makeOutfitItem({ category: "other" });
    const untagged = makeOutfitItem({ category: null });
    const top = makeOutfitItem();
    const snapshot = buildSuggestionSnapshot([other, untagged, top], weather);
    expect(snapshot.lines.map((line) => line.itemId)).toEqual([top.id]);
    expect(snapshot.droppedCount).toBe(0);
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
    const prompt = buildSuggestionInstruction({ weather, place: "Hamburg, Germany", lines: snapshot.lines });
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
    }
    expect(snapshot.lines.map((line) => line.alias)).toEqual(wardrobe.map((_, index) => `i${index + 1}`));
  });

  it("hashes the same wardrobe the same in any input order, and differently after a wear", () => {
    const wardrobe = Object.values(makeOutfitWardrobe());
    const hash = buildSuggestionSnapshot(wardrobe, weather).snapshotHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(buildSuggestionSnapshot([...wardrobe].reverse(), weather).snapshotHash).toBe(hash);
    const [first, ...rest] = wardrobe;
    if (first === undefined) throw new Error("empty wardrobe");
    const worn = { ...first, wearCount: 1, lastWornAt: new Date("2026-11-03T11:00:00Z") };
    expect(buildSuggestionSnapshot([worn, ...rest], weather).snapshotHash).not.toBe(hash);
    expect(buildSuggestionSnapshot(rest, weather).snapshotHash).not.toBe(hash);
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
  const lines = (...categories: SuggestionLine["category"][]) => categories.map((category) => ({ category }));

  it.each([
    ["nothing", lines(), 0],
    ["a top alone", lines("top"), 0],
    ["a top and a bottom", lines("top", "bottom"), 1],
    ["plus shoes", lines("top", "bottom", "shoes"), 2],
    ["plus a jacket", lines("top", "bottom", "shoes", "outerwear"), 4],
    ["two tops, two bottoms", lines("top", "top", "bottom", "bottom"), 4],
    ["a dress alone", lines("dress"), 1],
    ["a dress and a bottom", lines("dress", "bottom"), 2],
    ["a dress and two accessories", lines("dress", "accessory", "bag"), 4],
    ["a top, a bottom and five accessories", lines("top", "bottom", ...Array.from({ length: 5 }, () => "accessory" as const)), 26],
    ["two hats", lines("top", "bottom", "hat_beanie", "hat_beanie"), 3],
  ])("counts %s", (_label, input, expected) => {
    expect(countPossibleOutfits(input)).toBe(expected);
  });

  it("allows a suggestion only when three different outfits exist", () => {
    expect(canSuggestOutfits({ lines: lines("top", "bottom", "shoes").map((line, index) => ({ ...line, alias: `i${index + 1}`, itemId: "", text: "" })) })).toBe(false);
    expect(canSuggestOutfits({ lines: lines("top", "bottom", "shoes", "outerwear").map((line, index) => ({ ...line, alias: `i${index + 1}`, itemId: "", text: "" })) })).toBe(true);
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
    expect(names).toEqual(expect.arrayContaining(["outfits", "title", "items", "slot", "item", "why", "rain_ok"]));
    expect(names.filter((name) => FORBIDDEN_KEY.test(name))).toEqual([]);
    expect(JSON.stringify(schema)).not.toMatch(/reasoning|thinking|thought/i);
  });

  it("keeps the slot enum and states every limit the strict check enforces", () => {
    const text = JSON.stringify(schema);
    expect(text).toContain(JSON.stringify([...OUTFIT_SLOTS]));
    expect(text).toContain(`at most ${SUGGESTION_LIMITS.titleMax} characters`);
    expect(text).toContain(`at most ${SUGGESTION_LIMITS.whyMax} characters`);
    expect(text).toContain(`Exactly ${OUTFIT_SUGGESTION_COUNT} outfits`);
    expect(text).toContain(`up to ${MAX_ACCESSORIES} in accessory`);
  });
});

describe("makeOutfitSuggestionStrictSchema", () => {
  const wardrobe = makeOutfitWardrobe();
  const items = Object.values(wardrobe);
  const snapshot = buildSuggestionSnapshot(items, weather);
  const strict = makeOutfitSuggestionStrictSchema(snapshot, toCheckItems(items));
  const alias = (item: OutfitFixtureItem) => snapshot.aliasOfId.get(item.id) ?? "?";
  const valid = fakeOutfitSuggestionReply(snapshot);

  /** The fake reply with outfit `index` changed. */
  function withOutfit(index: number, change: Partial<OutfitSuggestionWire["outfits"][number]>): OutfitSuggestionWire {
    return { outfits: valid.outfits.map((outfit, i) => (i === index ? { ...outfit, ...change } : outfit)) };
  }

  it("accepts a valid reply and names items by uuid", () => {
    expect(OutfitSuggestionWireSchema.safeParse(valid).success).toBe(true);
    const parsed = strict.parse(valid);
    expect(parsed.outfits).toHaveLength(OUTFIT_SUGGESTION_COUNT);
    const first = valid.outfits[0];
    expect(parsed.outfits[0]?.items).toEqual(first?.items.map((entry) => ({ slot: entry.slot, itemId: snapshot.byAlias.get(entry.item) })));
    expect(parsed.outfits[0]).toMatchObject({ title: first?.title, why: first?.why, rain_ok: first?.rain_ok });
  });

  it("trims titles and whys, and folds the case of slots and aliases (D-165)", () => {
    const first = valid.outfits[0];
    if (first === undefined) throw new Error("no outfit");
    const reply = withOutfit(0, {
      title: "  Layered  ",
      items: first.items.map((entry) => ({ slot: ` ${entry.slot.toUpperCase()} ` as never, item: entry.item.toUpperCase() })),
    });
    const parsed = strict.parse(reply);
    expect(parsed.outfits[0]?.title).toBe("Layered");
    expect(parsed.outfits[0]?.items.map((entry) => entry.slot)).toEqual(first.items.map((entry) => entry.slot));
  });

  it.each([
    ["two outfits", { outfits: valid.outfits.slice(0, 2) }],
    ["four outfits", { outfits: [...valid.outfits, valid.outfits[0]] }],
    ["a 61-character title", withOutfit(0, { title: "x".repeat(61) })],
    ["a blank title", withOutfit(0, { title: "  " })],
    ["a 301-character why", withOutfit(1, { why: "x".repeat(301) })],
    ["an empty why", withOutfit(1, { why: "" })],
    ["an unknown slot", withOutfit(0, { items: [{ slot: "socks" as never, item: "i1" }] })],
  ])("rejects %s", (_label, reply) => {
    expect(strict.safeParse(reply).success).toBe(false);
  });

  it.each([
    ["an unknown alias", () => [{ slot: "top", item: "i999" }, { slot: "bottom", item: alias(wardrobe.jeans) }], "Unknown alias i999"],
    ["a malformed alias", () => [{ slot: "top", item: "sweater" }, { slot: "bottom", item: alias(wardrobe.jeans) }], "Unknown alias"],
    ["a dress in bottom", () => [{ slot: "top", item: alias(wardrobe.tee) }, { slot: "bottom", item: alias(wardrobe.dress) }], "wrong_category"],
    ["two tops", () => [{ slot: "top", item: alias(wardrobe.tee) }, { slot: "top", item: alias(wardrobe.oxford) }, { slot: "bottom", item: alias(wardrobe.jeans) }], "slot_taken"],
    ["no bottom with a top", () => [{ slot: "top", item: alias(wardrobe.tee) }, { slot: "shoes", item: alias(wardrobe.boots) }], "missing_bottom"],
    ["no top", () => [{ slot: "bottom", item: alias(wardrobe.jeans) }], "missing_top"],
    ["an item twice", () => [{ slot: "top", item: alias(wardrobe.tee) }, { slot: "bottom", item: alias(wardrobe.jeans) }, { slot: "accessory", item: alias(wardrobe.tee) }], "duplicate_item"],
    [
      "four accessories",
      () => [
        { slot: "top", item: alias(wardrobe.tee) },
        { slot: "bottom", item: alias(wardrobe.jeans) },
        ...[wardrobe.belt, wardrobe.tote, wardrobe.scarf, wardrobe.gloves].map((entry) => ({ slot: "accessory", item: alias(entry) })),
      ],
      "too_many_accessories",
    ],
  ] as const)("rejects %s as invalid output", (_label, entries, message) => {
    const reply = withOutfit(2, { items: entries().map((entry) => ({ slot: entry.slot, item: entry.item })) as never });
    const result = strict.safeParse(reply);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues.map((issue) => issue.message).join("\n")).toContain(message);
  });

  it("rejects two outfits with the same items, in any order", () => {
    const first = valid.outfits[0];
    if (first === undefined) throw new Error("no outfit");
    const reply = withOutfit(2, { title: "Again", items: [...first.items].reverse() });
    const result = strict.safeParse(reply);
    expect(result.success ? "" : result.error.issues.map((issue) => issue.message).join("\n")).toContain(
      "Outfit 3 uses the same items as outfit 1.",
    );
  });

  it("rejects an item archived since the snapshot", () => {
    const archived = new Map(toCheckItems(items));
    const first = valid.outfits[0]?.items[0];
    const itemId = first === undefined ? undefined : snapshot.byAlias.get(first.item);
    if (itemId === undefined) throw new Error("no item");
    archived.set(itemId, {
      id: itemId,
      category: archived.get(itemId)?.category ?? null,
      status: "archived",
      collection: "clothing",
    });
    const result = makeOutfitSuggestionStrictSchema(snapshot, archived).safeParse(valid);
    expect(result.success ? "" : result.error.issues.map((issue) => issue.message).join("\n")).toContain("archived_item");
  });

  it("rejects an item moved to running gear since the snapshot (not_clothing, D-250)", () => {
    const moved = new Map(toCheckItems(items));
    const first = valid.outfits[0]?.items[0];
    const itemId = first === undefined ? undefined : snapshot.byAlias.get(first.item);
    const check = itemId === undefined ? undefined : moved.get(itemId);
    if (itemId === undefined || check === undefined) throw new Error("no item");
    moved.set(itemId, { ...check, collection: "running" });
    const result = makeOutfitSuggestionStrictSchema(snapshot, moved).safeParse(valid);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues.map((issue) => issue.message).join("\n")).toContain(
      `not_clothing (${first?.item ?? "?"}): This item is running gear, which outfits leave out.`,
    );
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

  it("accepts a dress without a bottom", () => {
    const reply = withOutfit(2, {
      items: [
        { slot: "top", item: alias(wardrobe.dress) },
        { slot: "shoes", item: alias(wardrobe.boots) },
        { slot: "accessory", item: alias(wardrobe.tote) },
      ],
    });
    expect(strict.safeParse(reply).success).toBe(true);
  });
});

describe("OutfitSuggestionResultSchema", () => {
  it("accepts the stored result the service builds", () => {
    const result = makeOutfitSuggestionResult(Object.values(makeOutfitWardrobe()));
    expect(OutfitSuggestionResultSchema.parse(result)).toEqual(result);
    expect(result.meta).toMatchObject({ prompt_version: OUTFIT_PROMPT_VERSION, effort: "low", dropped_count: 0 });
  });

  it("requires exactly three outfits with uuid items", () => {
    const result = makeOutfitSuggestionResult(Object.values(makeOutfitWardrobe()));
    expect(OutfitSuggestionResultSchema.safeParse({ ...result, outfits: result.outfits.slice(1) }).success).toBe(false);
    const [first, ...rest] = result.outfits;
    if (first === undefined) throw new Error("no outfit");
    const aliased = { ...first, items: [{ slot: "top", itemId: "i1" }] };
    expect(OutfitSuggestionResultSchema.safeParse({ ...result, outfits: [aliased, ...rest] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

// The system prompt and one hash over the instruction template and the wire
// schema, rendered on fixed input, pinned per version. The service's reuse
// check sees the prompt only through OUTFIT_PROMPT_VERSION, so an edit to any
// of them must bump the version and record the new hashes here.
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
} as const;

const PIN_LINES = [
  { text: "i1|outerwear/rain jacket|navy|polyester|w2|wp1 wd1 ins0 br1|spring,autumn|casual|good|confirmed|Navy shell|worn:3|last:2026-10-30" },
  { text: "i2|top/sweater|grey|merino|w3|wp0 wd0 ins0 br1|winter,spring,autumn|smart_casual|good|tagged|Grey sweater|lc:w|worn:0|last:never" },
];

function renderTemplates(): string {
  return canonicalJson([
    buildSuggestionInstruction({ weather: makeWeatherSnapshot(), place: "Hamburg, Germany", lines: PIN_LINES }),
    buildSuggestionInstruction({
      weather: makeWeatherSnapshot({ currentC: null, precipProbMax: null }),
      place: "Bologna, Italy",
      lines: PIN_LINES.slice(0, 1),
    }),
    toJsonSchemaFormat(OutfitSuggestionWireSchema),
  ]);
}

describe("OUTFIT_PROMPT_VERSION", () => {
  it("pins the system prompt for its version", () => {
    expect(OUTFIT_PROMPT_VERSION).toBe("outfit-v2");
    expect(sha256(OUTFIT_SYSTEM_PROMPT)).toBe(PINNED[OUTFIT_PROMPT_VERSION].system);
  });

  it("pins the instruction template and the wire schema for its version", () => {
    expect(sha256(renderTemplates())).toBe(PINNED[OUTFIT_PROMPT_VERSION].templates);
  });
});

describe("OUTFIT_SYSTEM_PROMPT", () => {
  it("is long enough to cache, with room over the 512-token minimum", () => {
    const tokens = estimateTextTokens(OUTFIT_SYSTEM_PROMPT);
    expect(tokens).toBeGreaterThanOrEqual(1000);
    expect(tokens).toBeLessThanOrEqual(2500);
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
      "Each slot takes one item, except accessory, which takes up to 3",
      "Every outfit has exactly one item in the top slot",
      "A dress goes in the top slot and needs no bottom",
      "top and dress in top",
      "accessory and bag in accessory",
      "hat_beanie in hat",
      "No two outfits may use exactly the same items",
      "Use only the aliases listed. Never invent items, aliases or attributes.",
      "exactly 3 outfits",
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
});

describe("buildSuggestionInstruction", () => {
  const wardrobe = Object.values(makeOutfitWardrobe());
  const snapshot = buildSuggestionSnapshot(wardrobe, weather);
  const text = buildSuggestionInstruction({ weather, place: "Hamburg, Germany", lines: snapshot.lines });

  it("gives the weather, every line and the task, items before the task", () => {
    expect(text).toContain('<weather place="Hamburg, Germany">\nDate: Tuesday 2026-11-03 (Europe/Berlin)');
    expect(text).toContain(`<items count="${wardrobe.length}">`);
    for (const line of snapshot.lines) expect(text).toContain(line.text);
    expect(text.indexOf("</items>")).toBeLessThan(text.indexOf("Suggest exactly 3 different outfits for today in Hamburg, Germany"));
    expect(text).toContain(
      "feels-like range of 2.1 to 7.6 °C, 3.4 mm of precipitation with a chance of up to 80 %, and gusts up to 53 km/h.",
    );
    expect(text).toContain("title: at most 60 characters. why: at most 300 characters.");
  });

  it("says when the rain chance is unknown and keeps the place on one line", () => {
    const unknown = buildSuggestionInstruction({
      weather: makeWeatherSnapshot({ precipProbMax: null }),
      place: 'Ham"burg\n<x>',
      lines: [],
    });
    expect(unknown).toContain("3.4 mm of precipitation (chance unknown)");
    expect(unknown).toContain('<weather place="Ham burg x">');
  });

  it("never asks for keys the API reserves", () => {
    for (const prompt of [OUTFIT_SYSTEM_PROMPT, text]) expect(prompt).not.toMatch(/reasoning|thinking|thought/i);
  });
});

describe("OUTFIT_CALL_PARAMS", () => {
  it("uses the outfit purpose at effort low", () => {
    expect(AI_PURPOSES).toContain(OUTFIT_CALL_PARAMS.purpose);
    expect(OUTFIT_CALL_PARAMS).toMatchObject({ effort: "low", maxTokens: 8000, maxTokensCeiling: 8000 });
  });

  it("caps the reply at what can be written before the deadline, with no doubled retry (D-164)", () => {
    const slowestTokensPerSecond = 110;
    const firstTokenMarginMs = 30_000;
    expect(OUTFIT_CALL_PARAMS.maxTokensCeiling).toBe(OUTFIT_CALL_PARAMS.maxTokens);
    expect((OUTFIT_CALL_PARAMS.maxTokens / slowestTokensPerSecond) * 1000 + firstTokenMarginMs).toBeLessThanOrEqual(OUTFIT_DEADLINE_MS);
    expect(OUTFIT_DEADLINE_MS).toBeLessThan(120_000);
  });
});

describe("estimateOutfitSuggestionUsd", () => {
  const lines = (count: number) =>
    buildSuggestionSnapshot(
      Array.from({ length: count }, () => makeOutfitItem({ id: randomUUID(), wearCount: 12, lastWornAt: new Date("2026-10-30T11:00:00Z") })),
      weather,
    ).lines;

  it("grows with the lines and does not depend on today's weather", () => {
    const small = estimateOutfitSuggestionUsd("claude-sonnet-5-5", lines(20));
    const large = estimateOutfitSuggestionUsd("claude-sonnet-5-5", lines(200));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
    expect(estimateOutfitInputTokens(lines(20))).toBeGreaterThan(estimateTextTokens(OUTFIT_SYSTEM_PROMPT));
  });

  it("puts 200 items at a few cents on Sonnet and under a cent on Haiku", () => {
    const items = lines(200);
    const sonnet = estimateOutfitSuggestionUsd("claude-sonnet-5-5", items);
    expect(sonnet).toBeGreaterThan(0.02);
    expect(sonnet).toBeLessThan(0.08);
    expect(estimateOutfitSuggestionUsd("claude-haiku-5-5", items)).toBeLessThan(0.01);
  });

  it(`keeps a full ${MAX_SUGGESTION_ITEMS}-item request far below Haiku's long-context tier`, () => {
    expect(estimateOutfitInputTokens(lines(MAX_SUGGESTION_ITEMS))).toBeLessThan(100_000);
  });
});
