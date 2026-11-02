import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { aiBatches, aiCalls, type NewAiBatch } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { assertWithinBudget, getBudgetStatus, nextUtcMonthStart, utcMonthStart } from "./budget";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const NOW = new Date("2026-11-15T12:00:00.000Z");
const LIMITS = { budgetUsd: 20, creditUsd: 100 };

let testDb: TestDb;

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

async function spend(db: Db, costUsd: number, createdAt: Date): Promise<void> {
  await db.insert(aiCalls).values({ model: "claude-haiku-5-5", purpose: "tagging", status: "success", costUsd, createdAt });
}

let batchSeq = 0;
async function batch(db: Db, estimatedCostUsd: number, status: NewAiBatch["status"]): Promise<void> {
  batchSeq += 1;
  await db.insert(aiBatches).values({
    anthropicBatchId: `msgbatch_test_${batchSeq}`,
    purpose: "tagging",
    model: "claude-haiku-5-5",
    status,
    requestCount: 25,
    estimatedCostUsd,
  });
}

async function budgetError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected BUDGET_EXCEEDED");
}

describe("UTC month boundaries", () => {
  it("starts at midnight UTC on the 1st and resets on the next 1st", () => {
    expect(utcMonthStart(NOW).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(nextUtcMonthStart(NOW).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(nextUtcMonthStart(new Date("2026-12-31T23:59:59.999Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    // 00:30 on 1 Dec in Berlin is still November in UTC.
    expect(utcMonthStart(new Date("2026-11-30T23:30:00.000Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("getBudgetStatus", () => {
  it("sums only the current UTC month into spentUsd and everything into allTimeSpentUsd", async () => {
    await spend(testDb.db, 1.5, new Date("2026-10-31T23:59:59.999Z"));
    await spend(testDb.db, 2.25, new Date("2026-11-01T00:00:00.000Z"));
    await spend(testDb.db, 0.000123, new Date("2026-11-15T11:00:00.000Z"));

    const status = await getBudgetStatus(testDb.db, NOW, LIMITS);

    expect(status.spentUsd).toBeCloseTo(2.250123, 9);
    expect(status.allTimeSpentUsd).toBeCloseTo(3.750123, 9);
    expect(status.budgetUsd).toBe(20);
    expect(status.creditUsd).toBe(100);
    expect(status.resetsAt).toBe("2026-12-01T00:00:00.000Z");
    expect(status.remainingUsd).toBeCloseTo(20 - 2.250123, 9);
  });

  it("includes unprocessed batch estimates as pending", async () => {
    await batch(testDb.db, 0.5, "in_progress");
    await batch(testDb.db, 0.25, "ended");
    await batch(testDb.db, 9, "processed");

    const status = await getBudgetStatus(testDb.db, NOW, LIMITS);

    expect(status.pendingBatchUsd).toBeCloseTo(0.75, 9);
    expect(status.remainingUsd).toBeCloseTo(19.25, 9);
  });

  it("reports zero for an empty database and never a negative remainder", async () => {
    expect(await getBudgetStatus(testDb.db, NOW, LIMITS)).toMatchObject({
      spentUsd: 0,
      pendingBatchUsd: 0,
      allTimeSpentUsd: 0,
      remainingUsd: 20,
    });
    await spend(testDb.db, 25, NOW);
    expect((await getBudgetStatus(testDb.db, NOW, LIMITS)).remainingUsd).toBe(0);
  });

  it("reads the configured budget when no limits are passed", async () => {
    // Vitest blanks the app's variables, so the documented defaults apply.
    expect(await getBudgetStatus(testDb.db, NOW)).toMatchObject({ budgetUsd: 20, creditUsd: 100 });
  });

  it("checks the session first", async () => {
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Your session has ended."));
    await expect(getBudgetStatus(testDb.db, NOW, LIMITS)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("assertWithinBudget", () => {
  it("passes when spend, pending batches and the estimate fit, and returns the status", async () => {
    await spend(testDb.db, 10, NOW);
    await batch(testDb.db, 5, "in_progress");

    const status = await assertWithinBudget(testDb.db, { estimateUsd: 5, now: NOW, limits: LIMITS });
    expect(status.remainingUsd).toBeCloseTo(5, 9);
  });

  it("blocks when the projection exceeds the budget, reporting what remains and when it resets", async () => {
    await spend(testDb.db, 10, NOW);
    await batch(testDb.db, 5, "in_progress");

    const error = await budgetError(
      assertWithinBudget(testDb.db, { estimateUsd: 5.000001, now: NOW, limits: LIMITS }),
    );

    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(error.message).toContain("$5.00");
    expect(error.message).toContain("1 December 2026");
    expect(error.details).toMatchObject({
      budgetUsd: 20,
      spentUsd: 10,
      pendingBatchUsd: 5,
      estimateUsd: 5.000001,
      remainingUsd: 5,
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
  });

  it("blocks everything once spend reaches the budget, even a free request", async () => {
    await spend(testDb.db, 20, NOW);
    const error = await budgetError(assertWithinBudget(testDb.db, { estimateUsd: 0, now: NOW, limits: LIMITS }));
    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(error.message).toContain("used up");
  });

  it("blocks above the budget too", async () => {
    await spend(testDb.db, 20.5, NOW);
    await expect(assertWithinBudget(testDb.db, { estimateUsd: 0.01, now: NOW, limits: LIMITS })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  });

  it("ignores last month's spend", async () => {
    await spend(testDb.db, 19.99, new Date("2026-10-20T00:00:00.000Z"));
    await expect(
      assertWithinBudget(testDb.db, { estimateUsd: 19.99, now: NOW, limits: LIMITS }),
    ).resolves.toMatchObject({ spentUsd: 0 });
  });

  it("is not tipped by float noise at the exact budget", async () => {
    for (let i = 0; i < 10; i += 1) await spend(testDb.db, 0.1, NOW);
    // 0.1 x 10 plus 19 is exactly 20 in micro-dollars.
    await expect(assertWithinBudget(testDb.db, { estimateUsd: 19, now: NOW, limits: LIMITS })).resolves.toBeDefined();
  });

  it.each([Number.NaN, -0.01, Number.POSITIVE_INFINITY])("rejects an invalid estimate of %s", async (estimateUsd) => {
    await expect(assertWithinBudget(testDb.db, { estimateUsd, now: NOW, limits: LIMITS })).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });

  it("checks the session before reading anything", async () => {
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Your session has ended."));
    await expect(assertWithinBudget(testDb.db, { estimateUsd: 0, now: NOW, limits: LIMITS })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
