import { describe, expect, it } from "vitest";

import { ITEM_CATEGORIES, type ItemCategory } from "@/lib/db/enums";
import { planChunks, relocationCacheKey, type RelocationCacheKeyInput } from "@/lib/relocation/chunks";
import { MAX_ITEMS_PER_CHUNK } from "@/lib/relocation/contracts";
import { buildSnapshot, type SnapshotLine } from "@/lib/relocation/payload";
import { makeSnapshotItem } from "../../../test/relocation-fixtures";

/** Lines for `counts` items per category, in snapshot order, with cycling subcategories. */
function linesFor(counts: Partial<Record<ItemCategory, number>>, subcategories = ["a", "b", "c"]): SnapshotLine[] {
  const items = ITEM_CATEGORIES.flatMap((category) =>
    Array.from({ length: counts[category] ?? 0 }, (_, index) =>
      makeSnapshotItem({ category, subcategory: subcategories[index % subcategories.length] ?? null }),
    ),
  );
  return buildSnapshot(items, { includeOnlyConfirmed: true, destination: "hamburg" }).lines;
}

function checkPartition(lines: readonly SnapshotLine[], max = MAX_ITEMS_PER_CHUNK) {
  const chunks = planChunks(lines, { maxPerChunk: max });
  const all = chunks.flatMap((chunk) => chunk.aliases);
  expect([...all].sort()).toEqual(lines.map((line) => line.alias).sort());
  expect(new Set(all).size).toBe(all.length);
  for (const chunk of chunks) {
    expect(chunk.aliases.length).toBeGreaterThan(0);
    expect(chunk.aliases.length).toBeLessThanOrEqual(max);
  }
  expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
  return chunks;
}

/** The chunk indexes each category's items landed in. */
function chunksPerCategory(lines: readonly SnapshotLine[], chunks: ReturnType<typeof planChunks>) {
  const chunkOf = new Map(chunks.flatMap((chunk) => chunk.aliases.map((alias) => [alias, chunk.index] as const)));
  const result = new Map<string, Set<number>>();
  for (const line of lines) {
    const set = result.get(line.category ?? "unknown") ?? new Set<number>();
    set.add(chunkOf.get(line.alias) ?? -1);
    result.set(line.category ?? "unknown", set);
  }
  return result;
}

describe("planChunks", () => {
  it("returns no chunks for no lines", () => {
    expect(planChunks([])).toEqual([]);
  });

  it("puts a single item in one chunk", () => {
    const lines = linesFor({ top: 1 });
    expect(planChunks(lines)).toEqual([{ index: 0, aliases: ["i1"], categories: ["top"] }]);
  });

  it("fits exactly 70 items in one chunk and splits 71", () => {
    expect(checkPartition(linesFor({ top: 40, bottom: 30 }))).toHaveLength(1);
    const chunks = checkPartition(linesFor({ top: 40, bottom: 31 }));
    expect(chunks).toHaveLength(2);
    // Whole categories: tops alone, then bottoms.
    expect(chunks.map((chunk) => chunk.categories)).toEqual([["top"], ["bottom"]]);
  });

  it("covers 300 items in chunks of at most 70 without splitting any category of 70 or fewer", () => {
    const lines = linesFor({
      outerwear: 25,
      top: 70,
      bottom: 45,
      dress: 5,
      shoes: 30,
      gloves: 6,
      hat_beanie: 8,
      scarf: 9,
      base_layer: 40,
      accessory: 30,
      bag: 20,
      other: 12,
    });
    expect(lines).toHaveLength(300);
    const chunks = checkPartition(lines);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.length).toBeLessThanOrEqual(7);
    for (const [, indexes] of chunksPerCategory(lines, chunks)) expect(indexes.size).toBe(1);
    // Categories appear in snapshot order across the chunks.
    expect(chunks.flatMap((chunk) => chunk.categories)).toEqual([...ITEM_CATEGORIES]);
  });

  it("splits a 150-item category along its subcategories", () => {
    const lines = linesFor({ top: 150 }, ["shirt", "sweater", "t-shirt", "hoodie", "blazer"]);
    const chunks = checkPartition(lines);
    expect(chunks.length).toBe(3);
    const subOf = new Map(lines.map((line) => [line.alias, line.subcategory]));
    // Each of the five subcategories (30 items each) stays whole.
    const placements = new Map<string | null, Set<number>>();
    for (const chunk of chunks) {
      for (const alias of chunk.aliases) {
        const sub = subOf.get(alias) ?? null;
        const set = placements.get(sub) ?? new Set<number>();
        set.add(chunk.index);
        placements.set(sub, set);
      }
    }
    for (const [, indexes] of placements) expect(indexes.size).toBe(1);
    expect(chunks.every((chunk) => chunk.categories.length === 1 && chunk.categories[0] === "top")).toBe(true);
  });

  it("splits a subcategory larger than the limit by order", () => {
    const lines = linesFor({ top: 150 }, ["t-shirt"]);
    const chunks = checkPartition(lines);
    expect(chunks.map((chunk) => chunk.aliases.length)).toEqual([70, 70, 10]);
    expect(chunks[0]?.aliases.slice(0, 3)).toEqual(["i1", "i2", "i3"]);
  });

  it("packs the rest of a split category with the next categories", () => {
    const lines = linesFor({ top: 150, bottom: 20 }, ["t-shirt"]);
    const chunks = checkPartition(lines);
    expect(chunks.map((chunk) => chunk.aliases.length)).toEqual([70, 70, 30]);
    expect(chunks[2]?.categories).toEqual(["top", "bottom"]);
  });

  it("is deterministic and honours a custom limit", () => {
    const lines = linesFor({ top: 33, bottom: 17, shoes: 9 });
    expect(planChunks(lines, { maxPerChunk: 20 })).toEqual(planChunks(lines, { maxPerChunk: 20 }));
    checkPartition(lines, 20);
    expect(() => planChunks(lines, { maxPerChunk: 0 })).toThrow(RangeError);
    expect(() => planChunks(lines, { maxPerChunk: 2.5 })).toThrow(RangeError);
  });
});

describe("relocationCacheKey", () => {
  const base: RelocationCacheKeyInput = {
    promptVersion: "reloc-v1",
    model: "claude-sonnet-5-5",
    effort: "medium",
    snapshotHash: "a".repeat(64),
    climateText: "Destination: Hamburg, Germany",
    months: [11, 12, 1, 2],
    constraints: "I commute by bike. Office is business casual.",
    purchaseBudgetEur: 600,
    includeOnlyConfirmed: true,
  };
  const key = relocationCacheKey(base);

  it("is a sha256 hex digest and stable", () => {
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(relocationCacheKey({ ...base })).toBe(key);
  });

  it("ignores whitespace differences in the constraints", () => {
    expect(relocationCacheKey({ ...base, constraints: "  I commute by bike.\n\nOffice   is\tbusiness casual.  " })).toBe(key);
  });

  it.each<[string, Partial<RelocationCacheKeyInput>]>([
    ["model", { model: "claude-opus-5-5" }],
    ["effort", { effort: "high" }],
    ["months", { months: [11, 12, 1] }],
    ["month order", { months: [12, 11, 1, 2] }],
    ["budget", { purchaseBudgetEur: 500 }],
    ["no budget", { purchaseBudgetEur: null }],
    ["includeOnlyConfirmed", { includeOnlyConfirmed: false }],
    ["climate text", { climateText: "Destination: Hamburg, Germany (edited)" }],
    ["prompt version", { promptVersion: "reloc-v2" }],
    ["snapshot hash", { snapshotHash: "b".repeat(64) }],
    ["constraint words", { constraints: "I commute by car. Office is business casual." }],
  ])("changes with the %s", (_label, change) => {
    expect(relocationCacheKey({ ...base, ...change })).not.toBe(key);
  });
});
