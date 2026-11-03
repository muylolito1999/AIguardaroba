import { describe, expect, it } from "vitest";

import { computeCostUsd, estimateTextTokens } from "@/lib/ai/cost";
import { HAMBURG } from "@/lib/climate/hamburg";
import { describeClimateForPrompt, monthsInRange } from "@/lib/climate/range";
import { planChunks } from "@/lib/relocation/chunks";
import type { RelocationEffort } from "@/lib/relocation/contracts";
import {
  estimateChunkInputTokens,
  estimateRelocationCost,
  estimateSynthesisInputTokens,
  RELOCATION_ESTIMATE,
  relocationInputTokens,
  synthesisFitsOutputCap,
  synthesisOutputTokens,
  withThinkingAllowance,
} from "@/lib/relocation/estimate";
import { buildSnapshot, type SnapshotLine } from "@/lib/relocation/payload";
import {
  buildChunkInstruction,
  buildSharedContext,
  RELOCATION_CALL_PARAMS,
  RELOCATION_SYSTEM_PROMPT,
} from "@/lib/relocation/prompts";
import { makeTypicalWardrobe } from "../../../test/relocation-fixtures";

const MONTHS = monthsInRange("2026-11-03", "2027-11-02");
const CONSTRAINTS =
  "I commute by bike. Office is business casual. 2 suitcases of 23 kg, and I can ship 2 boxes later. Budget for new purchases €600.";

/** The whole pre-run pipeline, as the service runs it, for `count` typical items. */
function estimateFor(count: number, effort: RelocationEffort = "medium") {
  const snapshot = buildSnapshot(makeTypicalWardrobe(count), { includeOnlyConfirmed: true, destination: "hamburg" });
  const shared = buildSharedContext({
    climateText: describeClimateForPrompt(HAMBURG, MONTHS),
    months: MONTHS,
    constraints: CONSTRAINTS,
    purchaseBudgetEur: 600,
    summaryText: snapshot.summaryText,
    legend: snapshot.legend,
  });
  const byAlias = new Map(snapshot.lines.map((line) => [line.alias, line]));
  const chunks = planChunks(snapshot.lines);
  const chunkInputTokens = chunks.map((chunk) =>
    estimateChunkInputTokens(
      shared,
      chunk.aliases.map((alias) => byAlias.get(alias)).filter((line): line is SnapshotLine => line !== undefined),
    ),
  );
  const estimate = estimateRelocationCost({
    model: "claude-sonnet-5-5",
    effort,
    chunkInputTokens,
    synthesisInputTokens: estimateSynthesisInputTokens(shared, snapshot.lines),
    itemCount: snapshot.lines.length,
  });
  return { estimate, chunks, snapshot };
}

describe("input token helpers", () => {
  const lines = [{ alias: "i1", text: "i1|top/shirt|white|cotton|w2|wp0 wd0 ins0 br1|summer|business|good|confirmed|Shirt" }];

  it("counts the system prompt, the shared context, the instruction and the format overhead", () => {
    const tokens = relocationInputTokens({ sharedContext: "context", instruction: "instruction" });
    expect(tokens).toBe(
      estimateTextTokens(RELOCATION_SYSTEM_PROMPT) +
        estimateTextTokens("context") +
        estimateTextTokens("instruction") +
        RELOCATION_ESTIMATE.formatOverheadTokens,
    );
    expect(estimateChunkInputTokens("context", lines)).toBe(
      relocationInputTokens({ sharedContext: "context", instruction: buildChunkInstruction(lines) }),
    );
  });

  it("stands in a decision per line for the synthesis before the run", () => {
    expect(estimateSynthesisInputTokens("context", lines)).toBe(
      estimateSynthesisInputTokens("context", lines, ["i1|donate|2"]),
    );
    expect(estimateSynthesisInputTokens("context", lines, [])).toBeLessThan(estimateSynthesisInputTokens("context", lines));
  });
});

describe("estimateRelocationCost", () => {
  const fixed = { model: "claude-sonnet-5-5" as const, chunkInputTokens: [8_000, 8_000], synthesisInputTokens: 20_000, itemCount: 140 };

  it("is zero for an empty wardrobe and rejects a bad item count", () => {
    expect(estimateRelocationCost({ ...fixed, effort: "medium", itemCount: 0 })).toEqual({
      usd: 0,
      lowUsd: 0,
      highUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(() => estimateRelocationCost({ ...fixed, effort: "medium", itemCount: -1 })).toThrow(RangeError);
  });

  it("adds the thinking allowance by effort: 0.3x low, 1x medium, 2x high", () => {
    // Visible: 2 chunks x (55 x 70 + 300) = 8,300, plus 2,600 + 3 x 140 for the synthesis.
    const chunkVisible = RELOCATION_ESTIMATE.outputTokensPerItem * 70 + RELOCATION_ESTIMATE.outputTokensPerChunk;
    const synthesisVisible = synthesisOutputTokens(140);
    expect(synthesisVisible).toBe(3_020);
    const expected = (factor: number) => 2 * Math.round(chunkVisible * factor) + Math.round(synthesisVisible * factor);
    const low = estimateRelocationCost({ ...fixed, effort: "low" });
    const medium = estimateRelocationCost({ ...fixed, effort: "medium" });
    const high = estimateRelocationCost({ ...fixed, effort: "high" });
    expect(low.outputTokens).toBe(expected(1.3));
    expect(medium.outputTokens).toBe(expected(2));
    expect(high.outputTokens).toBe(expected(3));
    expect(medium.inputTokens).toBe(36_000);
    expect(low.usd).toBeLessThan(medium.usd);
    expect(medium.usd).toBeLessThan(high.usd);
    // Standard Sonnet rates, $2 in and $10 out per MTok, no cache discount.
    expect(medium.usd).toBeCloseTo((36_000 * 2 + expected(2) * 10) / 1_000_000, 10);
  });

  it("gives the low and high ends as 0.7x and 1.5x", () => {
    const estimate = estimateRelocationCost({ ...fixed, effort: "medium" });
    expect(estimate.lowUsd).toBeCloseTo(estimate.usd * 0.7, 12);
    expect(estimate.highUsd).toBeCloseTo(estimate.usd * 1.5, 12);
  });

  it("prices each call on its own, so Haiku's long tier applies per request", () => {
    const estimate = estimateRelocationCost({
      model: "claude-haiku-5-5",
      effort: "low",
      chunkInputTokens: [60_000, 60_000],
      synthesisInputTokens: 150_000,
      itemCount: 140,
    });
    const chunkOutput = Math.round((55 * 70 + 300) * 1.3);
    const synthesisOutput = Math.round(synthesisOutputTokens(140) * 1.3);
    const expected =
      2 * computeCostUsd("claude-haiku-5-5", { input_tokens: 60_000, output_tokens: chunkOutput }) +
      computeCostUsd("claude-haiku-5-5", { input_tokens: 150_000, output_tokens: synthesisOutput });
    expect(estimate.usd).toBeCloseTo(expected, 12);
    // The two chunks stay at the standard rate; only the synthesis crosses 100K.
    expect(computeCostUsd("claude-haiku-5-5", { input_tokens: 60_000, output_tokens: chunkOutput })).toBeCloseTo(
      (60_000 * 0.1 + chunkOutput * 0.5) / 1_000_000,
      12,
    );
  });

  it("grows with the number of items", () => {
    const costs = [10, 50, 100, 200, 300, 450].map((count) => estimateFor(count).estimate.usd);
    for (let index = 1; index < costs.length; index += 1) {
      expect(costs[index]).toBeGreaterThan(costs[index - 1] ?? Infinity);
    }
  });

  it("puts 300 typical items with Sonnet 5.5 at medium effort at about $0.55 (range about $0.39 to $0.83)", () => {
    const { estimate, chunks, snapshot } = estimateFor(300);
    expect(snapshot.lines).toHaveLength(300);
    expect(chunks).toHaveLength(6);
    expect(estimate.usd).toBeGreaterThan(0.5);
    expect(estimate.usd).toBeLessThan(0.6);
    expect(estimate.lowUsd).toBeGreaterThan(0.35);
    expect(estimate.highUsd).toBeLessThan(0.9);
    // Output, mostly thinking plus a reason per item, is about 80 % of the cost.
    expect((estimate.outputTokens * 10) / 1_000_000 / estimate.usd).toBeGreaterThan(0.75);
  });

  it("prices the synthesis's output by the items it may have to pack, 3,500 visible tokens for 300 (D-175)", () => {
    expect(synthesisOutputTokens(300)).toBe(3_500);
    expect(synthesisOutputTokens(2_000)).toBe(8_600);
    expect(estimateFor(2_000).estimate.outputTokens).toBeGreaterThan(estimateFor(2_000, "low").estimate.outputTokens);
  });

  it("puts the same wardrobe at about $0.40 at low effort and $0.77 at high effort", () => {
    expect(estimateFor(300, "low").estimate.usd).toBeGreaterThan(0.35);
    expect(estimateFor(300, "low").estimate.usd).toBeLessThan(0.45);
    expect(estimateFor(300, "high").estimate.usd).toBeGreaterThan(0.7);
    expect(estimateFor(300, "high").estimate.usd).toBeLessThan(0.85);
  });
});

describe("synthesisFitsOutputCap (D-175)", () => {
  it("refuses a wardrobe whose packing list cannot fit the synthesis's output cap at that effort", () => {
    // 2,000 items at high effort: (2,600 + 3 x 2,000) x 3 = 25,800 tokens against a cap of 24,000.
    expect(withThinkingAllowance(synthesisOutputTokens(2_000), "high")).toBeGreaterThan(
      RELOCATION_CALL_PARAMS.synthesis.maxTokens,
    );
    expect(synthesisFitsOutputCap(2_000, "high")).toBe(false);
    expect(synthesisFitsOutputCap(1_800, "high")).toBe(true);
    expect(synthesisFitsOutputCap(1_801, "high")).toBe(false);
    // Medium and low leave room for the 2,000 items the wardrobe list allows.
    expect(synthesisFitsOutputCap(2_000, "medium")).toBe(true);
    expect(synthesisFitsOutputCap(2_000, "low")).toBe(true);
    expect(synthesisFitsOutputCap(300, "high")).toBe(true);
  });

  it("puts the limits D-175 states at 1,800 items at high, 3,133 at medium and 5,287 at low", () => {
    expect(synthesisFitsOutputCap(1_800, "high")).toBe(true);
    expect(synthesisFitsOutputCap(1_801, "high")).toBe(false);
    expect(synthesisFitsOutputCap(3_133, "medium")).toBe(true);
    expect(synthesisFitsOutputCap(3_134, "medium")).toBe(false);
    expect(synthesisFitsOutputCap(5_287, "low")).toBe(true);
    expect(synthesisFitsOutputCap(5_288, "low")).toBe(false);
  });

  it("never refuses for a chunk: 70 items fit the chunk cap at every effort", () => {
    const visible = RELOCATION_ESTIMATE.outputTokensPerItem * 70 + RELOCATION_ESTIMATE.outputTokensPerChunk;
    expect(withThinkingAllowance(visible, "high")).toBeLessThan(RELOCATION_CALL_PARAMS.chunk.maxTokens);
  });
});
