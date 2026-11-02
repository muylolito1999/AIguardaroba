# Wardrobe

A private, single-user, climate-aware digital wardrobe. You photograph your clothes, Claude tags each item from the photo (category, colours, materials, warmth, seasons and so on), and you browse and filter the result. Relocation mode takes the climate of a destination (Hamburg first) and tells you what to bring, what to leave, donate or sell, and what is missing for that climate. It runs as a Next.js app on Vercel and installs on a phone as a PWA.

Task tracking lives in Beads (`bd ready`, `bd show <id>`). Why things are built the way they are is in [DECISIONS.md](DECISIONS.md); the current state of work is in [HANDOFF.md](HANDOFF.md).

## Features

| Phase | Feature |
|---|---|
| 1 | App shell: desktop sidebar, mobile bottom tab bar (Wardrobe, Add, Relocate, Shopping, Settings), light/dark theme |
| 1 | Installable PWA: manifest, icons, offline fallback page, iOS install hint |
| 1 | Lazy environment validation, model and pricing configuration |
| 2 | Postgres schema and migrations; seeded climate profiles (Hamburg, Bologna placeholder) |
| 2 | Single-user login with a signed session cookie and a DB-backed login rate limit |
| 3 | Add items: multi-file picker, camera, drag and drop, folder import, HEIC support |
| 3 | AI tagging with Claude Haiku 5.5, review screen with editable tags, optional Batch mode (50% cheaper) |
| 3 | Optional in-browser background removal; AI usage and budget page |
| 4 | Wardrobe grid with search, filters, sorting and category counts; item detail page |
| 4 | Stats page with a winter-readiness checklist; JSON, CSV and image ZIP export |
| 5 | Relocation analysis with Claude Sonnet 5.5: Bring / Leave / Donate-Sell, gaps, layering, packing checklist |
| 5 | Shopping list fed from relocation gaps; climate profile editor |
| 6 | Outfit builder; `/today` with weather and three AI outfit suggestions; wear tracking |
| 6 | "What to buy next" AI analysis behind `FEATURE_SHOPPING_AI` |

## Architecture

```text
 Browser / installed PWA (iPhone, desktop)
   │                         │
   │ HTTPS                   │ client upload of originals
   ▼                         │ (short-lived token from /api/blob/upload)
 Next.js 16 on Vercel, fra1  │
   ├─ src/proxy.ts           optimistic session check (jose HS256 cookie)
   ├─ Server Components      static shell + <Suspense> children (Cache Components)
   ├─ Server Actions         single mutations (confirm item, decisions, settings, login)
   └─ Route Handlers         concurrent work (register, tag, analysis parts),
        │                    exports, daily cron for batch polling
        │                    │
        ├──► Neon Postgres (aws-eu-central-1)   pg driver + Drizzle ORM
        ├──► Vercel Blob (public store, fra1) ◄─┘ originals, processed WebP, thumbnails
        ├──► Anthropic API                      Haiku 5.5 tagging, Sonnet 5.5 analysis
        └──► Open-Meteo                         forecast for /today, cached 30 min
```

Every server read and action checks the session through the data access layer (`requireSession()`); `proxy.ts` is only a fast first filter. Work the browser runs in parallel (registering uploads, tagging, relocation chunks) goes through Route Handlers, because Next.js runs Server Actions one at a time per client.

## Tech stack

| Area | Choice |
|---|---|
| Runtime | Node 26 LTS (`engines.node: 26.x`), pnpm 11.28.9 |
| Framework | Next.js 16.4.3 (App Router, Turbopack, Cache Components, typed routes), React 19.3, TypeScript 5 |
| UI | Tailwind CSS 4 via `@tailwindcss/turbopack`, shadcn CLI 4.23 (base-nova style, Base UI primitives), lucide-react 1.x, next-themes 0.4.6 |
| Data | Postgres (Neon in production), drizzle-orm and drizzle-kit 1.0.0-rc.5 (exact pin), pg 8.23, `@vercel/functions` 3.10 |
| Files | `@vercel/blob` 2.8, sharp 0.35 |
| AI | `@anthropic-ai/sdk` 1.3 (API version 2026-10-21), zod 4.6 |
| Auth | jose 6.2 (HS256 JWT), bcryptjs 3 |
| Tests | Vitest 5 with Vite 8, jsdom and Testing Library; PGlite 0.5; Playwright 1.64 |
| Scripts | tsx 4.23, `@next/env` 16.4.3 |

Packages that only one feature needs are added in that feature's phase: `heic-to`, `@imgly/background-removal` with `onnxruntime-web`, `react-hook-form` (Phase 3); `@tanstack/react-virtual`, `client-zip` (Phase 4).

## Environment variables

Copy `.env.example` to `.env.local`, or get the values with `vercel env pull .env.local` once the Vercel project exists. Phase 1 needs no variables at all. Each group is validated the first time it is used, and an empty value counts as unset. From Phase 2, `pnpm env:check` reports which groups are complete.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Phase 2+, runtime (Vercel and local) | Pooled Postgres connection string. Set by the Neon integration; locally it can point at the Docker database. |
| `DATABASE_URL_UNPOOLED` | Phase 2+, migrations | Direct (unpooled) connection used by `drizzle-kit`. `drizzle.config.ts` fails with the variable name if it is missing; there is no fallback to the pooled URL. |
| `BLOB_READ_WRITE_TOKEN` | Phase 3+, runtime (Vercel and local) | Blob store token. Required even when the store is connected through OIDC: `handleUpload` signs client upload tokens with it, and every server Blob call passes it explicitly. Connect the store with the Development environment included so `vercel env pull` writes it. |
| `ANTHROPIC_API_KEY` | Phase 3+, runtime | Anthropic API key. Mark it as sensitive in Vercel. |
| `CLAUDE_TAGGING_MODEL` | Optional | Tagging model. Default `claude-haiku-5-5`. Must be priced in `src/lib/ai/models.ts`. |
| `CLAUDE_ANALYSIS_MODEL` | Optional | Relocation analysis model. Default `claude-sonnet-5-5`. Must be priced. |
| `CLAUDE_OUTFIT_MODEL` | Optional (Phase 6) | Outfit suggestion model. Defaults to the analysis model. Must be priced. |
| `CLAUDE_ANALYSIS_EFFORT` | Optional (Phase 5) | Effort for the relocation analysis: `low`, `medium` or `high`. Default `medium`. |
| `MONTHLY_AI_BUDGET_USD` | Optional | Hard monthly stop for AI spend (UTC calendar month). Default `20`. |
| `AI_CREDIT_USD` | Optional | Prepaid API credit that the usage page compares all-time spend against. Default `100`. |
| `APP_PASSWORD_HASH` | Phase 2+, runtime | The base64 encoding of the bcrypt hash of the app password. `pnpm hash-password` prints it. A raw `$2b$…` value is rejected with a hint, because `@next/env` expands `$` in `.env` files and would corrupt it. |
| `SESSION_SECRET` | Phase 2+, runtime | Signs the session cookie and salts the login rate-limit key. At least 32 characters; `pnpm hash-password --with-secret` prints one. |
| `CRON_SECRET` | Phase 3+, Vercel | Bearer secret for `/api/cron/poll-batches`. Vercel sends it on cron invocations. At least 16 characters. |
| `FEATURE_SHOPPING_AI` | Optional (Phase 6) | Enables the "What to buy next" AI analysis. Default `false`. |
| `E2E_TAG` | Test only | Set to `1` to run the live tagging steps of the Playwright smoke test (needs a real API key and Blob token). |
| `ENABLE_EXPERIMENTAL_COREPACK` | Vercel dashboard only | Set to `1` so Vercel builds with the pnpm version in `packageManager` instead of guessing from the lockfile. |

Variables that Vercel injects on its own (`VERCEL_OIDC_TOKEN`, `BLOB_STORE_ID`, `PG*`, `POSTGRES_*`) are not used: the app passes the Blob token explicitly and reads only the variables above.

## Local setup

1. Install Node 26 LTS (on Windows: `winget install --id OpenJS.NodeJS.LTS --exact --source winget`).
2. Install pnpm: `npm i -g pnpm@11.28.9`.
3. Install dependencies: `pnpm i`.
4. Get the environment: `vercel env pull .env.local` (needs the Vercel project, see "Connecting the cloud" below). Phase 1 runs without it.
5. Phase 2 onward: start the local database with `docker compose up -d db`. It is Postgres 18 on port 5433 with the databases `wardrobe` and `wardrobe_e2e`, for local browser and e2e checks only; production uses Neon. To use it, point `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in `.env.local` at it (the connection details are in `docker-compose.yml`).
6. Phase 2 onward: `pnpm db:migrate`, then `pnpm db:seed`. The seed is idempotent.
7. Phase 2 onward: set the password with `pnpm hash-password --with-secret` and put both printed values in `.env.local`.
8. `pnpm dev` and open http://localhost:3000.

Notes:

- The session cookie is `Secure`. Chromium and Firefox accept it on `http://localhost`; Safari may not, so use `pnpm dev --experimental-https` there.
- Five failed logins from one client lock that client out for 15 minutes. `pnpm auth:unlock` clears all recorded attempts.
- Testing on a phone (camera, HEIC, install) needs real HTTPS. The simplest route is a preview deploy. The alternative is LAN HTTPS with a certificate issued for the LAN IP (`--experimental-https-key` and `--experimental-https-cert`) and the mkcert root CA installed on the phone; plain `--experimental-https` is not trusted over a LAN IP.

## Connecting the cloud (one time)

1. `npm i -g vercel`, then `vercel login` and `vercel link`.
2. Neon: `vercel integration add neon` with region aws-eu-central-1 and preview branching off.
3. Blob: `vercel blob create-store wardrobe --access public --region fra1 --yes` (`--yes` connects all environments, including Development).
4. In the Vercel dashboard, add for all environments: `ANTHROPIC_API_KEY` (sensitive), `APP_PASSWORD_HASH` and `SESSION_SECRET` (from `pnpm hash-password --with-secret`, available from Phase 2), `CRON_SECRET`, and `ENABLE_EXPERIMENTAL_COREPACK=1`. Set the Function region to fra1.
5. `vercel env pull .env.local`.

## Deploy

Follow this order:

1. Make sure every dashboard variable is set, including `ENABLE_EXPERIMENTAL_COREPACK=1` and `CRON_SECRET`.
2. `vercel env pull .env.local`.
3. `pnpm db:migrate`, then `pnpm db:seed`, both against Neon, using the connection strings that step 2 wrote to `.env.local`.
4. `vercel --prod`.

Migrations never run during the build. Re-run `pnpm db:migrate` against Neon before any deploy that ships a new migration. On the first deploy, check that the build log shows pnpm 11.

## Costs

AI spend is the only running cost; the Vercel, Neon and Blob free tiers cover the rest. The owner has $100 of prepaid API credit (`AI_CREDIT_USD`). `MONTHLY_AI_BUDGET_USD` (default $20) is a hard stop: a call or batch is refused when month-to-date spend, plus pending batch estimates, plus the estimate for the new operation would pass the budget. Calls already in flight can overshoot it by a few cents. Every attempt, including failed ones, is logged with its tokens and cost, and `/settings/usage` shows the totals (Phase 3).

Expected costs (estimates, not yet measured):

| Operation | Model | Estimate |
|---|---|---|
| Tag 100 items | Haiku 5.5, effort low | About $0.06 (the spec's figure); about half that with Batch mode |
| Relocation analysis of 300 items | Sonnet 5.5, effort medium | About $0.30–0.50. This is above the spec's $0.20–0.30 because of thinking tokens and a reason per item. |

These rows will be replaced by measured values after the first live runs.

## Changing models

Set `CLAUDE_TAGGING_MODEL`, `CLAUDE_ANALYSIS_MODEL` or `CLAUDE_OUTFIT_MODEL` (and `CLAUDE_ANALYSIS_EFFORT` for the analysis) in Vercel and `.env.local`. A model can only be used if it has an entry in the pricing table in `src/lib/ai/models.ts`; otherwise every AI call fails with a configuration error before anything is sent, because unpriced calls would break budget accounting. To add a model, add its id to `PRICED_MODEL_IDS` and its prices to `PRICING_PER_MTOK` in that file (input, output, cache-read and cache-write multipliers, batch multiplier, and any long-context tier, all from Anthropic's pricing page), then set the variable.

A different tagging model applies to new items and to items you re-tag; existing tags stay as they are. A different analysis model or effort changes the relocation cache key, so the next run calls Claude again instead of reusing the previous result.

## Exporting data (planned, Phase 4)

`/settings/export` will offer:

- JSON: a streamed dump of every table.
- CSV: items only, UTF-8 with BOM, arrays joined with `;`, safe against spreadsheet formula injection.
- ZIP of images (original, processed, thumbnail or background-removed): a single ZIP when it can stream well within the 300-second function limit, otherwise numbered parts of up to 100 items each.

## Testing

| Command | What it does |
|---|---|
| `pnpm typecheck` | `next typegen && tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest. Database tests run on in-memory PGlite; the Anthropic API, Blob and `fetch` are faked. No network access. |
| `pnpm build` | Production build. Cache Components violations only show up here. |
| `pnpm test:e2e` | Playwright, local only, in a visible browser, against `pnpm build && pnpm start` and the Docker `wardrobe_e2e` database. Upload specs skip with a reason when there is no Blob token. |
| `pnpm ai:smoke` | Live check against the Anthropic API (about $0.001). Run it manually after connecting the cloud. |

A phase is done when `pnpm typecheck && pnpm lint && pnpm test && pnpm build` passes.

## Project structure

```text
src/
  app/              routes: (app) group for signed-in pages, (auth) for login, api/* route handlers,
                    manifest.ts, offline page
  components/
    ui/             shadcn components (Base UI primitives)
    layout/         sidebar, mobile tab bar, nav-items.ts (single source for the tabs)
    theme/  pwa/    theme provider and toggle; service worker registration, install hint
    items/ add/ wardrobe/ relocate/ outfits/    feature components (Phases 3-6)
  lib/
    ai/             models and pricing (models.ts), structured calls, retries, cost, budget
    db/  auth/      Drizzle schema and client; session, DAL, password, rate limit (Phase 2)
    images/ climate/ weather/ export/           feature libraries (Phases 3-6)
    result.ts       Result<T> type and error codes
  server/
    actions/        Server Actions (thin)
    services/       domain logic with injected dependencies, tested on PGlite
  env.ts            lazy, grouped environment validation
  proxy.ts          optimistic auth check (Phase 2)
drizzle/            generated SQL migrations (committed)
scripts/            tsx scripts: seed, hash-password, auth-unlock, icons, env check, AI smoke test
assets/             icon.svg (source for the generated PWA icons)
public/             sw.js, generated icons
test/  e2e/         Vitest helpers and fakes; Playwright specs
```

## Licences of notable dependencies

- `@imgly/background-removal` is AGPL-3.0. The owner accepted it for this private, single-user app. Because the app is served over a network, the AGPL requires offering the app's source code to anyone who uses it; with a single user who owns the code, that is already the case. Anyone who opens the app to other users must offer them the source. Its model files load from IMG.LY's CDN on first use, and the processing happens in the browser.
- `heic-to` is LGPL-3.0. It is loaded as a separate chunk through a dynamic import, only when a HEIC photo is picked, so it remains a replaceable library.
- Open-Meteo weather data is CC BY 4.0. The `/today` page shows "Weather data by Open-Meteo.com". The free API is for non-commercial use.
- sharp's prebuilt binaries include libvips (LGPL-3.0), linked dynamically.
- The other dependencies use permissive licences (MIT, ISC, Apache-2.0, BSD).

## Vercel Hobby limits that shape the design

- Functions stop after 300 seconds, including streaming and `after()`. That is why the relocation analysis runs in chunks that can resume, image exports can come in parts, and AI retries give up early when a wait would overrun the deadline.
- Request bodies are capped at 4.5 MB, so photos upload from the browser straight to Blob.
- Cron jobs run at most once a day, at an imprecise time. Batch results are also collected whenever you open the review or usage page.
- Blob allows 2,000 advanced operations a month and 1 GB of storage; going over blocks Blob for 30 days. Each new item costs about 3 operations (roughly 600 uploads a month). The app dedupes photos before upload, never calls `list()`, and shows the monthly count on the usage page.
- Images render as plain `<img>` tags (`images.unoptimized`), so the Image Optimization quota is never used.
