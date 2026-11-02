import "server-only";

import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";

import { relations, type Relations } from "./relations";

/**
 * The database handle every service takes. It is the driver-agnostic async
 * Postgres type, so the node-postgres database used at runtime and the PGlite
 * database used in tests (test/db.ts) are both assignable to it.
 */
export type Db = PgAsyncDatabase<PgQueryResultHKT, Relations>;

/**
 * Builds a pooled node-postgres client (D-009). Fluid compute reuses one
 * instance for many requests, so a small pool is enough, and idle connections
 * close quickly so a suspended instance does not hold Neon connections.
 * attachDatabasePool lets Vercel drain the pool before it suspends the instance;
 * outside Vercel it does nothing.
 */
export function createDb(url: string): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    // An unreachable database fails the request after 10 s instead of holding
    // it until the function's maxDuration.
    connectionTimeoutMillis: 10_000,
  });
  // pg-pool re-emits errors of idle clients (Neon restarting or suspending a
  // compute, a proxy reset) as a pool 'error' event. Without a listener Node
  // throws it as an unhandled 'error' event and the whole instance, with every
  // request it is serving, goes down. The broken client is already removed
  // from the pool, and the next query opens a new connection.
  pool.on("error", (error) => {
    console.error("[db] idle client error", error);
  });
  attachDatabasePool(pool);
  const db = drizzle({ client: pool, relations });
  return { db, pool };
}
