import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  countSchemaComplexity,
  FORBIDDEN_KEY,
  SCHEMA_LIMITS,
  toJsonSchema,
  toJsonSchemaFormat,
  type JsonSchema,
} from "@/lib/ai/json-schema";
import { PACKING_GROUPS } from "@/lib/db/enums";
import { BUY_TIMINGS, RELOCATION_DECISIONS } from "@/lib/relocation/contracts";
import {
  ChunkWireSchema,
  makeChunkStrictSchema,
  makeGapKey,
  makeRelocationAnalysisSchema,
  makeSynthesisStrictSchema,
  priorityGapsMinimumEur,
  RELOCATION_LIMITS,
  RelocationAnalysisSchema,
  SynthesisWireSchema,
  type SynthesisWire,
} from "@/lib/relocation/schemas";
import { fakeChunkReply, fakeSynthesisReply, makeRelocationResult } from "../../../test/relocation-fixtures";

/** Every property name anywhere in a JSON Schema. */
function propertyNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(propertyNames);
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as JsonSchema;
  const own =
    typeof node.properties === "object" && node.properties !== null ? Object.keys(node.properties as JsonSchema) : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
}

describe("wire schemas", () => {
  it.each([
    ["chunk", ChunkWireSchema],
    ["synthesis", SynthesisWireSchema],
  ] as const)("the %s wire converts within the structured-output limits", (_name, wire) => {
    const schema = toJsonSchema(wire);
    const complexity = countSchemaComplexity(schema);
    expect(complexity.unions).toBeLessThanOrEqual(SCHEMA_LIMITS.unions);
    expect(complexity.optionals).toBe(0);
    expect(toJsonSchemaFormat(wire).schema).toEqual(schema);
    const names = propertyNames(schema);
    expect(names.length).toBeGreaterThan(3);
    expect(names.filter((name) => FORBIDDEN_KEY.test(name))).toEqual([]);
    expect(JSON.stringify(schema)).not.toMatch(/reasoning|thinking|thought/i);
  });

  it("states every text length the synthesis strict check enforces, so a reply is not retried over an unstated limit", () => {
    const L = RELOCATION_LIMITS;
    const schema = toJsonSchema(SynthesisWireSchema);
    // Follows properties, and items for arrays ("*").
    const at = (path: readonly string[]): unknown =>
      path.reduce<unknown>((node, key) => {
        const record = node as Record<string, unknown>;
        if (key === "*") return record.items;
        return (record.properties as Record<string, unknown>)[key];
      }, schema);
    const caps: [string[], number][] = [
      [["summary"], L.summaryMax],
      [["layering_systems", "*", "title"], L.titleMax],
      [["layering_systems", "*", "conditions"], L.conditionsMax],
      [["layering_systems", "*", "gap_note"], L.gapNoteMax],
      [["gaps", "*", "item_type"], L.itemTypeMax],
      [["gaps", "*", "why_needed"], L.whyNeededMax],
      [["gaps", "*", "specs"], L.specMax],
      [["packing_checklist", "*", "extras"], L.extraMax],
      [["warnings", "*", "message"], L.warningMessageMax],
    ];
    for (const [path, cap] of caps) {
      expect(JSON.stringify(at(path)).toLowerCase(), path.join(".")).toContain(
        `at most ${cap.toLocaleString("en-US")} characters`,
      );
    }
  });

  it("keeps the enums and integer types the grammar enforces", () => {
    const chunk = JSON.stringify(toJsonSchema(ChunkWireSchema));
    expect(chunk).toContain(JSON.stringify([...RELOCATION_DECISIONS]));
    expect(chunk).toContain('"enum":[1,2,3]');
    const synthesis = JSON.stringify(toJsonSchema(SynthesisWireSchema));
    expect(synthesis).toContain(JSON.stringify([...BUY_TIMINGS]));
    expect(synthesis).toContain(JSON.stringify([...PACKING_GROUPS]));
    expect(synthesis).toContain('"type":"integer"');
  });
});

describe("makeChunkStrictSchema", () => {
  const aliases = ["i1", "i2", "i3"];
  const strict = makeChunkStrictSchema(aliases);

  it("accepts a complete reply and one with a missing alias", () => {
    expect(strict.safeParse(fakeChunkReply(aliases)).success).toBe(true);
    const missing = fakeChunkReply(aliases, { omit: ["i2"] });
    expect(missing.decisions.map((entry) => entry.item)).toEqual(["i1", "i3"]);
    expect(strict.safeParse(missing).success).toBe(true);
  });

  it.each([
    ["an alias outside the chunk", "i4"],
    ["a malformed alias", "item1"],
    ["a duplicate alias", "i1"],
  ])("rejects %s", (_label, item) => {
    const reply = fakeChunkReply(aliases, {
      extra: [{ item, decision: "bring", priority: 1, reason: "Extra." }],
    });
    expect(ChunkWireSchema.safeParse(reply).success).toBe(true);
    expect(strict.safeParse(reply).success).toBe(false);
  });

  it.each([
    ["priority 4", { priority: 4 }],
    ["an empty reason", { reason: "   " }],
    ["a 201-character reason", { reason: "x".repeat(201) }],
    ["an unknown decision", { decision: "undecided" }],
  ])("rejects %s", (_label, change) => {
    const [first, ...rest] = fakeChunkReply(aliases).decisions;
    const reply = { decisions: [{ ...first, ...change }, ...rest] };
    expect(strict.safeParse(reply).success).toBe(false);
  });

  it("compares the decision case-insensitively, since structured outputs do not guarantee enum casing (D-165)", () => {
    const [first, second, ...rest] = fakeChunkReply(aliases).decisions;
    if (first === undefined || second === undefined) throw new Error("fixture too short");
    const parsed = strict.safeParse({
      decisions: [{ ...first, decision: "Bring" }, { ...second, decision: " LEAVE " }, ...rest],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.decisions.slice(0, 2).map((entry) => entry.decision)).toEqual(["bring", "leave"]);
    for (const decision of ["pack", "br ing"]) {
      expect(strict.safeParse({ decisions: [{ ...first, decision }, second, ...rest] }).success).toBe(false);
    }
  });
});

describe("makeSynthesisStrictSchema", () => {
  const aliases = Array.from({ length: 12 }, (_, index) => `i${index + 1}`);
  const strict = makeSynthesisStrictSchema(aliases);
  const valid = fakeSynthesisReply(aliases);
  const [firstGap] = valid.gaps;
  if (!firstGap) throw new Error("fixture has no gap");
  const system = valid.layering_systems[0];
  if (!system) throw new Error("fixture has no layering system");

  it("accepts the fixture reply", () => {
    expect(SynthesisWireSchema.safeParse(valid).success).toBe(true);
    expect(strict.safeParse(valid).success).toBe(true);
  });

  it.each<[string, Partial<SynthesisWire>]>([
    ["2 layering systems", { layering_systems: [system, system] }],
    ["6 layering systems", { layering_systems: Array.from({ length: 6 }, () => system) }],
    ["min above max", { gaps: [{ ...firstGap, est_price_min_eur: 300, est_price_max_eur: 200 }] }],
    ["a negative price", { gaps: [{ ...firstGap, est_price_min_eur: -1 }] }],
    ["quantity 0", { gaps: [{ ...firstGap, quantity: 0 }] }],
    ["quantity 2.5", { gaps: [{ ...firstGap, quantity: 2.5 }] }],
    ["quantity 11", { gaps: [{ ...firstGap, quantity: 11 }] }],
    ["an empty why_needed", { gaps: [{ ...firstGap, why_needed: " " }] }],
    ["13 gaps", { gaps: Array.from({ length: 13 }, () => firstGap) }],
    ["an unknown alias in a layering system", { layering_systems: [{ ...system, item_aliases: ["i99"] }, system, system] }],
    ["an unknown alias in a warning", { warnings: [{ kind: "duplicate", item_aliases: ["i0"], message: "x" }] }],
    ["a summary over 1,200 characters", { summary: "x".repeat(1201) }],
    [
      "an alias in two packing groups",
      {
        packing_checklist: [
          { group: "suitcase", item_aliases: ["i1", "i2"], extras: [] },
          { group: "carry_on", item_aliases: ["i2"], extras: [] },
        ],
      },
    ],
    [
      "a group listed twice",
      {
        packing_checklist: [
          { group: "suitcase", item_aliases: ["i1"], extras: [] },
          { group: "suitcase", item_aliases: ["i2"], extras: [] },
        ],
      },
    ],
  ])("rejects %s", (_label, change) => {
    const reply = { ...valid, ...change };
    expect(strict.safeParse(reply).success).toBe(false);
  });

  it("compares enum values case-insensitively and keeps the canonical value (D-165)", () => {
    const [suitcase, ...otherGroups] = valid.packing_checklist;
    if (suitcase === undefined) throw new Error("fixture has no packing group");
    const cased = {
      ...valid,
      gaps: [{ ...firstGap, category: "Outerwear", buy_timing: "Before_Move" }, ...valid.gaps.slice(1)],
      packing_checklist: [{ ...suitcase, group: "Suitcase" }, ...otherGroups],
      warnings: [{ kind: "Duplicate", item_aliases: ["i1"], message: "Two similar shells." }],
    };
    const parsed = strict.safeParse(cased);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.gaps[0]).toMatchObject({ category: "outerwear", buy_timing: "before_move" });
    expect(parsed.data.packing_checklist[0]?.group).toBe("suitcase");
    expect(parsed.data.warnings[0]?.kind).toBe("duplicate");

    expect(strict.safeParse({ ...valid, gaps: [{ ...firstGap, category: "outer wear" }] }).success).toBe(false);
    // A group named twice in different cases is still a group listed twice.
    expect(
      strict.safeParse({
        ...valid,
        packing_checklist: [
          { group: "Suitcase", item_aliases: ["i1"], extras: [] },
          { group: "suitcase", item_aliases: ["i2"], extras: [] },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a gap note of up to 300 characters, the limit the wire schema states", () => {
    const note = (length: number) => ({ ...valid, layering_systems: [{ ...system, gap_note: "x".repeat(length) }, system, system] });
    expect(strict.safeParse(note(300)).success).toBe(true);
    expect(strict.safeParse(note(301)).success).toBe(false);
  });

  it("accepts an alias repeated within one packing group: harmless, so not worth a paid retry", () => {
    const parsed = strict.safeParse({
      ...valid,
      packing_checklist: [{ group: "suitcase", item_aliases: ["i1", "i1", "i2"], extras: [] }],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts 3 and 5 layering systems and an empty gap list", () => {
    expect(strict.safeParse({ ...valid, layering_systems: [system, system, system], gaps: [] }).success).toBe(true);
    expect(strict.safeParse({ ...valid, layering_systems: Array.from({ length: 5 }, () => system) }).success).toBe(true);
  });

  it("turns a blank gap note into null and drops blank specs and extras", () => {
    const parsed = strict.parse({
      ...valid,
      layering_systems: [{ ...system, gap_note: "  " }, system, system],
      gaps: [{ ...firstGap, specs: ["  Hood ", "", " "] }],
      packing_checklist: [{ group: "suitcase", item_aliases: ["i1"], extras: ["", " Umbrella "] }],
    });
    expect(parsed.layering_systems[0]?.gap_note).toBeNull();
    expect(parsed.gaps[0]?.specs).toEqual(["Hood"]);
    expect(parsed.packing_checklist[0]?.extras).toEqual(["Umbrella"]);
  });
});

describe("RelocationAnalysisSchema", () => {
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const result = makeRelocationResult(ids);
  const strict = makeRelocationAnalysisSchema(ids);

  it("accepts the fixture result with every item once", () => {
    expect(RelocationAnalysisSchema.safeParse(result).success).toBe(true);
    expect(strict.safeParse(result).success).toBe(true);
    expect(result.items.map((item) => item.item_id)).toEqual(ids);
  });

  it("rejects a missing item", () => {
    expect(strict.safeParse({ ...result, items: result.items.slice(1) }).success).toBe(false);
  });

  it("rejects a duplicated item_id, in the base schema too", () => {
    const [first] = result.items;
    if (!first) throw new Error("fixture has no items");
    const duplicated = { ...result, items: [...result.items, first] };
    expect(RelocationAnalysisSchema.safeParse(duplicated).success).toBe(false);
    expect(strict.safeParse(duplicated).success).toBe(false);
  });

  it("rejects an item outside the snapshot, anywhere in the result", () => {
    const stranger = randomUUID();
    const [first, ...rest] = result.items;
    if (!first) throw new Error("fixture has no items");
    expect(strict.safeParse({ ...result, items: [{ ...first, item_id: stranger }, ...rest] }).success).toBe(false);
    expect(
      strict.safeParse({
        ...result,
        packing_checklist: [{ group: "suitcase", item_ids: [stranger], extras: [] }],
      }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid id, a duplicate gap key and a computed warning kind without a source", () => {
    const [gap] = result.gaps;
    if (!gap) throw new Error("fixture has no gaps");
    expect(
      RelocationAnalysisSchema.safeParse({ ...result, layering_systems: [{ ...result.layering_systems[0], item_ids: ["i1"] }] })
        .success,
    ).toBe(false);
    expect(RelocationAnalysisSchema.safeParse({ ...result, gaps: [gap, gap] }).success).toBe(false);
    expect(
      RelocationAnalysisSchema.safeParse({
        ...result,
        warnings: [{ kind: "over_budget", item_ids: [], message: "Over budget." }],
      }).success,
    ).toBe(false);
    expect(
      RelocationAnalysisSchema.safeParse({
        ...result,
        warnings: [{ kind: "over_budget", item_ids: [], message: "Over budget.", source: "computed" }],
      }).success,
    ).toBe(true);
  });

  it("accepts an empty snapshot result", () => {
    const empty = makeRelocationResult([]);
    expect(makeRelocationAnalysisSchema([]).safeParse(empty).success).toBe(true);
  });
});

describe("makeGapKey", () => {
  it("is the position plus a slug of category and type, unique by position", () => {
    const key = (index: number, category: string, item_type: string) => makeGapKey(index, { category, item_type });
    expect(key(0, "outerwear", "Waterproof breathable shell jacket")).toBe("g1-outerwear-waterproof-breathable-shell-jacket");
    expect(key(4, "hat_beanie", "Wool/fleece-lined beanie (ears)")).toBe("g5-hat-beanie-wool-fleece-lined-beanie-ears");
    expect(key(1, "shoes", "Stiefel für Schnee – gefüttert")).toBe("g2-shoes-stiefel-fur-schnee-gefuttert");
    expect(key(2, "", "—")).toBe("g3");
    // The same gap twice still gets two keys.
    expect(key(0, "outerwear", "Shell")).not.toBe(key(1, "outerwear", "Shell"));
    // Cut at a word boundary; a twelfth gap still fits the stored key's limit.
    const long = key(11, "other", "x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(RELOCATION_LIMITS.gapKeyMax);
    expect(key(11, "other", "word ".repeat(40))).toMatch(/^g12-other(-word)+$/);
    expect(key(11, "other", "word ".repeat(40)).length).toBeLessThanOrEqual(4 + 70);
  });
});

describe("priorityGapsMinimumEur", () => {
  it("sums minimum price times quantity over priority 1 and 2 gaps", () => {
    const gap = (priority: 1 | 2 | 3, min: number, quantity: number) => ({
      priority,
      quantity,
      est_price_range_eur: { min, max: min + 50 },
    });
    expect(priorityGapsMinimumEur([gap(1, 120, 1), gap(2, 15, 3), gap(3, 400, 1)])).toBe(165);
    expect(priorityGapsMinimumEur([])).toBe(0);
  });
});
