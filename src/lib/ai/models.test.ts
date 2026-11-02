import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MODELS,
  MODELS,
  PRICED_MODEL_IDS,
  PRICING_PER_MTOK,
  PricedModelIdSchema,
  getPricing,
  isPricedModel,
  resolveModels,
  safeResolveModels,
} from "@/lib/ai/models";
import { AppError } from "@/lib/result";

describe("pricing table", () => {
  it("prices every default model", () => {
    for (const model of Object.values(DEFAULT_MODELS)) {
      expect(isPricedModel(model)).toBe(true);
      expect(getPricing(model).in).toBeGreaterThan(0);
    }
  });

  it("keeps the spec's base rates", () => {
    expect(PRICING_PER_MTOK["claude-haiku-5-5"]).toMatchObject({ in: 0.1, out: 0.5 });
    expect(PRICING_PER_MTOK["claude-sonnet-5-5"]).toMatchObject({ in: 2, out: 10 });
    expect(PRICING_PER_MTOK["claude-opus-5-5"]).toMatchObject({ in: 4, out: 20 });
  });

  it("has Haiku long-context tier fields", () => {
    expect(PRICING_PER_MTOK["claude-haiku-5-5"]).toMatchObject({
      inLong: 0.5,
      outLong: 2.5,
      longThreshold: 100_000,
    });
    expect(getPricing("claude-sonnet-5-5").longThreshold).toBeUndefined();
  });

  it("uses the documented cache and batch multipliers", () => {
    expect(getPricing("claude-haiku-5-5").cacheReadMultiplier).toBe(0.1);
    expect(getPricing("claude-sonnet-5-5").cacheReadMultiplier).toBe(0.1);
    expect(getPricing("claude-opus-5-5").cacheReadMultiplier).toBe(0.05);
    for (const model of PRICED_MODEL_IDS) {
      expect(getPricing(model)).toMatchObject({
        cacheWrite5mMultiplier: 1.25,
        cacheWrite1hMultiplier: 2,
        batchMultiplier: 0.5,
      });
    }
  });

  it("isPricedModel and the zod schema agree with the table", () => {
    expect(Object.keys(PRICING_PER_MTOK).sort()).toEqual([...PRICED_MODEL_IDS].sort());
    expect(isPricedModel("claude-haiku-5-5")).toBe(true);
    expect(isPricedModel("claude-haiku-4-5")).toBe(false);
    // Prototype keys must not count as priced models.
    expect(isPricedModel("toString")).toBe(false);
    expect(PricedModelIdSchema.safeParse("claude-opus-5-5").success).toBe(true);
    expect(PricedModelIdSchema.safeParse("claude-opus-5-5-20261101").success).toBe(false);
  });
});

describe("resolveModels", () => {
  it("returns the defaults with no overrides", () => {
    expect(resolveModels({})).toEqual(DEFAULT_MODELS);
  });

  it("applies priced overrides from the source", () => {
    expect(
      resolveModels({
        CLAUDE_TAGGING_MODEL: "claude-sonnet-5-5",
        CLAUDE_ANALYSIS_MODEL: "claude-opus-5-5",
        CLAUDE_OUTFIT_MODEL: "claude-haiku-5-5",
      }),
    ).toEqual({ tagging: "claude-sonnet-5-5", analysis: "claude-opus-5-5", outfits: "claude-haiku-5-5" });
  });

  it("treats empty overrides as unset", () => {
    expect(
      resolveModels({ CLAUDE_TAGGING_MODEL: "", CLAUDE_ANALYSIS_MODEL: "  ", CLAUDE_OUTFIT_MODEL: "" }),
    ).toEqual(DEFAULT_MODELS);
  });

  it("lets outfits inherit the analysis override", () => {
    expect(resolveModels({ CLAUDE_ANALYSIS_MODEL: "claude-opus-5-5" }).outfits).toBe("claude-opus-5-5");
  });

  it("rejects an unpriced override with a CONFIG error naming the variable only", () => {
    const value = "claude-sonnet-9-secret-ish";
    let caught: unknown;
    try {
      resolveModels({ CLAUDE_ANALYSIS_MODEL: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    const appError = caught as AppError;
    expect(appError.code).toBe("CONFIG");
    expect(appError.message).toContain("CLAUDE_ANALYSIS_MODEL");
    expect(appError.message).not.toContain(value);
    expect(appError.details).toEqual({ variables: ["CLAUDE_ANALYSIS_MODEL"] });
  });

  it("collects every invalid variable in the safe variant", () => {
    expect(safeResolveModels({ CLAUDE_TAGGING_MODEL: "x", CLAUDE_OUTFIT_MODEL: "y" })).toMatchObject({
      ok: false,
      variables: ["CLAUDE_TAGGING_MODEL", "CLAUDE_OUTFIT_MODEL"],
    });
  });
});

describe("MODELS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves lazily from process.env on each access", () => {
    vi.stubEnv("CLAUDE_TAGGING_MODEL", "");
    expect(MODELS.tagging).toBe("claude-haiku-5-5");

    vi.stubEnv("CLAUDE_TAGGING_MODEL", "claude-sonnet-5-5");
    expect(MODELS.tagging).toBe("claude-sonnet-5-5");

    vi.stubEnv("CLAUDE_ANALYSIS_MODEL", "claude-opus-5-5");
    vi.stubEnv("CLAUDE_OUTFIT_MODEL", "");
    expect(MODELS.analysis).toBe("claude-opus-5-5");
    expect(MODELS.outfits).toBe("claude-opus-5-5");
  });

  it("throws on access, not on import, when an override is unpriced", () => {
    vi.stubEnv("CLAUDE_OUTFIT_MODEL", "not-a-model");
    expect(() => MODELS.outfits).toThrow(AppError);
  });
});
