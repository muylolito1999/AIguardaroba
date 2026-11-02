// `pnpm db:seed`: inserts the Hamburg and Bologna climate profiles and the
// app_settings row. Safe to run repeatedly (see src/lib/climate/seed.ts).
// Runs under `tsx --conditions=react-server`, so `server-only` resolves to its
// empty export (D-017).
import "./load-env";

async function main(): Promise<void> {
  // Imported after load-env so the environment is complete before any module
  // that reads it is evaluated.
  const [{ dbEnv }, { createDb }, { seedDatabase }] = await Promise.all([
    import("@/env"),
    import("@/lib/db/client"),
    import("@/lib/climate/seed"),
  ]);

  const { db, pool } = createDb(dbEnv().DATABASE_URL);
  try {
    const { profiles, appSettings } = await seedDatabase(db);
    for (const [slug, outcome] of Object.entries(profiles)) {
      console.log(`climate profile ${slug}: ${outcome}`);
    }
    console.log(`app_settings: ${appSettings}`);
    console.log("Seed complete.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Messages from env.ts name variables, never values, and pg errors carry no
  // password, so the message is safe to print.
  console.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
