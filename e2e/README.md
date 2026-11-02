# End-to-end tests

Playwright specs that run locally only, in a visible (headed) Chromium window, against a production build that `pnpm test:e2e` starts itself with `pnpm build && pnpm start` (see `playwright.config.ts`). They are not part of `pnpm test` and are never pointed at a deployment.

## Running

1. Once: `pnpm exec playwright install chromium`.
2. Every time: `docker compose up -d db`, then `pnpm test:e2e`. One spec: `pnpm test:e2e e2e/auth.spec.ts`.

No `.env.local` is needed. The config gives the server its own environment, which overrides anything in `.env.local`:

- `DATABASE_URL` and `DATABASE_URL_UNPOOLED` point at the Docker `wardrobe_e2e` database, never at `wardrobe`, so local data is never touched.
- `APP_PASSWORD_HASH` is the base64 bcrypt hash (cost 4, for speed) of `E2E_PASSWORD` in `constants.ts`, a fixed password that only works on this throwaway server.
- `SESSION_SECRET` is random and new on every run, so a session from an earlier run never verifies.

`global-setup.ts` runs once per run, after the server has started: it applies the migrations in `drizzle/` to `wardrobe_e2e`, empties every table (login attempts included, so the login rate limit never carries over between runs) and seeds the climate profiles and `app_settings`. If the database is unreachable it stops with a message saying to run `docker compose up -d db`.

Chromium accepts the `Secure` session cookie on `http://localhost`, so the auth specs run without HTTPS.

## Specs

- `auth.spec.ts`: redirects to `/login?next=…` when signed out; the PWA files and `/offline` stay public; `/api/*` answers 401 JSON; a wrong password shows the error; the right one sets the httpOnly, Secure, SameSite=Lax cookie and returns to `next`; with JavaScript disabled, a wrong password still shows the error and signing in still returns to `next` (D-054); logout from Settings; `/login` while signed in goes to `/wardrobe`; and a cookieless POST with a forged `Next-Action` header returns no app page and no item data (D-013).
