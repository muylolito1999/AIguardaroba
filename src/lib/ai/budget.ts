import "server-only";

import { gte, lt, ne, sql } from "drizzle-orm";

import { aiSettingsEnv } from "@/env";
import { formatUsd } from "@/lib/ai/cost";
import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiCalls } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

// The monthly AI budget (spec section 4, D-020). Spend is the sum of ai_calls
// costs in the current UTC calendar month; batches that are not processed yet
// count with their estimate until their results are logged as ai_calls rows.
// Reads aiSettingsEnv, not aiEnv, so the usage page works before the API key
// is configured.

export type BudgetLimits = { budgetUsd: number; creditUsd: number };

export type BudgetStatus = {
  /** ai_calls cost since the start of the current UTC month. */
  spentUsd: number;
  /** Estimates of batches whose results are not processed yet. */
  pendingBatchUsd: number;
  budgetUsd: number;
  /** budget - spent - pending, never below 0. */
  remainingUsd: number;
  /** ISO time of the next UTC month start, when the budget resets. */
  resetsAt: string;
  /** The prepaid credit the all-time total is compared with. */
  creditUsd: number;
  allTimeSpentUsd: number;
};

export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function nextUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function configuredLimits(): BudgetLimits {
  const settings = aiSettingsEnv();
  return { budgetUsd: settings.MONTHLY_AI_BUDGET_USD, creditUsd: settings.AI_CREDIT_USD };
}

// Amounts are compared in whole micro-dollars (the column's scale), so float
// noise in sums cannot tip a check either way.
function micros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function fromMicros(value: number): number {
  return value / 1_000_000;
}

/** Month-to-date and all-time spend, pending batches and the remaining budget. */
export async function getBudgetStatus(
  db: Db,
  now: Date = new Date(),
  limits: BudgetLimits = configuredLimits(),
): Promise<BudgetStatus> {
  await requireSession();
  const monthStart = utcMonthStart(now);
  const resetsAt = nextUtcMonthStart(now);

  const [[calls], [batches]] = await Promise.all([
    db
      .select({
        month: sql<number>`coalesce(sum(${aiCalls.costUsd}) filter (where ${gte(
          aiCalls.createdAt,
          monthStart,
        )} and ${lt(aiCalls.createdAt, resetsAt)}), 0)`.mapWith(Number),
        allTime: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`.mapWith(Number),
      })
      .from(aiCalls),
    db
      .select({ pending: sql<number>`coalesce(sum(${aiBatches.estimatedCostUsd}), 0)`.mapWith(Number) })
      .from(aiBatches)
      .where(ne(aiBatches.status, "processed")),
  ]);

  const spent = micros(calls?.month ?? 0);
  const pending = micros(batches?.pending ?? 0);
  const budget = micros(limits.budgetUsd);
  return {
    spentUsd: fromMicros(spent),
    pendingBatchUsd: fromMicros(pending),
    budgetUsd: limits.budgetUsd,
    remainingUsd: fromMicros(Math.max(0, budget - spent - pending)),
    resetsAt: resetsAt.toISOString(),
    creditUsd: limits.creditUsd,
    allTimeSpentUsd: fromMicros(micros(calls?.allTime ?? 0)),
  };
}

const RESET_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Throws BUDGET_EXCEEDED when this month's spend has reached the budget (the
 * spec's hard stop) or when spend plus pending batches plus `estimateUsd`
 * would pass it. Returns the status it checked against. In-flight calls are
 * not counted, so concurrent work can overshoot by a few cents (D-020).
 */
export async function assertWithinBudget(
  db: Db,
  { estimateUsd, now = new Date(), limits }: { estimateUsd: number; now?: Date; limits?: BudgetLimits },
): Promise<BudgetStatus> {
  await requireSession();
  if (!Number.isFinite(estimateUsd) || estimateUsd < 0) {
    throw new AppError("INTERNAL", "The cost estimate for this AI request is invalid.");
  }
  const status = await getBudgetStatus(db, now, limits ?? configuredLimits());
  const budget = micros(status.budgetUsd);
  const spent = micros(status.spentUsd);
  const reserved = spent + micros(status.pendingBatchUsd);
  const needed = micros(estimateUsd);

  if (spent >= budget || reserved + needed > budget) {
    const resetDate = RESET_DATE.format(new Date(status.resetsAt));
    const message =
      spent >= budget
        ? `The monthly AI budget of ${formatUsd(status.budgetUsd)} is used up (${formatUsd(status.spentUsd)} spent). It resets on ${resetDate}.`
        : `This needs about ${formatUsd(estimateUsd)}, but only ${formatUsd(status.remainingUsd)} of the monthly AI budget of ${formatUsd(status.budgetUsd)} is left. It resets on ${resetDate}.`;
    throw new AppError("BUDGET_EXCEEDED", message, {
      budgetUsd: status.budgetUsd,
      spentUsd: status.spentUsd,
      pendingBatchUsd: status.pendingBatchUsd,
      estimateUsd,
      remainingUsd: status.remainingUsd,
      resetsAt: status.resetsAt,
    });
  }
  return status;
}
