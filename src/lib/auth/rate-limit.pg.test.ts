import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/lib/db/client";
import { relations } from "@/lib/db/relations";
import { loginAttempts } from "@/lib/db/schema";

import { MAX_FAILURES_PER_WINDOW, reserveLoginAttempt } from "./rate-limit";

// Opt-in check against real Postgres, because PGlite runs one transaction at a
// time and cannot show the race the advisory lock prevents: several pooled
// connections in READ COMMITTED each counting 4 failures and all inserting.
// Run it against a migrated database, for example the Docker e2e one:
//
//   TEST_DATABASE_URL=postgres://wardrobe:wardrobe@localhost:5433/wardrobe_e2e \
//     pnpm exec vitest run src/lib/auth/rate-limit.pg.test.ts
//
// It only touches login_attempts rows under its own random keys and deletes
// them afterwards.

const url = process.env.TEST_DATABASE_URL;
const ROUNDS = 5;
const PARALLEL = 12;

describe.skipIf(!url)("reserveLoginAttempt on real Postgres", () => {
  let pool: Pool;
  let db: Db;
  const keys: string[] = [];

  beforeAll(() => {
    // More connections than the limit, so unserialized checks would overlap.
    pool = new Pool({ connectionString: url, max: 6 });
    db = drizzle({ client: pool, relations });
  });

  afterAll(async () => {
    if (keys.length > 0) await db.delete(loginAttempts).where(inArray(loginAttempts.keyHash, keys));
    await pool.end();
  });

  it(`lets exactly ${MAX_FAILURES_PER_WINDOW} of ${PARALLEL} parallel attempts through per key`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const key = `pg-test-${randomUUID()}`;
      keys.push(key);
      const now = new Date();
      const results = await Promise.all(Array.from({ length: PARALLEL }, () => reserveLoginAttempt(db, key, now)));

      expect(results.filter((result) => result.allowed), `round ${round}`).toHaveLength(MAX_FAILURES_PER_WINDOW);
      expect(await db.$count(loginAttempts, eq(loginAttempts.keyHash, key)), `round ${round}`).toBe(
        MAX_FAILURES_PER_WINDOW,
      );
    }
  });
});
