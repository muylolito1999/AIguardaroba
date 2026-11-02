// Which real credentials the e2e run may use. Read only from the shell that
// starts Playwright: Playwright never loads .env.local, and playwright.config.ts
// gives the server a blank value for every other app variable (D-102), so a
// token in .env.local can never reach these runs by accident.
//
// Only the smoke spec needs them (e2e/smoke.spec.ts, D-113). The specs that
// assume the server has neither a Blob token nor an API key skip their
// affected tests when one is passed, so run the smoke spec on its own:
//   BLOB_READ_WRITE_TOKEN=… pnpm test:e2e e2e/smoke.spec.ts
// The values are never printed; only whether they are set is used here.

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ""
}

/** The shell has a Blob token: the e2e server gets it and uploads go to that real store. */
export const SHELL_HAS_BLOB_TOKEN = isSet(process.env.BLOB_READ_WRITE_TOKEN)

/** E2E_TAG=1 asks for the paid tagging steps of the smoke spec. */
export const E2E_TAG_REQUESTED = process.env.E2E_TAG === "1"

/** E2E_TAG=1 and the shell has an API key: the e2e server gets the key and Claude is called for real. */
export const SHELL_TAGGING = E2E_TAG_REQUESTED && isSet(process.env.ANTHROPIC_API_KEY)

/** The credentials to pass to the e2e server: only those the shell set and the run asked for. */
export function liveServerEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const token = process.env.BLOB_READ_WRITE_TOKEN
  if (SHELL_HAS_BLOB_TOKEN && isSet(token)) env.BLOB_READ_WRITE_TOKEN = token
  const key = process.env.ANTHROPIC_API_KEY
  if (SHELL_TAGGING && isSet(key)) env.ANTHROPIC_API_KEY = key
  return env
}

export const NEEDS_NO_BLOB_TOKEN =
  "the server has the shell's BLOB_READ_WRITE_TOKEN (a smoke run); this test assumes none, run it without the token"
export const NEEDS_NO_API_KEY =
  "the server has the shell's ANTHROPIC_API_KEY (E2E_TAG=1); this test assumes none, run it without E2E_TAG"
