import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs only from the terminal (`pnpm db:generate`, `pnpm db:migrate`,
// `pnpm db:studio`), never in the Vercel build: migrations are applied by hand
// before a deploy that ships one (README, Deploy).

loadEnvConfig(process.cwd());

// Commands that work from the schema and the migrations folder alone. Every
// other command connects to a database.
const OFFLINE_COMMANDS = new Set(["generate", "check", "up", "export"]);
const CONNECTING_COMMANDS = new Set(["migrate", "push", "pull", "introspect", "studio"]);

function kitCommand(argv: readonly string[]): string | undefined {
  return argv.slice(2).find((arg) => OFFLINE_COMMANDS.has(arg) || CONNECTING_COMMANDS.has(arg));
}

// Migrations use the direct connection: DDL and the migrator's advisory lock do
// not belong on Neon's pooled (PgBouncer) endpoint. There is deliberately no
// fallback to the pooled DATABASE_URL (D-009). An empty value counts as unset,
// as in src/env.ts.
const unpooledUrl = process.env.DATABASE_URL_UNPOOLED?.trim() || undefined;
const command = kitCommand(process.argv);
// An unrecognised command is treated as connecting, so it fails loudly here
// instead of later with a less helpful driver error.
const needsDatabase = command === undefined || !OFFLINE_COMMANDS.has(command);

if (needsDatabase && unpooledUrl === undefined) {
  const subject = command === undefined ? "This drizzle-kit command" : "drizzle-kit " + command;
  throw new Error(
    `DATABASE_URL_UNPOOLED is not set. ${subject} needs the direct (unpooled) Postgres URL; ` +
      "the pooled DATABASE_URL is not used for migrations. Set it in .env.local (see .env.example).",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  verbose: true,
  ...(unpooledUrl === undefined ? {} : { dbCredentials: { url: unpooledUrl } }),
});
