// `pnpm env:check`: reports, per group, whether the server environment is
// valid, using the same validation the app runs on first use (D-016). The
// report names variables and what is wrong with them, never their values. It
// is informational and always exits 0: a feature only needs its own group.
// Runs under `tsx --conditions=react-server` (D-017).
import "./load-env";

const GROUP_USES: Record<string, string> = {
  db: "the app's database queries",
  session: "login sessions and the proxy",
  password: "the login password",
  blob: "photo uploads",
  ai: "tagging and analyses",
  cron: "the daily batch poll",
  flags: "optional features",
};

async function main(): Promise<void> {
  const { ENV_GROUPS, serverEnvReport } = await import("@/env");
  const report = serverEnvReport(process.env);

  for (const group of ENV_GROUPS) {
    const { ok, problems } = report[group];
    const use = GROUP_USES[group] ?? group;
    if (ok) {
      console.log(`${group.padEnd(9)} OK        (${use})`);
    } else {
      console.log(`${group.padEnd(9)} PROBLEMS  (${use})`);
      for (const problem of problems) console.log(`          - ${problem}`);
    }
  }

  // Not an app group: only drizzle-kit reads it, for migrations.
  const unpooled = process.env.DATABASE_URL_UNPOOLED?.trim();
  console.log(
    unpooled
      ? `${"migrate".padEnd(9)} OK        (pnpm db:migrate)`
      : `${"migrate".padEnd(9)} PROBLEMS  (pnpm db:migrate)\n          - DATABASE_URL_UNPOOLED is not set`,
  );
}

main().catch((error: unknown) => {
  console.error(`env:check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
