import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { aiBatches, aiCalls, type NewAiCall } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem } from "../../../test/factories";
import {
  BLOB_HOBBY_ADVANCED_OPS,
  RECENT_CALLS_LIMIT,
  cacheHitRatio,
  estimateBlobOps,
  getUsageSummary,
} from "./usage";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const NOW = new Date("2026-11-15T12:00:00Z");
const THIS_MONTH = new Date("2026-11-03T08:00:00Z");
const LAST_MONTH = new Date("2026-10-31T23:59:59Z");
const NEXT_MONTH = new Date("2026-12-01T00:00:00Z");
const LIMITS = { budgetUsd: 20, creditUsd: 100 };

let testDb: TestDb;

async function insertCall(db: Db, overrides: Partial<NewAiCall>): Promise<void> {
  await db.insert(aiCalls).values({
    model: "claude-haiku-5-5",
    purpose: "tagging",
    status: "success",
    ...overrides,
  });
}

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterAll(async () => {
  await testDb.close();
});

describe("cacheHitRatio", () => {
  it("divides cache reads by every input token class", () => {
    expect(cacheHitRatio(100, 300, 100)).toBe(0.6);
    expect(cacheHitRatio(50, 0, 0)).toBe(0);
  });

  it("is null before anything was sent", () => {
    expect(cacheHitRatio(0, 0, 0)).toBeNull();
  });
});

describe("estimateBlobOps", () => {
  it("counts originals once, server images once and background-removed images twice", () => {
    expect(estimateBlobOps({ original: 3, processed: 3, thumb: 3, nobg: 2 })).toEqual({
      serverPuts: 8,
      clientUploads: 5,
      estimatedAdvancedOps: 13,
      limit: BLOB_HOBBY_ADVANCED_OPS,
    });
    expect(estimateBlobOps({})).toMatchObject({ estimatedAdvancedOps: 0, limit: 2_000 });
  });
});

describe("getUsageSummary", () => {
  it("sums this UTC month against the budget and every month against the credit", async () => {
    const { db } = testDb;
    await insertCall(db, { createdAt: THIS_MONTH, costUsd: 1.5, inputTokens: 1_000, outputTokens: 200 });
    await insertCall(db, {
      createdAt: THIS_MONTH,
      costUsd: 0.25,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 600,
      cacheCreationInputTokens: 300,
      status: "invalid_output",
    });
    await insertCall(db, { createdAt: LAST_MONTH, costUsd: 4 });
    // A row dated in the future (clock skew) is outside this month's window.
    await insertCall(db, { createdAt: NEXT_MONTH, costUsd: 0.5 });

    const summary = await getUsageSummary({ db, now: NOW, limits: LIMITS });

    expect(summary.monthStartsAt).toBe("2026-11-01T00:00:00.000Z");
    expect(summary.month).toMatchObject({
      spentUsd: 1.75,
      budgetUsd: 20,
      pendingBatchUsd: 0,
      remainingUsd: 18.25,
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
    expect(summary.month.totals).toEqual({
      calls: 2,
      inputTokens: 1_100,
      outputTokens: 250,
      cacheReadTokens: 600,
      cacheWriteTokens: 300,
      costUsd: 1.75,
    });
    expect(summary.allTime).toEqual({ spentUsd: 6.25, creditUsd: 100, remainingCreditUsd: 93.75 });
    // 600 / (1,100 + 600 + 300)
    expect(summary.cache).toEqual({ readTokens: 600, writeTokens: 300, hitRatio: 0.3 });
  });

  it("breaks spend down by purpose and by model, keeping groups with only older spend", async () => {
    const { db } = testDb;
    await insertCall(db, { createdAt: THIS_MONTH, purpose: "tagging", costUsd: 0.002, inputTokens: 10 });
    await insertCall(db, { createdAt: THIS_MONTH, purpose: "tagging", costUsd: 0.003, inputTokens: 20 });
    await insertCall(db, {
      createdAt: THIS_MONTH,
      purpose: "relocation_chunk",
      model: "claude-sonnet-5-5",
      costUsd: 0.4,
      outputTokens: 900,
    });
    await insertCall(db, { createdAt: LAST_MONTH, purpose: "smoke_test", costUsd: 0.001 });

    const summary = await getUsageSummary({ db, now: NOW, limits: LIMITS });

    expect(summary.byPurpose.map((row) => row.key)).toEqual(["relocation_chunk", "tagging", "smoke_test"]);
    expect(summary.byPurpose[1]).toEqual({
      key: "tagging",
      calls: 2,
      inputTokens: 30,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.005,
      allTimeCostUsd: 0.005,
      allTimeCalls: 2,
    });
    expect(summary.byPurpose[2]).toMatchObject({ key: "smoke_test", calls: 0, costUsd: 0, allTimeCostUsd: 0.001 });
    expect(summary.byModel.map((row) => [row.key, row.calls, row.allTimeCalls])).toEqual([
      ["claude-sonnet-5-5", 1, 1],
      ["claude-haiku-5-5", 2, 3],
    ]);
  });

  it("lists the newest calls first, at most the page limit", async () => {
    const { db } = testDb;
    for (let index = 0; index < RECENT_CALLS_LIMIT + 5; index += 1) {
      await insertCall(db, {
        createdAt: new Date(THIS_MONTH.getTime() + index * 60_000),
        costUsd: 0.001,
        latencyMs: 900 + index,
      });
    }

    const { recentCalls } = await getUsageSummary({ db, now: NOW, limits: LIMITS });

    expect(recentCalls).toHaveLength(RECENT_CALLS_LIMIT);
    expect(recentCalls[0]).toMatchObject({
      createdAt: new Date(THIS_MONTH.getTime() + (RECENT_CALLS_LIMIT + 4) * 60_000).toISOString(),
      purpose: "tagging",
      model: "claude-haiku-5-5",
      status: "success",
      latencyMs: 900 + RECENT_CALLS_LIMIT + 4,
      isBatch: false,
      errorCode: null,
    });
  });

  it("reports unprocessed batches and reserves them in the budget", async () => {
    const { db } = testDb;
    await db.insert(aiBatches).values([
      {
        anthropicBatchId: "msgbatch_a",
        purpose: "tagging",
        model: "claude-haiku-5-5",
        requestCount: 30,
        estimatedCostUsd: 0.02,
      },
      {
        anthropicBatchId: "msgbatch_b",
        purpose: "tagging",
        model: "claude-haiku-5-5",
        requestCount: 25,
        estimatedCostUsd: 0.01,
        status: "ended",
      },
      {
        anthropicBatchId: "msgbatch_c",
        purpose: "tagging",
        model: "claude-haiku-5-5",
        requestCount: 40,
        estimatedCostUsd: 5,
        status: "processed",
      },
    ]);

    const summary = await getUsageSummary({ db, now: NOW, limits: LIMITS });

    expect(summary.pendingBatches).toEqual({ count: 2, estimatedUsd: 0.03 });
    expect(summary.month.pendingBatchUsd).toBe(0.03);
    expect(summary.month.remainingUsd).toBe(19.97);
  });

  it("estimates Blob uploads from this month's image rows", async () => {
    const { db } = testDb;
    const item = await makeItem(db);
    for (const kind of ["original", "processed", "thumb", "nobg"] as const) {
      await makeImage(db, item.id, { kind, createdAt: THIS_MONTH });
    }
    const older = await makeItem(db);
    await makeImage(db, older.id, { kind: "original", createdAt: LAST_MONTH });

    const { blob } = await getUsageSummary({ db, now: NOW, limits: LIMITS });

    expect(blob).toEqual({ serverPuts: 3, clientUploads: 2, estimatedAdvancedOps: 5, limit: 2_000 });
  });

  it("answers zeros for an empty database", async () => {
    const summary = await getUsageSummary({ db: testDb.db, now: NOW, limits: LIMITS });
    expect(summary.month.spentUsd).toBe(0);
    expect(summary.cache.hitRatio).toBeNull();
    expect(summary.byPurpose).toEqual([]);
    expect(summary.recentCalls).toEqual([]);
    expect(summary.pendingBatches).toEqual({ count: 0, estimatedUsd: 0 });
  });

  it("checks the session before reading", async () => {
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in"));
    await expect(getUsageSummary({ db: testDb.db, now: NOW, limits: LIMITS })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
