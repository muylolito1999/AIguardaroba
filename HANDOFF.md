# Handoff

Newest entry first. Each entry records the state at the end of a working session. Task tracking lives in Beads (`bd ready`, `bd show <id>`); the reasons behind choices are in [DECISIONS.md](DECISIONS.md).

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
