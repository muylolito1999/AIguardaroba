import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { E2E_DATABASE_URL, E2E_PASSWORD } from "./e2e/constants";
import { liveServerEnv } from "./e2e/live-env";
import { APP_ENV_VARS } from "./test/app-env-vars";

// Every app variable starts blank on the e2e server. `next build` and
// `next start` load .env.local through @next/env, which fills only keys that
// are undefined in process.env; a key set to "" counts as defined, so the file
// cannot fill it, and src/env.ts treats a blank value as unset. Without this,
// a real ANTHROPIC_API_KEY or BLOB_READ_WRITE_TOKEN in .env.local would reach
// the server, and the specs, which assume neither exists, would make paid
// Claude calls and upload to the production Blob store. E2E_TAG stays out: the
// smoke spec reads it in the test runner, not the server. Real credentials
// reach the server only through liveServerEnv() below, never by inheritance.
const BLANK_APP_ENV = Object.fromEntries(
  APP_ENV_VARS.filter((name) => name !== "E2E_TAG").map((name) => [name, ""]),
);

// The e2e server gets its own throwaway credentials. Process variables take
// precedence over .env files in Next, so a developer's .env.local cannot point
// these runs at the dev database or a real password. Cost 4 keeps the hash
// cheap; env.ts checks the bcrypt format, not the cost. The secret is new on
// every run, so sessions from an earlier run never verify.
const APP_PASSWORD_HASH = Buffer.from(hashSync(E2E_PASSWORD, 4)).toString("base64");
const SESSION_SECRET = randomBytes(36).toString("base64url"); // 48 characters

// Local-only, headed runs against a production build: Cache Components errors
// and the service worker only behave realistically outside `next dev`.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    headless: false,
    trace: "retain-on-failure",
  },
  // Chromium accepts the Secure session cookie on http://localhost.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm build && pnpm start",
    url: "http://localhost:3000",
    reuseExistingServer: false,
    timeout: 240_000,
    // Merged over process.env; NODE_ENV is left to `next build` and `next start`.
    env: {
      ...BLANK_APP_ENV,
      DATABASE_URL: E2E_DATABASE_URL,
      DATABASE_URL_UNPOOLED: E2E_DATABASE_URL,
      APP_PASSWORD_HASH,
      SESSION_SECRET,
      // Only what the runner's shell set (D-113): BLOB_READ_WRITE_TOKEN when it
      // is set there, ANTHROPIC_API_KEY only with E2E_TAG=1 as well. Otherwise
      // both stay blank as above. Never read from .env.local.
      ...liveServerEnv(),
    },
  },
});
