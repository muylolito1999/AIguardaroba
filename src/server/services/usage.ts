import "server-only";

import { desc, gte, lt, ne, sql, type AnyColumn } from "drizzle-orm";

import { getBudgetStatus, nextUtcMonthStart, utcMonthStart, type BudgetLimits } from "@/lib/ai/budget";
import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import type { AiCallStatus, AiPurpose, ImageKind } from "@/lib/db/enums";
import { aiBatches, aiCalls, itemImages } from "@/lib/db/schema";

// The numbers behind /settings/usage (spec section 1: watch the $100 credit;
// section 4: the monthly budget). Months are UTC calendar months, the same
// window the budget check uses, so the page and the hard stop always agree.

/** Vercel Blob's Hobby allowance of advanced operations (uploads) per month. */
export const BLOB_HOBBY_ADVANCED_OPS = 2_000;

/** How many recent ai_calls rows the page lists. */
export const RECENT_CALLS_LIMIT = 50;

export type UsageDeps = {
  db: Db;
  now: Date;
  /** Tests pass fixed limits; the configured MONTHLY_AI_BUDGET_USD and AI_CREDIT_USD otherwise. */
  limits?: BudgetLimits;
};

export type TokenTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

export type UsageBreakdownRow<K extends string> = TokenTotals & {
  key: K;
  /** Spend since the first call, for comparison with the month. */
  allTimeCostUsd: number;
  allTimeCalls: number;
};

export type RecentCall = {
  id: string;
  /** ISO 8601. */
  createdAt: string;
  purpose: AiPurpose;
  model: string;
  status: AiCallStatus;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latencyMs: number | null;
  isBatch: boolean;
  errorCode: string | null;
};

export type UsageSummary = {
  /** ISO 8601 start of the current UTC month. */
  monthStartsAt: string;
  month: {
    spentUsd: number;
    budgetUsd: number;
    /** Estimates of batches whose results are not in yet; the budget check reserves them. */
    pendingBatchUsd: number;
    remainingUsd: number;
    /** ISO 8601 start of next UTC month, when the budget resets. */
    resetsAt: string;
    totals: TokenTotals;
  };
  allTime: {
    spentUsd: number;
    creditUsd: number;
    /** creditUsd - spentUsd, never below 0. */
    remainingCreditUsd: number;
  };
  cache: {
    readTokens: number;
    writeTokens: number;
    /** cache_read / (input + cache_read + cache_write) this month; null before the first call. */
    hitRatio: number | null;
  };
  pendingBatches: { count: number; estimatedUsd: number };
  byPurpose: UsageBreakdownRow<AiPurpose>[];
  byModel: UsageBreakdownRow<string>[];
  recentCalls: RecentCall[];
  blob: {
    /** Server puts this month: processed, thumbnail and background-removed images. */
    serverPuts: number;
    /** Browser uploads this month: originals and background-removed PNGs. */
    clientUploads: number;
    estimatedAdvancedOps: number;
    limit: number;
  };
};

/** cache_read / (input + cache_read + cache_write); null when nothing was sent. */
export function cacheHitRatio(inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): number | null {
  const total = inputTokens + cacheReadTokens + cacheWriteTokens;
  return total === 0 ? null : cacheReadTokens / total;
}

// Advanced operations are uploads (spec: Hobby allows 2,000 a month). Each
// image row stands for the upload that stored it: originals come from the
// browser, processed and thumbnail images from the server's put(). A
// background-removed image is uploaded by the browser as PNG and then stored
// again by the server as WebP, so it counts twice.
const SERVER_PUT_KINDS: readonly ImageKind[] = ["processed", "thumb", "nobg"];
const CLIENT_UPLOAD_KINDS: readonly ImageKind[] = ["original", "nobg"];

/**
 * Estimates this month's Blob advanced operations from item_images rows.
 * Uploads that never became a row (a duplicate deleted at register, an
 * abandoned upload) are missing, so the true count can be higher.
 */
export function estimateBlobOps(rowsByKind: Partial<Record<ImageKind, number>>): UsageSummary["blob"] {
  const sum = (kinds: readonly ImageKind[]) => kinds.reduce((total, kind) => total + (rowsByKind[kind] ?? 0), 0);
  const serverPuts = sum(SERVER_PUT_KINDS);
  const clientUploads = sum(CLIENT_UPLOAD_KINDS);
  return {
    serverPuts,
    clientUploads,
    estimatedAdvancedOps: serverPuts + clientUploads,
    limit: BLOB_HOBBY_ADVANCED_OPS,
  };
}

/** Everything /settings/usage shows, in one round of parallel queries. */
export async function getUsageSummary({ db, now, limits }: UsageDeps): Promise<UsageSummary> {
  await requireSession();
  const monthStart = utcMonthStart(now);
  const monthEnd = nextUtcMonthStart(now);
  const inMonth = sql`${gte(aiCalls.createdAt, monthStart)} and ${lt(aiCalls.createdAt, monthEnd)}`;

  // Month-to-date token and cost sums, plus all-time cost and call count, per group.
  const monthSum = (column: AnyColumn) =>
    sql<number>`coalesce(sum(${column}) filter (where ${inMonth}), 0)`.mapWith(Number);
  const breakdownColumns = {
    calls: sql<number>`count(*) filter (where ${inMonth})`.mapWith(Number),
    inputTokens: monthSum(aiCalls.inputTokens),
    outputTokens: monthSum(aiCalls.outputTokens),
    cacheReadTokens: monthSum(aiCalls.cacheReadInputTokens),
    cacheWriteTokens: monthSum(aiCalls.cacheCreationInputTokens),
    costUsd: monthSum(aiCalls.costUsd),
    allTimeCostUsd: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`.mapWith(Number),
    allTimeCalls: sql<number>`count(*)`.mapWith(Number),
  };

  const [budget, purposeRows, modelRows, recentRows, [batches], imageRows] = await Promise.all([
    getBudgetStatus(db, now, limits),
    db
      .select({ key: aiCalls.purpose, ...breakdownColumns })
      .from(aiCalls)
      .groupBy(aiCalls.purpose),
    db
      .select({ key: aiCalls.model, ...breakdownColumns })
      .from(aiCalls)
      .groupBy(aiCalls.model),
    db
      .select({
        id: aiCalls.id,
        createdAt: aiCalls.createdAt,
        purpose: aiCalls.purpose,
        model: aiCalls.model,
        status: aiCalls.status,
        inputTokens: aiCalls.inputTokens,
        outputTokens: aiCalls.outputTokens,
        cacheReadTokens: aiCalls.cacheReadInputTokens,
        cacheWriteTokens: aiCalls.cacheCreationInputTokens,
        costUsd: aiCalls.costUsd,
        latencyMs: aiCalls.latencyMs,
        isBatch: aiCalls.isBatch,
        errorCode: aiCalls.errorCode,
      })
      .from(aiCalls)
      .orderBy(desc(aiCalls.createdAt), desc(aiCalls.id))
      .limit(RECENT_CALLS_LIMIT),
    db
      .select({
        count: sql<number>`count(*)`.mapWith(Number),
        estimatedUsd: sql<number>`coalesce(sum(${aiBatches.estimatedCostUsd}), 0)`.mapWith(Number),
      })
      .from(aiBatches)
      .where(ne(aiBatches.status, "processed")),
    db
      .select({ kind: itemImages.kind, rows: sql<number>`count(*)`.mapWith(Number) })
      .from(itemImages)
      .where(sql`${gte(itemImages.createdAt, monthStart)} and ${lt(itemImages.createdAt, monthEnd)}`)
      .groupBy(itemImages.kind),
  ]);

  // Groups with no calls this month still show their all-time spend; groups
  // that never had a call are left out.
  const byCostThenKey = <K extends string>(a: UsageBreakdownRow<K>, b: UsageBreakdownRow<K>) =>
    b.costUsd - a.costUsd || b.allTimeCostUsd - a.allTimeCostUsd || a.key.localeCompare(b.key);
  const byPurpose = purposeRows.toSorted(byCostThenKey);
  const byModel = modelRows.toSorted(byCostThenKey);

  const totals: TokenTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: budget.spentUsd,
  };
  for (const row of purposeRows) {
    totals.calls += row.calls;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.cacheWriteTokens += row.cacheWriteTokens;
  }

  const rowsByKind: Partial<Record<ImageKind, number>> = {};
  for (const row of imageRows) rowsByKind[row.kind] = row.rows;

  return {
    monthStartsAt: monthStart.toISOString(),
    month: {
      spentUsd: budget.spentUsd,
      budgetUsd: budget.budgetUsd,
      pendingBatchUsd: budget.pendingBatchUsd,
      remainingUsd: budget.remainingUsd,
      resetsAt: budget.resetsAt,
      totals,
    },
    allTime: {
      spentUsd: budget.allTimeSpentUsd,
      creditUsd: budget.creditUsd,
      remainingCreditUsd: Math.max(0, budget.creditUsd - budget.allTimeSpentUsd),
    },
    cache: {
      readTokens: totals.cacheReadTokens,
      writeTokens: totals.cacheWriteTokens,
      hitRatio: cacheHitRatio(totals.inputTokens, totals.cacheReadTokens, totals.cacheWriteTokens),
    },
    pendingBatches: { count: batches?.count ?? 0, estimatedUsd: batches?.estimatedUsd ?? 0 },
    byPurpose,
    byModel,
    recentCalls: recentRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    blob: estimateBlobOps(rowsByKind),
  };
}
