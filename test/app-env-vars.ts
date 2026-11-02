// Every environment variable the app reads, plus E2E_TAG, which the Playwright
// smoke spec reads in the test runner. vitest.config.mts blanks all of them for
// unit tests, and playwright.config.ts blanks all but E2E_TAG for the e2e
// server (passing a real Blob token or API key only from the shell, D-113), so
// neither run sees a developer's real credentials from .env.local. A variable
// the app starts reading belongs here too.
//
// A plain module with no imports: both configs load it outside Next, where
// `server-only` would throw.
export const APP_ENV_VARS = [
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
] as const;
