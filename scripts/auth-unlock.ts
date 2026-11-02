// `pnpm auth:unlock`: deletes every row in login_attempts, lifting all login
// rate-limit locks (D-014). Use it when the owner is locked out. Runs under
// `tsx --conditions=react-server` (D-017).
import "./load-env";

async function main(): Promise<void> {
  // Imported after load-env so the environment is complete before any module
  // that reads it is evaluated.
  const [{ dbEnv }, { createDb }, { clearLoginAttempts }] = await Promise.all([
    import("@/env"),
    import("@/lib/db/client"),
    import("@/lib/auth/rate-limit"),
  ]);

  const { db, pool } = createDb(dbEnv().DATABASE_URL);
  try {
    const removed = await clearLoginAttempts(db);
    console.log(`Removed ${removed} login attempt${removed === 1 ? "" : "s"}. Login is unlocked for every client.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // env.ts messages name variables, never values, and pg errors carry no password.
  console.error(`Unlock failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
