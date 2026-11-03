// The pre-run cost estimate of a relocation analysis (D-026). Pure, but it
// prices through cost.ts and models.ts, which client code must not import
// (test/boundaries.test.ts): the form gets the numbers from estimateRelocation.
// The service counts the request text with the same helpers below, so the
// estimate and the run measure the same prompt.

import { computeCostUsd, estimateTextTokens } from "@/lib/ai/cost";
import type { PricedModelId } from "@/lib/ai/models";
import type { RelocationEffort, RelocationPriority } from "@/lib/relocation/contracts";
import type { SnapshotLine } from "@/lib/relocation/payload";
import {
  buildChunkInstruction,
  buildSynthesisInstruction,
  formatDecisionLine,
  RELOCATION_CALL_PARAMS,
  RELOCATION_SYSTEM_PROMPT,
} from "@/lib/relocation/prompts";

/**
 * The assumptions, to be replaced by measured values after the first live run.
 * Output per item is one JSON decision with a reason of up to 120 characters;
 * the synthesis writes the summary, 3 to 5 layering systems, up to 12 gaps,
 * the packing groups and warnings, plus every alias decided bring in a
 * packing group: before the run, every item counts as one that could be
 * (about 3 tokens per alias; 3,500 for 300 items, D-175). Thinking comes on top of the visible
 * output, scaled by effort. The structured-output format adds system text of
 * its own (not published; the tagging estimate uses the same 400 tokens).
 */
export const RELOCATION_ESTIMATE = {
  outputTokensPerItem: 55,
  outputTokensPerChunk: 300,
  synthesisOutputBaseTokens: 2_600,
  synthesisOutputTokensPerItem: 3,
  formatOverheadTokens: 400,
  thinkingMultiplier: { low: 0.3, medium: 1, high: 2 } satisfies Record<RelocationEffort, number>,
  lowFactor: 0.7,
  highFactor: 1.5,
} as const;

/** Visible output plus the thinking allowance of the effort. */
export function withThinkingAllowance(visibleTokens: number, effort: RelocationEffort): number {
  return Math.round(visibleTokens * (1 + RELOCATION_ESTIMATE.thinkingMultiplier[effort]));
}

/** Visible output of the synthesis for a run of `itemCount` items, each of which could be packed. */
export function synthesisOutputTokens(itemCount: number): number {
  return RELOCATION_ESTIMATE.synthesisOutputBaseTokens + RELOCATION_ESTIMATE.synthesisOutputTokensPerItem * itemCount;
}

/**
 * Whether the synthesis of `itemCount` items, thinking included, fits its
 * output cap, which is also what one part can write in time (D-164). A run
 * that does not fit would pay for every chunk and then fail its synthesis on
 * every Retry, so it is refused before it starts (D-175).
 */
export function synthesisFitsOutputCap(itemCount: number, effort: RelocationEffort): boolean {
  return withThinkingAllowance(synthesisOutputTokens(itemCount), effort) <= RELOCATION_CALL_PARAMS.synthesis.maxTokens;
}

/** Input tokens of one relocation request: system prompt, shared context, instruction and format overhead. */
export function relocationInputTokens(input: { sharedContext: string; instruction: string }): number {
  return (
    estimateTextTokens(RELOCATION_SYSTEM_PROMPT) +
    estimateTextTokens(input.sharedContext) +
    estimateTextTokens(input.instruction) +
    RELOCATION_ESTIMATE.formatOverheadTokens
  );
}

/** Input tokens of one chunk call. */
export function estimateChunkInputTokens(sharedContext: string, chunkLines: readonly Pick<SnapshotLine, "text">[]): number {
  return relocationInputTokens({ sharedContext, instruction: buildChunkInstruction(chunkLines) });
}

/**
 * Input tokens of the synthesis call. Before the run the decisions are not
 * known; a stand-in of the longest decision word is used per line.
 */
export function estimateSynthesisInputTokens(
  sharedContext: string,
  lines: readonly Pick<SnapshotLine, "alias" | "text">[],
  decisionLines?: readonly string[],
): number {
  const stand: { decision: "donate"; priority: RelocationPriority } = { decision: "donate", priority: 2 };
  const decisions = decisionLines ?? lines.map((line) => formatDecisionLine({ item: line.alias, ...stand }));
  return relocationInputTokens({ sharedContext, instruction: buildSynthesisInstruction({ lines, decisions }) });
}

export type RelocationCostEstimate = {
  usd: number;
  lowUsd: number;
  highUsd: number;
  inputTokens: number;
  /** Visible output plus the thinking allowance. */
  outputTokens: number;
};

/**
 * The run's cost: every chunk plus the synthesis, at standard rates with no
 * cache-read discount assumed (parallel chunks start before any cache entry
 * exists). Each call is priced on its own so a long-context tier applies per
 * request, as billed. Low is 0.7x and high 1.5x the point estimate; a repair
 * call or a retry falls inside the high end.
 */
export function estimateRelocationCost(input: {
  model: PricedModelId;
  effort: RelocationEffort;
  chunkInputTokens: readonly number[];
  synthesisInputTokens: number;
  itemCount: number;
}): RelocationCostEstimate {
  const { model, effort, chunkInputTokens, synthesisInputTokens, itemCount } = input;
  if (!Number.isInteger(itemCount) || itemCount < 0) throw new RangeError("itemCount must be a non-negative integer.");
  if (itemCount === 0 || chunkInputTokens.length === 0) {
    return { usd: 0, lowUsd: 0, highUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
  const withThinking = (visible: number) => withThinkingAllowance(visible, effort);

  const chunkCount = chunkInputTokens.length;
  const chunkOutput = withThinking(
    (RELOCATION_ESTIMATE.outputTokensPerItem * itemCount) / chunkCount + RELOCATION_ESTIMATE.outputTokensPerChunk,
  );
  const synthesisOutput = withThinking(synthesisOutputTokens(itemCount));

  const calls = [
    ...chunkInputTokens.map((tokens) => ({ input: tokens, output: chunkOutput })),
    { input: synthesisInputTokens, output: synthesisOutput },
  ];
  const usd = calls.reduce(
    (sum, call) => sum + computeCostUsd(model, { input_tokens: call.input, output_tokens: call.output }),
    0,
  );
  return {
    usd,
    lowUsd: usd * RELOCATION_ESTIMATE.lowFactor,
    highUsd: usd * RELOCATION_ESTIMATE.highFactor,
    inputTokens: calls.reduce((sum, call) => sum + call.input, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.output, 0),
  };
}
