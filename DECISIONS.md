# Decisions

Each entry records one decision and the reason for it. "Deviates from spec" compares the decision with the original product spec. To change a decision, add a new entry that supersedes the old one and set the old entry's status to `superseded by D-NNN`.

## Process and toolchain

### D-001 Build all six phases in one run
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Phases 1 to 6 are built back to back. Each phase ends with the gate, a commit and a short summary; work pauses only when it is blocked.
- Why: The owner chose this run scope.

### D-002 Build offline first, connect the cloud later
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Everything is built and tested without cloud credentials. The owner provisions Vercel, Neon, Blob and the Anthropic key later; migrations, seed and live checks run after that.
- Why: The owner's choice. Every phase gate can pass without secrets.

### D-003 Docker Postgres for local checks only
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: `docker-compose.yml` runs postgres:18-alpine on port 5433 with the databases `wardrobe` and `wardrobe_e2e`, used only for local browser and e2e checks. Production uses Neon only. Unit tests use PGlite.
- Why: Migrations, seed, login and Playwright can run before Neon exists. It is a development environment, not a runtime fallback.

### D-004 Beads for task tracking
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Work is tracked as `bd` issues, one per phase or major sub-task (wardrobe-pai, wardrobe-52y, wardrobe-6rd, wardrobe-a27, wardrobe-evp, wardrobe-g4t). No markdown TODO lists.
- Why: The owner's AGENTS.md rule.

### D-005 Node 26 LTS
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: The global Node 25.2.1 was upgraded to Node 26 LTS with winget; `engines.node` is `26.x`.
- Why: Node 25 is end-of-life, ships without corepack, is outside Vitest 5's engine range and is not offered on Vercel. pnpm refuses to install when `engines` does not match the running Node.

### D-006 pnpm 11 with corepack on Vercel
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: pnpm 11.28.9 via `packageManager`. `pnpm-workspace.yaml` holds `allowBuilds` (esbuild allowed; sharp and unrs-resolver not) and exempts `next`, `@next/*` and `eslint-config-next` from `minimumReleaseAge`. Vercel needs `ENABLE_EXPERIMENTAL_COREPACK=1`.
- Why: pnpm 12 is a Rust rewrite not yet verified on Vercel. Without corepack, Vercel picks pnpm 9/10 from the lockfile version. The 24-hour release-age rule would block the Next.js security release due 2026-11-03.

### D-007 Next.js 16.4.3 and TypeScript 5
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: next and eslint-config-next 16.4.3, React 19.3, Turbopack, `typedRoutes` on, React Compiler off, TypeScript ^5 (not 7). Bump next and eslint-config-next to the security release once it is out.
- Why: Current stable release. typescript-eslint does not support TypeScript 6.1 or later yet.

### D-008 Drizzle 1.0.0-rc.5, exact pin
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: drizzle-orm and drizzle-kit pinned to exactly 1.0.0-rc.5, using the v1 API (`snakeCase.table`, `defineRelations`, `drizzle-orm/zod`, v3 migration folders). Falling back to 0.45.4 would need a new entry.
- Why: The official docs are v1-first, and starting on v1 avoids a later migration. Exact pins plus PGlite and Docker migration tests contain the release-candidate risk.

## Platform and data

### D-009 `pg` driver instead of `@neondatabase/serverless`
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: `pg` with `drizzle-orm/node-postgres` and `attachDatabasePool` on the pooled `DATABASE_URL`. drizzle-kit migrates over `DATABASE_URL_UNPOOLED`, and `drizzle.config.ts` throws if that variable is missing (no silent fallback to the pooled URL). Confirmed with the owner.
- Why: This is Neon's current recommendation for Vercel Fluid compute. It gives real interactive transactions that behave like PGlite in tests and works unchanged against Docker Postgres.

### D-010 `src/proxy.ts` instead of `middleware.ts`
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: The auth gate is `src/proxy.ts` exporting `proxy`.
- Why: Next.js 16 renamed middleware to proxy; `middleware.ts` is deprecated.

### D-011 Extra tables and columns
- Date: 2026-11-01 · Status: accepted; extended by D-058 and D-128 · Deviates from spec: yes (additions only; every spec table and column stays)
- Decision: Extra tables `login_attempts`, `ai_batches`, `analysis_parts` and `app_settings` (one row: home climate profile, default item location). Extra columns: `items.source_hash` (unique), `tagging_error`, `tagging_batch_id`, `ai_prompt_version`; `analyses.status`, `effort`, `prompt_version`, `cache_key`, `input_snapshot`, `estimated_cost_usd`, `error`, `completed_at`; `shopping_list_items.gap_key`, `quantity`, `est_price_min_eur`, `est_price_max_eur`, `buy_timing`; `climate_profiles.slug`, `timezone`, `is_placeholder`.
- Why: Each one backs a concrete need: login rate limiting, batch tracking, resumable analyses under the 300 s limit, pre-upload dedupe, idempotent "add gaps", the `/today` location.

### D-012 Climate seed data
- Date: 2026-11-01 · Status: accepted; re-seed behaviour refined by D-057 · Deviates from spec: no
- Decision: Hamburg is seeded from spec section 6 with every note copied verbatim (lat 53.633, lon 9.988, Europe/Berlin). Bologna is a placeholder: only January tmax 6.5 and July tmax 31, everything else null, `is_placeholder` true. Month values are nullable, the seed upserts on slug, and the 12-month editor clears the flag once every value is filled.
- Why: Avoids inventing climate numbers that the owner will supply.

## Authentication

### D-013 Proxy check plus a session check in every read and action
- Date: 2026-11-01 · Status: accepted; matcher superseded by D-055, cookie name by D-059 · Deviates from spec: no
- Decision: `proxy.ts` does an optimistic jose HS256 check (`algorithms: ['HS256']`, iss/aud `wardrobe`, 30 days, cookie `wardrobe_session` httpOnly, secure, lax). Every Server Action, Route Handler and DAL or service read function calls `requireSession()` itself. A boundary test checks the read functions, and an e2e test checks that a cookieless forged action POST returns no data.
- Why: Proxy lets requests with a `Next-Action` header through, and that header can be forged. The Next.js docs say not to rely on proxy alone.
- Matcher (Phase 2 copies it as is): `matcher: ['/((?!_next/static|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|icons/|manifest\\.webmanifest$|sw\\.js$|offline$|login$|api/blob/upload$|api/cron/).*)']`. The metadata icons, `/icons/*`, `/manifest.webmanifest`, `/sw.js` and `/offline` must stay public: browsers fetch the manifest without cookies (unless the link has `crossorigin="use-credentials"`), so a gated manifest breaks installation even when signed in, and the service worker fetches `/offline` with `redirect: 'error'`, so a redirect to `/login` fails its install. A unit test checks the matcher with `unstable_doesProxyMatch` from `next/experimental/testing/server`.

### D-014 Login rate limit without a global lock
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Attempts are stored in `login_attempts`, keyed by sha256(ip|SESSION_SECRET); 5 failures in 15 minutes lock that key. There is no global lock: a high threshold only logs. `pnpm auth:unlock` clears the attempts. `?next=` redirects must be same-origin relative paths. bcryptjs cost 12, passwords at most 72 bytes.
- Why: In-memory counters do not survive serverless instances. A global lock would let any anonymous visitor lock the owner out.

### D-015 `APP_PASSWORD_HASH` stored as base64
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: The variable holds the base64 encoding of the bcrypt hash; `pnpm hash-password` prints it. A raw `$2b$…` value is rejected with a hint.
- Why: `@next/env` expands `$` in `.env` files, and `vercel env pull` writes dashboard values into `.env.local`, so a raw hash gets corrupted locally. Base64 has no `$`, so one value works everywhere.

## Environment

### D-016 Lazy, grouped environment validation
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: `src/env.ts` exposes one memoized zod getter per concern (db, session, password, blob, ai, cron, flags), parsed at first use, never at import. An empty string counts as unset; errors name variables, never values. `env.ts`, the db client and the AI and auth modules import `server-only`; `src/lib/ai/models.ts` stays free of it so scripts and tests can load it. A boundary test forbids client imports of all of them, `models.ts` included. `pnpm env:check` reports each group.
- Why: Phase 1 must build with no credentials and each later phase needs only its own variables. Missing values still fail loudly when first used.

### D-017 tsx scripts run with `--conditions=react-server`
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Every tsx script runs as `tsx --conditions=react-server …`. Vitest aliases `server-only` to a stub. `schema.ts`, `enums.ts` and `drizzle.config.ts` do not import `server-only`.
- Why: Under that condition `server-only` resolves to its empty export instead of throwing. drizzle-kit loads the schema files without the condition.

## AI layer

### D-018 Structured outputs through our own schema conversion
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: Calls use `messages.create` or `.stream` with `output_config.format` built by our own zod-to-JSON-Schema sanitizer: it keeps `enum` and `const`, strips min/max/length/pattern, and forces `additionalProperties: false` with every key required. The text is then `JSON.parse`d and checked against a stricter zod schema.
- Why: The SDK's `zodOutputFormat` drops `enum` and `const`, so enums would only be hints. `messages.parse` throws and loses the `usage` and `stop_reason` needed for logging and retries.

### D-019 A single, deadline-aware retry loop
- Date: 2026-11-01 · Status: accepted; outcomes and error mapping refined by D-062 · Deviates from spec: no
- Decision: The SDK runs with `maxRetries: 0`; `callStructured()` is the only retry loop, with at most 3 attempts. It retries 408, 409, 429, 5xx and 529, connection and mid-stream errors, invalid JSON or schema output, and `max_tokens` (once, with the cap doubled). Refusals and other 4xx are final. It honours `retry-after-ms` and `retry-after`, otherwise uses full jitter capped at 8 s, and fails fast with `RATE_LIMITED` when a wait would pass the route deadline.
- Why: Layering our loop on the SDK's would allow up to 9 attempts, and the SDK's uncapped `retry-after` could overrun the 300 s function limit.

### D-020 Every attempt logged; budget checked before spending
- Date: 2026-11-01 · Status: accepted; refined by D-127 · Deviates from spec: no
- Decision: Every attempt writes an `ai_calls` row: tokens (including cache read, cache write and thinking), cost, latency, request id, stop reason and status. An operation is blocked when UTC month-to-date spend plus pending batch estimates plus its own estimate would exceed `MONTHLY_AI_BUDGET_USD`.
- Why: Failed attempts cost money too, and a projection makes the hard stop meaningful for bulk runs. Concurrent in-flight calls can still overshoot by a few cents.

### D-021 Extended pricing table
- Date: 2026-11-01 · Status: accepted; corrected 2026-11-02 (Sonnet 5.5 cache reads are 0.1x, not 0.05x) · Deviates from spec: yes
- Decision: `PRICING_PER_MTOK` keeps the spec's values and adds cache read (Haiku 5.5 and Sonnet 5.5 0.1x, Sonnet's $0.20 per MTok; only Opus 5.5 0.05x, also $0.20 per MTok), cache write (5 minutes 1.25x, 1 hour 2x) and batch (0.5x). Haiku 5.5's long tier applies when input plus cache tokens exceed 100,000, and then the whole request pays long rates. Model overrides use `||` and must be priced models, otherwise a configuration error is raised before any call.
- Why: Cache and batch tokens must be costed for the budget to hold, and an empty env string must fall back to the default model.

### D-022 No sampling parameters, no refusal fallback, no "reasoning" keys
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Requests send no temperature, top_p, top_k or assistant prefill. Refusals surface as errors (a tagged item stays `pending_tagging` with `tagging_error`; a relocation part fails with Retry). Thinking blocks are skipped by type. No structured-output key may match `/reasoning|thinking|thought/`; user-facing justifications are named `why` or `reason`.
- Why: API version 2026-10-21 rejects sampling parameters. The owner's rules forbid silent fallbacks. Keys named like reasoning risk `reasoning_extraction` refusals.

### D-023 Tagging with Haiku 5.5 at low effort and a cached prompt
- Date: 2026-11-01 · Status: accepted; request shapes in D-065 · Deviates from spec: no
- Decision: Haiku 5.5, effort `low`, `max_tokens` 4096, non-streaming. A static system prompt of about 1.3–1.6K tokens with `cache_control`, versioned `tag-v1`, with the image block before the text. The client tags 4 items at a time with per-item Retry. The tag cache key is `image_hash`; Re-tag forces a new call and keeps `user_edited_fields`.
- Why: Cheap, fast tagging that follows the spec. Caching makes the repeated prompt about 10x cheaper, and a test pins the prompt hash so any edit forces a version bump.

### D-024 Batch mode with a synchronous dry run
- Date: 2026-11-01 · Status: accepted; processing refined by D-068, pricing and creation by D-084, claiming and deadlines by D-089 and D-090 · Deviates from spec: no
- Decision: Above 20 items, the app offers Message Batches (50% cheaper, image as a URL source, 1-hour cache TTL). Batches are polled on page visits and by a daily cron, and results are processed idempotently by `custom_id`. Before `batches.create`, the first item is tagged synchronously with exactly the batch parameters; if that fails, no batch is created.
- Why: Batch parameters are only validated after the whole batch ends. Hobby crons run at most once a day.

## Relocation analysis

### D-025 Chunked, resumable relocation analysis
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: Instead of one call, the analysis runs as chunks of at most 70 items grouped by category, in parallel, plus one synthesis call. The browser orchestrates it; parts are stored in `analysis_parts` and can resume. Items appear as aliases `i1..iN`, mapped back to UUIDs on the server.
- Why: Vercel Hobby functions stop at 300 s. A single 300-item Sonnet call takes about 200–250 s and grows with the wardrobe. Aliases cut output tokens about 10x compared with UUIDs.

### D-026 Honest relocation cost estimate
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: The cost of a 300-item analysis is documented as about $0.30–0.50, not the spec's $0.20–0.30, and will be replaced by the measured value after the first live run.
- Why: Thinking at effort medium plus a reason per item make the spec's figure unrealistic.

### D-027 Relocation result shapes
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: The stored result keeps the spec's field names, but `est_price_range_eur` becomes `{min, max}`, `buy_before_or_after_move` an enum (`before_move`, `after_move`, `either`), and each gap's `specs` a string array. Wire schemas may use aliases internally.
- Why: Numbers are needed for the budget checks; enums and arrays validate cleanly.

### D-028 Relocation inputs and caching
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: The snapshot holds tagged and confirmed items only (pending and archived items are excluded, and the form shows how many). Each line carries a low-confidence marker for unedited fields with `ai_confidence` below 0.6. The form takes an explicit purchase budget in EUR. An identical earlier run is reused unless the user chooses "Re-run anyway". AI decisions are never written to `items.decision` without an explicit action.
- Why: The warnings can flag uncertain tags, the gap list can be checked against a budget, and the owner's own decisions are never overwritten silently.

### D-029 Gaps preselected for one-click adding
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes (minor)
- Decision: All gaps start selected, so one click adds them to the shopping list (idempotent on `gap_key`); the user can deselect some first.
- Why: Keeps the spec's one-click behaviour while allowing opt-out.

## Uploads and images

### D-030 `BLOB_READ_WRITE_TOKEN` stays required
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no (the spec's variable is kept)
- Decision: The token is required even on an OIDC-connected store. The store must be connected with the Development environment included.
- Why: `handleUpload` still signs client tokens with it, and `vercel env pull` only writes it when Development is connected.

### D-031 Blob calls and upload validation
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Every server Blob call (`put`, `del`, `head`) passes the token explicitly. `/api/blob/upload` checks the session and a zod-discriminated `clientPayload` (`{kind: 'original', itemId, sourceHash}` or `{kind: 'nobg', itemId}`), validates the pathname per kind, sets size limits and registers no `onUploadCompleted`. `/api/items/register` validates the URL with `head(url)` and the pathname prefix and is idempotent on the item id.
- Why: One deterministic credential path instead of an implicit OIDC one. The completion callback never fires on localhost and carries no session. `head()` is documented, while parsing the token format is not.

### D-032 Hand-rolled client image pipeline
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: Instead of `browser-image-compression`: `createImageBitmap(file, {imageOrientation: 'from-image', resizeWidth/resizeHeight})`, drawn to an HTMLCanvasElement (no OffscreenCanvas branch), encoded as JPEG q0.85 with a 2048 px long edge. HEIC is detected by magic bytes and converted by a lazily loaded `heic-to`.
- Why: The library is unmaintained since 2023 and loads its worker from a CDN. Safari cannot encode WebP from canvas and silently returns PNG. Resizing at decode time avoids iOS canvas limits, and re-encoding strips EXIF and GPS data.

### D-033 Server-side images and dedupe
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Register runs sharp `.rotate()` and produces a 1024 px WebP q80 and a 400 px thumbnail. `image_hash` is sha256 of the processed image; a duplicate deletes the new original. The client also sends `source_hash` (sha256 of the original) so known photos are skipped before upload. Thumbnails render as plain `<img>` with `images.unoptimized`.
- Why: The spec's sizes and cache key. Pre-upload dedupe saves Blob operations and API calls, and plain images use no Image Optimization quota.

### D-034 Background removal with `@imgly/background-removal`
- Date: 2026-11-01 · Status: accepted; spike passed, setup in D-077, runtime served by the app per D-081 · Deviates from spec: no
- Decision: `@imgly/background-removal` 1.7.0 with `onnxruntime-web` 1.21.0 pinned exactly, loaded lazily on the client only, models from the IMG.LY CDN, `device: 'cpu'` only, and no COOP/COEP headers, so it runs single-threaded. It starts with a time-boxed compatibility spike in a visible browser; if it does not bundle or run on Next.js 16 with Turbopack, work stops and the owner is asked (no silent library swap).
- Why: The owner accepted the AGPL-3.0 licence for this private single-user app (see README). COOP/COEP would break loading images from Blob.

## Features

### D-035 Route Handlers for concurrent work
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: Work the browser runs in parallel uses Route Handlers (`/api/items/register`, `/api/items/[id]/tag`, `/api/analyses/[id]/parts/[partId]`). Single mutations stay Server Actions.
- Why: Next.js dispatches Server Actions one at a time per client, so a pool of 4 built on actions would run serially.

### D-036 Image export as one ZIP or numbered parts
- Date: 2026-11-01 · Status: accepted; refined by D-115 · Deviates from spec: yes
- Decision: A streamed ZIP route (`client-zip`) returns one ZIP when the predicted size streams comfortably within 300 s, otherwise `?part=N` with at most 100 items each.
- Why: Streamed responses avoid the 4.5 MB limit, but Hobby stops functions at 300 s, and iOS cannot hold a large in-memory Blob.

### D-037 Search and browsing
- Date: 2026-11-01 · Status: accepted; refined by D-108 and D-109 · Deviates from spec: no
- Decision: Filters live in URL search params parsed with zod. Search is ILIKE (with `%` and `_` escaped) over name, description, brand, subcategory and notes, plus array matches. The grid is row-virtualized with `useWindowVirtualizer`, 2 to 6 columns.
- Why: A single wardrobe is a few hundred rows; ILIKE behaves the same on Neon, Docker and PGlite and needs no extension.

### D-038 Outfit slots
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: A `base_layer` slot is added, and a dress fills the top slot and makes the bottom optional. AI outfit outputs are a list of `{slot, item}` entries with a `why` field.
- Why: Base layers are central to dressing for Hamburg. A list avoids hitting the structured-output union limit.

### D-039 Weather from Open-Meteo, cached
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: The `/today` forecast is fetched server-side in a `'use cache'` function (about 30 minutes), validated with zod, and shown with the attribution "Weather data by Open-Meteo.com".
- Why: Free and keyless. Its licence requires attribution, and caching protects against per-IP limits on Vercel's shared IPs.

### D-040 Shopping AI behind a flag
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: The shopping list is always on. The "What to buy next" analysis is behind `FEATURE_SHOPPING_AI` (default false). How many outfits an item would unlock is computed deterministically in TypeScript; Claude only ranks and explains.
- Why: The spec allows a flag. Deterministic counts are testable and keep the numbers honest.

## UI and framework

### D-041 Cache Components page convention
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Cache Components stays on. Each page is a static shell; session, cookies, `searchParams`, route `params` and DB reads live in async children inside `<Suspense>` with skeleton fallbacks. The page passes the `params` promise down and the child awaits it. No `dynamic` or `runtime` segment exports.
- Why: It is the scaffold default and the Next.js 17 direction, and suits a PWA. Violations only fail `next build`, so the build is part of every phase gate.

### D-042 shadcn with Base UI primitives
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: shadcn CLI 4.23, base-nova style. Components use the Base UI `render` prop, never `asChild`. Toasts use Base UI `toast` (`toast.add`), forms use `field` with react-hook-form. Buttons and toggles get 44 px `touch` and `icon-touch` sizes. The sidebar and the mobile tab bar switch by CSS (`md:`), not by a JS media query.
- Why: Current shadcn defaults. The default 32 px controls are below the 44 px touch target, and CSS switching avoids a hydration flash.

### D-043 next-themes warning accepted
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: next-themes 0.4.6 is used even though it logs a dev-only "script tag" error with React 19 and Next.js 16.
- Why: Known upstream issue (#387) with no effect on production. Recorded so it is not mistaken for a regression.

### D-044 English UI
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: All UI text is in English.
- Why: One language keeps UI labels, enum values and prompts consistent.

### D-045 PWA with a hand-written service worker
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: `src/app/manifest.ts` (standalone, start URL `/wardrobe`). Icons are generated from `assets/icon.svg` with sharp and committed. `public/sw.js` serves navigations network-first with a precached `/offline` fallback and `/_next/static` cache-first, and caches nothing else. It is registered in production only, with `updateViaCache: 'none'`. iOS gets a manual install hint. Install stores `/offline`, the stylesheets it links and the icons in a shell cache, fetched with `redirect: 'error'` so a redirected page is never stored; runtime `/_next/static` copies go to a separate cache capped at 200 entries. `test/sw.test.ts` runs the worker against fake caches and fetch.
- Why: The spec asks only for an offline shell, and iOS has no install prompt event.

## Testing

### D-046 Tests with PGlite and fakes, no network
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Vitest in a node environment by default, jsdom per file. Services take injected dependencies (`db`, `anthropic`, `blob`, `fetch`, `clock`, `random`); DB tests run on PGlite migrated from `./drizzle`; AI, Blob and fetch are faked. `pnpm test` never touches the network. Playwright runs locally only, in a visible browser, against a production build and the Docker `wardrobe_e2e` database.
- Why: Fast, deterministic tests of the real SQL and logic. Live behaviour is listed separately in HANDOFF.md until it has been checked.

### D-047 Phase gate includes the build
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: A phase is done only when `pnpm typecheck && pnpm lint && pnpm test && pnpm build` passes.
- Why: Cache Components violations surface only during `next build`.

### D-048 Phone testing over real HTTPS
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Phone checks (camera, HEIC, install) use a preview deploy, requested when needed. The alternative is LAN HTTPS with a certificate for the LAN IP and the mkcert root CA installed on the phone.
- Why: The camera, `crypto.subtle` and service workers need a trusted secure context; plain `--experimental-https` is not trusted over a LAN IP.

## Added after the Phase 1 review

### D-049 Environment variables and MODELS beyond the spec
- Date: 2026-11-02 · Status: accepted · Deviates from spec: yes (additions only)
- Decision: Four variables join the spec's list: `CLAUDE_OUTFIT_MODEL` (defaults to the analysis model), `CLAUDE_ANALYSIS_EFFORT` (`low`, `medium` or `high`, default `medium`), `AI_CREDIT_USD` (default 100) and `CRON_SECRET` (at least 16 characters, needed only by the cron route). `MODELS` in `src/lib/ai/models.ts` gains an `outfits` key, and its keys are getters that resolve the overrides on each access and throw a CONFIG error for an unpriced model, instead of a plain object read once when the module loads.
- Why: Phase 6 asks for a configurable outfit model and Phase 1 for a configurable analysis effort; the usage page compares spend with the $100 prepaid credit; the daily cron route needs a bearer secret. Resolving on access keeps the import free of env validation, so the build, tests and scripts load the module without credentials.

### D-050 Local edits to generated shadcn files
- Date: 2026-11-02 · Status: accepted; refined by D-117 · Deviates from spec: no
- Decision: These generated files carry local edits that `shadcn add --overwrite` would undo, so re-apply them after any overwrite: `sidebar.tsx` has no Ctrl/Cmd+B keyboard toggle; `badge.tsx` starts with `"use client"`; the `toast.tsx` viewport sits above the mobile tab bar below `md`; `button.tsx` and `toggle.tsx` have the 44 px sizes from D-042. Since Phase 4 (D-117): `button.tsx` renames the cva output to `buttonClasses` and exports `buttonVariants` as a wrapper that merges it with `cn` (D-117 d), and its destructive variant uses `text-destructive-strong`; `badge.tsx`'s destructive variant uses `text-destructive-strong` (D-117 c); `globals.css` defines `--destructive-strong` in light and dark mode and maps it as `--color-destructive-strong` in `@theme`.
- Why: The sidebar uses `collapsible="none"`, so the shortcut changed nothing visible but took Ctrl+B from the browser (Firefox's bookmarks sidebar) and wrote a `sidebar_state` cookie the app never reads. `badge.tsx` calls Base UI's `useRender`, which reaches client-only hooks, so a Badge rendered from a Server Component would fail. Toasts would otherwise cover the tab bar.

### D-051 Focus rings and reduced motion
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `--ring` and `--sidebar-ring` use the foreground colour (`oklch(0.145 0 0)` light, `oklch(0.985 0 0)` dark) instead of shadcn's grey. A global `prefers-reduced-motion: reduce` rule in `globals.css` cuts animation and transition durations to 0.01 ms.
- Why: The components draw focus rings at 50% of `--ring`. The grey default gave about 1.5:1 in light mode and 1.9:1 in dark mode, below the 3:1 of WCAG 1.4.11; the foreground colour gives about 3.7:1 and 5.1:1 without editing the components. Near-zero durations instead of `none` let Base UI still see its transitions end.

### D-052 iOS status bar and theme colour
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `appleWebApp.statusBarStyle` is `default`, not `black-translucent`. The client component `ThemeColorSync` sets every `theme-color` meta tag to the resolved theme and drops its media query, so the browser and installed-app chrome follow the in-app theme choice. The manifest's `theme_color` and `background_color` stay `#0a0a0a`.
- Why: `black-translucent` always draws white status-bar text over the page, which is invisible on the light theme. The viewport tags alone follow only the OS scheme. The manifest is static, so an Android launch on the light theme briefly shows the dark splash and title bar until the page sets its colour; that is accepted.

### D-053 CONFIG errors hidden from clients
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `toErrorPayload` turns every CONFIG AppError into the fixed message "The server is misconfigured. Check the server logs." with no details. Server code that converts errors (the Phase 2 `authedRoute` and `authedAction` wrappers and the login action) logs the original error first, for CONFIG and INTERNAL alike.
- Why: CONFIG messages from `env.ts` name variables and what is wrong with them. Without this, public routes such as login would show that to anonymous visitors.

## Added in Phase 2

### D-054 Login form that works without JavaScript
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `/login` is a fully static page under the `(auth)` layout (no sidebar or tab bar) and reads no request data on the server. The whole form prerenders: the `login` Server Action goes straight into `useActionState` and `<form action>`, so before hydration or without JavaScript the browser posts the form, the action redirects on success, and an error re-renders the page with the returned state. The hidden `next` field is a client component reading `useSearchParams()` inside `<Suspense>`, so it renders only after hydration; a form posted before that has no `next` field, and the action takes `next` from the Referer instead when the Referer is `/login` (the browser posts the form to the page's own URL, and the app's `strict-origin-when-cross-origin` policy keeps the query on same-origin requests). Both values are untrusted and go through `safeRedirect`. After an error, focus returns to the cleared password field, whose `aria-describedby` points at the alert. Logout is a plain form posting to the `logout` action, on Settings (Account) and in the desktop sidebar footer.
- Why: A login page that needs JavaScript fails on slow or broken connections, which is when a PWA most needs it. Wrapping the whole form in Suspense would leave visitors without JavaScript with only the fallback, and wrapping the action in a client function would lose the progressive enhancement. The page must stay fully static because Next 16.4.3 answers a form-posted (non-JavaScript) Server Action on a partially prerendered route with only the resumed dynamic part and no static shell: the first version read `searchParams` on the server for the `next` field, and a wrong password without JavaScript then showed a blank page. `e2e/auth.spec.ts` covers both the error and the `next` redirect with JavaScript disabled.

### D-055 Proxy behaviour and matcher
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: D-013's matcher with two changes: `/login` is matched, so a signed-in visitor is redirected to the `next` target (default `/wardrobe`) instead of seeing the form, while a signed-out visitor always passes (the target goes through `safeRedirect`, which checks the raw value and again after URL normalization, because dot segments such as `/.//evil.com` or `/%2e//evil.com` collapse into the protocol-relative `//evil.com`); and `robots.txt` is excluded, so crawlers get the file or a 404 rather than a redirect. Signed-out page requests get 307 (GET and HEAD) or 303 (other methods) to `/login?next=<path and query>`. `/api/*` without a valid session gets 401 JSON `{ ok: false, error: { code: "UNAUTHENTICATED" } }` with `Cache-Control: no-store`, and a `Next-Action` header buys no pass there. Page POSTs with a `Next-Action` header pass through, because redirecting them would break the action protocol; the actions and the DAL answer for themselves (D-013). Without `SESSION_SECRET` the proxy fails closed and treats every request as signed out. `e2e/auth.spec.ts` covers the redirects, the public PWA files, the API 401, `/login` while signed in, and a cookieless forged action POST to `/wardrobe` that must return neither the app shell nor a seeded item's name. The matcher unit test uses `unstable_doesMiddlewareMatch` from `next/experimental/testing/server`: Next 16.4.3 exports the helper under that name, and the `unstable_doesProxyMatch` named in D-013 and the proxy docs does not exist in this version.
- Why: Showing the login form to someone already signed in is a dead end, and API clients need a status they can act on rather than an HTML redirect. The proxy stays an optimistic filter; the security boundary is the DAL.

### D-056 E2E runs on an isolated database with throwaway credentials
- Date: 2026-11-02 · Status: accepted; every other app variable blanked by D-102 · Deviates from spec: no
- Decision: `playwright.config.ts` starts the server with its own environment: `DATABASE_URL` and `DATABASE_URL_UNPOOLED` point at the Docker `wardrobe_e2e` database, `APP_PASSWORD_HASH` is the base64 bcrypt hash (cost 4) of the fixed, non-secret `E2E_PASSWORD` in `e2e/constants.ts`, and `SESSION_SECRET` is 48 random characters generated at each run. Process variables override `.env.local`, so no env file is needed and a developer's real values are never used. `e2e/global-setup.ts` applies the migrations, truncates every public table (migration history excluded) and runs the same seeder as `pnpm db:seed`; it builds its own `pg` pool because `src/lib/db/client.ts` imports `server-only`. If the database is unreachable it fails with a hint to run `docker compose up -d db`.
- Why: Runs must be repeatable and must never touch the development database or a real password. Truncating `login_attempts` keeps the rate limit from carrying over between runs, and a fresh secret invalidates any session left from an earlier run.

### D-057 Re-seeding keeps the owner's data
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `pnpm db:seed` upserts Hamburg on its slug, restoring the reference values on every run, and makes it the only default profile (taking the flag from any other profile first, because of the partial unique index). Bologna is inserted only when missing and never overwritten. The `app_settings` row (home profile Bologna, new items in Bologna) is created only when it does not exist. `seedDatabase(db)` needs no Next or env imports, so the e2e global setup reuses it.
- Why: The climate editor lets the owner fill in Bologna and change settings; a re-run of the seed must not undo that, while Hamburg is spec data that should stay correct.

### D-058 Schema details settled in Phase 2
- Date: 2026-11-02 · Status: accepted · Deviates from spec: yes (additions only)
- Decision:
  - `wear_logs` foreign keys to `items` and `outfits` cascade on delete instead of setting null.
  - Additions beyond D-011: `ai_batches.model` (not null), `item_images.created_at`, `climate_profiles.created_at` and `updated_at`; CHECKs `wear_count >= 0`, shopping `quantity >= 1` and exactly 12 entries in `climate_profiles.months`; an index on `analyses (kind, created_at)`, and an index led by every foreign-key column (a plain index, or a unique constraint or primary key that starts with it) except `app_settings.home_profile_id` on the single settings row. `test/db/migrations.test.ts` checks the foreign-key indexes against the database catalogue.
  - Enum values not fixed elsewhere: analysis and part statuses `pending`, `running`, `complete`, `failed`; part kinds `chunk`, `synthesis`; AI purposes `tagging`, `relocation_chunk`, `relocation_repair`, `relocation_synthesis`, `outfit_suggestion`, `shopping`, `smoke_test`; AI call statuses `success`, `invalid_output`, `max_tokens`, `refusal`, `error`; batch statuses `in_progress`, `canceling`, `ended`, `processed`.
  - `drizzle.config.ts` sets neither `strict` nor `casing`: drizzle-kit 1.0.0-rc.5 has no such keys (`strict` is replaced by `--explain`). Snake case comes from `snakeCase.table` in the schema, which also covers the runtime, since v1 drivers take no casing option.
  - The first migration is `drizzle/20261102094305_init`. It was regenerated once before anything was deployed, to add the missing foreign-key indexes, so no second migration exists for them.
- Why: With SET NULL, the CHECK that a wear log names an item or an outfit would make it impossible to delete an item or outfit that has wear logs. The extra columns and checks back Blob-operation counting, batch costing and data integrity; the indexes serve the foreign-key lookups and the analysis history. Without them, every ON DELETE SET NULL or CASCADE scans the referencing table; for `ai_calls`, which gains a row per Claude attempt, that would make each item or analysis delete slower over time.

### D-059 Session and login details
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: The session token is issued once at login for a fixed 30 days and is not renewed on use; `maxTokenAge` bounds its age by `iat` as well, so no token outlives 30 days and changing `SESSION_SECRET` signs out every device. The cookie is `__Host-wardrobe_session` with `path=/`, no Domain, httpOnly, Secure and SameSite=Lax; logout overwrites it with `maxAge` 0. Changing the password does not end existing sessions; rotating `SESSION_SECRET` does, and the README says to do both after a suspected compromise. The rate-limit client is the first `x-forwarded-for` entry, then `x-real-ip`, otherwise one shared `unknown` bucket. An IPv6 address counts as its /64 network and an IPv4-mapped IPv6 address as the IPv4 address before hashing. The per-client limit is only trustworthy behind a proxy that overwrites `x-forwarded-for`, such as Vercel: Next 16.4.3 sets the header from the socket only when it is absent, so a self-hosted `next start` lets each client pick its own key. More than 200 failed logins in an hour across all clients only logs a warning (D-014). The login and logout actions are the only ones that run without a session. Mutating Route Handlers also refuse a missing or foreign `Origin` with 403.
- Why: A single owner gains little from sliding sessions, and a fixed lifetime keeps the token check stateless. On Vercel the platform overwrites `x-forwarded-for`, so its first entry is the client. One host routinely holds a whole IPv6 /64 and could otherwise get 5 guesses per address. The `__Host-` prefix makes browsers refuse a session cookie set by a sibling subdomain or with a Domain attribute, so it cannot be shadowed (cookie tossing); Chromium accepts it on `http://localhost`, so local builds and e2e runs need no change. The Origin check guards cookie-authenticated routes against cross-site requests, which SameSite=Lax alone does not fully cover.

## Added in Phase 3

### D-060 One set of item contracts for Claude's output and the owner's edits
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `src/lib/items/contracts.ts` (client-safe) defines the field limits and one validator per editable tag field; the strict tagging schema and the patch schema both use them. Text is trimmed; colour names and materials are 1–40 characters; colour names are unique ignoring case. `colors` and `color_hex` are parallel lists, so a patch must carry both with the same length. The item-card loaders treat a malformed id as NOT_FOUND (routes as VALIDATION) without querying.
- Why: Claude's tags and the owner's edits then pass the same rules, and the form and server cannot drift apart. Passing a malformed uuid to Postgres fails with a syntax error, which would surface as a 500.

### D-061 Tagging wire schema and its conversion
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: The wire schema has no optional keys and exactly three nullable unions (`breathable`, `fit`, `brand_guess`); its length limits are written into the field descriptions, and the strict schema enforces them after `JSON.parse`. Warmth is `z.literal([1, 2, 3, 4, 5])`, which converts to an integer enum. The converter reads zod's input side, inlines refs, rejects cycles, allow-lists keywords (anything unknown throws), turns `oneOf` into `anyOf`, drops `format`, `default`, `uniqueItems` and the other limits, and throws above 16 unions or on any optional key. The result is memoised and frozen per schema.
- Why: A union of literals would count toward the 16-union limit. Refusing unknown constructs is safer than loosening them silently. Identical bytes on every request keep the prompt cache prefix stable.

### D-062 Retry outcomes and error mapping (refines D-019)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: When the server's `retry-after` would pass the deadline the call ends with AI_UNAVAILABLE (with `details.retryAfterSeconds`), and when even the backoff leaves too little time with AI_TIMEOUT; D-019's RATE_LIMITED is not used for Claude calls. An attempt starts only with at least 2 s left. 401, 403 and 404 (and the same mid-stream errors) are CONFIG; 400, 402, 413 and 422 are AI_UNAVAILABLE and final; 408 is retried as AI_TIMEOUT; 409, 429, 5xx and 529 are retried as AI_UNAVAILABLE; `x-should-retry` is obeyed both ways. Invalid output is retried at once, `max_tokens` once with the cap doubled up to the ceiling (tagging 4096 to 8192), and refusals are final with `stop_details` in the error. `ai_calls.error_code` holds a short label (`http_529`, `stream_overloaded_error`, `connection`, `deadline`, `invalid_output` and so on).
- Why: The caller can tell a temporary outage from a deadline, and RATE_LIMITED stays the login limit's code. A 401 or 404 means a wrong key or model, which retrying cannot fix. Short labels keep the usage page and log queries readable.

### D-063 Cost estimate and budget arithmetic
- Date: 2026-11-02 · Status: accepted; the dry run's price refined by D-084 · Deviates from spec: no
- Decision: The tagging estimate assumes a 1024 × 1024 image (1,369 tokens), 400 tokens of format overhead, 700 output tokens and a system prompt of characters ÷ 3.5 × 1.3 (1,984 tokens); the first call of a run writes the cache and later calls read it. About $0.055 per 100 items synchronously and $0.028 batched. Cache writes not covered by the per-TTL breakdown are priced as 5-minute writes. The budget compares whole micro-dollars and stops when spend reaches the budget, even for a zero estimate. A batch is checked as the dry run at normal rates plus the rest at batch rates; `ai_batches.estimated_cost_usd` holds only the batch part, because the dry run is logged at once, and it counts as pending until the batch is marked processed.
- Why: The spec's estimator with its tokenizer factor, made explicit so `ai:smoke` can compare it with measured cost. Counting the dry run twice, or a processed batch both as pending and as logged spend, would block work early.

### D-064 AI settings without the key; the client only when needed
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `aiSettingsEnv()` returns the models, effort, budget and credit without reading `ANTHROPIC_API_KEY`; its errors are reported under the `ai` group, and `env:check` is unchanged. The Anthropic client is created only when a call is sent: a cached tag and a poll with no open batch never touch it.
- Why: The add, review and usage pages must render, and say what is missing, before the key exists (and in e2e, which has no key).

### D-065 Tagging request shapes
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: Tagging one item reads the processed WebP (10 s timeout, no redirects, at most 5 MiB) and sends it as base64 with the 5-minute cache, under a 50 s deadline inside the route's `maxDuration` of 60. The batch dry run and the batch requests are built by one function with a URL image and the 1-hour cache, so they differ only in the URL; a test checks this. The tag route does not pass the request's abort signal on. tag-v1 category boundaries: blazers and fleece pullovers are tops, zip-up outdoor fleeces and softshells outerwear, socks, tights and underwear base layers, wallets and umbrellas accessories, swimwear and sleepwear other.
- Why: A dry run is only meaningful if it sends what the batch sends. A paid-for answer should be stored even if the browser leaves.

### D-066 Tagging failures and items in a batch
- Date: 2026-11-02 · Status: accepted; the open question resolved by D-093 · Deviates from spec: no
- Decision: A budget block sends nothing and writes no `tagging_error`. Any later failure writes one (the AppError message cut to 300 characters, or a generic text for CONFIG and INTERNAL) and leaves the status unchanged. Tagging an item that waits in a batch is a CONFLICT unless forced; a forced re-tag clears the batch link, and the later batch result is skipped but still logged as spend. Open question for the owner (resolved by D-093, "Fill in by hand"): an item Claude refuses stays pending and cannot be confirmed even with every tag filled in by hand; Re-tag is the only way out today.
- Why: The owner sees why each item has no tags, configuration details stay on the server (D-053), and the same item is not paid for twice by accident.

### D-067 Tracking the owner's edits
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `computeUserEditedFields` compares a patch with Claude's stored output: text exactly (case included), `""` and null alike for `fit` and `brand`, `materials` and `seasons` as sets, `colors` in order. An edit to either colour list marks both. Marks are sticky (setting a field back to Claude's value keeps the mark), only tag fields are tracked, and on an item with no tagging output every tag field in a patch counts as edited. A re-tag keeps edited values (null included for `breathable`, `fit` and `brand`); colours are kept as a pair only while both lists still have the same length; a required field that is somehow empty takes Claude's value so the tagged CHECK holds.
- Why: Re-tag must never undo the owner's corrections, and the parallel colour lists must stay consistent.

### D-068 Applying batch results exactly once
- Date: 2026-11-02 · Status: accepted; when the row is inserted replaced by D-089, how poll failures are returned by D-092 · Deviates from spec: no
- Decision: Batches take 21 to 1,000 items that are pending, untagged, in no batch and have a processed photo; joining clears an old `tagging_error`. The `ai_batches` row is inserted after `batches.create`; if that insert fails, the Anthropic batch id is logged for recovery. A poll reads all results first, then applies the whole batch in one transaction that locks its row and ends with a guarded update to `processed`. Succeeded results are always logged at batch rates (`item_id` null if the item was deleted), errored ones as zero-cost error rows with `batch_<type>`, expired and canceled ones not at all (not billed). Items without a result get a `tagging_error`. An unpriced batch model fails the poll with CONFIG and leaves the batch unprocessed, so its estimate keeps counting. `canceling` is mirrored; `ended` is never stored. Results are stamped with the prompt version current at poll time. One failing batch does not stop the others, but the first failure is returned afterwards.
- Why: The daily cron and page visits can overlap, and cron delivery can repeat; spend must be logged once and never lost.

### D-069 The cron route
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `GET /api/cron/poll-batches`, `maxDuration` 300, daily at 04:00 UTC in `vercel.json`. It reads the Authorization header first and compares it with `Bearer <CRON_SECRET>` in constant time after hashing both with sha256. Missing or wrong: 401; `CRON_SECRET` unset: a generic 500. It is the only session-free service entry (`runBatchPoll`, listed with its reason in the boundary test); the review page uses the session-checked `pollTaggingBatches`.
- Why: Vercel Cron carries no session cookie. Hashing first also hides the secret's length, and reading the header first keeps the handler out of prerendering.

### D-070 Confirming items
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: Only tagged or confirmed items with a complete tag set (the database CHECK fields plus a name and a colour) can be confirmed; otherwise VALIDATION. Bulk confirm changes only items that are still tagged, at most 500 per call, and returns the count; the list asks for a reload when fewer were confirmed than sent. Edits are allowed on pending items and survive tagging.
- Why: The wardrobe and the relocation analysis rely on complete tags; a stale list must not confirm items that changed elsewhere.

### D-071 Direct Blob uploads with our own token request
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: The browser POSTs the `blob.generate-client-token` event to `/api/blob/upload` itself and then calls `put()` from `@vercel/blob/client` with the token, instead of `upload()`; the add flow and background removal share this in `src/lib/images/blob-upload-client.ts`. The route answers success in handleUpload's own shape and failures in the app's Result shape. Tokens last 10 minutes, add a random suffix, never overwrite and carry a one-year cache; the pathname must equal the contract's exactly; originals are JPEG, PNG or WebP up to 10 MiB, cut-outs PNG up to 15 MiB. A known source hash is a 409 DUPLICATE with the existing item id, and a cut-out for a missing item a 404.
- Why: `upload()` reports every refusal as "Failed to retrieve the client token", which hid DUPLICATE, CONFIG and an ended session from the page.

### D-072 Registering an upload
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: Register validates the blob with `head()` before fetching or deleting anything: https only, no query or fragment, the URL `head()` returns must equal the input, and the pathname must match. It fetches only that URL, with redirects refused, a 20 s timeout and the 10 MiB cap, and the byte count must equal the `head()` size. sharp accepts JPEG, PNG and WebP up to 50 MP, checked from the header before decoding. An undecodable original is deleted; a read or database failure keeps it so the register can be retried (a database failure deletes the derived images). A lost unique-constraint race is settled by item id first: the same id returns that item, a different one is a duplicate. A missing `app_settings` row is CONFIG, with no fallback location. Blob token and store errors are CONFIG; other Blob failures UPSTREAM. `originalFilename` is accepted but not stored.
- Why: A crafted request must not be able to make the server fetch arbitrary URLs or delete another blob, a short read must never delete a good original, and retries must be idempotent.

### D-073 Browser pipeline details
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: HEIC sniffing excludes AVIF (which also lists `mif1`, but browsers decode it themselves). HEIC is converted to JPEG at q0.92 before the final q0.85 encode. The canvas is filled with white before JPEG encoding. The original filename is cut to 255 characters. Without `crypto.subtle` (plain HTTP on a LAN address) the page says to open the app over HTTPS.
- Why: Transparent PNGs would otherwise turn black, and hashing needs a secure context.

### D-074 Add flow behaviour
- Date: 2026-11-02 · Status: accepted; the page refresh after tagging replaced by D-096 · Deviates from spec: no
- Decision: Per photo: prepare, in-list duplicate check, batched source-hash check (lookups within 50 ms grouped, up to 500 per request), upload, register; three photos at a time and four tagging calls at a time from the start of a run. The item id is generated in the browser once per photo, so Retry resumes idempotently from the failed step. Toasts have one id per step and error code. The CONFIG hints describe the setting ("the Blob store's read-write token", "the Anthropic API key") rather than naming the variable. The page receives the per-item cost rates from the server and rounds estimates to cents ("< $0.01"); the usage page shows sub-cent amounts. A tagging run or a started batch refreshes the page so the remaining budget is current.
- Why: Starting with four parallel calls can write the prompt cache up to four times instead of once, which costs well under a cent per run and keeps the first results fast. Keeping server variable names out of client code means the build check for leaked secrets finds none of the app's own strings. `src/lib/ai/cost.ts` imports the pricing table, which client code must not load.

### D-075 Review screen behaviour
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: The page loads the newest 200 waiting items, renders cards ten at a time and says when more are waiting. A patch is the difference from the item's current values, not react-hook-form's dirty flags. Enter in a text field saves rather than confirms; Confirm reads "Save and confirm" when there are edits. Fields below 0.6 confidence show "Check this: Claude was N% sure" with an amber ring until edited (the materials score also covers the material guess, the colours score the hex values). "Confirm all untouched" skips edited, unsaved and untagged items. Confirming moves focus to the next card's heading. Photos are plain `<img>` inside `<picture>`; the warmth slider is built from Base UI parts so the thumb can be named and speak the rubric. Selects are 44 px tall and the switches have a 46 px hit area, with their labels toggling them.
- Why: Saving can be undone and confirming moves the item on. The visual check found the select triggers at 32 px, because the shadcn trigger sets its height under `data-[size=default]`.

### D-076 Usage page figures
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: Months are UTC calendar months, as in the budget check, and times are shown in UTC. The cache hit ratio is cache reads ÷ (uncached input + cache reads + cache writes). Recent calls list failed attempts too. Blob advanced operations are estimated from stored image rows: an original 1, processed and thumbnail 1 each, a background removal 2.
- Why: One window for spend and budget avoids two different "this month" figures. Vercel does not expose the Blob counter to the app, so the page says it is an estimate.

### D-077 Background removal setup (follows D-034)
- Date: 2026-11-02 · Status: accepted; where the files come from replaced by D-081 · Deviates from spec: no
- Decision: Model `isnet_quint8`, `device: 'cpu'`, PNG output, single-threaded, no COOP/COEP and no GPU path; files from IMG.LY's default CDN path for 1.7.0 (now: runtime from the app, model from the CDN, D-081). The confirmation names the first download (about 53 MB, now 57 MB); accepting is remembered in `localStorage` (`wardrobe.bgRemoval.downloadAccepted`), declining is not. Runs are queued one at a time and one fixed progress callback forwards to the active run. The uploaded PNG is temporary and always deleted once validated; the server requires an alpha channel, stores a 1024 px WebP, keeps one cut-out per item (row locked, previous blob deleted) and leaves `items.updated_at` unchanged.
- Why: The compatibility spike measured the small model at about 7 s warm with the same alpha as the default model at 11 s and 84 MB. The library memoises its session together with the first caller's progress callback. Not touching `updated_at` keeps an open review form from hitting a conflict.

### D-078 Session-gated page content renders at request time only
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `verifySession()` calls `connection()` before reading the cookie, so with Partial Prefetching the cookie-dependent part of a page is not rendered during a link prefetch; the static shell still prefetches.
- Why: The first e2e run logged "encountered the unstable value `new Date()` while prerendering" for `/add`, `/add/review` and `/settings/usage`: the prefetch rendered the Suspense children, and the token check compares its expiry with the current time. The reads behind the check (budget, items, the batch poll on the review page) must not run on a prefetch either.

### D-079 Boundary test covers the Phase 3 modules
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: Every module under `src/lib/ai` must start with `import "server-only"` except the pure `models`, `cost`, `json-schema`, `retry`, `tagging/prompt` and `tagging/schema`, each listed with a reason; so must `src/lib/images/blob.ts` and `server-pipeline.ts`. Client code may not reach `@/lib/ai/log`, `@/lib/ai/budget`, `@/lib/images/blob` or `@/lib/images/server-pipeline`. Server code (`src/server`, `src/lib/ai`, `src/lib/auth`, `src/app/api` and the two server image modules) may not import the browser-only `client-pipeline`, `bg-removal`, `heic-to`, `@imgly/background-removal` or `onnxruntime-web`.
- Why: Next only enforces the split at build time and only for modules that import `server-only`; a new AI module now fails the test until it is classified.

### D-080 Function durations
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: The tag, register and nobg routes set `maxDuration` 60 (tagging stops calling Claude at 50 s); the cron route sets 300. Pages set none, so their Server Actions (including `startTaggingBatch`, which runs the dry run) get the platform default of 300 s under Fluid compute.
- Why: Explicit limits where the code's own deadline depends on them; a page-level 60 could cut a batch start short.

## Added in the Phase 3 review fixes

### D-081 The background-removal runtime is served by the app (refines D-034 and D-077)
- Date: 2026-11-02 · Status: accepted; cache headers narrowed by D-101 · Deviates from spec: no
- Decision: `onnxruntime-web` 1.21.0's `ort-wasm-simd-threaded.wasm` and `.mjs` are copied into `public/vendor/bg-removal/imgly-1.7.0-ort-1.21.0/` by `pnpm vendor:bg-removal`, which `pnpm build` and `pnpm dev` run first. The copy checks the installed versions and each file's pinned sha256 and size and fails the build on any difference; the folder is git-ignored. A `resources.json` written next to them lists only the CPU path's three entries: the two runtime files by relative name and the `isnet_quint8` model chunks by absolute URL on IMG.LY's CDN (`@imgly/background-removal-data` 1.7.0, each chunk named by its sha256). `publicPath` is set per run from `location.origin`, never left at the library's default. The files are excluded from the proxy and served with `Cache-Control: public, max-age=31536000, immutable`. The confirmation now names 57 MB, the uncompressed total.
- Why: The library wraps the runtime's `.mjs` glue in a `blob:` URL that onnxruntime imports, so that file runs as script in the app's origin. Loaded from the CDN, a change to that path could have used the owner's session to read every item, tag with `force` until the budget is spent, or replace cut-outs; the only check was a byte size taken from the same CDN. The runtime now comes from a lockfile-pinned package with hashes checked at build, and it matches the onnxruntime JavaScript bundled with the app, which the CDN copy did not byte for byte. The model is data, about 44 MB, and stays on the CDN so it is neither committed nor deployed: a changed model can spoil the mask but cannot run script, and the library still checks every chunk's size against the app's own `resources.json`. A visible-browser run on 2026-11-02 fetched the runtime from the app and the model from the CDN and produced a 1024 × 1280 PNG with real alpha in 8 s.

### D-082 Leaving the add page while work is running
- Date: 2026-11-02 · Status: accepted; what leaving does corrected by D-098 · Deviates from spec: no
- Decision: While any upload is in progress or any tagging call is queued or running, `/add` asks before it is left: `beforeunload` for a reload, a tab close or an address-bar navigation, and a capture-phase click listener on `window` that holds back any same-origin link (the Review link, the sidebar, the tab bar) and opens a dialog ("Leave this page?" with what would be lost; "Stay here" or "Leave anyway"). The browser's Back button is not covered.
- Why: Leaving unmounts the flow, which aborts uploads and drops queued calls; the photos had to be picked again and an upload aborted after `put()` left an orphaned original. Next's client navigation fires no `beforeunload`, so links need their own guard. Back is a `popstate` the app router handles itself and cannot be cancelled cleanly.

### D-083 Tagging from the review page
- Date: 2026-11-02 · Status: accepted; refined by D-094 and D-096 · Deviates from spec: no
- Decision: The review list has a "Tag N waiting items ≈ $X" control for every loaded item that is pending and in no batch (failed ones included), with the model, the remaining budget, four calls at a time and the same stop on BUDGET_EXCEEDED as the add page; above 20 items it offers the batch. After a batch starts, the batched cards show "In batch" and the dry-run item's card is read back with a plain tag request, which the server answers from the stored tags without a call. The page reads the model, rates and budget through `getTaggingSetup`, shared with `/add`; a CONFIG error there disables only these controls, with the reason. A card waiting in a batch offers "Tag now instead", which sends `force` after a confirmation that the batch result is still billed; the server's CONFLICT message names that button. Cards and the bulk run share one set of busy item ids, so neither sends a second call for the same item.
- Why: Only the add page could tag in bulk, and only for its own session's queue; items left from a reload, a lifted budget block or an expired batch could only be tagged one card at a time, without the spec's cost quote. Batch items had no way out while polling failed.

### D-084 Batch pricing, and retrying batch creation (refines D-024 and D-063)
- Date: 2026-11-02 · Status: accepted; deadlines and timeouts added by D-090 · Deviates from spec: no
- Decision: The dry run is priced everywhere as one item at standard rates writing the 1-hour cache (2x instead of 1.25x): in the batch button's quote (`dryRunUsd` plus n − 1 items at batch rates), in `startTaggingBatch`'s budget check and in `tagItem`'s own check when `batchShape` is set. `batches.create` is retried up to three attempts only after a 429, a 529 or `x-should-retry: true` (never after `x-should-retry: false`, a connection error or a timeout), waiting for `retry-after` or the jittered backoff, and only while the wait stays within 60 s. A failure after the dry run carries `taggedItemId`, and both pages then show that item as tagged and leave it out of the next attempt. A started batch shows its dry-run item as tagged and the toast says "1 item was tagged right away; N in the batch".
- Why: The button showed less than the server reserved, so a run near the budget could pass the page's check and then be refused. A rejected 429 or 529 creates no batch, so retrying cannot bill twice; a lost answer might have created one. Without the detail, the next attempt sent an item that was already tagged and failed with CONFLICT.

### D-085 Batch polls have request timeouts
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `BatchPollDeps.requestTimeoutMs` bounds each Batches API request: the SDK `timeout` for `retrieve` and `results`, and an abort signal for reading the results body, which the SDK timeout does not cover. The review page's poll uses 10 s, the cron 60 s. A timeout is AI_TIMEOUT and leaves the batch unprocessed; on the review page it becomes the existing "Batch results not checked" notice.
- Why: The review page polls while it renders; with the SDK's 10-minute default a slow API held the page until the 300 s function limit.

### D-086 An error boundary for the app's pages
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `src/app/(app)/error.tsx` renders inside the (app) layout, so the sidebar and tab bar stay. It shows the safe message from `toErrorPayload`, the error's digest for the server log, "Try again" (`retry()`, which refetches the segment) and links to Settings and AI usage.
- Why: A database outage, an invalid setting or a failed item read replaced the whole app with Next's generic error screen, with no navigation and no retry.

### D-087 Hex colours are lowercased, not refused
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: The strict `color_hex` entries are trimmed and lowercased before the `#rrggbb` check, in Claude's output and in the owner's patches alike. Short forms such as `#fff` are still refused.
- Why: The wire schema cannot carry a pattern, so an uppercase reply failed as invalid output and cost up to three paid attempts for a usable value.

### D-088 Upload progress stops when the upload settles; toasts clear the tagging bar
- Date: 2026-11-02 · Status: accepted; toast placement replaced by D-100 · Deviates from spec: no
- Decision: `progressUntilSettled` drops progress events that arrive after `put()` resolved or rejected, for originals and cut-outs. While the add page's tagging bar is shown it sets `--toast-lift` on the document to its measured height plus 16 px, and the toast viewport adds that to its bottom offset at every width.
- Why: `put()` throttles progress with a trailing call, which could arrive after the upload finished and put a saving or ready photo back to "Uploading 100%"; the new headed e2e test with a fast fake register found it, with the photo stuck there. The toasts and the sticky bar shared the bottom edge, so an error toast covered "Start tagging" and the batch button.

## Added in the Phase 3 second review

### D-089 Batch starts claim their items first (replaces part of D-068)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: Before any paid call, one transaction locks the requested item rows (`ORDER BY id FOR UPDATE`, the dry-run item included), checks them again with the same rules and messages as before, inserts the `ai_batches` row with `anthropic_batch_id` = `claim:<uuid>` and the batch-only estimate, and links the batched items; if any item changed in the meantime, the start fails with CONFLICT and rolls back. The dry-run item is not linked. If the dry run or `batches.create` fails, the claim row is deleted (guarded by the `claim:` prefix; a failed delete is logged) and the foreign key unlinks the items. On success one transaction writes the real batch id and clears the linked items' `tagging_error`. Polls skip claim rows and delete those older than 15 minutes, with a log line. There is no schema change: the placeholder id avoids a migration. This replaces D-068's "the `ai_batches` row is inserted after `batches.create`".
- Why: Two overlapping starts both paid for a dry run and a whole batch. Now the second one fails before anything is spent, and while a start runs, its reservation already counts in the budget.

### D-090 A batch start fits inside the action's 300 s (refines D-084)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `startTaggingBatch` has a 270 s deadline. Each `batches.create` attempt gets a request timeout of min(60 s, time left); no attempt starts with less than 5 s left (AI_TIMEOUT, "There was not enough time left to create the batch. Try again."), and a retry wait must end both within D-084's 60 s window and 5 s before the deadline. Timeouts are not retried: they release the claim and return AI_TIMEOUT with `taggedItemId`. A timeout, a connection error or a 5xx logs that a batch may exist at Anthropic without a known id; a 4xx and the app's own pre-attempt timeout, which sent nothing, do not.
- Why: With the SDK's 10-minute default, a stalled create was killed by the platform before any error handling ran, so the page lost which item the dry run had tagged.

### D-091 Choosing and reporting the dry-run item
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: The dry run uses the first item, in the page's order, with no stored `tagging_error`, or the first item when every one failed before. A failed dry run names its item (`DRY_RUN_ITEM_DETAIL`, read with `dryRunItemIdFrom()`); /add then marks only that row as failed, with Retry, and leaves it out of the next batch attempt, while the other items go back to idle; /add/review marks only that card as failed, with Retry, and keeps it among the waiting items, so a later batch includes it (the server never picks it as the dry run while another item has no stored error). A BUDGET_EXCEEDED stop marks no card, because a budget stop stores no error (D-066).
- Why: An item whose dry run had failed was chosen first again on every attempt, so one photo Claude refuses blocked the whole batch, and the add page showed every row as failed.

### D-092 Batch polls return partial results (replaces part of D-068)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `runBatchPoll` returns the counts for the batches it processed plus `errors`, one safe payload per failed batch (each logged), and throws only when reading the open batches or creating the client fails. The cron answers 200 when there are no errors; otherwise it answers with the first error's status and `{ ok: false, error, data }`, so the cron log shows a failure and the counts are kept. The review page shows "Applied N finished batch results" and the "Batch results not checked" notice together; the notice lists distinct messages, so its "N batches could not be checked" counts messages, not batches. This replaces D-068's "the first failure is returned afterwards".
- Why: One failing batch hid the results that had been applied from the others.

### D-093 Pending items can be tagged by hand (resolves D-066's open question)
- Date: 2026-11-02 · Status: accepted; decided under the owner's "pause only if blocked" run scope, so the owner can veto it · Deviates from spec: no
- Decision: Every pending item on `/add/review` that is in no batch offers "Fill in by hand". It opens the review form in a manual mode: no hints and no Re-tag; Save, Save and confirm, and Cancel; focus starts on the name. Values the card already has are prefilled; category, formality and condition start unset ("Choose…"), warmth at 3, the switches off and breathable unknown. The form requires a name, category, at least one colour, warmth, formality, condition and at least one season before anything is sent. `tagItemByHand` checks the same on the server (VALIDATION with `details.missing`), stores the item as tagged (Save) or confirmed (Save and confirm), leaves `ai_raw`, `ai_model` and `ai_confidence` null, clears `tagging_error`, and adds every tag field with a value (`false` counts) to `user_edited_fields`, keeping earlier marks. An item in a batch, or one that already has tags or Claude's output, gets CONFLICT and does not show the button. While the form is open the item counts as busy, so bulk tagging and batches skip it. Tagging counts a hand-tagged item as tagged, so it is sent to Claude only with Re-tag, which keeps the owner's values (D-067).
- Why: An item Claude refuses had no way out, and the owner can now catalogue items without AI spend. The form's defaults (warmth 3, switches off) are saved as the owner's values too, so a later Re-tag keeps them.

### D-094 A stale "Tag now instead" does not pay twice (refines D-083)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: "Tag now instead" sends `{ force: true, batchId }` with the card's batch id; `TagBodySchema` accepts an optional uuid `batchId`. When the item is no longer linked to that batch and already has tags (Claude's or the owner's), the tag route returns those tags without a budget check or an API call. With a matching batch id, or for an item the batch failed to tag, it tags as before.
- Why: A card rendered before the batch result was applied would otherwise pay for a second tagging of an item that already had its tags.

### D-095 The review list re-syncs with newer server props
- Date: 2026-11-02 · Status: accepted; refined by D-103 · Deviates from spec: no
- Decision: With Cache Components, Next keeps up to three visited routes in a hidden `<Activity>`, so a return to `/add/review` hands the same `ReviewList` new props. The list merges them with `mergeServerItems`: the server's order, the local card kept for dirty or busy items, new ids added, and unlisted ids dropped unless busy (a busy card stays after the card it followed). Dirty marks for departed ids are dropped and the bulk problem line is cleared. A clean tag form resets to a newer card; a dirty one keeps its edits. `ReviewTagging` takes a newer `setup` prop and re-derives the budget block from it. Runs started from an older render change only the fields they own (`onItemPatch`), so newer state such as a finished cut-out survives. A rejected action call (a network failure) shows "Not saved" or "Not confirmed" with the network message and always clears the busy state; bulk confirm does the same.
- Why: After confirming everything and adding more photos, the revisited page still showed the old list, and a failed call left a form disabled for good. A key per render or `bfcacheId` would have thrown away unsaved edits.

### D-096 The budget is re-read through a route, not a page refresh (replaces D-074's refresh)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `GET /api/ai/tagging-setup` (session-checked; CONFIG answered as a 500 with the safe message) returns the model, rates and month's budget. `/add` re-reads it when a tag run settles and after every batch attempt; `/add/review` after a bulk run and after every batch attempt. A failed batch start counts too, because the dry run may already have been paid for. A failed read silently keeps the last numbers, and only the latest read applies. On `/add` a re-read updates the numbers but never sets or lifts the budget block; a new server `setup` prop (a new render) re-derives it. On `/add/review` the block after a run is that run's BUDGET_EXCEEDED answer if there was one, otherwise it is derived from the fresh numbers.
- Why: `router.refresh()` re-ran the page's server reads (on the review page also the batch poll and every list read), and a failure there replaced the page with `error.tsx`, which cancelled uploads on `/add` and lost unsaved edits on `/add/review`.

### D-097 A tagging CONFIG error on /add disables only tagging
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `getTaggingSetupResult` turns a CONFIG error from the model or budget settings into an Err with the safe message (logged on the server); `/add` and `/add/review` both use it. `/add` then shows a "Tagging is unavailable" alert and a reduced bar with only "Review N items"; Retry tagging is disabled and the flow enqueues no tag calls, while the pickers, uploads and registration keep working. Tagging comes back with the next server render (a reload or a return to `/add`), because the route re-read only runs after tagging.
- Why: An invalid budget or model setting replaced the whole add page with the error page although only tagging depends on it. This mirrors the review page (D-083).

### D-098 Hiding /add counts as leaving it (corrects D-082)
- Date: 2026-11-02 · Status: accepted; refined by D-104 · Deviates from spec: no
- Decision: D-082's "leaving unmounts the flow" is wrong under Cache Components: Next keeps `/add` in a hidden `<Activity>`, where effect cleanups run but state survives. The flow now treats a hide as leaving: a `useLayoutEffect` cleanup aborts uploads, revokes previews, clears both queues (`p-limit` with `rejectOnClear`, so queued work settles), the jobs and the hash owners, and empties the list with a new `reset` action. The budget block is kept. A return starts with an empty list, and leaving again does not ask.
- Why: The hidden page kept rows whose uploads had been aborted and queued calls that never settled, so a return showed rows that would never finish and the leave guard kept counting work that no longer existed.

### D-099 Add-queue details: duplicates, focus and the leave warning
- Date: 2026-11-02 · Status: accepted; refined by D-105 and D-106 · Deviates from spec: no
- Decision: Removing an entry re-checks the copies marked "Already in this list" because of it; they go back to waiting and run again. Focus is kept: after Remove it moves to the next row's Remove button, else the previous row's, else the "Photos" heading, else "Choose photos"; after Retry, only if focus was lost, to the same row's Remove button. Start tagging and the batch button stay focusable while disabled (`aria-disabled`), and if the batch offer disappears while it has focus, focus moves to the bar's summary line. While a batch is starting, the leave dialog says leaving does not stop the batch start and that the review page shows the items once it has started, instead of telling the owner to tag those items from the review page.
- Why: A duplicate stayed blocked after its original was removed, keyboard and screen-reader users lost their place after each action, and the old leave text pointed to a step that did not apply.

### D-100 Toasts follow the tagging bar's measured position (replaces D-088's toast placement)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: While the add page's tagging bar is in view, `useToastClearance` sets `--toast-bar-top` on the document to the distance from the viewport bottom to the bar's top edge plus a gap, and removes it when the bar is out of view. It recomputes on a ResizeObserver (the bar and its parent), window resize and passive scroll. The toast viewport's bottom offset is the larger of its usual offset and that value, so toasts sit above the bar whether it is stuck to the bottom or higher up on a short page.
- Why: D-088 lifted toasts by the bar's height, which only works while the bar is stuck to the bottom; on a short list a toast could still cover it.

### D-101 Only the hash-pinned runtime files are cached forever (refines D-081)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: Under `/vendor/bg-removal/<dir>/` only `ort-wasm-simd-threaded.wasm` and `ort-wasm-simd-threaded.mjs` get `public, max-age=31536000, immutable`, one literal rule each; `resources.json` gets `no-cache`; no rule covers the whole folder. `PINNED_VERSIONS` lives in `src/lib/images/bg-removal-assets.ts`, and both `BG_REMOVAL_ASSET_PATH` and `MODEL_CDN_BASE` are built from it, so a version upgrade, which the build step requires, always moves the immutable files to a new URL. Tests tie the path, the CDN base and the header rules (matched with Next's own route matcher) to the pins and to `ORT_FILES`.
- Why: `resources.json` is generated from `MODEL_CDN_BASE`, `MODEL_CHUNKS` and `ORT_FILES`, which can change while the folder name stays the same; an immutable manifest would stay stale in browsers for a year, and a reload would not fix it. Revalidating a 4 KB file costs almost nothing.

### D-102 The e2e server starts with every app variable blank (refines D-056)
- Date: 2026-11-02 · Status: accepted; refined by D-113 · Deviates from spec: no
- Decision: `test/app-env-vars.ts` lists every variable the app reads plus `E2E_TAG`. `vitest.config.mts` blanks all of them; `playwright.config.ts` sets all but `E2E_TAG` to `""` in `webServer.env` before its own four overrides. `@next/env` only fills keys that are undefined, and `src/env.ts` treats a blank value as unset. A spec that needs real credentials must pass them in explicitly; the smoke spec does so only from the shell (D-113).
- Why: A real `ANTHROPIC_API_KEY` or `BLOB_READ_WRITE_TOKEN` in `.env.local` would have reached the e2e server, and the specs, which assume neither exists, would then make paid Claude calls and upload to the production Blob store.

## Added in the Phase 3 third review

### D-103 The review list keeps on-screen work through merges and late results (refines D-095)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: (a) A merge of a newer server list grows the shown page so every card that was on screen stays mounted (new items arrive above it); unsaved form values and an open hand-tagging form survive a revisit. (b) When the page capped its list (`totalCount` larger than the items listed), a dirty card the server no longer lists is kept and placed after every server item, since newer uploads pushed it out of the newest-200 window rather than someone confirming it; uncapped, a dirty unlisted card is still treated as confirmed elsewhere and dropped. A dirty card that was in fact confirmed elsewhere then stays until its own Save or Confirm answers. (c) Removing confirmed items is a functional state update on the latest list, so tagging results, batch marks, revisit merges and other confirms that arrive while a confirm request runs are kept. (d) Focus moves after a request settles (Tag now, Confirm, Show more) only when focus was lost (`<body>`, null or a removed element), is still inside the card that changed, or is still on the element that asked for the move; it is never taken from a field the owner moved to meanwhile, the same rule as on `/add` (D-099). (e) The tagging section returns focus to the list summary when it disappears while holding focus (a run tagged every waiting item, a batch started). While a run or a batch start is going, the batch offer stays mounted and busy, and both tagging buttons keep the size they started with instead of the waiting count, whose items are busy (no more "Tag 0 items").
- Why: A revisit that added items above the page unmounted the last cards and lost their edits; a capped list dropped a dirty card that had only left the window; a confirm that finished late overwrote changes made meanwhile from the list it started with; focus was taken from a field the owner was typing in; and focus fell to `<body>` when the tagging section left.

### D-104 The /add leave dialog closes when the page is hidden (refines D-098)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `useLeaveGuard` clears `pendingHref` in a `useLayoutEffect` cleanup, which runs when Next (cacheComponents) hides the page in an `<Activity>`; this is the cleanup reset from Next's `preserving-ui-state.md` guide. `pendingHref` is deliberately not cleared when the guard turns inactive, so the dialog stays open while the owner reads it after uploads finish.
- Why: Browser Back or a swipe, which the guard does not intercept (D-082), left the page with the dialog open. On return it showed "Everything has finished, so nothing will be lost." and "Leave anyway" followed the old link.

### D-105 Buttons that stay focusable while disabled look disabled
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: The shared `Button` styles `aria-disabled="true"` like the native `disabled` state: `aria-disabled:opacity-50` and `aria-disabled:pointer-events-none`, next to the existing `disabled:` pair. Base UI's `focusableWhenDisabled` sets only `aria-disabled` on a native button, never `disabled`, so the old classes never matched.
- Why: Found in the third review's visible-browser check. Every button kept focusable while disabled (Start tagging, the batch buttons, Tag N items, Confirm all untouched, the form's Save and Confirm, login and logout while pending) looked fully enabled.

### D-106 Focus moves after list changes run in layout effects (refines D-099)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: The effects that move focus after Remove or Retry on `/add` and after Confirm or Show more on `/add/review` are `useLayoutEffect`, not `useEffect`. The click handler (or the state updater) sets a pending focus target; a passive effect still pending from an earlier background commit, such as an upload that just failed, runs when the click's update starts rendering, used that target up while the clicked button still had focus, and focus then fell to `<body>` once the button left. Layout effects never stay pending across events.
- Why: The unit test for focus after Retry failed about once in ten runs under parallel load; instrumented, focus went to `<body>` and never moved. With layout effects, 60 runs in parallel passed. The same pattern was on the review page.

## Added in Phase 4

### D-107 Pages kept by Next read themselves again after an item changes, and Back restores the wardrobe's scroll position
- Date: 2026-11-02 · Status: accepted; refined by D-123 (also while shown, the item page, batch results), D-129 (the review page), D-130 (bursts of changes), D-134 (the back link without the Navigation API) and D-138 (the export page) · Deviates from spec: no
- Decision: With Cache Components, Next keeps `/wardrobe` and `/stats` in a hidden `<Activity>` and serves browser back/forward from its client cache without a server request (`node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`; glossary, "Client Cache"), so Back after a change on an item page would show the item as it was. `src/lib/items/wardrobe-changes.ts` keeps a per-tab change count: every client call site that saves an item change calls `noteWardrobeChange` (the item page's patches for the toggles, tags, cut-out, archive and unarchive, and its delete; the tag form's requests on the review and item pages; `requestTagging`; bulk confirm; the add page's register and tag calls). `shownDataIsStale(data)` records the count when a server data object is first shown (a `WeakMap` keyed by the object the server sent, so data restored from the back/forward cache keeps its count) and says whether a change was noted since. `WardrobeResults` checks its list in an effect, which runs again whenever Next shows the page, and calls `router.refresh()` inside the filter transition (the list shows "Updating…"); `/stats` does the same through `RefreshAfterItemChanges` (`src/components/items/refresh-after-item-changes.tsx`, given the stats totals object), so Back from an item opened from the checklist shows the new figures. A fresh navigation (the tab, a link) already brings new data and is not read twice. The item page's "Back to wardrobe" goes back in history whenever the previous entry is the list, whether or not something was saved, so the filters and scroll position come back and the list refreshes itself; otherwise it is a plain link to `/wardrobe`. Telling that the previous entry is the list needs the Navigation API (D-134). After a delete the item page is replaced by `/wardrobe`. `VirtualizedGrid` records the window's scroll position while the grid is displayed and puts it back when the page is shown again, before the virtualizer re-subscribes: Next shows the page before the popstate event, when the window is still where the item page left it, and only the browser's own restoration, which differs between browsers, would have fixed it. A fresh navigation still starts at the top, because Next scrolls the page into view after its children's layout effects.
- Why: Refreshing on every return would re-read up to 2,000 rows each time the owner looks at an item; a `bfcacheId` key would throw away the list's state and scroll position, which the Next docs advise against; calling `refresh()` in the Server Actions would re-render the item page on every toggle and render the not-found page after a delete, and would not cover the tag and register route handlers. Checked in a visible browser on 2026-11-02 against the production build: with both refresh calls disabled, Back after a plan change showed the old badge on `/wardrobe` and the donated item still linked on `/stats`, and the browser sent no request for either page; with them, a plan change, a rename, and archive and unarchive all showed on the list after Back, and the donated item left the checklist.

### D-108 Wardrobe filters live in the URL (refines D-037)
- Date: 2026-11-02 · Status: accepted; refined by D-119, D-120 and D-125 · Deviates from spec: no
- Decision: `src/lib/items/filters.ts` (client- and server-safe) parses and serialises the filters by hand. `parseItemFilters` never throws: unknown keys are ignored, invalid values dropped one by one (warmth must match `^[1-5]$`, booleans are exactly `true` or `false`, enum values are case-sensitive, colours longer than 40 characters are dropped and the rest sorted, then cut to 10, `q` is cut to 100 UTF-16 code units without splitting a character), `warmthMin` above `warmthMax` is swapped, and no valid status means the default three (archived hidden). `serializeItemFilters` writes the canonical form in a fixed key order with defaults left out, so parse and serialise round-trip byte for byte, and `itemFiltersKey` is that string, used as the "did anything change" check. Values within one field are alternatives (OR), fields combine with AND, warmth bounds are inclusive and leave out items with no warmth, a category filter leaves out uncategorised items, and colour matching is case-insensitive on any of the item's colours. Changes go through `useWardrobeFilters`: `router.replace(href, { scroll: false })` in a transition, with `useOptimistic` showing the requested filters at once so two quick changes build on each other; when the request ends the server's parsed filters take over again. `replace`, not `push`, so Back leaves the page instead of undoing a filter. The Untagged chip stands for `status=pending_tagging` with no category (enforced since D-119). The filter panel (one Base UI Drawer: from the bottom below `md`, from the right above) applies each change at once; "Show N items" only closes it. Its Reset clears only the panel's fields; the empty state's Reset clears everything but the sort. The Filters badge counts fields, not values (search and category have their own controls), at most 10. Colour options are a free-text field plus, since D-120, a server facet of the colours the other filters leave (it was the colours of the current results, which hid every other colour once one was chosen). The design's zod `ItemFiltersSchema`, `serializeFilters` and `categoryCounts()` became these names, and the counts come back inside the list (`WardrobeListDto.counts`).
- Why: The URL is shareable and survives reloads, and with Cache Components the page reads `searchParams` on the server anyway (D-041). A zod schema would reject a whole URL for one bad value.

### D-109 The list is capped at 2,000 items and virtualised by rows (refines D-037)
- Date: 2026-11-02 · Status: accepted; refined by D-119 (counts) and D-124 (measuring and focus) · Deviates from spec: no
- Decision: `listWardrobeItems` returns at most `WARDROBE_LIST_LIMIT` (2,000) items with `total` (every match) and `capped`, which the page states, instead of pages. The list and the per-category counts are queries run together; the thumbnail comes in through a left join; the counts honour every filter except the category and the status, which the chips set (D-119), and `counts.total` equals the sum of the categories plus the uncategorised items. Search is `ILIKE` with `\`, `%` and `_` escaped and an explicit `ESCAPE '\'`, over name, description, brand, subcategory and notes, plus any element of colours and materials. Sorts: created (id as tie-break), warmth with nulls last, wear count then newest. The grid uses `useWindowVirtualizer` over rows: 2 to 6 columns (tiles at least 150 px, 16 px gap), rows measured once rendered, overscan 3, and the focused card's row is always rendered so Tab never drops focus to `<body>`. When Next shows the page again with the same rows it keeps the measured heights, since dropping them shifted the restored position by about 20 px (the estimates' error). The first version also called `measure()` whenever the columns or the results changed and said the rows on screen were measured again at once; this version of the library does not do that, and a refresh moved the list, so D-124 replaced it. Every listener lives in a layout effect, so nothing listens while Next hides the page.
- Why: The owner has a few hundred items; one read of all of them plus a virtualised grid is simpler and faster to browse than paging, and the cap bounds the worst case. Measured with the 300-item demo seed on 2026-11-02 (one frame per 60 px step from top to bottom): at 1440 px the slowest frame took 12 to 19 ms (95th percentile 10 to 11 ms) with 42 cards in the page; at 390 px 11 to 13 ms (95th percentile 8 ms) with 14 cards; no frame took over 50 ms.

### D-110 The item page owns the plan and location toggles
- Date: 2026-11-02 · Status: accepted; refined by D-123 and D-132 · Deviates from spec: no
- Decision: On `/wardrobe/[id]` the decision and location toggles save at once (`setItemDecision`, `setItemLocation`, each returning the item card), revert with a toast when a call fails or is rejected, and each success changes only its own field, so a late answer never undoes newer state. The tag form gets a `detail` mode: a confirmed item has Save and Re-tag, a tagged one also Confirm (focus moves to Save afterwards); neither shows nor sends decision and location, and the manual form takes `showPlans={false}` here, so a Save can never undo a toggle. A pending item is tagged in place (Tag now or Retry, and Fill in by hand); an item waiting in a batch links to `/add/review`, because that page applies batches and lists only the newest 200. An archived item shows a notice instead of the form. A newer server item replaces the local copy when the page is shown again (on Back or Forward the page only gets one by reading itself again after a change noted elsewhere, D-123); unsaved form edits are kept and the fields not edited take the newer values (D-132); the status line and the delete dialog reset when Next hides the page. Dates are shown in Europe/Berlin, so the server render and hydration agree on the day. The page title is a static "Item", because naming the item needs the session and a database read outside the Suspense child (D-041). "Last changed" comes from the last full read (page load, archive, unarchive), since the item card carries no `updatedAt`.
- Why: Two controls owning the same field would race; a quick toggle is what the owner uses most on this page.

### D-111 Archive, unarchive and delete
- Date: 2026-11-02 · Status: accepted; refined by D-127 and D-128 · Deviates from spec: no
- Decision: `src/server/services/item-lifecycle.ts`. Archive works from any status, and archiving twice writes nothing. Unarchive returns an item to the status it was archived from (D-128; it first returned every item with complete tags to `confirmed`, which confirmed tags nobody had checked), and to `pending_tagging` when its tags are incomplete; unarchiving an item that is not archived changes nothing. Delete: check that the item exists, delete all its photo URLs in one `del()` (with the token, D-031) with no lock held, then lock the row in a transaction, re-read the photos and delete the item; photos attached in between are deleted afterwards on a best-effort basis. The action calls `getBlobStorage()` first, so a missing token is a CONFIG error before anything is deleted; a Blob failure becomes UPSTREAM ("…so the item was kept…"), is logged, and leaves every row in place. Rows follow the schema's foreign keys: `item_images`, `outfit_items` and `wear_logs` go with the item (the outfits stay); `shopping_list_items.linked_item_id`, `packing_checklist_items.item_id` and `ai_calls.item_id` become null. Blobs without an `item_images` row are not looked for, because listing the store costs advanced operations. After a delete the page is replaced by `/wardrobe` (a fresh read).
- Why: Deleting the photos first means a failure never leaves rows pointing at missing blobs; holding no lock during the Blob call keeps the row lock short.

### D-112 Stats scope and the winter-readiness rules
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `/stats` counts every item except archived ones as "Items"; archived items appear only in their own count. Category, warmth and weather numbers and the checklist use tagged and confirmed items only; decisions and locations include pending items, since those are the owner's choices, not tags; pending items get a "Review untagged items" link. `computeWinterReadiness` (pure) checks, in this order, a waterproof shell (outerwear, waterproof), insulated waterproof footwear, windproof gloves, a warm beanie (warmth 3 or more), a scarf, and at least 2 merino, wool or thermal base layers (a case-insensitive match on materials, material guess, subcategory and name). Items marked Leave, Donate or Sell never count, since they will not be in Hamburg. An unmet rule can still list evidence ("1 of 2 so far"); up to six evidence links show per rule, then "and N more". Charts are real tables with the bar hidden from screen readers and the count as text, one neutral colour in both themes, no chart library; categories sort largest first, warmth, decisions and locations keep their order, and weather bars are a share of all tagged and confirmed items. The checklist comes right after the overview so it is not below five charts on a phone; there are no hover tooltips, since every value is printed. The Wardrobe tab stays marked on `/stats` (`alsoActiveOn` in `nav-items.ts`), which is reached from the wardrobe's Stats button; there is still no sixth tab.
- Why: The checklist answers "is the wardrobe ready for Hamburg", which only items that are going there can answer.

### D-113 The e2e smoke spec uses real credentials from the shell only (refines D-102)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `e2e/live-env.ts` reads the runner's shell only: `playwright.config.ts` passes `BLOB_READ_WRITE_TOKEN` to the e2e server when the shell has it, and `ANTHROPIC_API_KEY` only when `E2E_TAG=1` is set as well; otherwise both stay blank (D-102). Playwright never loads `.env.local`, and no value is printed. `e2e/smoke.spec.ts` skips with "needs BLOB_READ_WRITE_TOKEN in the shell" without the token, and with "E2E_TAG=1 needs ANTHROPIC_API_KEY in the shell" when tagging is asked for without a key. It tags by hand unless `E2E_TAG=1`. Its `afterAll` deletes every blob it created (`del()` with the shell's token): the browser's upload answers are recorded as well as the `item_images` rows, so a failed registration leaves nothing behind; then it deletes its rows. Tests that assume the server has no token (`add.spec.ts`, Delete in `item-detail.spec.ts`) or no key (the two tagging tests in `review.spec.ts`) skip themselves with that reason when one is passed, so the smoke spec runs on its own. `e2e/a11y.spec.ts` fails on serious or critical axe violations (WCAG 2.0 and 2.1, A and AA) on every page built so far: `/login` and `/offline` signed out, the signed-in pages, and the item page's not-found state (the last two since the second Phase 4 review), plus `/wardrobe` at 390 px.
- Why: The smoke test must reach a real store to mean anything, but a real token in `.env.local` must never reach the other specs, which would upload to it and pay for Claude calls.

### D-114 What the JSON and CSV exports contain
- Date: 2026-11-02 · Status: accepted; refined by D-135 · Deviates from spec: no
- Decision: The JSON (format version 1) holds every table except `login_attempts`, which only stores keyed hashes of client addresses derived from `SESSION_SECRET`; `analysisParts` is included too. Each table is an array of rows with camelCase keys, ISO timestamps and money as numbers; items carry their photo rows (URL, kind, size, dimensions). The CSV has one row per item, archived ones included, 35 snake_case columns ending in the processed, original and cut-out photo URLs (thumbnails are derived copies and left out); only text gets the formula guard, while numbers, booleans and dates are written as they are. Both stream 200 rows per database read, items oldest first by creation time with the id as tie-break, paged with a UTC cursor that keeps microseconds so no row is skipped or repeated; the export is not one consistent snapshot. A read that fails part-way ends the stream with an error and is logged, so a short file never looks complete. File names are dated in UTC (`wardrobe-YYYY-MM-DD`). The download links are plain links without `download`, so an error (an expired session) opens as a readable message.
- Why: Portable data the owner can read without the app; streaming keeps memory flat whatever the wardrobe's size.

### D-115 Photo ZIP parts (refines D-036)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `planZipParts(items, { kind, maxItems = 100 })` (pure; the design's signature plus `kind`) splits the items that have a photo of that kind into parts of at most 100, with file names `<category or untagged>/<slug>-<id8>-<kind>.<ext>` unique ignoring case across all parts of a kind; `manifest.json` is the first entry of each part and is built from the plan alone, so the archive's size can be predicted. `GET /api/export/images?kind&part` (`maxDuration` 300; JSON and CSV 60) checks the whole part before the first byte: only stored `blob_url`s over https on the default port, with no credentials and a `*.public.blob.vercel-storage.com` host, are fetched, redirects refused; a bad address fails the part with a 500 naming the item. Photos are fetched one at a time, each read in full with a 30 s timeout and checked against its stored size. A photo that fails ends the download with an error (logged; a client leaving is not), instead of an `errors.txt` in the archive, so a part that downloads completely is always complete; `Content-Length` is sent when every size is known, so a cut-off file shows. Parts are cut by count alone, not by D-036's predicted streaming time: up to 100 photos of a kind make one ZIP, more make numbered parts. Export routes refuse `Sec-Fetch-Site: cross-site`, so another site cannot start downloads that cost Blob transfer; the photos are public URLs, so the route needs no Blob token. `vercel.json` sets `supportsCancellation` for the images route, so a client disconnect aborts `request.signal` on Vercel and stops the fetches.
- Why: 100 originals of up to 10 MB still stream well within 300 s; a partial archive that looks complete would be worse than a failed download.

### D-116 Demo seed for local checks
- Date: 2026-11-02 · Status: accepted; refined by D-126 · Deviates from spec: no
- Decision: `pnpm db:seed:demo` inserts 300 confirmed items from a fixed random seed and refuses to run unless `DATABASE_URL` points at `localhost` or `127.0.0.1` (and, since D-126, names no other host in its query string). Rows are marked `notes = 'demo-seed'`, image rows use `blob_pathname 'demo-seed/<id>/<kind>'` and the relative URL `/icons/icon-192.png` (not the design's `/demo/thumb.webp`), and image hashes come from each item's index, so running it again adds nothing. `--clean` deletes exactly the marked rows. Delete and the photo ZIP do not work on demo items, because their photo URLs are not in a Blob store.
- Why: Virtualisation, filters and stats need a realistic size to check, without touching a Blob store.

### D-117 Accessibility fixes from the first axe scan and browser check
- Date: 2026-11-02 · Status: accepted; refined by D-133 · Deviates from spec: no
- Decision: (a) A wardrobe card's link holds the photo, name and category, which are its name ("Navy coat Outerwear", with a space in the text between them); the badges sit after the link and describe it (`aria-describedby`), and the link's `::after` covers the whole card so a tap on a badge still opens the item, with the card drawing the focus ring. (b) The category chips and the Filters button have one visually hidden name ("Shoes, 3 items", "Filters, 1 active") with the visible label and count hidden from screen readers; the chip row's scroll box is `relative`. (c) Destructive buttons and badges use a new `--destructive-strong` text colour (oklch 0.505 0.213 27.5 in light mode, unchanged in dark). (d) `buttonVariants` returns a merged class list (`cn`), so a Link styled as an outline button keeps its border. (c) and (d) edit generated shadcn files; D-050 lists them with the other edits to re-apply after `shadcn add --overwrite`.
- Why: (a) Badges inside a link whose name left them out failed WCAG 2.5.3 (axe `label-content-name-mismatch`). (b) Chrome put a space before a separate hidden ", 3 items" span ("Shoes , 3 items"), and the absolutely positioned hidden spans escaped the chip row's scroll box and widened the page by about 1,100 px at 390 px. (c) `text-destructive` on `bg-destructive/10` reached about 4.0:1, below AA's 4.5:1 (the Delete item button). (d) cva only concatenates: the base's `border-transparent` stayed next to the outline variant's `border-border`, and in light mode the stylesheet order hid the border of every outline Link (Stats, the Download links, the back links, Settings' AI usage and Export links), seen in the 2026-11-02 browser check; `Button` already merged its classes.

### D-118 The offline page's Try again is a form
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `/offline` uses `<form action="/wardrobe" method="get">` with a submit button instead of `<a href="/wardrobe">`. The URL becomes `/wardrobe?`, which the page treats like `/wardrobe`.
- Why: With the dynamic `/wardrobe/[id]` route, Next's `no-html-link-for-pages` lint rule flags `<a href="/wardrobe">`, and `<Link>` would navigate on the client, while this page needs a full page load through the network, with or without JavaScript.

## Added in the Phase 4 review

### D-119 Each chip's badge counts what the list shows with that chip alone on (refines D-108 and D-109)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `listWardrobeItems` counts with every filter except category and status (the two fields the chips set), grouped by category and status, and derives each badge from those rows. All and the categories use the statuses those chips switch to, `statusesAfterChip` in `src/lib/items/filters.ts`, which `applyChip` uses too: the default three when the Untagged view is on, the current ones otherwise. `CategoryCounts` gains `untagged` (items waiting for tags, whatever their category: what pressing Untagged lists, also from an archived view) and `archived` (D-121). The Untagged chip shows while `untagged` is above 0 or the view is on. `isUntaggedView` (moved to `filters.ts`) also requires that no category is chosen, which D-108 already said; `category=shoes&status=pending_tagging` now shows Shoes as pressed, and pressing Shoes removes the category it shows. The capped list's total comes from the same rows with the list's own statuses and categories. `chipCount` maps a chip to its badge for the component and for the regression test, which checks every chip against the list it stands for in seven views.
- Why: In the Untagged view every category chip read 0 and was drawn muted, and All showed only the waiting items, although pressing them showed the whole wardrobe; an archived view hid the Untagged chip while items waited. A category left chosen behind the Untagged chip was hidden while it emptied the grid.

### D-120 The colour options are a server facet that ignores only the colour filter (refines D-108)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `WardrobeListDto.colors` holds up to `COLOR_FACET_MAX` (24) colours, `{ name, hex, count }`, of the items every filter except colour matches (the category and status included), counted per item (`count(DISTINCT id)` over `lower(unnest(colors))`, with the hex at the same position, `min` when items disagree), most common first and ties alphabetical, sorted in TypeScript so the order does not depend on the database's collation. A third grouped query runs with the other two. The panel shows that facet plus any chosen colour it lacks (`colorOptionsWithChosen`), and its hint reads "Colours of the items the other filters show."
- Why: Built from the listed tiles, the options dropped every other colour once one was chosen, against the panel's own "several chosen means any of them", and missed colours seen only past the 2,000-item cap.

### D-121 An all-archived wardrobe says so, and Reset filters keeps focus on the page
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: When no filter is set and nothing shows but archived items exist (`counts.archived`), `/wardrobe` shows "All N items are archived" (one item: "Your only item is archived") with "Show archived items" (`/wardrobe?status=archived`) and Add items, instead of "No items yet". After "Reset filters" in the no-matches state, once the new list replaces the empty state (and with it the focused button), focus moves to the result count (`tabIndex={-1}`, a focus ring), only when focus was lost, once per reset (compared by list object, so an Activity return or a refresh never moves it). `focusWasLost` now lives in `src/lib/focus.ts`, shared by the review page, the item page and the grid.
- Why: "No items yet" with an Add button made archived items look lost; focus fell to `<body>` and keyboard and screen-reader users started again at the top of the page.

### D-122 One status vocabulary
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: Wardrobe cards word their status badge with `STATUS_LABELS`, like the Status filter, the item page, `/add/review` and `/stats`: "Waiting for tags", "Tagged", "Archived", and no badge for confirmed items. The Untagged chip keeps its name: it stands for "no tags" and lists the items whose badge reads "Waiting for tags".
- Why: Cards said "Untagged" and "To review" while the filter on the same page said "Waiting for tags" and "Tagged", so Status = Tagged listed cards marked "To review".

### D-123 Pages also re-read when a change is noted while they are shown; the item page and finished batches join D-107 (refines D-107 and D-110)
- Date: 2026-11-02 · Status: accepted; refined by D-129, D-130, D-132 and D-136 · Deviates from spec: no
- Decision: `noteWardrobeChange` also calls listeners (`subscribeWardrobeChanges`). `useRefreshAfterItemChanges(data, refresh)` checks on mount, on new data and on every show, and while the page is shown it subscribes, so a save that answers after the owner went Back refreshes `/wardrobe` and `/stats`; a hidden page does not listen (Activity cleans the effect up). Which saves answer after Back: those that do not hold Back. Fetch saves (`requestTagging` for Tag now and Re-tag, the add page's register and tag calls) bypass the router. Server Actions called from a plain async handler (Archive, Unarchive and Delete in `danger-zone.tsx`) do not hold it either: Next marks the pending action discarded, runs the Back at once and later resolves the action without refreshing, because the item actions do not revalidate (measured on 2026-11-02 with Archive's answer held 2.5 s: the list showed 37 ms after the press, and the archived card left it at 2.6 s, through this listener). Saves made inside `startTransition(async …)` (the plan and location toggles) do hold Back until they answer: Next runs Back in a transition, and React makes it wait for the pending async transition (traced in the second review; the browser check saw the hold), so the D-107 check on show already catches them. The item page now renders `RefreshAfterItemChanges` with its server item and `refreshWhileShown={false}`: it re-reads when shown after a change noted elsewhere in the tab (the review page confirmed or tagged it), but not for its own saves, which it already shows; after its own save, coming back to it by Back or Forward re-reads it once. `/add/review` renders `NoteServerItemChanges` with its poll result when that server render applied finished batch results, noted once per render (`WeakSet`), so the pages Next keeps hidden re-read when shown.
- Why: A fetch save that answered after Back left the list stale until the next navigation: in a production build without the listener, a "Tag now" answer held 2.5 s left the card on "Waiting for tags", and the fixed build showed "Tagged" (2026-11-02). The same build showed a late plan change (Sell) on the list anyway, because the toggle's transition held Back until it answered; the first version of this entry named Donate and Archive as the stale cases, which the browser check contradicted for the toggles. Back to an item page after it was confirmed elsewhere showed the old status and tagging controls, and "Fill in by hand" then failed with CONFLICT; batch results applied by the review page's server render reached none of the kept pages. `refresh()` in the Server Actions stays rejected for D-107's reasons. Accepted: while a toggle's save is pending, Back waits for its answer, so on a slow network it can feel stuck for that long.

### D-124 Grid rows are keyed by their tiles, and focus survives a column change (refines D-109)
- Date: 2026-11-02 · Status: accepted; refined by D-131 · Deviates from spec: no
- Decision: `useWindowVirtualizer` gets a memoised `getItemKey` that joins the ids of a row's tiles, so a measured height stays with the same tiles: a refreshed list with the same rows keeps every height, and a row whose tiles changed is a new node, measured by its ref callback once it is rendered (rows above the rendered ones fall back to the estimate, which D-131 keeps from moving the screen). `measure()` runs only when the tile width changes (rows with the same tiles really resize then, and the virtualizer's ResizeObserver measures those on screen), never for new results or on an Activity return; the loop that called `measureElement` on the rows on screen is gone, since it compared against stale measurements and changed nothing. The focused card is tracked by item id (`data-item-id` on each list item), its row derived with the current columns and always rendered; when new columns or new rows remount it and focus was lost, focus goes back to its link (`preventScroll`). A blur from a card a re-render removes does not forget it; leaving the grid or Next hiding the page does.
- Why: After a D-107 refresh every row above the screen fell back to the estimate, and the restored Back position jumped by up to 22 px per row (660 px at row 30 in the repro); rows on screen stayed at the estimated pitch and overlapped. A zoom, resize or rotation with a card focused dropped focus to `<body>`.

### D-125 A NUL in the URL's search or colours is dropped (refines D-108)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `normalizeSearchText` and `normalizeColors` strip U+0000 before trimming, capping and the blank check, so parse and serialise stay canonical and `?q=%00` parses as no search. Other control characters are kept: Postgres accepts them.
- Why: Postgres text cannot hold U+0000 and rejects the whole query, so `/wardrobe?q=%00` rendered the error page on every load; the parser's contract is that bad input is dropped, never fatal.

### D-126 The demo seed refuses a host in the query string (refines D-116)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `nonLocalReason` refuses a `DATABASE_URL` whose query string has `host` or `hostaddr`, before checking that the URL's host is `localhost` or `127.0.0.1`. The message names no password.
- Why: node-postgres copies query parameters into its config, and a `host` there replaces the URL's host, so `postgres://…@localhost/db?host=<neon host>` passed the check and seeded (or `--clean`ed) the remote database. `pg-connection-string` is only a transitive dependency, so the check reads the URL itself.

### D-127 A call whose item was deleted meanwhile is still logged (refines D-020 and D-111)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: When the `ai_calls` insert fails with SQLSTATE 23503 on `ai_calls_item_id_items_id_fkey`, `logAiCall` writes the same row once more with `item_id` null; any other failure still propagates. A Tag now or Re-tag whose item is deleted during the Claude call therefore records its cost and answers NOT_FOUND from `applyTags`. Batch results already lock the item and write null when it is gone (D-068), so they never reach this path. No lock is held across the Claude call.
- Why: The insert's foreign-key failure turned into INTERNAL "The AI call could not be recorded" and the spend went missing from the month-to-date budget.

## Added in the Phase 4 second review

### D-128 Unarchive restores the status the item was archived from (refines D-111)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: yes (additions only)
- Decision: `items.archived_from` (an addition beyond D-011 and D-058; nullable `item_status`, migration `drizzle/20261102210917_archived-from`) records the status an item had when it was archived: `archiveItem` sets it in the same conditional update (`archived_from = status`; SET reads the row as it was, so there is no race), and `unarchiveItem` clears it. `statusAfterUnarchive`: incomplete tags give `pending_tagging`; otherwise `tagged` when the item was archived from `tagged`, or from `pending_tagging` and a batch result or Re-tag tagged it while archived (tagging keeps an archived item archived); `confirmed` only when it was archived from `confirmed`. A row archived before the column existed (null) keeps the earlier rule, complete tags giving `confirmed`. The unarchive toast says where the item went: "confirmed again", "back on the review page, with its tags still to check", or "waiting for tags again". The JSON export carries the column (the item row is spread); the CSV's fixed columns do not.
- Why: Archive then Unarchive of a tagged item confirmed Claude's tags without anyone checking them: the item left the review queue for good (no path un-confirms an item), its card lost the "Tagged" badge, the toast said "confirmed again", and Phase 5's "confirmed items only" switch would have trusted those tags. The old rule's reason, an item the owner already handled, held only for confirmed items. The alternative without a migration, always returning complete tags as `tagged`, would have sent every confirmed item back to the review queue.

### D-129 The review page reads itself again when shown after a change elsewhere (refines D-123)
- Date: 2026-11-02 · Status: accepted; refined by D-136 and D-138 · Deviates from spec: no
- Decision: `/add/review` renders `RefreshAfterItemChanges` with its server cards and `refreshWhileShown={false}`, after `NoteServerItemChanges`, which credits its own batch results to those cards (D-136; sibling effects run in order, so the credit is recorded before the hook records when the cards were read; the order alone did not do it, as this entry first said), and outside the empty-state conditional, so "All caught up" re-reads too. Changes noted while it is shown (its own Save, Confirm, Tag now and Tag-all answers) do not refresh it, except one noted while a refresh of the page is running, which brings one more refresh after the interval (D-130, D-136). Cards with unsaved edits or a running request survive the new list (D-095, D-103). `test/item-freshness.test.ts` checks the wiring in every page that shows item data (`/settings/export` since D-138), since no unit test renders those async pages.
- Why: Back to the review page after archiving, confirming or deleting an item on its item page listed it as still waiting with its old tags; Confirm then failed ("Archived items cannot be confirmed." or not found) and "Confirm all untouched" asked for a reload. Back from `/add` after registering photos had the same gap since Phase 3.

### D-130 Refreshes asked for while a page is shown wait 5 s after the last one, and refreshed data counts as read when it was asked for (refines D-123)
- Date: 2026-11-02 · Status: accepted; refined by D-136 · Deviates from spec: no
- Decision: In `useRefreshAfterItemChanges`, showing the page again (the same data object) still checks at once. A change noted while the page is shown refreshes at once when the page has not asked for a refresh in the last `REFRESH_INTERVAL_MS` (5 s); otherwise one check is scheduled for the end of that interval, and every change until then shares it. Data a refresh brings is recorded as read at the change count when the refresh was asked for (`noteDataReadAt` with `wardrobeChangeCount`), not when it arrived, so a change noted while the request ran still makes it stale; new data that is stale waits for the interval like a noted change. Hiding the page drops a scheduled check (the next show checks at once). A refresh that brings nothing (a navigation won) only delays the next one; no change is ignored for good.
- Why: A "Tag N waiting items" run keeps answering after the owner leaves `/add/review`, about one answer a second, and every answer refreshed a shown `/wardrobe`: 40 answers meant 40 full reads of up to 2,000 items with the counts and the colour facet, on a pool of 3 connections the tagging calls also need, with the grid dimmed. With the interval the same run costs about one read per 5 s, and a single late save still refreshes at once. Counting refreshed data from when it arrived would have hidden changes saved while the request ran.

### D-131 The grid keeps the card at the top of the screen in place when the same results come back changed above it (refines D-124)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `VirtualizedGrid` takes a `resultsKey` (`WardrobeResults` passes `itemFiltersKey` of the server's filters). After each commit and on each scroll it remembers the first card whose row starts on screen and that row's distance from the top of the window, taken only from committed rows (a render hands the virtualizer new row keys before it commits). When new items arrive with the same results key and columns, the window is below the top of the list (`scrollY` past the grid's `scrollMargin`), and the card is still listed, the window is scrolled so its row is at the same distance again; rows above it that are measured later are compensated by the virtualizer itself. A new key (another search, filter or sort) moves nothing.
- Why: After a refresh that added an item above the screen (newest first, Back from `/add`) or removed one, every following row got new tiles and a new key, the rows above the rendered ones fell back to the estimate, and the card the owner was looking at jumped by the sum of the estimates' errors: 378 px in the review's repro at 390 px, 138 px with fewer wrapped rows. At the top of the list a new item should simply appear.

### D-132 A newer item becomes the tag form's baseline even with unsaved edits (refines D-110 and D-123)
- Date: 2026-11-02 · Status: accepted; refined by D-137 · Deviates from spec: no
- Decision: `useTagForm` adopts every new item prop once no request runs (an item that arrives during one is adopted when it ends; since D-137 it also waits for a running field check). A clean form is reset to it as before; a form with unsaved edits is reset with `keepDirtyValues`, `keepDirty` and `keepErrors` (and its submit state, D-137), so the fields the owner edited keep their drafts and errors and every other field shows the newer value. Save and Confirm, which send the fields that differ from the item, then send only the edited ones.
- Why: After the item page re-read itself (D-107) with a draft in its form, the form kept every old value while its baseline became the newer item, so a Save sent the old values of fields changed elsewhere: it silently undid a rename made on the review page, or Claude's newer tags after a Re-tag, and recorded those old values as the owner's edits. `keepDirtyValues` alone leaves react-hook-form reporting the form clean, which disables Save and drops the "unsaved changes" warnings.

### D-133 Focus and descriptions in the wardrobe filters (refines D-117)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: Pressing the pressed Untagged chip to leave its view when no item waits for tags (likely with a search, since waiting items have no name or colours) removes the chip while it has focus; focus then goes to All, the chip that view returns to, once and only when it was lost (a one-shot ref read in a layout effect, so a later render or Next showing the page again never moves it). The filter panel's hints are the descriptions of the controls they explain (`aria-describedby` on the Status and Colour groups, the warmth group and the "Another colour" field), as in the tag form.
- Why: Focus fell to `<body>`, and keyboard and screen-reader users started again at the top of the page. Screen readers announced "Status, group" without "None chosen shows the usual three" or "Archived items stay hidden unless Archived is chosen".

### D-134 "Back to wardrobe" needs the Navigation API; without it the link opens the list afresh (refines D-107)
- Date: 2026-11-02 · Status: awaiting the owner's acceptance (a degraded path) · Deviates from spec: no
- Decision: `previousWardrobeListHref` reads `navigation.entries()` and `navigation.currentEntry.index` to tell that the previous history entry is the wardrobe list. Where `window.navigation` is missing, "Back to wardrobe" is a plain client navigation to `/wardrobe`: the top of the list with the default filters, without the list's earlier state. The browser's own Back still returns to the filtered list where it was. The Navigation API is in Chromium 102 and later, Safari 26.2 and later, and Firefox 147 and later (MDN compatibility data, checked 2026-11-02), so only older browsers take this path, the owner's iPhone included if it runs an iOS older than 26.2.
- Why: `history` cannot read earlier entries, and guessing from `document.referrer` breaks with client-side navigation. A plain link is the safe baseline; always calling `router.back()` instead would leave the app when the item page was opened from outside it. Recorded because the shared rules allow no degraded behaviour without the owner's permission.

### D-135 The JSON export's table list is a pure module, tied to the schema by a test (refines D-114)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `EXPORT_JSON_TABLES` and `EXPORT_FORMAT_VERSION` live in `src/lib/export/json-tables.ts` (no `server-only`, like `csv.ts`), re-exported by `src/server/services/export.ts`. `export.test.ts` maps each key to the schema's table (`isTable`, `getTableName`) and requires every schema table to be exported except `item_images` (nested under items) and `login_attempts` (D-114). `e2e/export.spec.ts` checks the downloaded file's keys against the same list, in order.
- Why: Both checks compared the file only with the hand-kept list, so a table added in a later phase would have been left out of the owner's backup with every test green; the e2e spec checked four of the twelve tables.

## Added in the Phase 4 third review

### D-136 The review page's own batch results do not read it again; a change noted during one of its refreshes still does, once (refines D-129 and D-130)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `noteWardrobeChangeIn(data)` (`src/lib/items/wardrobe-changes.ts`) notes a change and records that `data` already holds it; `noteDataReadAt(data, count)` records the data as read at `count` plus those changes. `NoteServerItemChanges` takes `includedIn`, and `/add/review` passes its cards, which the same server render loads after applying the finished batch results. This relies on `includedIn={cards}` and `snapshot={cards}` arriving as one object: React Flight sends an object passed twice in one render once, and the client gets one object (checked in the production build on 2026-11-02). A refresh whose render applied results therefore no longer counts its own cards as stale. Other pages still see the change, and any other change noted while the request ran still makes the cards stale. That part stays on purpose for the pages that do not listen while shown (`refreshWhileShown={false}`, the review and item pages): their own Save, Confirm or tag answer landing while one of their refreshes runs brings one more refresh after the interval (D-130), because the refreshed data may have been read before it, and `mergeServerItems` takes the server card for every card that is neither dirty nor busy (`ItemDetail` takes every new server item), so an older copy replaces the newer one until that refresh. During a "Tag N waiting items" run that follows a refresh on show, the review page therefore re-reads up to once every 5 s while answers keep landing during its refreshes; accepted.
- Why: Back to `/add/review` after a change elsewhere, with a refresh whose render applied finished batch results, refreshed the page a second time 5 s later: the batch poll and the 200-card read ran again and the "Applied N finished batch results" notice disappeared. D-129 said sibling order made those results count as seen, but the hook recorded the cards at the count from before the marker's note. Recording a non-listening page's refreshed data as read when it arrives, the fix first proposed, would have stopped the follow-up refreshes too, and with them the repair of a tagged card replaced by its older "Waiting for tags" copy. Dropping the follow-up safely would need `updatedAt` on cards and merges that keep the newer card.

### D-137 A tag form with unsaved edits keeps its submit state when a newer item arrives, and waits for a running field check (refines D-132)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `useTagForm`'s reset for a form with unsaved edits also passes `keepIsSubmitted`, `keepSubmitCount` and `keepTouched`. A form without edits is still reset plainly, and `keepValues` is not used, because untouched fields must take the newer values (D-132). A newer item is also not adopted while a field check runs (`isValidating` from `useFormState`); it is adopted when the check ends, the same way an item that arrives during a request is.
- Why: The form checks its fields on submit and re-checks a field as it changes only once submitted. The D-132 reset set `isSubmitted` back to false, so after a Save that failed on a field (an invalid price) and then a plan or location toggle, a cut-out or a re-read, the error and `aria-invalid` stayed on the field after the owner fixed it, until the next Save, and a screen reader kept reporting it as invalid. Keeping the submit state was not enough on its own: react-hook-form 7.91 drops the result of a field check that a reset overtakes, and when the toggle's answer landed while the fixed price was being checked (seen in the full test suite under load), the error from before the change stayed. Side effect, the normal behaviour after a submit: editing a field that shows a server VALIDATION error re-checks it in the browser and clears the error once the value passes the form's schema.

### D-138 The export page's photo parts read themselves again after an item change (refines D-107 and D-129)
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: `/settings/export` renders `RefreshAfterItemChanges` with the photo overview (`summaries`) next to `PhotoExports`. It listens while shown too (the page saves nothing itself), so after a new upload, a cut-out or a delete in the tab, the page re-reads its photo counts and parts when shown again. `test/item-freshness.test.ts` checks it with the other four pages. Pages that show no item data are not covered: `/settings/usage` (AI spend), `/add` (the tagging setup), `/settings`, `/relocate` and `/shopping`.
- Why: Back to the export page after registering photos on `/add` showed the old counts and parts. Parts hold 100 photos each, oldest first, so new photos fall into a part the page did not link, and a backup taken from that screen would have missed them. The download route builds its plan when it is called, so a listed part already downloaded its current contents under its current name, and a part past the end answers "reload the export page for the current list"; still, the missing part was not offered, and the test and D-129 claimed every page that shows item data.
