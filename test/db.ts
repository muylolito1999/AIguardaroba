import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { getTableName, isTable, sql, type Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { Db } from "@/lib/db/client";
import { relations } from "@/lib/db/relations";
import * as schema from "@/lib/db/schema";

// DB tests run the committed migrations on an in-memory PGlite (D-046), so they
// exercise the same SQL that `pnpm db:migrate` applies to Neon and Docker.
// The migrations need no extension: gen_random_uuid() is built into Postgres.

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Every table the schema module exports, found by value rather than by a hand-kept list. */
export function schemaTables(): Table[] {
  const exported: unknown[] = Object.values(schema);
  return exported.filter((value): value is Table => isTable(value));
}

/** The DB names of every exported table. */
export function schemaTableNames(): string[] {
  return schemaTables()
    .map((table) => getTableName(table))
    .sort();
}

export type TestDb = {
  db: Db;
  client: PGlite;
  /** Empties every app table; call it in beforeEach (or afterEach) to isolate tests. */
  truncateAll(): Promise<void>;
  /** Releases the PGlite instance; call it in afterAll. */
  close(): Promise<void>;
};

export async function makeTestDb(): Promise<TestDb> {
  const client = await PGlite.create();
  const pgliteDb = drizzle({ client, relations });
  await migrate(pgliteDb, { migrationsFolder: MIGRATIONS_FOLDER });

  const tableList = sql.raw(
    schemaTableNames()
      .map((name) => `"${name}"`)
      .join(", "),
  );

  return {
    db: pgliteDb,
    client,
    async truncateAll() {
      await pgliteDb.execute(sql`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    },
    async close() {
      await client.close();
    },
  };
}
