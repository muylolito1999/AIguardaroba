// Token and cost math (spec section 4, D-021). Pure: no I/O, no env.
// It imports the pricing table from models.ts, which client code must not
// import (test/boundaries.test.ts follows that import), so client components
// get estimates from the server as numbers (see taggingCostRates).

import { getPricing, type PricedModelId } from "@/lib/ai/models";
import { TAGGING_SYSTEM_PROMPT, TAGGING_USER_INSTRUCTION } from "@/lib/ai/tagging/prompt";

// ---------------------------------------------------------------------------
// Token estimates
// ---------------------------------------------------------------------------

/** Images are cut into 28 x 28 px patches; each patch is one token. */
const IMAGE_PATCH_PX = 28;

/**
 * High-resolution tier of the Claude 4.7+ models (every priced model is a 5.5
 * model): larger images are scaled down, keeping the aspect ratio, until both
 * limits hold.
 */
export const IMAGE_LIMITS = { maxLongEdgePx: 2576, maxTokens: 4784 } as const;

function patchTokens(width: number, height: number): number {
  return Math.ceil(width / IMAGE_PATCH_PX) * Math.ceil(height / IMAGE_PATCH_PX);
}

/** The image size Claude actually sees after its automatic downscale. */
export function fitImageToLimits(width: number, height: number): { width: number; height: number } {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new RangeError("Image dimensions must be positive finite numbers.");
  }
  const longEdge = Math.max(width, height);
  const scale = Math.min(1, IMAGE_LIMITS.maxLongEdgePx / longEdge);
  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));
  if (patchTokens(w, h) <= IMAGE_LIMITS.maxTokens) return { width: w, height: h };

  // Start from the area-based guess, then shrink until the patch count fits.
  // Each step removes at least one pixel from the long edge, so it ends quickly.
  const ratio = width / height;
  const shrink = Math.sqrt((IMAGE_LIMITS.maxTokens * IMAGE_PATCH_PX * IMAGE_PATCH_PX) / (w * h));
  w = Math.max(1, Math.floor(w * shrink));
  h = Math.max(1, Math.floor(h * shrink));
  while (patchTokens(w, h) > IMAGE_LIMITS.maxTokens) {
    if (w >= h) {
      w -= 1;
      h = Math.max(1, Math.floor(w / ratio));
    } else {
      h -= 1;
      w = Math.max(1, Math.floor(h * ratio));
    }
  }
  return { width: w, height: h };
}

/** Visual tokens for an image: ceil(w/28) x ceil(h/28) after the model's downscale. */
export function estimateImageTokens(width: number, height: number): number {
  const fitted = fitImageToLimits(width, height);
  return patchTokens(fitted.width, fitted.height);
}

/**
 * Text tokens: chars / 3.5, times 1.3 for the newer tokenizer (spec section 4).
 * Computed as chars x 13 / 35 so exact multiples do not round up from float noise.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil((text.length * 13) / 35);
}

// ---------------------------------------------------------------------------
// Cost from usage
// ---------------------------------------------------------------------------

/** The usage fields cost depends on; the SDK's Usage type satisfies it. */
export type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  output_tokens_details?: { thinking_tokens: number } | null;
};

export type PricingTier = "standard" | "long";

export type CostBreakdown = {
  costUsd: number;
  tier: PricingTier;
  /** input + cache reads + cache writes: what decides Haiku's long tier. */
  promptTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  thinkingTokens: number;
};

const PER_MTOK = 1_000_000;

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Splits cache writes by TTL. The per-TTL breakdown wins when present; tokens
 * the breakdown does not cover (or all writes when it is missing) count as
 * 5-minute writes, so a write is never left unpriced.
 */
function cacheWrites(usage: UsageLike): { write5m: number; write1h: number } {
  const total = count(usage.cache_creation_input_tokens);
  const breakdown = usage.cache_creation;
  if (!breakdown) return { write5m: total, write1h: 0 };
  const write5m = count(breakdown.ephemeral_5m_input_tokens);
  const write1h = count(breakdown.ephemeral_1h_input_tokens);
  return { write5m: write5m + Math.max(0, total - write5m - write1h), write1h };
}

/**
 * Cost of one request. Haiku's long tier applies when input plus cache read and
 * write tokens exceed 100K, and then every token class in the request (output
 * and cache included) pays the long rates. Batches halve everything.
 */
export function computeCostBreakdown(
  model: PricedModelId,
  usage: UsageLike,
  options: { batch?: boolean } = {},
): CostBreakdown {
  const pricing = getPricing(model);
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  const cacheReadTokens = count(usage.cache_read_input_tokens);
  const { write5m, write1h } = cacheWrites(usage);
  const promptTokens = inputTokens + cacheReadTokens + write5m + write1h;

  const long =
    pricing.longThreshold !== undefined &&
    pricing.inLong !== undefined &&
    pricing.outLong !== undefined &&
    promptTokens > pricing.longThreshold;
  const inRate = long && pricing.inLong !== undefined ? pricing.inLong : pricing.in;
  const outRate = long && pricing.outLong !== undefined ? pricing.outLong : pricing.out;

  const perMillion =
    inputTokens * inRate +
    cacheReadTokens * inRate * pricing.cacheReadMultiplier +
    write5m * inRate * pricing.cacheWrite5mMultiplier +
    write1h * inRate * pricing.cacheWrite1hMultiplier +
    outputTokens * outRate;
  const batchFactor = options.batch ? pricing.batchMultiplier : 1;

  return {
    costUsd: (perMillion / PER_MTOK) * batchFactor,
    tier: long ? "long" : "standard",
    promptTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    thinkingTokens: count(usage.output_tokens_details?.thinking_tokens),
  };
}

/** USD cost of one request from its usage. */
export function computeCostUsd(model: PricedModelId, usage: UsageLike, options: { batch?: boolean } = {}): number {
  return computeCostBreakdown(model, usage, options).costUsd;
}

// ---------------------------------------------------------------------------
// Tagging estimate
// ---------------------------------------------------------------------------

/**
 * Assumptions behind the tagging estimate. The processed image is at most
 * 1024 px on the long edge; a square is the worst case. The structured-output
 * format adds its own system text (not published; about 400 tokens) and output
 * includes thinking at effort low. `pnpm ai:smoke` prints the measured values.
 */
export const TAGGING_ESTIMATE = {
  imageWidth: 1024,
  imageHeight: 1024,
  formatOverheadTokens: 400,
  outputTokens: 700,
} as const;

export type TaggingCostRates = {
  /** The first call of a run writes the system prompt to the cache. */
  firstItemUsd: number;
  /** Later calls read it from the cache. */
  nextItemUsd: number;
};

type CacheWriteTtl = "5m" | "1h";

/** Estimated tokens of one tagging call: the cacheable system prompt and the rest. */
function taggingTokens(): { systemTokens: number; uncachedInput: number } {
  return {
    systemTokens: estimateTextTokens(TAGGING_SYSTEM_PROMPT),
    uncachedInput:
      estimateImageTokens(TAGGING_ESTIMATE.imageWidth, TAGGING_ESTIMATE.imageHeight) +
      estimateTextTokens(TAGGING_USER_INSTRUCTION) +
      TAGGING_ESTIMATE.formatOverheadTokens,
  };
}

/** A tagging call that writes the system prompt to the cache with this TTL. */
function cacheWritingCallUsd(model: PricedModelId, ttl: CacheWriteTtl, batch: boolean): number {
  const { systemTokens, uncachedInput } = taggingTokens();
  return computeCostUsd(
    model,
    {
      input_tokens: uncachedInput,
      output_tokens: TAGGING_ESTIMATE.outputTokens,
      cache_creation_input_tokens: systemTokens,
      cache_creation:
        ttl === "1h"
          ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: systemTokens }
          : { ephemeral_5m_input_tokens: systemTokens, ephemeral_1h_input_tokens: 0 },
    },
    { batch },
  );
}

/**
 * Per-item tagging cost. Sync calls use the 5-minute cache, batches the
 * 1-hour one (D-024). Client components get these numbers from the server and
 * compute first + (n - 1) x next themselves.
 */
export function taggingCostRates(model: PricedModelId, options: { batch?: boolean } = {}): TaggingCostRates {
  const { systemTokens, uncachedInput } = taggingTokens();
  const batch = options.batch === true;
  const firstItemUsd = cacheWritingCallUsd(model, batch ? "1h" : "5m", batch);
  const nextItemUsd = computeCostUsd(
    model,
    { input_tokens: uncachedInput, output_tokens: TAGGING_ESTIMATE.outputTokens, cache_read_input_tokens: systemTokens },
    { batch },
  );
  return { firstItemUsd, nextItemUsd };
}

/**
 * The synchronous dry run before a batch (D-024): one item at standard rates
 * that sends exactly the batch request, so it writes the 1-hour cache (2x
 * instead of the 5-minute 1.25x). The add page, the review page and
 * startTaggingBatch all price a batch run as this plus (n - 1) batch items.
 */
export function estimateTaggingDryRunUsd(model: PricedModelId): number {
  return cacheWritingCallUsd(model, "1h", false);
}

/** Estimated USD to tag `count` items in one run: the first writes the cache, the rest read it. */
export function estimateTaggingCostUsd({
  count: itemCount,
  model,
  batch = false,
}: {
  count: number;
  model: PricedModelId;
  batch?: boolean;
}): number {
  if (!Number.isInteger(itemCount) || itemCount < 0) {
    throw new RangeError("count must be a non-negative integer.");
  }
  if (itemCount === 0) return 0;
  const { firstItemUsd, nextItemUsd } = taggingCostRates(model, { batch });
  return firstItemUsd + (itemCount - 1) * nextItemUsd;
}

/** A batch run of `count` items: the synchronous dry run plus the rest at batch rates. */
export function estimateTaggingBatchRunUsd({ count: itemCount, model }: { count: number; model: PricedModelId }): {
  dryRunUsd: number;
  batchUsd: number;
  totalUsd: number;
} {
  if (!Number.isInteger(itemCount) || itemCount < 1) {
    throw new RangeError("count must be a positive integer.");
  }
  const dryRunUsd = estimateTaggingDryRunUsd(model);
  const batchUsd = estimateTaggingCostUsd({ count: itemCount - 1, model, batch: true });
  return { dryRunUsd, batchUsd, totalUsd: dryRunUsd + batchUsd };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const USD_CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const USD_SMALL = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/**
 * "$12.34" for amounts of a dollar or more; up to four decimals below that, so
 * a single tagging call ("$0.0006") does not read as "$0.00".
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return "n/a";
  if (amount > 0 && amount < 0.0001) return "<$0.0001";
  return Math.abs(amount) >= 1 ? USD_CENTS.format(amount) : USD_SMALL.format(amount);
}
