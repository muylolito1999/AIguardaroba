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

const ITEM_FOREIGN_KEY = "ai_calls_item_id_items_id_fkey";

/**
 * True when the insert failed because the item it links to no longer exists
 * (SQLSTATE 23503 on ai_calls.item_id). Drizzle wraps driver errors in
 * DrizzleQueryError with the pg or PGlite error as its cause; both carry
 * `code` and `constraint`.
 */
function isMissingItemLink(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && current.code === "23503") {
      return "constraint" in current && current.constraint === ITEM_FOREIGN_KEY;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * Records one Claude attempt (D-020). Every attempt is logged, failed ones too,
 * because the month-to-date budget is the sum of these rows. A failing insert
 * propagates: spending must not go unrecorded. One case is recorded anyway:
 * the item was deleted while its call ran (no lock is held across a Claude
 * call), so the row is written without the link, as deleting an item leaves
 * its earlier calls (D-111).
 */
export async function logAiCall(db: Db, row: AiCallRecord): Promise<void> {
  const errorMessage =
    typeof row.errorMessage === "string" && row.errorMessage.length > MAX_ERROR_MESSAGE
      ? `${row.errorMessage.slice(0, MAX_ERROR_MESSAGE - 1)}…`
      : row.errorMessage;
  const values = { ...row, errorMessage };
  try {
    await db.insert(aiCalls).values(values);
  } catch (error) {
    if (row.itemId === null || row.itemId === undefined || !isMissingItemLink(error)) throw error;
    await db.insert(aiCalls).values({ ...values, itemId: null });
  }
}

/** The ai_calls logger for a database. */
export function dbCallLogger(db: Db): AiCallLogger {
  return (row) => logAiCall(db, row);
}
