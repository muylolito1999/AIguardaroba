import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { estimateTaggingDryRunUsd, taggingCostRates } from "@/lib/ai/cost";
import type { Db } from "@/lib/db/client";
import { aiCalls } from "@/lib/db/schema";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { getTaggingSetup, getTaggingSetupResult } from "./tagging-setup";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const NOW = new Date("2026-11-15T12:00:00Z");

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.close();
});

/**
 * A fresh copy of the module with an unpriced tagging model. The env getters
 * keep the first valid parse, so a module that has read the settings once
 * would never see the override.
 */
async function withUnpricedModel(): Promise<typeof import("./tagging-setup")> {
  vi.stubEnv("CLAUDE_TAGGING_MODEL", "claude-unpriced-9");
  vi.resetModules();
  return import("./tagging-setup");
}

describe("getTaggingSetup", () => {
  it("returns the configured model, its rates including the batch dry run, and the month's budget", async () => {
    await testDb.db
      .insert(aiCalls)
      .values({ model: "claude-haiku-5-5", purpose: "tagging", status: "success", costUsd: 1.5, createdAt: NOW });

    const setup = await getTaggingSetup(testDb.db, NOW);

    expect(setup.model).toEqual({ id: "claude-haiku-5-5", label: "Haiku 5.5" });
    expect(setup.costQuote).toEqual({
      standard: taggingCostRates("claude-haiku-5-5"),
      batch: taggingCostRates("claude-haiku-5-5", { batch: true }),
      dryRunUsd: estimateTaggingDryRunUsd("claude-haiku-5-5"),
    });
    expect(setup.budget.resetsAt).toBe("2026-12-01T00:00:00.000Z");
    expect(setup.budget.remainingUsd).toBeCloseTo(setup.budget.budgetUsd - 1.5, 6);
    expect(requireSession).toHaveBeenCalled();
  });

  it("refuses without a session before reading anything", async () => {
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in to continue."));

    await expect(getTaggingSetup(testDb.db, NOW)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("throws CONFIG for an unpriced tagging model", async () => {
    const fresh = await withUnpricedModel();

    await expect(fresh.getTaggingSetup(testDb.db, NOW)).rejects.toMatchObject({ code: "CONFIG" });
  });
});

describe("getTaggingSetupResult", () => {
  it("wraps the setup in an Ok", async () => {
    expect(await getTaggingSetupResult(testDb.db, NOW)).toEqual({
      ok: true,
      data: await getTaggingSetup(testDb.db, NOW),
    });
  });

  it("turns a CONFIG error into an Err with the safe message, and logs the detail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = await withUnpricedModel();

    const result = await fresh.getTaggingSetupResult(testDb.db, NOW);

    expect(result).toEqual({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } });
    expect(JSON.stringify(result)).not.toContain("CLAUDE_TAGGING_MODEL");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[1])).toContain("CLAUDE_TAGGING_MODEL");
  });

  it("rethrows anything else: no session, or a database failure", async () => {
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Sign in to continue."));
    await expect(getTaggingSetupResult(testDb.db, NOW)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const broken = {
      select: () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as Db;
    await expect(getTaggingSetupResult(broken, NOW)).rejects.toThrow("connection terminated unexpectedly");
  });
});
