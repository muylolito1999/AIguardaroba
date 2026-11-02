import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

import { APP_ENV_VARS } from "./test/app-env-vars";

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
    // Blanking every app variable (the app treats '' as unset) keeps tests
    // independent of whatever the developer's shell exports, and an SDK
    // constructed by mistake finds no real credentials.
    env: Object.fromEntries(APP_ENV_VARS.map((name) => [name, ""])),
  },
});
