import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Every variable the app reads. Blanking them (the app treats '' as unset)
// keeps tests independent of whatever the developer's shell exports, and an
// SDK constructed by mistake finds no real credentials.
const APP_ENV_VARS = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "BLOB_READ_WRITE_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_TAGGING_MODEL",
  "CLAUDE_ANALYSIS_MODEL",
  "CLAUDE_OUTFIT_MODEL",
  "CLAUDE_ANALYSIS_EFFORT",
  "MONTHLY_AI_BUDGET_USD",
  "AI_CREDIT_USD",
  "APP_PASSWORD_HASH",
  "SESSION_SECRET",
  "CRON_SECRET",
  "FEATURE_SHOPPING_AI",
  "E2E_TAG",
];

export default defineConfig({
  plugins: [react()],
  // Never load .env / .env.local: tests must not see real credentials.
  envDir: false,
  resolve: {
    tsconfigPaths: true,
    alias: {
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "e2e/**"],
    env: Object.fromEntries(APP_ENV_VARS.map((name) => [name, ""])),
  },
});
