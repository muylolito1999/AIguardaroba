# Handoff

Newest entry first. Each entry records the state at the end of a working session. Task tracking lives in Beads (`bd ready`, `bd show <id>`); the reasons behind choices are in [DECISIONS.md](DECISIONS.md).

## 2026-11-02 — Phase 2 (database + auth) complete

### State

Phase 2 is wardrobe-52y, now closed and committed. The code is complete and reviewed. The gate passes with no `.env.local`, the local Docker database migrates and seeds, and the headed e2e suite passes.

Database:

- `docker-compose.yml` (Postgres 18 on port 5433) with `docker/init` creating `wardrobe_e2e` next to `wardrobe`.
- `drizzle.config.ts`, which requires `DATABASE_URL_UNPOOLED` for every connecting command.
- The schema in `src/lib/db/` (enums, 14 tables, relations, the pooled `pg` client, `getDb()`) and the migration `drizzle/20261102094305_init`.
- The climate data and seeder in `src/lib/climate/`, with `scripts/seed.ts` and `scripts/load-env.ts`.
- The PGlite test harness and row factories in `test/`.

Auth:

- `src/lib/auth/` holds the token, session cookie, DAL, password, rate limit, client key and safe redirect.
- `src/proxy.ts` with the pure `decideAuth`.
- The `authedRoute` wrapper (`src/server/http.ts`) and `authedAction` (`src/server/actions/_wrap.ts`).
- The login and logout actions, and the login service.
- The scripts `hash-password`, `auth:unlock` and `env:check`.
- The UI: the `(auth)` layout, `/login`, the logout button in Settings (Account) and in the sidebar footer.
- The e2e setup: `playwright.config.ts` with its own server environment, `e2e/global-setup.ts`, `e2e/constants.ts` and `e2e/auth.spec.ts`.

README has new Database and Authentication sections and an updated Testing section.

The integration run found one bug, fixed before the review. A wrong password without JavaScript showed a blank page. Next 16.4.3 answers a form-posted Server Action on a partially prerendered route with only the dynamic part, and the first `/login` read `searchParams` on the server. `/login` is now fully static: the hidden `next` field renders on the client, and the action falls back to the Referer (D-054).

The review then led to these fixes:

- Open redirect: `safeRedirect` checked only the raw `next` value, so `/.//evil.com`, `/a/..//evil.com` and `/%2e//evil.com` normalized to `//evil.com`. That reached the proxy's redirect for a signed-in visitor on `/login` and the login action. The normalized path is now checked as well. Unit, proxy and e2e tests cover it.
- The session cookie is now `__Host-wardrobe_session`, so a subdomain cannot plant or shadow it.
- The login rate limit counts an IPv6 client as its /64 and an IPv4-mapped address as the IPv4 address. The code comment, D-059 and README now say the per-client limit relies on a proxy that overwrites `x-forwarded-for`, as Vercel does.
- The runtime `pg` pool has an `error` listener, so an idle connection dropped by Neon no longer crashes the instance. It also has a 10 s connection timeout.
- Every foreign-key column now has a leading index except the single-row `app_settings.home_profile_id`, and a migration test checks this. The init migration was regenerated, since nothing had been deployed.
- `test/boundaries.test.ts` now requires `import "server-only"` in every module under `src/lib/auth` and `src/server`, except `token.ts`, `safe-redirect.ts` and `'use server'` modules. It forbids every `@/lib/auth` module in client code except `safe-redirect`. It also checks the D-013 rule: every exported async function in `src/server/services` must call `requireSession()` or `verifySession()`. Only `login.ts`'s `attemptLogin` is exempt, and the list gives the reason.
- The PGlite concurrency test no longer claims to prove the advisory lock. A new test checks that the lock statement runs first in the transaction. The opt-in `src/lib/auth/rate-limit.pg.test.ts` checks the race on real Postgres.
- README: after a suspected compromise, rotate `SESSION_SECRET` as well as the password, because a password change does not end existing sessions.

### Decisions

D-054 to D-059 are new: the login form without JavaScript, the proxy behaviour and matcher changes, the isolated e2e database, re-seeding that keeps the owner's data, the schema details settled in this phase, and session and login details. The review fixes updated D-055 (normalized redirect check), D-058 (foreign-key indexes, the regenerated migration) and D-059 (`__Host-` cookie, IPv6 /64, the trust limit of `x-forwarded-for`, password change versus secret rotation). D-012 and D-013 point to the entries that refine them. None are open.

### Checks run

An integration run from 10:13 to 10:24 passed: the gate, Docker migrate and seed, and headed e2e with 11 of 11. It ran on the previous migration (`20261102084605_init`) and cookie name. The review fixes changed both, so the checks were run again on 2026-11-02 (times UTC+1):

- Before the cookie rename, a probe page on `http://localhost` showed that Playwright's Chromium stores a `__Host-` cookie over plain HTTP on localhost and sends it back.
- 10:41 `src/lib/auth/rate-limit.pg.test.ts` against the Docker `wardrobe_e2e` database: passed. With the advisory lock temporarily removed it failed as expected: 6 of 12 parallel reservations got through. The lock was then restored.
- 10:43 `pnpm db:generate --name init`, after deleting the old folder: the SQL differs from the old init only by the six new `CREATE INDEX` statements. `drizzle-kit check`: "Everything's fine".
- 10:44 `docker compose down -v` (this project's volume only), then `docker compose up -d db`: healthy, with `wardrobe` and `wardrobe_e2e` created.
- Gate with no env file except `.env.example`:
  - 10:44:25 `pnpm typecheck`: passed.
  - 10:44:30 `pnpm lint`: passed with no findings.
  - 10:44:43 `pnpm test`: passed. 21 files and 383 tests passed. One file and one test were skipped: the opt-in real-Postgres test.
  - 10:44:54 `pnpm build`: passed. 12 of 12 static pages, every route static including `/login`, and the proxy present.
- With the DB-only `.env.local`:
  - 10:45:09 `pnpm db:migrate`: applied `20261102094305_init`.
  - 10:45:11 `pnpm db:seed`: Hamburg inserted, Bologna inserted, `app_settings` created.
  - 10:45:12 `pnpm db:seed` again: Hamburg updated, Bologna kept, `app_settings` kept.
  - 10:45:19 the database had 14 public tables, 18 enums, all six new foreign-key indexes and one migration row (`20261102094305_init`). `pnpm env:check`: `db` and `migrate` OK; the other groups report their unset variables, as expected with this file.
- 10:45:31 `pnpm test:e2e` (headed Chromium, production build): 11 of 11 passed.
- 10:46:11 `pnpm test:e2e` again, after adding "a next that normalizes to another host is ignored": 12 of 12 passed. The server logged "Failed to find Server Action" for the forged-action test, which is that test's expected path.
- 10:46:32 `rate-limit.pg.test.ts` against `wardrobe_e2e`, now migrated by the e2e setup: passed, with exactly 5 of 12 parallel attempts allowed in each of 5 rounds. Its rows were removed afterwards.
- The gate again after the last code change (the new e2e test), with no env file except `.env.example`; all four passed:
  - 10:48:17 `pnpm typecheck`.
  - 10:48:21 `pnpm lint`.
  - 10:48:27 `pnpm test`: 21 files and 383 tests passed, 1 skipped.
  - 10:48:32 `pnpm build`: 12 of 12 static pages, `/login` static.
- An independent re-run before the commit, on the final tree:
  - With `.env.local` moved out of the project: 10:49:54 `pnpm typecheck` passed; 10:50:00 `pnpm lint` passed; 10:50:00 `pnpm test` passed (21 files and 383 tests, 1 opt-in file skipped); 10:50:15 `pnpm build` passed with every route static.
  - With the DB-only `.env.local` restored: 10:50:22 `pnpm db:migrate` succeeded (nothing new to apply); 10:50:23 `pnpm db:seed` gave Hamburg updated, Bologna kept, `app_settings` kept; `pnpm env:check` reported `db` and `migrate` OK and the other groups unset.
  - 10:50:45 `pnpm test:e2e`, headed (`headless: false`, `pnpm build && pnpm start`): 12 of 12 passed.
  - 10:50:52 `rate-limit.pg.test.ts` with `TEST_DATABASE_URL` pointing at the Docker `wardrobe_e2e` database: passed.

### Migration state

`drizzle/20261102094305_init` replaces `drizzle/20261102084605_init`, which never left this machine. It is applied to the local Docker `wardrobe` database (`pnpm db:migrate`) and `wardrobe_e2e` (e2e global setup), both recreated with `docker compose down -v`. It is not applied to Neon, which does not exist yet.

### Deploy state

Not deployed. No Vercel project exists yet.

### Open risks

- Next 16.4.3 shows a blank page when a form posted without JavaScript returns a result (rather than redirecting) on a partially prerendered page. Any later form that must work without JavaScript needs a fully static page, as `/login` has (D-054), or a redirect after the action. Test such forms with JavaScript disabled.
- Two checks pass trivially for now. The D-013 boundary test has no service that reads data yet. The forged-action e2e test posts to a `/wardrobe` that renders no items. Both become meaningful when Phases 3 and 4 add read services and pages that show items. Phase 3 service tests will need to mock `@/lib/auth/dal` (or sign a session), because every service now calls `requireSession()`.
- The cookie rename drops any session issued before it, once. So far only local runs have been affected.

### Live checks pending

None of these have been run yet; they need the cloud connection.

- Neon: `pnpm db:migrate` over `DATABASE_URL_UNPOOLED` and `pnpm db:seed` against Neon, then `pnpm env:check`.
- Login on a deployed preview over HTTPS: the `__Host-` Secure cookie, the proxy redirects and the 401 on `/api/*`.
- The login rate limit on Vercel: one key per client from the platform's `x-forwarded-for` (IPv6 by /64), and a lockout after 5 failures.
- Blob: the first real upload, plus a check that the public URL host passes the `head()` validation in `/api/items/register`.
- `pnpm ai:smoke`: the API accepts the structured-output schemas (no "schema too complex" 400), base64 and URL image sources both work, and the second call shows a cache read.
- Tagging cost: the measured cost per item against the estimate of about $0.06 per 100 items.
- Batch path: the synchronous dry run, batch creation, polling and idempotent processing.
- Relocation: each part finishes in under 200 s; actual against estimated cost for a full run.
- iPhone over HTTPS: photo picker, camera, HEIC through the Files app, and installing the PWA.
- ZIP export: one part streams in under 300 s.
- Open-Meteo: the 30-minute cache works on Vercel.

### Next steps

1. Phase 3 is wardrobe-6rd: upload and AI tagging. Phases 4 to 6 follow as wardrobe-a27, wardrobe-evp and wardrobe-g4t.

A Next.js security release is expected on 2026-11-03. When it is out, bump `next`, `eslint-config-next` and `@next/env` together.

## 2026-11-02 — Phase 1 (scaffold) complete

### State

Phase 1 is complete and committed on `main` as the first commit; wardrobe-pai is closed. The gate passes with no `.env.local`, and the visible-browser checks below passed.

The toolchain is Node 26.13, pnpm 11.28.9 and Beads (`bd`). Beads holds one issue per phase: wardrobe-pai (Phase 1, in progress), wardrobe-52y, wardrobe-6rd, wardrobe-a27, wardrobe-evp and wardrobe-g4t.

Phase 1 contains the create-next-app 16.4.3 scaffold (src directory, Cache Components and partial prefetching on), `pnpm-workspace.yaml`, shadcn 4.23 (base-nova style, Base UI primitives) with 31 components, the `next.config.ts` additions (typed routes, unoptimized images, the `/` to `/wardrobe` redirect, security headers, `/sw.js` headers), `src/env.ts`, `src/lib/ai/models.ts`, `src/lib/result.ts`, the root and `(app)` layouts with the desktop sidebar and mobile tab bar, the theme toggle and theme-colour sync, placeholder pages, the PWA pieces (manifest, generated icons, `public/sw.js`, `/offline`, iOS install hint), `vercel.json`, the Vitest and Playwright configs, `.env.example`, the tests and these docs. The tsx scripts are declared in `package.json`; their files arrive in Phases 2 and 3.

A three-part review of Phase 1 led to fixes: stronger focus rings and a reduced-motion rule, the opaque iOS status bar, `theme-color` following the chosen theme, the service worker precaching the offline page's stylesheets and refusing redirects, CONFIG errors hidden from clients, the sidebar's Ctrl/Cmd+B shortcut removed, and `badge.tsx` marked as a client module.

### Decisions

All decisions are recorded in [DECISIONS.md](DECISIONS.md) as D-001 to D-053. D-049 to D-053 come from the review, which also added the exact proxy matcher to D-013 and the shell and static caches to D-045. None are open.

### Checks run

Gate on 2026-11-02 (times UTC+1), no `.env`, `.env.local` or other env file present except `.env.example`:

- 00:27:00 `pnpm typecheck`: passed ("Types generated successfully", `tsc --noEmit` clean).
- 00:27:07 `pnpm lint`: passed, no findings.
- 00:27:13 `pnpm test`: passed, 9 files and 120 tests.
- 00:27:19 `pnpm build`: passed. Turbopack compiled, TypeScript passed, 11 of 11 static pages, every route static (`/add`, `/apple-icon.png`, `/icon.svg`, `/manifest.webmanifest`, `/offline`, `/relocate`, `/settings`, `/shopping`, `/wardrobe`, `/_not-found`).

After the build, the prerendered `/offline` HTML was inspected: the status-bar meta is `default`, the service worker's stylesheet pattern finds both linked CSS files, and the compiled CSS holds the reduced-motion rule and the new `--ring` values.

The gate was then re-run independently before committing (same conditions, no env file except `.env.example`): 00:28:57 `pnpm typecheck` passed, 00:29:00 `pnpm lint` passed, 00:29:06 `pnpm test` passed (9 files, 120 tests), 00:29:09 `pnpm build` passed (all 10 routes static).

Against `pnpm start` (production build), 00:29–00:35:

- `curl.exe -I http://localhost:3000/sw.js`: 200 with `Content-Type: application/javascript; charset=utf-8`, `Cache-Control: no-cache, no-store, must-revalidate`, the CSP and the global security headers. `/` returns 307 to `/wardrobe`; `/manifest.webmanifest` is 200 `application/manifest+json`; `/icons/icon-192.png` and `/offline` are 200.
- Headed Chromium (Playwright 1.64, visible window; the Claude-in-Chrome extension was not connected), 22 of 22 checks passed:
  - Desktop 1280×800: sidebar visible and tab bar hidden; the first Tab focuses "Skip to content"; keyboard focus shows a 2 px ring; every primary route renders its h1 with the matching nav item active.
  - Theme: Dark applies the `dark` class and survives a reload, and Light switches back.
  - Service worker: registered with scope `/` and active. After going offline, navigating to `/add` shows the styled `/offline` page (Geist font).
  - Mobile 390×844 (iPhone user agent, touch): tab bar visible and sidebar hidden; five tabs in order Wardrobe, Add, Relocate, Shopping, Settings, each 50×78 px, with Wardrobe as `aria-current`. The iOS install hint shows on Settings, and `main`'s bottom padding (72 px) clears the 51 px tab bar.
  - The only console error was the expected `ERR_INTERNET_DISCONNECTED` during the offline step. Screenshots were inspected for the desktop light and dark themes and mobile Settings.
- Not verified in a browser:
  - Chrome's "installable" verdict in DevTools; only the manifest and icons being served correctly was checked.
  - Reduced-motion toasts.
  - Toast focus rings.
  - `theme-color` changing when the in-app theme differs from the OS setting: the check only saw `#0a0a0a`, which matches both, so it can't tell.
  - Real iOS/Android devices (needs HTTPS, see live checks).

### Migration state

None. The schema and the first migration arrive in Phase 2 (wardrobe-52y).

### Deploy state

Not deployed. No Vercel project exists yet.

### Live checks pending

None of these have been run yet; they need the cloud connection.

- Neon: `pnpm db:migrate` and `pnpm db:seed` against Neon.
- Blob: the first real upload, plus a check that the public URL host passes the `head()` validation in `/api/items/register`.
- `pnpm ai:smoke`: the API accepts the structured-output schemas (no "schema too complex" 400), base64 and URL image sources both work, and the second call shows a cache read.
- Tagging cost: the measured cost per item against the estimate of about $0.06 per 100 items.
- Batch path: the synchronous dry run, batch creation, polling and idempotent processing.
- Relocation: each part finishes in under 200 s; actual against estimated cost for a full run.
- iPhone over HTTPS: photo picker, camera, HEIC through the Files app, and installing the PWA.
- ZIP export: one part streams in under 300 s.
- Open-Meteo: the 30-minute cache works on Vercel.

### Connecting the cloud

The owner follows [Connecting the cloud (one time)](README.md#connecting-the-cloud-one-time) in the README. After that the next session runs `pnpm db:migrate`, `pnpm db:seed` and `pnpm ai:smoke`, then the live checks above, and records measured costs and timings here and in the README. Deploying with `vercel --prod` happens only when the owner asks.

### Next steps

Phase 2 is wardrobe-52y: the Drizzle schema and migrations, the climate seed, and single-user auth with `proxy.ts`, the DAL and the DB-backed login rate limit, verified on PGlite and the local Docker database. `proxy.ts` copies the matcher from D-013 and tests it with `unstable_doesProxyMatch`. The `authedRoute` and `authedAction` wrappers and the login action log the original error before `toErrorPayload` hides CONFIG and INTERNAL details (D-053). `scripts/check-env.ts` (`pnpm env:check`) is written then. Phases 3 to 6 follow as wardrobe-6rd, wardrobe-a27, wardrobe-evp and wardrobe-g4t.

A Next.js security release is expected on 2026-11-03. When it is out, bump `next` and `eslint-config-next` (and `@next/env`, which is pinned to the same version); they are exempt from pnpm's 24-hour release-age rule.
