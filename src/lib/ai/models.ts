// Single source of truth for Claude model ids and prices.
// Pure module (no `server-only`) so tsx scripts and tests can load it, but it
// reads process.env, so client code must never import it (test/boundaries.test.ts).
import { z } from "zod";

import { AppError } from "@/lib/result";

export const PRICED_MODEL_IDS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
] as const;

export type PricedModelId = (typeof PRICED_MODEL_IDS)[number];

export type ModelPricing = {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
  /** Long-context rates; once a request crosses longThreshold every token in it pays these. */
  inLong?: number;
  outLong?: number;
  longThreshold?: number;
  /** Multipliers applied to the input rate. */
  cacheReadMultiplier: number;
  cacheWrite5mMultiplier: number;
  cacheWrite1hMultiplier: number;
  /** Message Batches discount, applied to every token class. */
  batchMultiplier: number;
};

const CACHE_AND_BATCH = {
  cacheWrite5mMultiplier: 1.25,
  cacheWrite1hMultiplier: 2,
  batchMultiplier: 0.5,
} as const;

export const PRICING_PER_MTOK = {
  // $0.10 in / $0.50 out per MTok up to 100K prompt tokens, $0.50 / $2.50 above.
  "claude-haiku-5-5": {
    in: 0.1,
    out: 0.5,
    inLong: 0.5,
    outLong: 2.5,
    longThreshold: 100_000,
    cacheReadMultiplier: 0.1,
    ...CACHE_AND_BATCH,
  },
  // Sonnet and Opus cache reads cost 0.05x, not the usual 0.1x.
  "claude-sonnet-5-5": { in: 2, out: 10, cacheReadMultiplier: 0.05, ...CACHE_AND_BATCH },
  "claude-opus-5-5": { in: 4, out: 20, cacheReadMultiplier: 0.05, ...CACHE_AND_BATCH },
} as const satisfies Record<PricedModelId, ModelPricing>;

export const PricedModelIdSchema = z.enum(PRICED_MODEL_IDS);

export function isPricedModel(id: string): id is PricedModelId {
  return Object.hasOwn(PRICING_PER_MTOK, id);
}

export function getPricing(model: PricedModelId): ModelPricing {
  return PRICING_PER_MTOK[model];
}

export type ModelPurpose = "tagging" | "analysis" | "outfits";
export type ResolvedModels = Record<ModelPurpose, PricedModelId>;

export const DEFAULT_MODELS = {
  tagging: "claude-haiku-5-5",
  analysis: "claude-sonnet-5-5",
  outfits: "claude-sonnet-5-5",
} as const satisfies ResolvedModels;

export const MODEL_ENV_VARS = {
  tagging: "CLAUDE_TAGGING_MODEL",
  analysis: "CLAUDE_ANALYSIS_MODEL",
  outfits: "CLAUDE_OUTFIT_MODEL",
} as const satisfies Record<ModelPurpose, string>;

type EnvSource = Record<string, string | undefined>;

export type ModelResolution =
  | { ok: true; models: ResolvedModels }
  | { ok: false; variables: string[]; problems: string[] };

// Blank values come from copied .env.example lines and mean "use the default".
function readOverride(source: EnvSource, name: string): string | undefined {
  const raw = source[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

const ALLOWED_LIST = PRICED_MODEL_IDS.join(", ");

/** Non-throwing variant used by env reporting; problems name variables, never values. */
export function safeResolveModels(source: EnvSource = process.env): ModelResolution {
  const variables: string[] = [];

  const pick = (purpose: ModelPurpose, fallback: PricedModelId): PricedModelId => {
    const name = MODEL_ENV_VARS[purpose];
    const value = readOverride(source, name);
    if (value === undefined) return fallback;
    if (isPricedModel(value)) return value;
    variables.push(name);
    return fallback;
  };

  const tagging = pick("tagging", DEFAULT_MODELS.tagging);
  const analysis = pick("analysis", DEFAULT_MODELS.analysis);
  // Outfit suggestions follow the analysis model unless explicitly overridden.
  const outfits = pick("outfits", analysis);

  if (variables.length > 0) {
    return {
      ok: false,
      variables,
      problems: variables.map((name) => `${name} must be one of the priced models (${ALLOWED_LIST})`),
    };
  }
  return { ok: true, models: { tagging, analysis, outfits } };
}

/**
 * Resolves the model per purpose from CLAUDE_*_MODEL overrides. An unpriced id
 * would break cost accounting, so it fails with CONFIG before any API call.
 */
export function resolveModels(source: EnvSource = process.env): ResolvedModels {
  const result = safeResolveModels(source);
  if (!result.ok) {
    throw new AppError("CONFIG", `Invalid model configuration: ${result.problems.join("; ")}.`, {
      variables: result.variables,
    });
  }
  return result.models;
}

/** Read lazily so importing this module never validates env; each access re-resolves. */
export const MODELS: Readonly<ResolvedModels> = {
  get tagging() {
    return resolveModels().tagging;
  },
  get analysis() {
    return resolveModels().analysis;
  },
  get outfits() {
    return resolveModels().outfits;
  },
};
