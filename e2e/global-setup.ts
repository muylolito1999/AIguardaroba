import path from "node:path";

import type { FullConfig } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { seedDatabase } from "@/lib/climate/seed";
import { relations } from "@/lib/db/relations";

import { E2E_DATABASE_URL } from "./constants";

// Every run starts from the same state: the committed migrations applied, every
// app table empty (login attempts included, so the rate limit never carries
// over between runs), then the climate profiles and app_settings seeded. The
// database client is built here rather than through src/lib/db/client.ts,
// because that module imports `server-only`, which throws outside Next.

const E2E_DATABASE_LABEL = "localhost:5433/wardrobe_e2e";
// Lives in the "drizzle" schema by default; excluded by name as well, so the
// migration history survives even if it is ever moved into public.
const MIGRATIONS_TABLE = "__drizzle_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function assertReachable(pool: Pool): Promise<void> {
  try {
    await pool.query("select 1");
  } catch (error) {
    // pg error messages carry no password, so the reason is safe to print.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach the e2e database at ${E2E_DATABASE_LABEL} (${reason}). ` +
        "Start it with `docker compose up -d db` and run the e2e tests again. " +
        "If it says wardrobe_e2e does not exist, the Docker volume predates docker/init: " +
        "recreate it with `docker compose down -v` (this also empties the local dev database), " +
        "then `docker compose up -d db`.",
      { cause: error },
    );
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const projectRoot = config.configFile ? path.dirname(config.configFile) : process.cwd();
  const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2, connectionTimeoutMillis: 5_000 });
  try {
    await assertReachable(pool);

    const db = drizzle({ client: pool, relations });
    await migrate(db, { migrationsFolder: path.join(projectRoot, "drizzle") });

    const { rows } = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> $1 order by tablename",
      [MIGRATIONS_TABLE],
    );
    if (rows.length > 0) {
      const tables = rows.map(({ tablename }) => `public.${quoteIdentifier(tablename)}`).join(", ");
      await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
    }

    await seedDatabase(db);
  } finally {
    await pool.end();
  }
}
