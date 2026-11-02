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
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes (additions only; every spec table and column stays)
- Decision: Extra tables `login_attempts`, `ai_batches`, `analysis_parts` and `app_settings` (one row: home climate profile, default item location). Extra columns: `items.source_hash` (unique), `tagging_error`, `tagging_batch_id`, `ai_prompt_version`; `analyses.status`, `effort`, `prompt_version`, `cache_key`, `input_snapshot`, `estimated_cost_usd`, `error`, `completed_at`; `shopping_list_items.gap_key`, `quantity`, `est_price_min_eur`, `est_price_max_eur`, `buy_timing`; `climate_profiles.slug`, `timezone`, `is_placeholder`.
- Why: Each one backs a concrete need: login rate limiting, batch tracking, resumable analyses under the 300 s limit, pre-upload dedupe, idempotent "add gaps", the `/today` location.

### D-012 Climate seed data
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Hamburg is seeded from spec section 6 with every note copied verbatim (lat 53.633, lon 9.988, Europe/Berlin). Bologna is a placeholder: only January tmax 6.5 and July tmax 31, everything else null, `is_placeholder` true. Month values are nullable, the seed upserts on slug, and the 12-month editor clears the flag once every value is filled.
- Why: Avoids inventing climate numbers that the owner will supply.

## Authentication

### D-013 Proxy check plus a session check in every read and action
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
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
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: The SDK runs with `maxRetries: 0`; `callStructured()` is the only retry loop, with at most 3 attempts. It retries 408, 409, 429, 5xx and 529, connection and mid-stream errors, invalid JSON or schema output, and `max_tokens` (once, with the cap doubled). Refusals and other 4xx are final. It honours `retry-after-ms` and `retry-after`, otherwise uses full jitter capped at 8 s, and fails fast with `RATE_LIMITED` when a wait would pass the route deadline.
- Why: Layering our loop on the SDK's would allow up to 9 attempts, and the SDK's uncapped `retry-after` could overrun the 300 s function limit.

### D-020 Every attempt logged; budget checked before spending
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Every attempt writes an `ai_calls` row: tokens (including cache read, cache write and thinking), cost, latency, request id, stop reason and status. An operation is blocked when UTC month-to-date spend plus pending batch estimates plus its own estimate would exceed `MONTHLY_AI_BUDGET_USD`.
- Why: Failed attempts cost money too, and a projection makes the hard stop meaningful for bulk runs. Concurrent in-flight calls can still overshoot by a few cents.

### D-021 Extended pricing table
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: `PRICING_PER_MTOK` keeps the spec's values and adds cache read (Haiku 0.1x; Sonnet 5.5 and Opus 5.5 0.05x), cache write (5 minutes 1.25x, 1 hour 2x) and batch (0.5x). Haiku 5.5's long tier applies when input plus cache tokens exceed 100,000, and then the whole request pays long rates. Model overrides use `||` and must be priced models, otherwise a configuration error is raised before any call.
- Why: Cache and batch tokens must be costed for the budget to hold, and an empty env string must fall back to the default model.

### D-022 No sampling parameters, no refusal fallback, no "reasoning" keys
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Requests send no temperature, top_p, top_k or assistant prefill. Refusals surface as errors (a tagged item stays `pending_tagging` with `tagging_error`; a relocation part fails with Retry). Thinking blocks are skipped by type. No structured-output key may match `/reasoning|thinking|thought/`; user-facing justifications are named `why` or `reason`.
- Why: API version 2026-10-21 rejects sampling parameters. The owner's rules forbid silent fallbacks. Keys named like reasoning risk `reasoning_extraction` refusals.

### D-023 Tagging with Haiku 5.5 at low effort and a cached prompt
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: Haiku 5.5, effort `low`, `max_tokens` 4096, non-streaming. A static system prompt of about 1.3–1.6K tokens with `cache_control`, versioned `tag-v1`, with the image block before the text. The client tags 4 items at a time with per-item Retry. The tag cache key is `image_hash`; Re-tag forces a new call and keeps `user_edited_fields`.
- Why: Cheap, fast tagging that follows the spec. Caching makes the repeated prompt about 10x cheaper, and a test pins the prompt hash so any edit forces a version bump.

### D-024 Batch mode with a synchronous dry run
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
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
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
- Decision: `@imgly/background-removal` 1.7.0 with `onnxruntime-web` 1.21.0 pinned exactly, loaded lazily on the client only, models from the IMG.LY CDN, `device: 'cpu'` only, and no COOP/COEP headers, so it runs single-threaded. It starts with a time-boxed compatibility spike in a visible browser; if it does not bundle or run on Next.js 16 with Turbopack, work stops and the owner is asked (no silent library swap).
- Why: The owner accepted the AGPL-3.0 licence for this private single-user app (see README). COOP/COEP would break loading images from Blob.

## Features

### D-035 Route Handlers for concurrent work
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: Work the browser runs in parallel uses Route Handlers (`/api/items/register`, `/api/items/[id]/tag`, `/api/analyses/[id]/parts/[partId]`). Single mutations stay Server Actions.
- Why: Next.js dispatches Server Actions one at a time per client, so a pool of 4 built on actions would run serially.

### D-036 Image export as one ZIP or numbered parts
- Date: 2026-11-01 · Status: accepted · Deviates from spec: yes
- Decision: A streamed ZIP route (`client-zip`) returns one ZIP when the predicted size streams comfortably within 300 s, otherwise `?part=N` with at most 100 items each.
- Why: Streamed responses avoid the 4.5 MB limit, but Hobby stops functions at 300 s, and iOS cannot hold a large in-memory Blob.

### D-037 Search and browsing
- Date: 2026-11-01 · Status: accepted · Deviates from spec: no
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
- Date: 2026-11-02 · Status: accepted · Deviates from spec: no
- Decision: These generated files carry local edits that `shadcn add --overwrite` would undo, so re-apply them after any overwrite: `sidebar.tsx` has no Ctrl/Cmd+B keyboard toggle; `badge.tsx` starts with `"use client"`; the `toast.tsx` viewport sits above the mobile tab bar below `md`; `button.tsx` and `toggle.tsx` have the 44 px sizes from D-042.
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
