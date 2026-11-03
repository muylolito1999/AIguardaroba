import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { estimateTextTokens } from "@/lib/ai/cost";
import { toJsonSchemaFormat } from "@/lib/ai/json-schema";
import { HAMBURG } from "@/lib/climate/hamburg";
import { describeClimateForPrompt } from "@/lib/climate/range";
import { AI_PURPOSES, ITEM_CATEGORIES, type ItemCategory } from "@/lib/db/enums";
import { RELOCATION_DECISIONS } from "@/lib/relocation/contracts";
import {
  buildSnapshot,
  canonicalJson,
  SNAPSHOT_LEGEND,
  summaryToText,
  type WardrobeSummary,
} from "@/lib/relocation/payload";
import {
  buildChunkInstruction,
  buildRepairInstruction,
  buildSharedContext,
  buildSynthesisInstruction,
  describeStayMonths,
  formatDecisionLine,
  RELOC_PROMPT_VERSION,
  RELOCATION_CALL_PARAMS,
  RELOCATION_MIN_OUTPUT_TOKENS_PER_SECOND,
  RELOCATION_PART_DEADLINE_MS,
  RELOCATION_SYSTEM_PROMPT,
  type SharedContextInput,
} from "@/lib/relocation/prompts";
import { ChunkWireSchema, SynthesisWireSchema } from "@/lib/relocation/schemas";
import { makeSnapshotItem } from "../../../test/relocation-fixtures";

// Everything a request carries besides the run's own data, pinned per
// version: the system prompt, and one hash over the other templates rendered
// on fixed input (the shared context with the line legend and the summary
// format, the chunk, repair and synthesis instructions, and the wire schemas
// sent as output_config, and the decision-line format the synthesis reads).
// The cache key covers them only through RELOC_PROMPT_VERSION, so an edit to
// any of them must bump the version and record the new hashes here; a stored
// result is then never reused for a different prompt (D-140, D-160, D-171).
const PINNED = {
  "reloc-v3": {
    system: "f36db30a66911682c1f183fd429ead1f67d0fc59d75424d63dd921d83250246d",
    templates: "5e928f0abebe27fd1977461fb5a2f4f3c2b6032ceeb78936c6eecebf1520a955",
  },
  // The chunk instruction's leave line names the now: markers (D-179); the system prompt is unchanged.
  "reloc-v4": {
    system: "f36db30a66911682c1f183fd429ead1f67d0fc59d75424d63dd921d83250246d",
    templates: "304765dfe43e620d51e172918684c5c0d197f96332cc79061a61b9df13d810d3",
  },
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Literal input, so only a template edit changes the rendering: no fixture
// defaults, random ids or climate data (the climate text is in the cache key).
const PIN_LINES = [
  { text: "i1|outerwear/parka|navy,black|down;polyester|w5|wp1 wd1 ins1 br?|winter|casual|good|confirmed|Navy down parka" },
  {
    text: "i2|top/sweater|grey|merino wool|w3|wp0 wd0 ins0 br1|autumn,winter|smart_casual|worn|tagged|Grey merino sweater|lc:mat,w|now:there",
  },
];

const PIN_SUMMARY: WardrobeSummary = {
  itemCount: 2,
  byCategory: {
    ...(Object.fromEntries(ITEM_CATEGORIES.map((category) => [category, 0])) as Record<ItemCategory, number>),
    outerwear: 1,
    top: 1,
  },
  warmth: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 },
  waterproof: 1,
  windproof: 1,
  insulated: 1,
  unconfirmed: 1,
  alreadyMoved: 1,
};

function renderTemplates(): string {
  return canonicalJson([
    buildSharedContext({
      climateText: "CLIMATE TABLE",
      months: [11, 12, 1],
      constraints: "Bike commute.",
      purchaseBudgetEur: 600,
      summaryText: summaryToText(PIN_SUMMARY),
      legend: SNAPSHOT_LEGEND,
    }),
    buildSharedContext({
      climateText: "CLIMATE TABLE",
      months: [7],
      constraints: "",
      purchaseBudgetEur: null,
      summaryText: summaryToText(PIN_SUMMARY),
      legend: SNAPSHOT_LEGEND,
    }),
    buildChunkInstruction(PIN_LINES),
    buildChunkInstruction(PIN_LINES.slice(0, 1)),
    buildRepairInstruction(PIN_LINES),
    buildRepairInstruction(PIN_LINES.slice(0, 1)),
    // Through the service's own formatter, so a change to the decision lines changes the hash.
    buildSynthesisInstruction({
      lines: PIN_LINES,
      decisions: [
        formatDecisionLine({ item: "i1", decision: "bring", priority: 1 }),
        formatDecisionLine({ item: "i2", decision: "leave", priority: 3 }),
      ],
    }),
    toJsonSchemaFormat(ChunkWireSchema),
    toJsonSchemaFormat(SynthesisWireSchema),
  ]);
}

const snapshot = buildSnapshot(
  [
    makeSnapshotItem({ name: "Navy wool coat" }),
    makeSnapshotItem({ name: "Grey merino sweater", category: "top", subcategory: "sweater" }),
    makeSnapshotItem({ name: "Brown chelsea boots", category: "shoes", subcategory: "chelsea boots" }),
  ],
  { includeOnlyConfirmed: true, destination: "hamburg" },
);

const context: SharedContextInput = {
  climateText: describeClimateForPrompt(HAMBURG, [11, 12, 1]),
  months: [11, 12, 1],
  constraints: "I commute by bike.\n\nOffice is business casual.",
  purchaseBudgetEur: 1200,
  summaryText: snapshot.summaryText,
  legend: snapshot.legend,
};

describe("RELOC_PROMPT_VERSION", () => {
  it("pins the system prompt for its version", () => {
    expect(RELOC_PROMPT_VERSION).toBe("reloc-v4");
    expect(sha256(RELOCATION_SYSTEM_PROMPT)).toBe(PINNED[RELOC_PROMPT_VERSION].system);
  });

  it("pins the instructions, the shared-context template, the legend and the wire schemas for its version", () => {
    expect(sha256(renderTemplates())).toBe(PINNED[RELOC_PROMPT_VERSION].templates);
  });
});

describe("RELOCATION_SYSTEM_PROMPT", () => {
  it("is long enough to be worth caching, with room over the 512-token minimum", () => {
    const tokens = estimateTextTokens(RELOCATION_SYSTEM_PROMPT);
    expect(tokens).toBeGreaterThanOrEqual(1500);
    expect(tokens).toBeLessThanOrEqual(3000);
  });

  it("is static text: no dates, ids, template leftovers or CR characters", () => {
    expect(RELOCATION_SYSTEM_PROMPT).not.toMatch(/\$\{|\r|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}-|undefined|null,/);
    expect(RELOCATION_SYSTEM_PROMPT).toBe(RELOCATION_SYSTEM_PROMPT.trim());
  });

  it("asks for reasoning from the climate numbers the spec names", () => {
    for (const phrase of [
      "Reason from the numbers",
      "the first is the arrival month",
      "15 or more rain days",
      "breathable waterproof shell with a hood and waterproof footwear",
      "62 km/h",
      "30 km/h wind near freezing",
      "above about 80 %",
      "under about 8 hours of daylight",
      "visibility",
      "frost days and snow cover",
      "PLACEHOLDER",
    ]) {
      expect(RELOCATION_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it("defines every decision and priority, and the frugal, layering and constraint rules", () => {
    for (const decision of RELOCATION_DECISIONS) expect(RELOCATION_SYSTEM_PROMPT).toContain(`- ${decision}:`);
    for (const phrase of [
      "1 = needed in the first weeks",
      "3 = borderline",
      "Prefer layering over single heavy items",
      "Be frugal. Never recommend buying what the wardrobe already effectively covers",
      "justify it from the climate numbers",
      "suitcases",
      "purchase budget",
      "dress code",
    ]) {
      expect(RELOCATION_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it("states the line rules: aliases only, lc:, tagged, now: markers and terse reasons", () => {
    for (const phrase of [
      "Use only the aliases given. Never invent items, aliases or attributes.",
      "lc: lists tags",
      "Tag status tagged",
      "now:there or now:in_transit",
      "never put it in a packing checklist",
      "at most 120 characters",
    ]) {
      expect(RELOCATION_SYSTEM_PROMPT).toContain(phrase);
    }
  });
});

describe("buildSharedContext", () => {
  it("holds the climate, the stay, the constraints, the budget, the summary and the legend", () => {
    const text = buildSharedContext(context);
    expect(text).toContain(context.climateText);
    expect(text).toContain('<stay months="3">\nNov (arrival), Dec, Jan\n</stay>');
    expect(text).toContain("<owner_constraints>\nI commute by bike. Office is business casual.\n</owner_constraints>");
    expect(text).toContain("€1,200 in total for all new purchases.");
    expect(text).toContain(snapshot.summaryText);
    expect(text).toContain(snapshot.legend);
  });

  it("is identical for whitespace-only differences in the constraints, as the cache key is", () => {
    expect(buildSharedContext({ ...context, constraints: "  I commute by bike. Office   is business casual. " })).toBe(
      buildSharedContext(context),
    );
  });

  it("says when there are no constraints or budget", () => {
    const text = buildSharedContext({ ...context, constraints: "  ", purchaseBudgetEur: null });
    expect(text).toContain("<owner_constraints>\nNone given.\n</owner_constraints>");
    expect(text).toContain("No purchase budget given.");
  });

  it("rejects a month outside 1 to 12", () => {
    expect(describeStayMonths([7])).toBe("Jul (arrival)");
    expect(() => buildSharedContext({ ...context, months: [0] })).toThrow(RangeError);
  });
});

describe("instructions", () => {
  it("asks a chunk for exactly one decision per listed alias", () => {
    const text = buildChunkInstruction(snapshot.lines);
    for (const line of snapshot.lines) expect(text).toContain(line.text);
    expect(text).toContain('<items count="3">');
    expect(text).toContain("Return exactly 3 decisions: one per alias listed in <items>, each alias once");
    // The items come first and the task last, as recommended for long inputs.
    expect(text.indexOf("<items")).toBeLessThan(text.indexOf("Decide each"));
  });

  it("asks a repair call for the missing items only", () => {
    const missing = snapshot.lines.slice(1, 2);
    const text = buildRepairInstruction(missing);
    expect(text).toContain(missing[0]?.text);
    expect(text).not.toContain(snapshot.lines[0]?.text);
    expect(text).toContain("This item still has no decision. Decide it:");
    expect(text).toContain("Return exactly 1 decision: one per alias");
    expect(text).toContain("no other aliases");
    expect(buildRepairInstruction(snapshot.lines.slice(0, 2))).toContain("These 2 items still have no decision");
  });

  it("gives the synthesis every line, the decisions and the spec's tasks", () => {
    const decisions = snapshot.lines.map((line, index) =>
      formatDecisionLine({ item: line.alias, decision: index === 0 ? "bring" : "leave", priority: 1 }),
    );
    expect(decisions[0]).toBe("i1|bring|1");
    const text = buildSynthesisInstruction({ lines: snapshot.lines, decisions });
    for (const line of snapshot.lines) expect(text).toContain(line.text);
    expect(text).toContain("<decisions>\nalias|decision|priority, one line per item:\ni1|bring|1\ni2|leave|1\ni3|leave|1\n</decisions>");
    for (const phrase of [
      "summary: at most 1,200 characters",
      "3 to 5 layered outfits",
      "about 3 °C with drizzle and 30 km/h wind",
      "about 12 °C and showery, as in April",
      "about 21 °C in July with a risk of rain",
      "gap_note: what is missing for this condition in at most 300 characters",
      "at most 12 purchases",
      "citing the climate numbers",
      "at least 10,000 mm",
      "merino base layer 150-250 g/m²",
      "whole euros",
      "before_move",
      "after_move",
      "times their quantities",
      "suitcase, carry_on, wear_on_travel_day, ship_later",
      "Wear the bulkiest warm items on the travel day",
      "extras: up to 10 short, useful things",
      "each at most 120 characters",
      "items marked now:there or now:in_transit are never packed",
      "uncertain_tags",
      "duplicate",
      "poor_condition",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("never asks for keys the API reserves", () => {
    for (const text of [
      RELOCATION_SYSTEM_PROMPT,
      buildChunkInstruction(snapshot.lines),
      buildSynthesisInstruction({ lines: snapshot.lines, decisions: [] }),
    ]) {
      expect(text).not.toMatch(/reasoning|thinking|thought/i);
    }
  });
});

describe("RELOCATION_CALL_PARAMS", () => {
  it("uses the relocation purposes and leaves room for thinking", () => {
    for (const params of Object.values(RELOCATION_CALL_PARAMS)) expect(AI_PURPOSES).toContain(params.purpose);
    expect(RELOCATION_CALL_PARAMS.chunk.maxTokens).toBeGreaterThanOrEqual(16_000);
    expect(RELOCATION_CALL_PARAMS.synthesis.maxTokens).toBeGreaterThanOrEqual(24_000);
  });

  it("caps every call at what a part can write before its deadline, with no doubled retry (D-164)", () => {
    // Time to the first token and the synthesis's prefill of up to about 100K input tokens.
    const marginMs = 30_000;
    for (const params of Object.values(RELOCATION_CALL_PARAMS)) {
      expect(params.maxTokensCeiling).toBe(params.maxTokens);
      expect((params.maxTokens / RELOCATION_MIN_OUTPUT_TOKENS_PER_SECOND) * 1000 + marginMs).toBeLessThanOrEqual(
        RELOCATION_PART_DEADLINE_MS,
      );
    }
  });
});

describe("decision definitions (D-171)", () => {
  const line = (prefix: string) =>
    RELOCATION_SYSTEM_PROMPT.split("\n").find((candidate) => candidate.startsWith(prefix)) ?? "";

  it("defines the decisions by where an item ends up: shipped items are bring, leave is not moved", () => {
    expect(RELOCATION_SYSTEM_PROMPT).toContain("Decide by where the item ends up, not by how it travels.");
    expect(line("- bring:")).toMatch(/shipped later/);
    expect(line("- leave:")).toContain("not moved in this relocation");
    expect(line("- leave:")).not.toMatch(/follows later|luggage cannot take/);
    expect(RELOCATION_SYSTEM_PROMPT).toContain("Items to ship later are bring, usually priority 2 or 3.");
    expect(RELOCATION_SYSTEM_PROMPT).not.toContain("leave or ship");
    expect(buildChunkInstruction(PIN_LINES)).toContain("bring includes items to ship later; leave means the item is not moved");
    // The synthesis packs only bring items, ship_later included, so the two definitions agree.
    const synthesis = buildSynthesisInstruction({ lines: PIN_LINES, decisions: [] });
    expect(synthesis).toContain("item_aliases: items decided bring, each in exactly one group");
    expect(synthesis).toContain("ship_later: items decided bring that are not needed in the first weeks");
  });

  it("gives leave the system prompt's meaning for items already there or on their way (D-179)", () => {
    // Both definitions travel in one request, beside items with these markers.
    expect(line("- leave:")).toContain("For an item already at the destination or on its way, leave means it is not needed there.");
    const leave = buildChunkInstruction(PIN_LINES)
      .split("\n")
      .filter((candidate) => /\bleave means\b/.test(candidate));
    expect(leave).toHaveLength(1);
    expect(leave[0]).toContain("now:there");
    expect(leave[0]).toContain("now:in_transit");
    expect(leave[0]).toContain("not needed there");
  });

  it("keeps enough of the items worn in rotation instead of one or two of a kind", () => {
    expect(RELOCATION_SYSTEM_PROMPT).toContain("worn in rotation");
    expect(RELOCATION_SYSTEM_PROMPT).toContain("about a week between washes");
    expect(RELOCATION_SYSTEM_PROMPT).not.toContain("one or two");
    expect(buildChunkInstruction(PIN_LINES)).toContain("about a week's worth of items worn in rotation");
    expect(buildSynthesisInstruction({ lines: PIN_LINES, decisions: [] })).toContain(
      "none that items decided bring already cover in the quantity needed",
    );
  });
});
