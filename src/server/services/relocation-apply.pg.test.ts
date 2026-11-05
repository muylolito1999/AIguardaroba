import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { relations } from "@/lib/db/relations";
import { analyses, items } from "@/lib/db/schema";
import type { RelocationDecision } from "@/lib/relocation/contracts";

import { TAGGED_ITEM_FIELDS } from "../../../test/factories";
import { makeRelocationResult } from "../../../test/relocation-fixtures";
import { applyAiDecisionsToUndecided } from "./relocation";

// Opt-in check against real Postgres (D-166), because PGlite runs one
// transaction at a time and cannot show a deadlock. Two finished runs whose
// first decision groups cross (run A brings the first half and leaves the
// second, run B lists the second half first and brings it) are applied at
// once, as from two tabs. Without the ordered lock one of them failed with
// 40P01 in every round. Run it against a migrated database, for example the
// Docker e2e one:
//
//   TEST_DATABASE_URL=postgres://wardrobe:wardrobe@localhost:5433/wardrobe_e2e \
//     pnpm exec vitest run src/server/services/relocation-apply.pg.test.ts
//
// It only touches its own rows (300 items named after a random prefix and two
// analyses) and deletes them afterwards. The last item has moved to running
// gear since the runs, so both applies must leave it undecided (D-249).

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const url = process.env.TEST_DATABASE_URL;
const ITEMS = 300;
const ROUNDS = 20;

/** The Postgres error under the wrappers, as "40P01 deadlock detected". */
function driverError(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ("code" in current && typeof current.code === "string") return `${current.code} ${current.message}`;
    current = current.cause;
  }
  return String(error);
}

describe.skipIf(!url)("applyAiDecisionsToUndecided on real Postgres", () => {
  let pool: Pool;
  let db: Db;
  const prefix = `pg-apply-${randomUUID()}`;
  let itemIds: string[] = [];
  let runningId = "";
  const analysisIds: string[] = [];

  beforeAll(async () => {
    requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
    pool = new Pool({ connectionString: url, max: 12 });
    db = drizzle({ client: pool, relations });
    const inserted = await db
      .insert(items)
      .values(
        Array.from({ length: ITEMS }, (_, index) => ({
          ...TAGGED_ITEM_FIELDS,
          status: "confirmed" as const,
          collection: index === ITEMS - 1 ? ("running" as const) : ("clothing" as const),
          name: `${prefix} ${index}`,
          imageHash: `${randomUUID()}${randomUUID()}`.replaceAll("-", "").slice(0, 64),
        })),
      )
      .returning({ id: items.id });
    itemIds = inserted.map((row) => row.id);
    runningId = itemIds[ITEMS - 1] ?? "";

    const half = ITEMS / 2;
    const decided = (ids: readonly string[], first: RelocationDecision, second: RelocationDecision) =>
      makeRelocationResult(ids).items.map((entry, index) => ({ ...entry, decision: index < half ? first : second }));
    // A: bring for the first half, then leave. B: the second half first, as bring, then the first half as leave.
    const runA = makeRelocationResult(itemIds);
    const reordered = [...itemIds.slice(half), ...itemIds.slice(0, half)];
    const runB = makeRelocationResult(reordered);
    for (const [result, ids] of [
      [{ ...runA, items: decided(itemIds, "bring", "leave") }, itemIds],
      [{ ...runB, items: decided(reordered, "bring", "leave") }, reordered],
    ] as const) {
      expect(result.items.map((entry) => entry.item_id)).toEqual(ids);
      const [row] = await db
        .insert(analyses)
        .values({
          kind: "relocation",
          status: "complete",
          model: "claude-sonnet-5-5",
          promptVersion: "pg-test",
          result,
          completedAt: new Date(),
        })
        .returning({ id: analyses.id });
      if (row === undefined) throw new Error("analysis not inserted");
      analysisIds.push(row.id);
    }
  });

  afterAll(async () => {
    if (analysisIds.length > 0) await db.delete(analyses).where(inArray(analyses.id, analysisIds));
    if (itemIds.length > 0) await db.delete(items).where(inArray(items.id, itemIds));
    await pool.end();
  });

  it("applies two runs at once without a deadlock, round after round", async () => {
    const [runA, runB] = analysisIds;
    if (runA === undefined || runB === undefined) throw new Error("no analyses");
    for (let round = 0; round < ROUNDS; round += 1) {
      await db.update(items).set({ decision: "undecided" }).where(inArray(items.id, itemIds));

      const outcomes = await Promise.allSettled([
        applyAiDecisionsToUndecided(db, runA),
        applyAiDecisionsToUndecided(db, runB),
      ]);

      const failures = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [driverError(outcome.reason)] : []));
      expect(failures.join("; "), `round ${round}`).toBe("");
      // Every clothing item got a decision; the running one kept none (D-249).
      const left = await db
        .select({ id: items.id })
        .from(items)
        .where(and(inArray(items.id, itemIds), eq(items.decision, "undecided")));
      expect(
        left.map((row) => row.id),
        `round ${round}`,
      ).toEqual([runningId]);
    }
  }, 120_000);
});
