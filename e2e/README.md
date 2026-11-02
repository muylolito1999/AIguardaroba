# End-to-end tests

Playwright specs that run locally only, in a visible (headed) Chromium window, against a production build that `pnpm test:e2e` starts itself with `pnpm build && pnpm start` (see `playwright.config.ts`). They are not part of `pnpm test` and are never pointed at a deployment.

## Running

1. Once: `pnpm exec playwright install chromium`.
2. Every time: `docker compose up -d db`, then `pnpm test:e2e`. One spec: `pnpm test:e2e e2e/auth.spec.ts`.

No `.env.local` is needed. The config gives the server its own environment, which overrides anything in `.env.local`:

- `DATABASE_URL` and `DATABASE_URL_UNPOOLED` point at the Docker `wardrobe_e2e` database, never at `wardrobe`, so local data is never touched.
- `APP_PASSWORD_HASH` is the base64 bcrypt hash (cost 4, for speed) of `E2E_PASSWORD` in `constants.ts`, a fixed password that only works on this throwaway server.
- `SESSION_SECRET` is random and new on every run, so a session from an earlier run never verifies.
- Every other app variable (`BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_TAGGING_MODEL`, `CLAUDE_ANALYSIS_MODEL`, `CLAUDE_OUTFIT_MODEL`, `CLAUDE_ANALYSIS_EFFORT`, `MONTHLY_AI_BUDGET_USD`, `AI_CREDIT_USD`, `CRON_SECRET`, `FEATURE_SHOPPING_AI`) is set to an empty value, so values in `.env.local` never reach the e2e server: `@next/env` only fills variables that are undefined, and the app treats a blank one as unset. The list is `test/app-env-vars.ts`, which Vitest uses too. `E2E_TAG` is left alone: it is reserved for the planned Phase 4 smoke spec, which will read it in the test runner, not the server; no spec reads it yet. That spec must pass a real API key and Blob token through `webServer.env` in `playwright.config.ts` (D-102): values in `.env.local` never reach the e2e server, and Playwright does not load `.env.local` itself.

`global-setup.ts` runs once per run, after the server has started: it applies the migrations in `drizzle/` to `wardrobe_e2e`, empties every table (login attempts included, so the login rate limit never carries over between runs) and seeds the climate profiles and `app_settings`. If the database is unreachable it stops with a message saying to run `docker compose up -d db`.

Chromium accepts the `Secure` session cookie on `http://localhost`, so the auth specs run without HTTPS.

## Specs

- `auth.spec.ts`: redirects to `/login?next=…` when signed out; the PWA files and `/offline` stay public; `/api/*` answers 401 JSON; a wrong password shows the error; the right one sets the httpOnly, Secure, SameSite=Lax cookie and returns to `next`; with JavaScript disabled, a wrong password still shows the error and signing in still returns to `next` (D-054); logout from Settings; `/login` while signed in goes to `/wardrobe`; and a cookieless POST with a forged `Next-Action` header returns no app page and no item data (D-013).
- `add.spec.ts`: the add page renders without a Blob token or an Anthropic key; picked photos are prepared and their source hashes checked (the check is held with `page.route` so the Checking state can be seen), then each photo and a toast report that uploads are not configured; no item row is created and no request reaches Blob storage (requests to the Blob API at `vercel.com/api/blob` are routed, recorded and aborted, and none may be made). The fixture JPEGs are generated with sharp while the spec runs.
- `add-tagging.spec.ts`: the add page's tagging controls with storage and Claude answered in the browser (`page.route` for `/api/blob/upload`, the Blob store's PUT, `/api/items/register` and `/api/items/<id>/tag`); the page, session, hash check and budget read are the real build. Two ready photos get the quote, the remaining budget and Start tagging; 21 get the batch offer; toasts stay off the bar at 390 and 1280 px, both stuck to the bottom (21 photos) and in the flow of a short page (2 photos); a BUDGET_EXCEEDED answer shows the budget alert and disables tagging; following a link while an upload runs opens the leave dialog, and Stay keeps the page; coming back to `/add` after leaving starts with an empty list, and leaving again does not ask. Screenshots go to each test's output folder and the HTML report.
- `review.spec.ts`: seeds a tagged item (with a low materials confidence), a pending item with a stored tagging error and a plain pending item, all pointing at a local icon instead of Blob. Editing the name and adding a season, then confirming, leaves the item `confirmed` with both fields in `user_edited_fields`; the stored error shows with Retry; Tag now without an API key shows the error and leaves the item `pending_tagging`; an item filled in by hand ("Fill in by hand", Save and confirm) is confirmed with `ai_raw` and `tagging_error` empty, its fields in `user_edited_fields` and no `ai_calls` row, and an item linked to a (processed) batch row does not offer the button; no sideways scrolling at 390 px; the bulk "Tag N waiting items" control quotes the waiting items, and running it without an API key leaves each card with its error and Retry (screenshots at 1280 and 390 px). The seeded rows and the batch row are deleted afterwards.
- `usage.spec.ts`: Settings links to `/settings/usage`; the month-to-date total and the Tagging row match figures read from the database (other specs may log calls of their own); at 390 px the tables scroll inside their own box, not the page.

None of the specs calls Claude or Blob; real tagging and uploads are live checks (HANDOFF.md).
