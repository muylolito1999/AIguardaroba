import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { estimateTextTokens } from "@/lib/ai/cost";
import { countSchemaComplexity, FORBIDDEN_KEY, SCHEMA_LIMITS, toJsonSchema, toJsonSchemaFormat, type JsonSchema } from "@/lib/ai/json-schema";
import { HAMBURG } from "@/lib/climate/hamburg";
import { AI_PURPOSES } from "@/lib/db/enums";
import { canonicalJson } from "@/lib/relocation/payload";
import {
  buildShoppingAdviceInstruction,
  candidateLine,
  describeAdviceClimate,
  estimateShoppingAdviceUsd,
  makeShoppingAdviceStrictSchema,
  SHOPPING_ADVICE_LIMITS,
  SHOPPING_CALL_PARAMS,
  SHOPPING_DEADLINE_MS,
  SHOPPING_PROMPT_VERSION,
  SHOPPING_SYSTEM_PROMPT,
  ShoppingAdviceResultSchema,
  ShoppingAdviceWireSchema,
  type ShoppingAdviceCandidate,
  type ShoppingAdviceInstructionInput,
  type ShoppingAdviceResult,
  type ShoppingAdviceWire,
} from "@/lib/shopping/advice";

import { fakeShoppingAdviceReply, HAMBURG_SCENARIOS } from "../../../test/outfit-fixtures";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function propertyNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(propertyNames);
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as JsonSchema;
  const own = typeof node.properties === "object" && node.properties !== null ? Object.keys(node.properties as JsonSchema) : [];
  return [...own, ...Object.values(node).flatMap(propertyNames)];
}

const shell: ShoppingAdviceCandidate = {
  key: "c1",
  itemType: "Waterproof breathable shell jacket",
  category: "outerwear",
  priority: 1,
  quantity: 1,
  specs: ["hood and taped seams", "at least 10,000 mm water column"],
  estPriceMinEur: 120,
  estPriceMaxEur: 200,
  source: "gap",
  unlocks: { jan: 12, apr: 0, jul: 3, oct: 5 },
};

const gloves: ShoppingAdviceCandidate = {
  key: "c2",
  itemType: "Windproof gloves",
  category: "gloves",
  priority: null,
  quantity: 2,
  specs: [],
  estPriceMinEur: null,
  estPriceMaxEur: 40,
  source: "list",
  unlocks: { jan: 0, apr: 0, jul: 0, oct: 0 },
};

const input: ShoppingAdviceInstructionInput = {
  candidates: [shell, gloves],
  scenarios: HAMBURG_SCENARIOS.map((scenario, index) => ({ ...scenario, outfitsNow: index })),
  remainingBudgetEur: 400,
  climateSummary: "  Hamburg: 17.7 rain days in January, mean 2.1 °C.  ",
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe("ShoppingAdviceWireSchema", () => {
  const schema = toJsonSchema(ShoppingAdviceWireSchema);

  it("converts within the structured-output limits with no reserved keys", () => {
    const complexity = countSchemaComplexity(schema);
    expect(complexity.unions).toBeLessThanOrEqual(SCHEMA_LIMITS.unions);
    expect(complexity.optionals).toBe(0);
    expect(toJsonSchemaFormat(ShoppingAdviceWireSchema).schema).toEqual(schema);
    const names = propertyNames(schema);
    expect(names).toEqual(expect.arrayContaining(["recommendations", "key", "rank", "why", "budget_eur"]));
    expect(names.filter((name) => FORBIDDEN_KEY.test(name))).toEqual([]);
    expect(JSON.stringify(schema)).not.toMatch(/reasoning|thinking|thought/i);
  });

  it("keeps integer types and states the limits the strict check enforces", () => {
    const text = JSON.stringify(schema);
    expect(text).toContain('"rank":{"type":"integer"');
    expect(text).toContain('"budget_eur":{"type":"integer"');
    expect(text).toContain(`at most ${SHOPPING_ADVICE_LIMITS.whyMax} characters`);
    expect(text).toContain(`Up to ${SHOPPING_ADVICE_LIMITS.maxRecommendations} candidates`);
  });
});

describe("makeShoppingAdviceStrictSchema", () => {
  const keys = ["c1", "c2", "c3", "c4"];
  const strict = makeShoppingAdviceStrictSchema(keys, 400);
  const valid = fakeShoppingAdviceReply(["c3", "c1", "c4"]);

  const withEntry = (index: number, change: Partial<ShoppingAdviceWire["recommendations"][number]>): ShoppingAdviceWire => ({
    recommendations: valid.recommendations.map((entry, i) => (i === index ? { ...entry, ...change } : entry)),
  });

  it("accepts a subset of the candidates, sorted by rank", () => {
    expect(ShoppingAdviceWireSchema.safeParse(valid).success).toBe(true);
    const shuffled = { recommendations: [...valid.recommendations].reverse() };
    expect(strict.parse(shuffled).recommendations.map((entry) => [entry.rank, entry.key])).toEqual([
      [1, "c3"],
      [2, "c1"],
      [3, "c4"],
    ]);
  });

  it("matches keys ignoring case and spaces and returns them as listed", () => {
    const loose = makeShoppingAdviceStrictSchema(["g1-Outerwear-shell"], null);
    const parsed = loose.parse(fakeShoppingAdviceReply([" G1-OUTERWEAR-SHELL "]));
    expect(parsed.recommendations[0]?.key).toBe("g1-Outerwear-shell");
  });

  it("keeps the budgets within the remaining budget, and has no limit without one", () => {
    expect(strict.safeParse(fakeShoppingAdviceReply(["c1", "c2"], 200)).success).toBe(true);
    const over = strict.safeParse(fakeShoppingAdviceReply(["c1", "c2"], 201));
    expect(over.success ? "" : over.error.issues.map((issue) => issue.message).join("\n")).toContain(
      "The budgets add up to €402, more than the €400 left.",
    );
    expect(makeShoppingAdviceStrictSchema(keys, null).safeParse(fakeShoppingAdviceReply(keys, 5000)).success).toBe(true);
    expect(makeShoppingAdviceStrictSchema(keys, 0).safeParse(fakeShoppingAdviceReply(["c1"], 0)).success).toBe(true);
  });

  it.each([
    ["no recommendations", { recommendations: [] }],
    ["more recommendations than candidates", fakeShoppingAdviceReply(["c1", "c2", "c3", "c4", "c1"])],
    ["an unknown key", withEntry(0, { key: "c9" })],
    ["a gap key not listed", withEntry(0, { key: "g1-outerwear-shell" })],
    ["a key twice", withEntry(1, { key: "c3" })],
    ["a gap in the ranks", withEntry(2, { rank: 4 })],
    ["a rank twice", withEntry(2, { rank: 2 })],
    ["rank 0", withEntry(0, { rank: 0 })],
    ["a fractional rank", withEntry(0, { rank: 1.5 })],
    ["an empty why", withEntry(0, { why: "  " })],
    ["a 301-character why", withEntry(0, { why: "x".repeat(301) })],
    ["a negative budget", withEntry(0, { budget_eur: -1 })],
    ["a fractional budget", withEntry(0, { budget_eur: 49.5 })],
    ["an unknown field", { recommendations: valid.recommendations.map((entry) => ({ ...entry, gap_key: "x" })) }],
  ])("rejects %s", (_label, reply) => {
    expect(strict.safeParse(reply).success).toBe(false);
  });

  it(`allows at most ${SHOPPING_ADVICE_LIMITS.maxRecommendations} recommendations`, () => {
    const many = Array.from({ length: 12 }, (_, index) => `c${index + 1}`);
    const schema = makeShoppingAdviceStrictSchema(many, null);
    expect(schema.safeParse(fakeShoppingAdviceReply(many.slice(0, 10))).success).toBe(true);
    expect(schema.safeParse(fakeShoppingAdviceReply(many.slice(0, 11))).success).toBe(false);
  });

  it("refuses to build a check for no candidates", () => {
    expect(() => makeShoppingAdviceStrictSchema([], 100)).toThrow(RangeError);
  });
});

describe("ShoppingAdviceResultSchema", () => {
  const result: ShoppingAdviceResult = {
    recommendations: [
      { key: "c1", rank: 1, why: "Unlocks 12 outfits in January.", budget_eur: 160, unlocks: { jan: 12, apr: 0, jul: 3, oct: 5 } },
      { key: "c2", rank: 2, why: "Cold, windy months.", budget_eur: 60, unlocks: { jan: 0, apr: 0, jul: 0, oct: 0 } },
    ],
    meta: {
      prompt_version: SHOPPING_PROMPT_VERSION,
      model: "claude-sonnet-5-5",
      effort: "low",
      candidate_count: 2,
      remaining_budget_eur: 400,
      scenarios: [...HAMBURG_SCENARIOS],
    },
  };

  it("accepts a stored result", () => {
    expect(ShoppingAdviceResultSchema.parse(result)).toEqual(result);
    expect(ShoppingAdviceResultSchema.parse({ ...result, meta: { ...result.meta, remaining_budget_eur: null } }).meta.remaining_budget_eur).toBeNull();
  });

  it("rejects negative or fractional unlock counts and too many recommendations", () => {
    const [first, second] = result.recommendations;
    if (first === undefined || second === undefined) throw new Error("fixture");
    expect(ShoppingAdviceResultSchema.safeParse({ ...result, recommendations: [{ ...first, unlocks: { jan: -1 } }] }).success).toBe(false);
    expect(ShoppingAdviceResultSchema.safeParse({ ...result, recommendations: [{ ...first, unlocks: { jan: 1.5 } }] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, index) => ({ ...second, key: `c${index}`, rank: index + 1 }));
    expect(ShoppingAdviceResultSchema.safeParse({ ...result, recommendations: eleven }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

// Pinned per version like the outfit prompt: an edit to the system prompt, the
// instruction template, the candidate line format or the wire schema must bump
// SHOPPING_PROMPT_VERSION and record the new hashes here.
const PINNED = {
  "shop-v1": {
    system: "a0b5fbf398aaaffc61fbacb7ba2cb22f69a55ea6d29af3e7bd5d56470ebaacd9",
    templates: "7214ca6fbb13f28cba4d25ff82ed46a6d6878c6d61880753115e49b9056d3c6c",
  },
  // Each piece of an outfit is checked on its own, and the climate table is the whole year, not a stay.
  "shop-v2": {
    system: "5ffc55ebcf9497a6bbe1c4acfc4c76f12877f4c5bb86badf5afd5707c4e59ddc",
    templates: "ec11c6bd184f682b2efb6e1c580c136819a798d4552369ca74a8ae53c5d8e0e0",
  },
} as const;

function renderTemplates(): string {
  return canonicalJson([
    buildShoppingAdviceInstruction(input),
    buildShoppingAdviceInstruction({ ...input, candidates: [gloves], remainingBudgetEur: null }),
    describeAdviceClimate(HAMBURG),
    toJsonSchemaFormat(ShoppingAdviceWireSchema),
  ]);
}

describe("SHOPPING_PROMPT_VERSION", () => {
  it("pins the system prompt for its version", () => {
    expect(SHOPPING_PROMPT_VERSION).toBe("shop-v2");
    expect(sha256(SHOPPING_SYSTEM_PROMPT)).toBe(PINNED[SHOPPING_PROMPT_VERSION].system);
  });

  it("pins the instruction template, the candidate lines and the wire schema for its version", () => {
    expect(sha256(renderTemplates())).toBe(PINNED[SHOPPING_PROMPT_VERSION].templates);
  });
});

describe("SHOPPING_SYSTEM_PROMPT", () => {
  it("is long enough to cache, with room over the 512-token minimum", () => {
    const tokens = estimateTextTokens(SHOPPING_SYSTEM_PROMPT);
    expect(tokens).toBeGreaterThanOrEqual(1000);
    expect(tokens).toBeLessThanOrEqual(2500);
  });

  it("is static text with no reserved words", () => {
    expect(SHOPPING_SYSTEM_PROMPT).not.toMatch(/\$\{|\r|\d{4}-\d{2}-\d{2}|undefined|null,/);
    expect(SHOPPING_SYSTEM_PROMPT).not.toMatch(/reasoning|thinking|thought/i);
    expect(SHOPPING_SYSTEM_PROMPT).toBe(SHOPPING_SYSTEM_PROMPT.trim());
  });

  it("keeps the counts deterministic and Claude to ranking and explaining (D-040)", () => {
    for (const phrase of [
      "take its numbers as given: never recount or invent them",
      "a top or a dress, plus a bottom unless it is a dress, plus shoes, with or without outerwear",
      "each piece suits the month on its own",
      "always unlock 0",
      "Judge them from the climate instead",
      "few or no outfits today is a real gap",
      "at least 1 and at most 10",
      "must not exceed it",
      "Use only the keys listed, each at most once",
      "why: at most 300 characters",
      "per item inside the listed price range",
    ]) {
      expect(SHOPPING_SYSTEM_PROMPT).toContain(phrase);
    }
  });
});

describe("buildShoppingAdviceInstruction", () => {
  const text = buildShoppingAdviceInstruction(input);

  it("gives the climate, budget, scenarios with today's counts, the candidates and the task, in that order", () => {
    expect(text).toContain("<climate>\nHamburg: 17.7 rain days in January, mean 2.1 °C.\n</climate>");
    expect(text).toContain("<budget>\n€400 left for all purchases together.\n</budget>");
    expect(text).toContain("jan: January, mean 2.1 °C, rainy (15 or more rain days); the wardrobe makes 0 outfits now");
    expect(text).toContain("apr: April, mean 9.1 °C, fewer than 15 rain days; the wardrobe makes 1 outfit now");
    expect(text).toContain('<candidates count="2">');
    expect(text.indexOf("</candidates>")).toBeLessThan(text.indexOf("Rank 1 to 2 of these candidates"));
    expect(text).toContain("together at most €400.");
  });

  it("writes one compact line per candidate", () => {
    expect(candidateLine(shell, HAMBURG_SCENARIOS)).toBe(
      "c1|outerwear|Waterproof breathable shell jacket|p1|x1|€120-200|gap|jan:12 apr:0 jul:3 oct:5|hood and taped seams; at least 10,000 mm water column",
    );
    expect(candidateLine(gloves, HAMBURG_SCENARIOS)).toBe("c2|gloves|Windproof gloves|p?|x2|up to €40|list|jan:0 apr:0 jul:0 oct:0|?");
    expect(candidateLine({ ...gloves, estPriceMinEur: 25, estPriceMaxEur: null }, [])).toContain("|from €25|list|?|?");
  });

  it("keeps free text from breaking the line format", () => {
    const line = candidateLine({ ...shell, itemType: "Shell | jacket\nwith hood", specs: ["a; b", " ", "c|d"] }, HAMBURG_SCENARIOS);
    expect(line.split("|")).toHaveLength(9);
    expect(line).toContain("|Shell jacket with hood|");
    expect(line.endsWith("|a b; c d")).toBe(true);
  });

  it("asks a single candidate to be ranked 1, and drops the budget cap without a budget", () => {
    const single = buildShoppingAdviceInstruction({ ...input, candidates: [gloves], remainingBudgetEur: null });
    expect(single).toContain("No purchase budget set.");
    expect(single).toContain("Rank this candidate as 1, using its key above.");
    expect(single).not.toContain("together at most");
  });
});

describe("SHOPPING_CALL_PARAMS", () => {
  it("uses the shopping purpose at effort low, with a cap that fits the deadline (D-164)", () => {
    expect(AI_PURPOSES).toContain(SHOPPING_CALL_PARAMS.purpose);
    expect(SHOPPING_CALL_PARAMS).toMatchObject({ effort: "low", maxTokens: 6000, maxTokensCeiling: 6000 });
    expect((SHOPPING_CALL_PARAMS.maxTokens / 110) * 1000 + 30_000).toBeLessThanOrEqual(SHOPPING_DEADLINE_MS);
  });
});

describe("estimateShoppingAdviceUsd", () => {
  it("prices the rendered instruction at a few cents on Sonnet", () => {
    const usd = estimateShoppingAdviceUsd("claude-sonnet-5-5", buildShoppingAdviceInstruction(input));
    expect(usd).toBeGreaterThan(0.01);
    expect(usd).toBeLessThan(0.06);
    const longer = buildShoppingAdviceInstruction({
      ...input,
      candidates: Array.from({ length: 30 }, (_, index) => ({ ...shell, key: `c${index + 1}` })),
    });
    expect(estimateShoppingAdviceUsd("claude-sonnet-5-5", longer)).toBeGreaterThan(usd);
    expect(estimateShoppingAdviceUsd("claude-haiku-5-5", longer)).toBeLessThan(usd);
  });
});
