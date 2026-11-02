import "server-only";

import { computeCostBreakdown, type UsageLike } from "@/lib/ai/cost";
import type { PricedModelId } from "@/lib/ai/models";
import type { Db } from "@/lib/db/client";
import { aiCalls, type NewAiCall } from "@/lib/db/schema";

/** One ai_calls row without the generated id and timestamp. */
export type AiCallRecord = Omit<NewAiCall, "id" | "createdAt">;

/** Where callStructured records attempts; the default writes to ai_calls. */
export type AiCallLogger = (row: AiCallRecord) => Promise<void>;

const MAX_ERROR_MESSAGE = 1_000;

export type UsageColumns = Required<
  Pick<
    AiCallRecord,
    | "inputTokens"
    | "outputTokens"
    | "cacheCreationInputTokens"
    | "cacheReadInputTokens"
    | "cacheWrite1hTokens"
    | "thinkingTokens"
    | "pricingTier"
    | "isBatch"
    | "costUsd"
  >
>;

/** The token, cost and tier columns of an ai_calls row, from a reply's usage. */
export function usageColumns(model: PricedModelId, usage: UsageLike, options: { batch?: boolean } = {}): UsageColumns {
  const cost = computeCostBreakdown(model, usage, options);
  return {
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    // All cache writes; the 1-hour share is also kept on its own.
    cacheCreationInputTokens: cost.cacheWrite5mTokens + cost.cacheWrite1hTokens,
    cacheReadInputTokens: cost.cacheReadTokens,
    cacheWrite1hTokens: cost.cacheWrite1hTokens,
    thinkingTokens: cost.thinkingTokens,
    pricingTier: cost.tier,
    isBatch: options.batch === true,
    costUsd: cost.costUsd,
  };
}

/**
 * Records one Claude attempt (D-020). Every attempt is logged, failed ones too,
 * because the month-to-date budget is the sum of these rows. A failing insert
 * propagates: spending must not go unrecorded.
 */
export async function logAiCall(db: Db, row: AiCallRecord): Promise<void> {
  const errorMessage =
    typeof row.errorMessage === "string" && row.errorMessage.length > MAX_ERROR_MESSAGE
      ? `${row.errorMessage.slice(0, MAX_ERROR_MESSAGE - 1)}…`
      : row.errorMessage;
  await db.insert(aiCalls).values({ ...row, errorMessage });
}

/** The ai_calls logger for a database. */
export function dbCallLogger(db: Db): AiCallLogger {
  return (row) => logAiCall(db, row);
}
