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

Two things happen only in the browser: photos are resized and re-encoded before upload, and the optional background removal runs a segmentation model in the browser. Its runtime is served by this app (copied from `onnxruntime-web` with pinned hashes by `pnpm vendor:bg-removal`, which `pnpm build` and `pnpm dev` run first); the model, which is data, comes from IMG.LY's CDN (`staticimgly.com`). The photo itself is never sent to IMG.LY.

## Tech stack

| Area | Choice |
|---|---|
| Runtime | Node 26 LTS (`engines.node: 26.x`), pnpm 11.28.9 |
| Framework | Next.js 16.4.3 (App Router, Turbopack, Cache Components, typed routes), React 19.3, TypeScript 5 |
| UI | Tailwind CSS 4 via `@tailwindcss/turbopack`, shadcn CLI 4.23 (base-nova style, Base UI primitives), lucide-react 1.x, next-themes 0.4.6 |
| Data | Postgres (Neon in production), drizzle-orm and drizzle-kit 1.0.0-rc.5 (exact pin), pg 8.23, `@vercel/functions` 3.10 |
| Files | `@vercel/blob` 2.8, sharp 0.35; in the browser `heic-to` 1.6 (HEIC decoding) and `@imgly/background-removal` 1.7.0 with `onnxruntime-web` 1.21.0 (both pinned exactly) |
| Forms | react-hook-form 7.91 with `@hookform/resolvers` 7 (zod 4); p-limit 7 for the upload and tagging pools |
| AI | `@anthropic-ai/sdk` 1.3 (API version 2026-10-21), zod 4.6 |
| Auth | jose 6.2 (HS256 JWT), bcryptjs 3 |
| Tests | Vitest 5 with Vite 8, jsdom and Testing Library; PGlite 0.5; Playwright 1.64 |
| Scripts | tsx 4.23, `@next/env` 16.4.3 |

Packages that only one feature needs are added in that feature's phase: `@tanstack/react-virtual` and `client-zip` come with Phase 4.

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
| `CRON_SECRET` | Phase 3+, Vercel | Bearer secret for `/api/cron/poll-batches` (see [Batch polling cron](#batch-polling-cron)). Vercel sends it on cron invocations. At least 16 characters. |
| `FEATURE_SHOPPING_AI` | Optional (Phase 6) | Enables the "What to buy next" AI analysis. Default `false`. |
| `E2E_TAG` | Test only (planned, Phase 4) | Reserved for the Phase 4 Playwright smoke spec, not implemented yet. That spec must pass a real API key and Blob token through `playwright.config.ts` `webServer.env` (D-102); values in `.env.local` never reach the e2e server. |
| `ENABLE_EXPERIMENTAL_COREPACK` | Vercel dashboard only | Set to `1` so Vercel builds with the pnpm version in `packageManager` instead of guessing from the lockfile. |

Variables that Vercel injects on its own (`VERCEL_OIDC_TOKEN`, `BLOB_STORE_ID`, `PG*`, `POSTGRES_*`) are not used: the app passes the Blob token explicitly and reads only the variables above.

## Local setup

1. Install Node 26 LTS (on Windows: `winget install --id OpenJS.NodeJS.LTS --exact --source winget`).
2. Install pnpm: `npm i -g pnpm@11.28.9`.
3. Install dependencies: `pnpm i`.
4. Get the environment: `vercel env pull .env.local` (needs the Vercel project, see "Connecting the cloud" below). Phase 1 runs without it.
5. Start the local database with `docker compose up -d db` and point `.env.local` at it (see [Database](#database)). Production uses Neon.
6. `pnpm db:migrate`, then `pnpm db:seed`. The seed is idempotent.
7. Set the password with `pnpm hash-password --with-secret` and put both printed values in `.env.local` (see [Authentication](#authentication)).
8. `pnpm dev` and open http://localhost:3000. You land on `/login`.

Notes:

- The session cookie is `Secure`. Chromium and Firefox accept it on `http://localhost`; Safari may not, so use `pnpm dev --experimental-https` there.
- Five failed logins from one client lock that client out for 15 minutes. `pnpm auth:unlock` clears all recorded attempts.
- Testing on a phone (camera, HEIC, install) needs real HTTPS. The simplest route is a preview deploy. The alternative is LAN HTTPS with a certificate issued for the LAN IP (`--experimental-https-key` and `--experimental-https-cert`) and the mkcert root CA installed on the phone; plain `--experimental-https` is not trusted over a LAN IP.

## Database

Postgres with Drizzle ORM. The schema lives in `src/lib/db/`: `enums.ts` (value lists shared with the zod schemas and forms), `schema.ts` (tables, snake_case in the database), `relations.ts`, `client.ts` (the pooled `pg` client) and `index.ts` (`getDb()`, created on first use). Migrations are generated SQL in `drizzle/`, one folder per migration, and are committed.

### Local database (Docker)

`docker compose up -d db` starts Postgres 18 on `localhost:5433` with two databases: `wardrobe` for local development and `wardrobe_e2e`, which the Playwright run empties and refills. The user and password are both `wardrobe`; they are local-only and not secret. For local development, put this in `.env.local`:

```text
DATABASE_URL=postgres://wardrobe:wardrobe@localhost:5433/wardrobe
DATABASE_URL_UNPOOLED=postgres://wardrobe:wardrobe@localhost:5433/wardrobe
```

The init script that creates `wardrobe_e2e` runs only on an empty volume. `docker compose down -v` deletes the volume, and with it both databases; the next `docker compose up -d db` starts fresh.

### Commands

| Command | What it does |
|---|---|
| `pnpm db:generate --name <name>` | Writes a new migration folder from the changes in `schema.ts`. Needs no database. Review the SQL, then commit it. |
| `pnpm db:migrate` | Applies pending migrations over `DATABASE_URL_UNPOOLED`. |
| `pnpm db:seed` | Seeds the climate profiles and the `app_settings` row (see below). Safe to run again. |
| `pnpm db:studio` | Opens Drizzle Studio on the `DATABASE_URL_UNPOOLED` database. |

Migrations always run over `DATABASE_URL_UNPOOLED`, the direct connection: DDL and the migrator's lock do not belong on Neon's pooled endpoint. If the variable is missing, `drizzle.config.ts` stops with an error naming it; there is no fallback to the pooled `DATABASE_URL`, which the app uses at runtime. Migrations never run during the Vercel build, and `drizzle-kit push` is not used.

The seed restores Hamburg to the reference values on every run and makes it the default profile. It inserts the Bologna placeholder only when it is missing, so values filled in through the climate editor survive a re-run, and it creates `app_settings` (home profile Bologna, new items located in Bologna) only when the row does not exist yet.

### Neon

Once the Neon integration exists, `vercel env pull .env.local` writes Neon's pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED` into `.env.local`, replacing the Docker values. The same commands then target Neon; the order before a deploy is in [Deploy](#deploy).

## Authentication

There is one user and one password. `proxy.ts` makes a fast first check of the session cookie, and every Server Action, Route Handler and server read checks the session again itself.

- Setting the password: `pnpm hash-password --with-secret` asks for the password twice without echoing it (at least 10 characters, at most 72 bytes) and prints `APP_PASSWORD_HASH=…` and `SESSION_SECRET=…`. Put both lines in `.env.local` and in the Vercel dashboard for all environments. To change only the password, run it without `--with-secret` and replace `APP_PASSWORD_HASH`. Changing the password does not sign anyone out, and neither does logging out elsewhere: sessions are stateless tokens. If the password or a device may be compromised, also rotate `SESSION_SECRET` (`pnpm hash-password --with-secret`); that invalidates every existing session and also resets the rate-limit counts.
- `APP_PASSWORD_HASH` is the base64 encoding of a bcrypt hash (cost 12), not the raw `$2b$…` hash: `@next/env` expands `$` in `.env` files and would corrupt it. A raw hash is rejected with a hint.
- Sessions: after signing in, the browser holds a signed token in the `__Host-wardrobe_session` cookie (httpOnly, Secure, SameSite=Lax, `Path=/`, no Domain) for 30 days. The `__Host-` prefix stops a subdomain or a plain-HTTP response from planting or shadowing it. Changing `SESSION_SECRET` signs out every device.
- Signed out, every page redirects to `/login?next=<path>`, and signing in returns there; `/api/*` answers 401 with a JSON error instead. Signed in, `/login` redirects to the app. The PWA files (manifest, icons, `/sw.js`), `/offline`, `/api/blob/upload` and `/api/cron/*` stay public; the last two check their own credentials.
- Log out from Settings (Account) or from the sidebar footer on desktop.
- The login form works without JavaScript too.
- Rate limit: 5 failed logins from one client within 15 minutes lock that client until the oldest failure is 15 minutes old. A client is identified by a hash of its IP address and `SESSION_SECRET`; raw IP addresses are not stored. An IPv6 client counts as its whole /64 network, and an IPv4-mapped IPv6 address as the plain IPv4 address. The client address comes from `x-forwarded-for` (then `x-real-ip`), so the limit is only trustworthy behind a proxy that overwrites those headers, as Vercel does: a self-hosted `next start` keeps a client-supplied `x-forwarded-for`, which lets clients choose their own key. There is no global lock, because anyone could trigger it and lock the owner out; more than 200 failures in an hour across all clients only log a warning. `pnpm auth:unlock` deletes every recorded attempt and unlocks everyone.

## Adding items

`/add` takes photos from the camera, the photo library, drag and drop or (on desktop) a whole folder. Each photo goes through these steps, three at a time, with its status shown in the list:

1. Prepare, in the browser: HEIC photos are converted by `heic-to` (loaded only when needed), then every photo is decoded with its EXIF orientation applied, resized to at most 2048 px on the long edge and re-encoded as JPEG (q0.85), which also strips EXIF and GPS data. A sha256 of the original file is its source hash.
2. Check: source hashes are looked up in batches (`POST /api/items/check-hashes`). A photo already in the wardrobe, or picked twice in the same selection, is marked and skipped before anything is uploaded.
3. Upload: the browser asks `/api/blob/upload` for a short-lived client token and puts the JPEG straight into Blob (`items/<id>/original-<suffix>.jpg`), so photos never pass through a function's request body.
4. Register: `POST /api/items/register` checks the blob with `head()`, makes the 1024 px WebP and the 400 px thumbnail with sharp and creates the item as `pending_tagging`. A processed image that matches an existing item is reported as a duplicate, and the new original is deleted.

Once photos are registered, "Tag N items ≈ $X" tags them, four at a time, through `POST /api/items/[id]/tag`. Failures stay in the list with the reason and a Retry button; nothing is retried silently. With more than 20 untagged items, Batch mode is offered: it costs about half, results usually arrive within an hour, and the first item is tagged straight away with exactly the batch parameters, so a bad request fails before the batch is created. A batch start claims its items before anything is paid for, so two overlapping starts cannot both pay; it gives up in time to answer within the function limit. When the monthly budget would be passed, tagging is blocked with an alert that links to the usage page. After a run or a batch attempt the page re-reads the remaining budget from `GET /api/ai/tagging-setup` instead of reloading itself. An invalid model or budget setting disables only tagging: the page says "Tagging is unavailable", and photos can still be picked, uploaded and reviewed. While photos are uploading or tagging calls are waiting, leaving `/add` through a link or a reload asks first, because it would cancel them; the page starts with an empty list when you come back.

`/add/review` lists the items waiting for review (the newest 200). Tagged items show an editable form: name, category, colours (name and swatch pairs), materials, warmth (1 to 5, with the rubric), the weather switches, seasons, formality, condition, and the purchase and plan fields. Fields Claude was less than 60% sure about are highlighted with "Check this". Saving records which tag fields you changed (`user_edited_fields`), and a later Re-tag keeps those values. Confirm (or "Confirm all untouched") moves items into the wardrobe. Items without tags offer Tag now, or Retry with the stored error, and "Tag N waiting items ≈ $X" tags all of them at once (four at a time, with the batch offer above 20). Items in no batch can also be filled in by hand ("Fill in by hand"): the same form without Claude, which needs a name, category, colour, warmth, formality, condition and a season, and saves the item as tagged or straight to the wardrobe without any AI spend. This is the way out for a photo Claude refuses. Items in a batch say so, and the page applies finished batches each time it loads, showing how many results it applied next to any batch it could not check; "Tag now instead" tags one at once after a confirmation, since the batch result is billed anyway, and returns the batch's tags without a new call if they arrived in the meantime. Coming back to the page shows new items while keeping unsaved edits, also on a card that newer uploads pushed out of the newest 200.

### Background removal (optional)

"Remove background" under a photo on the review page cuts the garment out in the browser with `@imgly/background-removal` (model `isnet_quint8`, CPU only, single-threaded). The first run downloads about 57 MB: the model (44 MB) from IMG.LY's CDN, which the browser caches for 4 hours and afterwards revalidates without downloading again, and the runtime (13 MB) from this app under a versioned path: its two hash-pinned files are cached for a year, and the small `resources.json` manifest is revalidated on each use. The app asks before that first download. A run takes about 7 seconds on a desktop and longer on a phone. The cut-out is uploaded as a PNG, stored as a WebP (`items/<id>/nobg-<suffix>.webp`) and shown instead of the processed photo; tagging does not use it. If the CDN is unreachable, the button shows an error and nothing else is affected.

### AI usage page

`/settings/usage` shows month-to-date spend against `MONTHLY_AI_BUDGET_USD` (with pending batch estimates and the reset date), all-time spend against `AI_CREDIT_USD`, the prompt cache hit ratio, spend and tokens by purpose and by model, the last 50 Claude attempts (failed ones included) and an estimate of this month's Blob advanced operations against the Hobby limit of 2,000. Months are UTC calendar months, the same window as the budget check.

### Batch polling cron

`vercel.json` schedules `GET /api/cron/poll-batches` daily at 04:00 UTC (Hobby allows one run a day, at an imprecise time). Vercel sends `Authorization: Bearer <CRON_SECRET>`; the route answers 401 to anything else and a generic 500 when `CRON_SECRET` is not set, so set it in the dashboard before the first deploy that includes the cron. Each finished batch is applied exactly once, even when the review page or a duplicate cron run gets there first. When every batch could be checked the route answers 200 with the counts; when one could not, it answers with that error's status and `{ ok: false, error, data }`, keeping the counts of the others, so the failure shows in the cron log. Crons only run on production deployments.

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

AI spend is the only running cost; the Vercel, Neon and Blob free tiers cover the rest. The owner has $100 of prepaid API credit (`AI_CREDIT_USD`). `MONTHLY_AI_BUDGET_USD` (default $20) is a hard stop: a call or batch is refused when month-to-date spend, plus pending batch estimates, plus the estimate for the new operation would pass the budget, and nothing is sent once the budget is used up. Calls already in flight can overshoot it by a few cents. Every attempt, including failed ones, is logged with its tokens and cost, and `/settings/usage` shows the totals.

Expected costs (estimates, not yet measured):

| Operation | Model | Estimate |
|---|---|---|
| Tag 100 items | Haiku 5.5, effort low | About $0.055 (the spec's "about $0.06"); about $0.028 with Batch mode |
| Relocation analysis of 300 items | Sonnet 5.5, effort medium | About $0.30–0.50. This is above the spec's $0.20–0.30 because of thinking tokens and a reason per item. |

How the tagging estimate is computed (`src/lib/ai/cost.ts`; the add page shows the same numbers):

- Input per item: the image at 1024 × 1024 px, which is ceil(1024 / 28)² = 1,369 tokens, the one-line user instruction, and 400 tokens of structured-output overhead.
- The system prompt is about 1,984 tokens (characters ÷ 3.5 × 1.3). The first call of a run writes it to the prompt cache (5-minute cache at 1.25× the input price; batches use the 1-hour cache at 2×), and later calls read it at 0.1×.
- Output: 700 tokens per item, which leaves room for Haiku's thinking at effort low.
- At Haiku 5.5 prices that is about $0.00078 for the first item and $0.00055 for each further item. Batch mode halves every rate; the first item of a batch is tagged straight away at normal prices, writing the 1-hour cache, and the batch button's estimate includes it.

The add page tags four items at once, so the first few calls of a run may each write the cache instead of only one; that adds well under a cent per run. These rows will be replaced by measured values after the first live runs (`pnpm ai:smoke` prints the estimated against the measured cost of one item).

## Changing models

Set `CLAUDE_TAGGING_MODEL`, `CLAUDE_ANALYSIS_MODEL` or `CLAUDE_OUTFIT_MODEL` (and `CLAUDE_ANALYSIS_EFFORT` for the analysis) in Vercel and `.env.local`. A model can only be used if it has an entry in the pricing table in `src/lib/ai/models.ts`; otherwise every AI call fails with a configuration error before anything is sent, because unpriced calls would break budget accounting. To add a model, add its id to `PRICED_MODEL_IDS` and its prices to `PRICING_PER_MTOK` in that file (input, output, cache-read and cache-write multipliers, batch multiplier, and any long-context tier, all from Anthropic's pricing page), then set the variable.

A different tagging model applies to new items and to items you re-tag; existing tags stay as they are, and each item records the model and prompt version that tagged it (`ai_model`, `ai_prompt_version`). The add page's estimate and the budget check use the new model's prices automatically. After changing the tagging model, run `pnpm ai:smoke` once to check that the model accepts the structured-output schema and reads the prompt cache. Editing the tagging prompt (`src/lib/ai/tagging/prompt.ts`) requires bumping `TAG_PROMPT_VERSION`; a unit test pins the prompt's hash, so the bump cannot be forgotten. A different analysis model or effort changes the relocation cache key, so the next run calls Claude again instead of reusing the previous result.

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
| `pnpm test` | Vitest. Database tests run on an in-memory PGlite database built from the committed migrations in `drizzle/`; the Anthropic API, Blob and `fetch` are faked. Needs no Docker, no `.env` file and no network. |
| `pnpm build` | Production build, after `pnpm vendor:bg-removal`. Cache Components violations only show up here. |
| `pnpm vendor:bg-removal` | Copies the background-removal runtime from `onnxruntime-web` into `public/vendor/bg-removal/` and writes its `resources.json`; fails when an installed version differs from `PINNED_VERSIONS` in `src/lib/images/bg-removal-assets.ts` (which also names the asset folder) or a file hash or size differs from the pins in `scripts/bg-removal-vendor.ts`. `pnpm build` and `pnpm dev` run it first. |
| `pnpm test:e2e` | Playwright, local only, in a visible browser, against `pnpm build && pnpm start` and the Docker `wardrobe_e2e` database. The server has no Anthropic key and no Blob token (every app variable except its own database and auth values is blanked), so the specs cover the add page's configuration errors, the review form (including filling an item in by hand) and the usage page with seeded rows, and `add-tagging.spec.ts` answers the Blob and tag requests inside the browser to exercise the tagging bar; nothing calls Claude or Blob. |
| `pnpm ai:smoke [image-path] [https-image-url]` | Live-only check against the Anthropic API (about $0.002), never part of `pnpm test`. It sends two identical base64 tagging requests and fails if the second shows no cache read; given an https URL, it also sends one request with the batch parameters (URL image, 1-hour cache). It prints usage, costs and the parsed tags, and logs to `ai_calls` only when `DATABASE_URL` is set. Run it after connecting the cloud and after changing the tagging model. |

A phase is done when `pnpm typecheck && pnpm lint && pnpm test && pnpm build` passes.

Before the first `pnpm test:e2e`, install the browser once with `pnpm exec playwright install chromium`, and start the database with `docker compose up -d db` before every run. The run needs no `.env.local`: `playwright.config.ts` starts the server with its own `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (both `wardrobe_e2e`), a fixed test password from `e2e/constants.ts` hashed into `APP_PASSWORD_HASH`, and a new random `SESSION_SECRET` on every run. Every other app variable (`BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, the `CLAUDE_*` models and effort, `MONTHLY_AI_BUDGET_USD`, `AI_CREDIT_USD`, `CRON_SECRET`, `FEATURE_SHOPPING_AI`) is set to an empty value, which `src/env.ts` treats as unset and which `.env.local` cannot fill, so a real key or Blob token there never reaches the e2e server; the list lives in `test/app-env-vars.ts`, shared with Vitest. These override any values in `.env.local`. The global setup then migrates `wardrobe_e2e`, empties every table and seeds it, so each run starts from the same state. Details are in [e2e/README.md](e2e/README.md).

`src/lib/auth/rate-limit.pg.test.ts` checks that parallel logins on separate connections cannot get past the limit, which PGlite cannot show because it runs one transaction at a time. It is skipped unless `TEST_DATABASE_URL` names a migrated database, for example `TEST_DATABASE_URL=postgres://wardrobe:wardrobe@localhost:5433/wardrobe_e2e pnpm exec vitest run src/lib/auth/rate-limit.pg.test.ts`. It only writes `login_attempts` rows under its own random keys and deletes them afterwards.

## Project structure

```text
src/
  app/              routes: (app) group for signed-in pages, (auth) for login, api/* route handlers,
                    manifest.ts, offline page
  components/
    ui/             shadcn components (Base UI primitives)
    layout/         sidebar, mobile tab bar, nav-items.ts (single source for the tabs)
    theme/  pwa/    theme provider and toggle; service worker registration, install hint
    auth/           login form, logout button
    add/            the add flow: pickers, upload queue, tagging bar, route calls
    items/          review list and card, tag form, background removal button
    usage/          usage page tables and formatting
    wardrobe/ relocate/ outfits/                feature components (Phases 4-6)
  lib/
    ai/             models and pricing (models.ts), structured calls, retries, cost, budget,
                    JSON Schema conversion, call logging; tagging/ holds the prompt and schemas
    items/          contracts shared by client and server (patch schema, item card, routes)
    images/         browser pipeline, background removal, Blob upload client; server
                    pipeline (sharp) and Blob storage
    db/  auth/      Drizzle schema and client; session token, DAL, password, rate limit
    climate/        climate profile types, Hamburg and Bologna seed data, seeder
    weather/ export/                            feature libraries (Phases 4-6)
    result.ts       Result<T> type and error codes
  server/
    actions/        Server Actions (thin)
    items/          item card DTO, user-edited-field tracking
    services/       domain logic with injected dependencies, tested on PGlite
  env.ts            lazy, grouped environment validation
  proxy.ts          optimistic auth check
drizzle/            generated SQL migrations (committed)
docker/             init script for the local Docker database (docker-compose.yml)
scripts/            tsx scripts: seed, hash-password, auth-unlock, icons, env check, AI smoke test
assets/             icon.svg (source for the generated PWA icons)
public/             sw.js, generated icons
test/               Vitest helpers: PGlite database (db.ts), row factories, stubs, fakes for
                    Anthropic and Blob, generated image fixtures
e2e/                Playwright specs, global setup and fixed test constants
```

## Licences of notable dependencies

- `@imgly/background-removal` 1.7.0 is AGPL-3.0 (see the package's `LICENSE.md`; its bundled third-party notices are in `ThirdPartyLicenses.json`). The owner accepted it for this private, single-user app. Its code is sent to the browser and the app is used over a network, so the AGPL requires offering the complete source of the app, under the AGPL, to everyone who is given access to it. Today that is only the owner, who has the source. Before the app is shared with anyone else or made public, either publish its source under AGPL-compatible terms or remove the library (the button and `src/lib/images/bg-removal.ts`). Its model (about 44 MB) loads from IMG.LY's CDN on first use and its runtime from this app; the processing happens in the browser, and the photo is not uploaded to IMG.LY.
- `onnxruntime-web` 1.21.0, the inference runtime the background removal uses, is MIT.
- `heic-to` is LGPL-3.0. It is loaded as a separate chunk through a dynamic import, only when a HEIC photo is picked, so it remains a replaceable library.
- Open-Meteo weather data is CC BY 4.0. The `/today` page shows "Weather data by Open-Meteo.com". The free API is for non-commercial use.
- sharp's prebuilt binaries include libvips (LGPL-3.0), linked dynamically.
- The other dependencies use permissive licences (MIT, ISC, Apache-2.0, BSD).

## Vercel Hobby limits that shape the design

- Functions stop after 300 seconds, including streaming and `after()`. That is why the relocation analysis runs in chunks that can resume, image exports can come in parts, and AI retries give up early when a wait would overrun the deadline.
- Request bodies are capped at 4.5 MB, so photos upload from the browser straight to Blob.
- Cron jobs run at most once a day, at an imprecise time. Batch results are also collected whenever you open the review page.
- Blob allows 2,000 advanced operations a month and 1 GB of storage; going over blocks Blob for 30 days. Each new item costs about 3 operations (the browser's upload of the original, then the processed image and the thumbnail), so roughly 600 items a month; a background removal adds 2 (the PNG upload and the stored WebP). The app dedupes photos before upload, never calls `list()`, and shows the monthly estimate on the usage page.
- Turbopack copies some unused onnxruntime-web files (about 25 MB, mainly the WebGPU wasm) into the build output. The browser never requests them; they only add to the deployment size.
- Images render as plain `<img>` tags (`images.unoptimized`), so the Image Optimization quota is never used.
