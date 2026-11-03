import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnthropicLike } from "@/lib/ai/client";
import type { Db } from "@/lib/db/client";
import { relations } from "@/lib/db/relations";
import { aiCalls, analyses, climateProfiles, shoppingListItems } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

import { createFakeAnthropic, fakeMessage } from "../../../test/fakes/anthropic";
import { fakeShoppingAdviceReply } from "../../../test/outfit-fixtures";
import { runShoppingAdvice } from "./shopping-advice";

// Opt-in check against real Postgres (D-220), because PGlite runs one
// transaction at a time and cannot show two requests passing the "nothing is
// running" check together. Six requests for the same ranking start at once,
// as from several tabs; the fake Claude answers after a delay, so they all
// overlap. Without the advisory lock more than one could insert a running
// row and pay. Run it against a migrated and seeded database (it needs the
// Hamburg climate profile and no other shopping rows), for example the
// Docker e2e one:
//
//   TEST_DATABASE_URL=postgres://wardrobe:wardrobe@localhost:5433/wardrobe_e2e \
//     pnpm exec vitest run src/server/services/shopping-advice.pg.test.ts
//
// It writes one shopping row under a random name and the analyses and
// ai_calls of the run it allows, and deletes them afterwards.

const mocks = vi.hoisted(() => ({ requireSession: vi.fn(), flagsEnv: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/env")>()),
  flagsEnv: mocks.flagsEnv,
}));

const url = process.env.TEST_DATABASE_URL;
const REQUESTS = 6;
const CLAUDE_DELAY_MS = 300;

describe.skipIf(!url)("runShoppingAdvice on real Postgres", () => {
  let pool: Pool;
  let db: Db;
  const itemType = `pg-advice ${randomUUID()} waterproof shell jacket`;
  let rowId: string | null = null;
  /** The shopping analyses that existed before, which the clean-up leaves alone. */
  let before = new Set<string>();

  beforeAll(async () => {
    mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
    mocks.flagsEnv.mockReturnValue({ FEATURE_SHOPPING_AI: true });
    pool = new Pool({ connectionString: url, max: REQUESTS + 2 });
    db = drizzle({ client: pool, relations });
    const [hamburg] = await db.select({ id: climateProfiles.id }).from(climateProfiles).where(eq(climateProfiles.slug, "hamburg"));
    if (hamburg === undefined) throw new Error("Seed the database first: the Hamburg climate profile is missing.");
    const [row] = await db
      .insert(shoppingListItems)
      .values({ itemType, category: "outerwear", priority: 1, estPriceMinEur: 120 })
      .returning({ id: shoppingListItems.id });
    rowId = row?.id ?? null;
    const existing = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.kind, "shopping"));
    before = new Set(existing.map((entry) => entry.id));
  });

  afterAll(async () => {
    const after = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.kind, "shopping"));
    const ids = after.map((entry) => entry.id).filter((id) => !before.has(id));
    if (ids.length > 0) {
      await db.delete(aiCalls).where(inArray(aiCalls.analysisId, ids));
      await db.delete(analyses).where(inArray(analyses.id, ids));
    }
    if (rowId !== null) await db.delete(shoppingListItems).where(eq(shoppingListItems.id, rowId));
    await pool.end();
  });

  it("lets exactly one of several simultaneous requests pay; the others get CONFLICT", async () => {
    const fake = createFakeAnthropic(
      Array.from({ length: REQUESTS }, () => fakeMessage({ json: fakeShoppingAdviceReply(["c1"]), model: "claude-sonnet-5-5" })),
    );
    const slow: AnthropicLike = {
      messages: {
        create: async (params, options) => {
          await new Promise((resolve) => setTimeout(resolve, CLAUDE_DELAY_MS));
          return await fake.messages.create(params, options);
        },
        stream: fake.messages.stream.bind(fake.messages),
        batches: fake.messages.batches,
      },
    };

    const outcomes = await Promise.all(
      Array.from({ length: REQUESTS }, () =>
        runShoppingAdvice(db, { anthropic: () => slow, deadlineAt: Date.now() + 110_000, sleep: async () => {} }).then(
          (run) => run.outcome,
          (error: unknown) => (error instanceof AppError ? error.code : `error ${String(error)}`),
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === "ran")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "CONFLICT")).toHaveLength(REQUESTS - 1);
    expect(fake.requests).toHaveLength(1);
  }, 60_000);
});
