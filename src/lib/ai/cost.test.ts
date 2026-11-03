import { describe, expect, it } from "vitest";

import {
  computeCostBreakdown,
  computeCostUsd,
  estimateImageTokens,
  estimateTaggingCostUsd,
  estimateTextTokens,
  fitImageToLimits,
  formatUsd,
  IMAGE_LIMITS,
  TAGGING_ESTIMATE,
  taggingCostRates,
} from "@/lib/ai/cost";
import { TAGGING_SYSTEM_PROMPT, TAGGING_USER_INSTRUCTION } from "@/lib/ai/tagging/prompt";

const M = 1_000_000;

describe("estimateImageTokens", () => {
  it.each([
    [1000, 1000, 1296],
    [768, 1024, 1036],
    [1024, 768, 1036],
    [1024, 1024, 1369],
    [28, 28, 1],
    [29, 1, 2],
  ])("%i x %i gives %i tokens", (w, h, tokens) => {
    expect(estimateImageTokens(w, h)).toBe(tokens);
  });

  it("caps a 3840 x 2160 photo at 4784 tokens (2576 x 1449)", () => {
    expect(fitImageToLimits(3840, 2160)).toEqual({ width: 2576, height: 1449 });
    expect(estimateImageTokens(3840, 2160)).toBe(4784);
  });

  it("shrinks a square that fits the edge limit but not the token limit", () => {
    const fitted = fitImageToLimits(2576, 2576);
    expect(fitted.width).toBe(fitted.height);
    expect(estimateImageTokens(2576, 2576)).toBeLessThanOrEqual(IMAGE_LIMITS.maxTokens);
    // The largest square that fits: 69 x 69 patches.
    expect(estimateImageTokens(2576, 2576)).toBe(69 * 69);
  });

  it("never exceeds either limit for phone-sized photos", () => {
    for (const [w, h] of [
      [4032, 3024],
      [3024, 4032],
      [6000, 4000],
      [8000, 8000],
      [20000, 100],
    ] as const) {
      const fitted = fitImageToLimits(w, h);
      expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(IMAGE_LIMITS.maxLongEdgePx);
      expect(estimateImageTokens(w, h)).toBeLessThanOrEqual(IMAGE_LIMITS.maxTokens);
    }
  });

  it("does not upscale small images", () => {
    expect(fitImageToLimits(300, 400)).toEqual({ width: 300, height: 400 });
  });

  it.each([
    [0, 10],
    [-1, 10],
    [Number.NaN, 10],
    [10, Number.POSITIVE_INFINITY],
  ])("rejects %s x %s", (w, h) => {
    expect(() => estimateImageTokens(w, h)).toThrow(RangeError);
  });
});

describe("estimateTextTokens", () => {
  it("is ceil(chars / 3.5 x 1.3)", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("a")).toBe(1);
    expect(estimateTextTokens("abcdefg")).toBe(3); // 2.6
    expect(estimateTextTokens("x".repeat(3500))).toBe(1300);
  });

  it("does not round exact multiples up through float noise", () => {
    // 35 / 3.5 * 1.3 is exactly 13; naive float math can land just above it.
    expect(estimateTextTokens("x".repeat(35))).toBe(13);
    for (let n = 0; n <= 2000; n += 35) expect(estimateTextTokens("x".repeat(n))).toBe((n / 35) * 13);
  });
});

describe("computeCostUsd", () => {
  it("prices Haiku input and output at the standard rates up to 100K prompt tokens", () => {
    const cost = computeCostBreakdown("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 1_000 });
    expect(cost.tier).toBe("standard");
    expect(cost.costUsd).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / M, 12);
  });

  it("switches the whole Haiku request to long rates above 100K, output included", () => {
    const cost = computeCostBreakdown("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 1_000 });
    expect(cost.tier).toBe("long");
    expect(cost.costUsd).toBeCloseTo((100_001 * 0.5 + 1_000 * 2.5) / M, 12);
  });

  it("counts cache reads and writes toward the long threshold and prices them at long rates", () => {
    const read = computeCostBreakdown("claude-haiku-5-5", {
      input_tokens: 50_000,
      cache_read_input_tokens: 50_001,
      output_tokens: 1_000,
    });
    expect(read.promptTokens).toBe(100_001);
    expect(read.tier).toBe("long");
    expect(read.costUsd).toBeCloseTo((50_000 * 0.5 + 50_001 * 0.5 * 0.1 + 1_000 * 2.5) / M, 12);

    const write = computeCostBreakdown("claude-haiku-5-5", {
      input_tokens: 1,
      cache_creation_input_tokens: 100_000,
      output_tokens: 0,
    });
    expect(write.tier).toBe("long");
    expect(write.costUsd).toBeCloseTo((1 * 0.5 + 100_000 * 0.5 * 1.25) / M, 12);
  });

  it("keeps Sonnet and Opus flat at any prompt size", () => {
    expect(computeCostBreakdown("claude-sonnet-5-5", { input_tokens: 200_000, output_tokens: 0 }).tier).toBe(
      "standard",
    );
    expect(computeCostUsd("claude-sonnet-5-5", { input_tokens: 200_000, output_tokens: 0 })).toBeCloseTo(0.4, 12);
    expect(computeCostUsd("claude-opus-5-5", { input_tokens: M, output_tokens: M })).toBeCloseTo(24, 12);
  });

  it("prices cache reads at 0.1x on Haiku and 0.05x on Sonnet and Opus", () => {
    // Sonnet 5.5 reads at $0.10 per MTok and Opus 5.5 at $0.20 (D-021).
    expect(computeCostUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M })).toBeCloseTo(
      0.1,
      12,
    );
    expect(computeCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M })).toBeCloseTo(
      0.2,
      12,
    );
    expect(computeCostUsd("claude-haiku-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 50_000 })).toBeCloseTo(
      (50_000 * 0.1 * 0.1) / M,
      12,
    );
  });

  it("prices 5-minute writes at 1.25x and 1-hour writes at 2x", () => {
    const base = { input_tokens: 0, output_tokens: 0 };
    // No breakdown: all writes count as 5-minute writes.
    expect(computeCostUsd("claude-sonnet-5-5", { ...base, cache_creation_input_tokens: M })).toBeCloseTo(2.5, 12);
    expect(
      computeCostUsd("claude-sonnet-5-5", {
        ...base,
        cache_creation_input_tokens: M,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: M },
      }),
    ).toBeCloseTo(4, 12);
    expect(
      computeCostUsd("claude-sonnet-5-5", {
        ...base,
        cache_creation_input_tokens: M,
        cache_creation: { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 600_000 },
      }),
    ).toBeCloseTo(0.4 * 2.5 + 0.6 * 4, 12);
  });

  it("prices writes the breakdown leaves out as 5-minute writes, never as free", () => {
    const cost = computeCostBreakdown("claude-sonnet-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: M,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500_000 },
    });
    expect(cost.cacheWrite5mTokens).toBe(500_000);
    expect(cost.cacheWrite1hTokens).toBe(500_000);
    expect(cost.costUsd).toBeCloseTo(0.5 * 2.5 + 0.5 * 4, 12);
  });

  it("halves every token class for batches, stacking with cache multipliers", () => {
    expect(computeCostUsd("claude-sonnet-5-5", { input_tokens: M, output_tokens: M }, { batch: true })).toBeCloseTo(6, 12);
    expect(
      computeCostUsd(
        "claude-sonnet-5-5",
        { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M },
        { batch: true },
      ),
    ).toBeCloseTo(0.05, 12);
  });

  it("bills thinking as part of output_tokens without counting it twice", () => {
    const cost = computeCostBreakdown("claude-haiku-5-5", {
      input_tokens: 0,
      output_tokens: 1_000,
      output_tokens_details: { thinking_tokens: 600 },
    });
    expect(cost.thinkingTokens).toBe(600);
    expect(cost.costUsd).toBeCloseTo((1_000 * 0.5) / M, 12);
  });

  it("treats null cache fields as zero", () => {
    expect(
      computeCostUsd("claude-haiku-5-5", {
        input_tokens: 1_000,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        cache_creation: null,
      }),
    ).toBeCloseTo((1_000 * 0.1) / M, 12);
  });
});

describe("tagging estimate", () => {
  it("matches the spec's figure of about $0.055 per 100 items at 2K in and 0.7K out", () => {
    const spec = 100 * computeCostUsd("claude-haiku-5-5", { input_tokens: 2_000, output_tokens: 700 });
    expect(spec).toBeCloseTo(0.055, 6);
    const estimate = estimateTaggingCostUsd({ count: 100, model: "claude-haiku-5-5" });
    expect(Math.abs(estimate - 0.055)).toBeLessThanOrEqual(0.01);
  });

  it("writes the cache on the first item and reads it afterwards", () => {
    const system = estimateTextTokens(TAGGING_SYSTEM_PROMPT);
    const uncached =
      estimateImageTokens(TAGGING_ESTIMATE.imageWidth, TAGGING_ESTIMATE.imageHeight) +
      estimateTextTokens(TAGGING_USER_INSTRUCTION) +
      TAGGING_ESTIMATE.formatOverheadTokens;
    const output = TAGGING_ESTIMATE.outputTokens * 0.5;
    const { firstItemUsd, nextItemUsd } = taggingCostRates("claude-haiku-5-5");

    expect(firstItemUsd).toBeCloseTo((uncached * 0.1 + system * 0.1 * 1.25 + output) / M, 12);
    expect(nextItemUsd).toBeCloseTo((uncached * 0.1 + system * 0.1 * 0.1 + output) / M, 12);
    expect(estimateTaggingCostUsd({ count: 1, model: "claude-haiku-5-5" })).toBeCloseTo(firstItemUsd, 12);
    expect(estimateTaggingCostUsd({ count: 3, model: "claude-haiku-5-5" })).toBeCloseTo(
      firstItemUsd + 2 * nextItemUsd,
      12,
    );
  });

  it("halves batch costs and writes the batch cache with the 1-hour TTL", () => {
    const system = estimateTextTokens(TAGGING_SYSTEM_PROMPT);
    const sync = taggingCostRates("claude-haiku-5-5");
    const batch = taggingCostRates("claude-haiku-5-5", { batch: true });
    expect(batch.nextItemUsd).toBeCloseTo(sync.nextItemUsd / 2, 12);
    // A 1-hour write costs 2x instead of 1.25x.
    expect(batch.firstItemUsd * 2 - sync.firstItemUsd).toBeCloseTo((system * 0.1 * (2 - 1.25)) / M, 12);
    const hundred = estimateTaggingCostUsd({ count: 100, model: "claude-haiku-5-5", batch: true });
    expect(Math.abs(hundred - 0.0275)).toBeLessThanOrEqual(0.005);
  });

  it("is zero for no items and rejects invalid counts", () => {
    expect(estimateTaggingCostUsd({ count: 0, model: "claude-haiku-5-5" })).toBe(0);
    expect(() => estimateTaggingCostUsd({ count: -1, model: "claude-haiku-5-5" })).toThrow(RangeError);
    expect(() => estimateTaggingCostUsd({ count: 1.5, model: "claude-haiku-5-5" })).toThrow(RangeError);
  });
});

describe("formatUsd", () => {
  it.each([
    [12.345, "$12.35"],
    [1, "$1.00"],
    [0.5, "$0.50"],
    [0.05505, "$0.0551"],
    [0.0006, "$0.0006"],
    [0, "$0.00"],
    [0.00004, "<$0.0001"],
    [Number.NaN, "n/a"],
  ])("formats %s as %s", (amount, expected) => {
    expect(formatUsd(amount)).toBe(expected);
  });
});
