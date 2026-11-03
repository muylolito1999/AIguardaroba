import { describe, expect, it } from "vitest";

import { estimateTextTokens } from "@/lib/ai/cost";
import { ITEM_CATEGORIES } from "@/lib/db/enums";
import type { Item } from "@/lib/db/schema";
import {
  buildSnapshot,
  canonicalJson,
  itemLineBody,
  LINE_LIMITS,
  LOW_CONFIDENCE_CODES,
  lowConfidenceFields,
  sanitizeLineValue,
  SNAPSHOT_LEGEND,
  type SnapshotItemInput,
} from "@/lib/relocation/payload";
import { makeSnapshotItem } from "../../../test/relocation-fixtures";

type SnapshotOptions = Parameters<typeof buildSnapshot>[1];
const ALL: SnapshotOptions = { includeOnlyConfirmed: false, destination: "hamburg" };
const CONFIRMED: SnapshotOptions = { includeOnlyConfirmed: true, destination: "hamburg" };

/** The contract's example item. */
function parka(overrides: Partial<SnapshotItemInput> = {}): SnapshotItemInput {
  return makeSnapshotItem({
    name: "Navy down parka",
    category: "outerwear",
    subcategory: "parka",
    colors: ["navy", "black"],
    materials: ["down", "polyester shell"],
    warmthLevel: 5,
    waterproof: true,
    windproof: true,
    insulated: true,
    breathable: null,
    seasons: ["winter"],
    formality: "casual",
    condition: "good",
    status: "confirmed",
    location: "bologna",
    aiConfidence: { category: 0.95, materials: 0.9 },
    userEditedFields: [],
    ...overrides,
  });
}

function fieldCount(line: string): number {
  return line.split("|").length;
}

describe("item lines", () => {
  it("matches the documented format", () => {
    const { lines } = buildSnapshot([parka()], CONFIRMED);
    expect(lines[0]?.text).toBe(
      "i1|outerwear/parka|navy,black|down;polyester shell|w5|wp1 wd1 ins1 br?|winter|casual|good|confirmed|Navy down parka",
    );
  });

  it("writes unknown values as ?, falls back to material_guess, and orders seasons", () => {
    const body = itemLineBody(
      parka({
        subcategory: null,
        colors: [],
        materials: [],
        materialGuess: "waxed cotton",
        warmthLevel: null,
        waterproof: false,
        windproof: null,
        seasons: ["autumn", "winter", "spring"],
        formality: null,
        condition: null,
        name: null,
      }),
      "hamburg",
    );
    expect(body).toBe("outerwear/?|?|waxed cotton|w?|wp0 wd? ins1 br?|winter,spring,autumn|?|?|confirmed|?");
    expect(itemLineBody(parka({ seasons: ["summer", "autumn", "spring", "winter"] }), "hamburg")).toContain("|all|");
  });

  it("keeps a name with | and line breaks on one line with the same field count", () => {
    const plain = itemLineBody(parka(), "hamburg");
    const hostile = itemLineBody(
      parka({
        name: "Parka | with\r\nline\tbreaks\u0000 and\u2028more",
        subcategory: "parka|long",
        colors: ["navy|blue", "black,grey"],
        materials: ["down;feather", "nylon\nshell"],
      }),
      "hamburg",
    );
    expect(hostile).not.toMatch(/[\p{Cc}\u2028]/u);
    expect(fieldCount(hostile)).toBe(fieldCount(plain));
    expect(hostile).toContain("|Parka with line breaks and more");
    expect(hostile).toContain("outerwear/parka long|navy blue,black grey|down feather;nylon shell|");
  });

  it("caps long values and keeps whole list entries within the totals", () => {
    const body = itemLineBody(
      parka({
        name: "N".repeat(80),
        subcategory: "S".repeat(50),
        colors: ["dark navy blue", "charcoal grey", "olive", "red"],
        materials: ["merino wool", "recycled polyester", "elastane", "nylon"],
      }),
      "hamburg",
    );
    const fields = body.split("|");
    expect(fields[0]).toBe(`outerwear/${"S".repeat(LINE_LIMITS.subcategory)}`);
    // "dark navy blue,charcoal grey" has 28 characters, over the 26 for colours: the second entry goes whole.
    expect(fields[1]).toBe("dark navy blue");
    // Exactly 30 characters fit the materials total; a third entry would not.
    expect(fields[2]).toBe("merino wool;recycled polyester");
    expect(fields[9]).toBe("N".repeat(LINE_LIMITS.name));
    expect(sanitizeLineValue("👍".repeat(50), 3)).toBe("👍👍👍");
    expect(sanitizeLineValue("   ", 10)).toBe("?");
  });

  it("marks low-confidence fields with short codes, skipping user-edited ones and brand", () => {
    const item = parka({
      aiConfidence: { category: 0.9, materials: 0.4, warmth_level: 0.59, waterproof: 0.6, condition: 0.2, brand: 0.1 },
      userEditedFields: ["condition"],
    });
    expect(lowConfidenceFields(item)).toEqual(["materials", "warmth_level"]);
    expect(itemLineBody(item, "hamburg").endsWith("|Navy down parka|lc:mat,w")).toBe(true);
    expect(itemLineBody(parka({ aiConfidence: null }), "hamburg")).not.toContain("lc:");
    expect(itemLineBody(parka({ aiConfidence: { materials: 0.4 }, userEditedFields: ["materials"] }), "hamburg")).not.toContain(
      "lc:",
    );
  });

  it("marks items already in Hamburg or in transit on a Hamburg run", () => {
    expect(itemLineBody(parka({ location: "hamburg" }), "hamburg").endsWith("|now:there")).toBe(true);
    expect(itemLineBody(parka({ location: "in_transit", aiConfidence: { colors: 0.3 } }), "hamburg").endsWith(
      "|lc:col|now:in_transit",
    )).toBe(true);
    expect(itemLineBody(parka({ location: "bologna" }), "hamburg")).not.toContain("now:");
    expect(itemLineBody(parka({ location: "unknown" }), "hamburg")).not.toContain("now:");
  });

  it("marks what is already at the run's own destination, not Hamburg (D-170)", () => {
    // A Bologna run: items in Bologna are there; Hamburg and in-transit items are not on their way to it.
    expect(itemLineBody(parka({ location: "bologna" }), "bologna").endsWith("|now:there")).toBe(true);
    expect(itemLineBody(parka({ location: "hamburg" }), "bologna")).not.toContain("now:");
    expect(itemLineBody(parka({ location: "in_transit" }), "bologna")).not.toContain("now:");
    // A profile that is not a place an item can be: nothing is there yet.
    expect(itemLineBody(parka({ location: "hamburg" }), null)).not.toContain("now:");

    const items = [parka({ location: "bologna" }), parka({ location: "hamburg", name: "Rain shell" })];
    const toBologna = buildSnapshot(items, { includeOnlyConfirmed: true, destination: "bologna" });
    expect(toBologna.summary.alreadyMoved).toBe(1);
    expect(toBologna.summaryText).toContain("Already at the destination or on its way there: 1.");
    expect(toBologna.lines.find((line) => line.text.includes("Rain shell"))?.text).not.toContain("now:");
    // The destination is part of the line, so the snapshot hash (and the cache key) differ.
    expect(toBologna.snapshotHash).not.toBe(buildSnapshot(items, CONFIRMED).snapshotHash);
  });

  it("keeps the longest possible line under 100 estimated tokens", () => {
    const maximal = makeSnapshotItem({
      name: "N".repeat(200),
      category: "base_layer",
      subcategory: "S".repeat(200),
      colors: ["c".repeat(13), "d".repeat(12), "e".repeat(40), "f".repeat(40)],
      materials: ["m".repeat(15), "n".repeat(14), "o".repeat(40), "p".repeat(40)],
      warmthLevel: 5,
      waterproof: true,
      windproof: true,
      insulated: true,
      breathable: true,
      seasons: ["winter", "spring", "autumn"],
      formality: "smart_casual",
      condition: "needs_repair",
      status: "confirmed",
      location: "in_transit",
      aiConfidence: Object.fromEntries(Object.keys(LOW_CONFIDENCE_CODES).map((key) => [key, 0.1])),
      userEditedFields: [],
    });
    const line = `i10000|${itemLineBody(maximal, "hamburg")}`;
    expect(line).toContain("|lc:cat,col,mat,w,wp,wd,ins,form,cond|now:in_transit");
    expect(estimateTextTokens(line)).toBeLessThan(100);
  });

  it("puts a typical line in the 40 to 70 token target", () => {
    const tokens = estimateTextTokens(buildSnapshot([parka()], CONFIRMED).lines[0]?.text ?? "");
    expect(tokens).toBeGreaterThanOrEqual(30);
    expect(tokens).toBeLessThanOrEqual(70);
  });
});

describe("buildSnapshot", () => {
  const base = Date.UTC(2026, 0, 1);
  const at = (minutes: number) => new Date(base + minutes * 60_000);

  it("gives dense aliases ordered by category, then creation time, then id", () => {
    const items = [
      parka({ id: "00000000-0000-4000-8000-000000000003", category: "shoes", createdAt: at(1) }),
      parka({ id: "00000000-0000-4000-8000-000000000002", category: "outerwear", createdAt: at(5) }),
      parka({ id: "00000000-0000-4000-8000-000000000001", category: "outerwear", createdAt: at(5) }),
      parka({ id: "00000000-0000-4000-8000-000000000004", category: "outerwear", createdAt: at(2).toISOString() }),
      parka({ id: "00000000-0000-4000-8000-000000000005", category: null, createdAt: at(0) }),
      parka({ id: "00000000-0000-4000-8000-000000000006", category: "top", createdAt: at(9) }),
    ];
    const snapshot = buildSnapshot(items, CONFIRMED);
    expect(snapshot.lines.map((line) => line.alias)).toEqual(["i1", "i2", "i3", "i4", "i5", "i6"]);
    expect(snapshot.lines.map((line) => line.itemId.slice(-1))).toEqual(["4", "1", "2", "6", "3", "5"]);
    expect(snapshot.aliasMap).toEqual(Object.fromEntries(snapshot.lines.map((line) => [line.alias, line.itemId])));
    for (const line of snapshot.lines) expect(line.text.startsWith(`${line.alias}|`)).toBe(true);

    const reversed = buildSnapshot([...items].reverse(), CONFIRMED);
    expect(reversed.lines).toEqual(snapshot.lines);
  });

  it("excludes pending and archived items always, and tagged ones unless asked, counting each", () => {
    const items = [
      parka({ status: "confirmed" }),
      parka({ status: "tagged" }),
      parka({ status: "tagged" }),
      parka({ status: "pending_tagging" }),
      parka({ status: "archived" }),
      parka({ status: "archived" }),
    ];
    const confirmedOnly = buildSnapshot(items, CONFIRMED);
    expect(confirmedOnly.lines).toHaveLength(1);
    expect(confirmedOnly.excluded).toEqual({ pending: 1, archived: 2, unconfirmed: 2 });

    const withTagged = buildSnapshot(items, ALL);
    expect(withTagged.lines).toHaveLength(3);
    expect(withTagged.excluded).toEqual({ pending: 1, archived: 2, unconfirmed: 0 });
    expect(withTagged.lines.filter((line) => line.text.includes("|tagged|"))).toHaveLength(2);
    expect(withTagged.summary.unconfirmed).toBe(2);
    expect(withTagged.summaryText).toContain("Not yet confirmed by the owner: 2.");
  });

  it("summarises the included items, zero categories included", () => {
    const snapshot = buildSnapshot(
      [
        parka(),
        parka({ category: "shoes", warmthLevel: 3, waterproof: true, windproof: false, insulated: false }),
        parka({ category: "top", warmthLevel: 2, waterproof: false, windproof: false, insulated: false, location: "hamburg" }),
        parka({ status: "archived" }),
      ],
      CONFIRMED,
    );
    expect(snapshot.summary.itemCount).toBe(3);
    expect(snapshot.summary.byCategory.outerwear).toBe(1);
    expect(snapshot.summary.byCategory.gloves).toBe(0);
    expect(Object.keys(snapshot.summary.byCategory)).toEqual([...ITEM_CATEGORIES]);
    expect(snapshot.summary.warmth).toEqual({ 1: 0, 2: 1, 3: 1, 4: 0, 5: 1 });
    expect(snapshot.summary.waterproof).toBe(2);
    expect(snapshot.summary.windproof).toBe(1);
    expect(snapshot.summary.insulated).toBe(1);
    expect(snapshot.summary.alreadyMoved).toBe(1);
    expect(snapshot.summaryText).toContain("Items in this analysis: 3.");
    expect(snapshot.summaryText).toContain("gloves 0");
    expect(snapshot.summaryText).toContain("Already at the destination or on its way there: 1.");
    expect(snapshot.legend).toBe(SNAPSHOT_LEGEND);
  });

  it("returns an empty snapshot for no items", () => {
    const snapshot = buildSnapshot([], CONFIRMED);
    expect(snapshot.lines).toEqual([]);
    expect(snapshot.summary.itemCount).toBe(0);
    expect(snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("explains every field once in the legend", () => {
    for (const term of ["alias", "warmth", "wp waterproof", "wd windproof", "ins insulated", "br breathable", "lc:", "now:there", "now:in_transit", "all = all four", "?"]) {
      expect(SNAPSHOT_LEGEND).toContain(term);
    }
    for (const code of Object.values(LOW_CONFIDENCE_CODES)) expect(SNAPSHOT_LEGEND).toContain(`${code} `);
  });
});

describe("snapshotHash", () => {
  const items = [
    parka({ id: "00000000-0000-4000-8000-00000000000a" }),
    parka({ id: "00000000-0000-4000-8000-00000000000b", category: "shoes", name: "Chelsea boots" }),
    parka({ id: "00000000-0000-4000-8000-00000000000c", category: "top", name: "Merino sweater" }),
  ];
  const hashOf = (list: readonly SnapshotItemInput[], options = CONFIRMED) => buildSnapshot(list, options).snapshotHash;
  const reference = hashOf(items);

  it("is stable across input order and object key order", () => {
    expect(hashOf([...items].reverse())).toBe(reference);
    const reordered = items.map(
      (item) => Object.fromEntries(Object.entries(item).reverse()) as unknown as SnapshotItemInput,
    );
    expect(hashOf(reordered)).toBe(reference);
    const confidenceReordered = items.map((item) => ({
      ...item,
      aiConfidence: item.aiConfidence && Object.fromEntries(Object.entries(item.aiConfidence).reverse()),
    }));
    expect(hashOf(confidenceReordered)).toBe(reference);
  });

  it.each<[string, Partial<SnapshotItemInput>]>([
    ["name", { name: "Black down parka" }],
    ["category", { category: "top" }],
    ["subcategory", { subcategory: "anorak" }],
    ["colors", { colors: ["navy"] }],
    ["colour order", { colors: ["black", "navy"] }],
    ["materials", { materials: ["down"] }],
    ["warmth", { warmthLevel: 4 }],
    ["waterproof", { waterproof: false }],
    ["windproof", { windproof: null }],
    ["insulated", { insulated: false }],
    ["breathable", { breathable: true }],
    ["seasons", { seasons: ["winter", "autumn"] }],
    ["formality", { formality: "smart_casual" }],
    ["condition", { condition: "worn" }],
    ["status", { status: "tagged" }],
    ["a low confidence", { aiConfidence: { materials: 0.3 } }],
    ["location", { location: "in_transit" }],
  ])("changes when the %s changes", (_field, change) => {
    const changed = items.map((item, index) => (index === 0 ? { ...item, ...change } : item));
    expect(hashOf(changed, ALL)).not.toBe(hashOf(items, ALL));
  });

  it("does not change for fields that never reach a line", () => {
    const withExtras = items.map((item, index) =>
      index === 0
        ? ({
            ...item,
            notes: "Bought in Rome",
            brand: "Acme",
            createdAt: item.createdAt, // same order, same hash
            materialGuess: "something else entirely",
            aiConfidence: { ...item.aiConfidence, brand: 0.1, materials: 0.95 },
          } as SnapshotItemInput)
        : item,
    );
    expect(hashOf(withExtras)).toBe(reference);
    // A user edit only matters when it removes an lc: marker.
    expect(hashOf(items.map((item) => ({ ...item, userEditedFields: ["materials"] })))).toBe(reference);
  });

  it("changes when an item is added or excluded", () => {
    expect(hashOf([...items, parka()])).not.toBe(reference);
    expect(hashOf(items.slice(1))).not.toBe(reference);
  });
});

describe("SnapshotItemInput", () => {
  it("is satisfied by a drizzle items row, so the service can pass rows as they are", () => {
    // Compile-time check: tsc fails here if the row type stops fitting.
    const fits: Item extends SnapshotItemInput ? true : false = true;
    expect(fits).toBe(true);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and rejects values JSON cannot hold", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":null,"z":1}]},"b":1}',
    );
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
  });
});
