import "server-only";

import { dbEnv } from "@/env";

import { createDb, type Db } from "./client";

export type { Db } from "./client";

let instance: Db | undefined;

/**
 * The app's database, created on first use so builds and pages that never
 * query it need no DATABASE_URL. Services take a `Db` parameter instead of
 * calling this, so tests can pass a PGlite database.
 */
export function getDb(): Db {
  instance ??= createDb(dbEnv().DATABASE_URL).db;
  return instance;
}
