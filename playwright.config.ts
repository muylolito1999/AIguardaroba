import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";
import { hashSync } from "bcryptjs";

import { E2E_DATABASE_URL, E2E_PASSWORD } from "./e2e/constants";

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
      DATABASE_URL: E2E_DATABASE_URL,
      DATABASE_URL_UNPOOLED: E2E_DATABASE_URL,
      APP_PASSWORD_HASH,
      SESSION_SECRET,
    },
  },
});
