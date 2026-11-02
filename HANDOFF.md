# Handoff

Newest entry first. Each entry records the state at the end of a working session. Task tracking lives in Beads (`bd ready`, `bd show <id>`); the reasons behind choices are in [DECISIONS.md](DECISIONS.md).

## 2026-11-02 — Phase 3 third review

### State

Phase 3 (wardrobe-6rd) after a third review of the second round's code. Three fix groups applied its findings. The integration run then fixed what the visible-browser check and the gate found: disabled buttons that looked enabled, "Tag 0 items" during a run, and a focus race behind an intermittent unit-test failure. The gate passes with no `.env.local`, Docker migrates and seeds with no schema change, the headed e2e suite passes 28 of 28, and every changed screen was checked in a visible browser. All of it was re-run independently before the commit (last bullet under Checks run). Phase 3 is committed as "Phase 3: photo upload, Claude tagging, review, usage tracking and background removal", and wardrobe-6rd is closed.

Fix groups:

- Review page (r3-client-1, -2, -3, -5, -6), D-103:
  - A revisit that adds items above the shown page grows the page, so an edited card or an open hand-tagging form stays mounted.
  - A capped list (newest 200) keeps a dirty card that newer uploads pushed out of the window, after every server item.
  - Confirms remove items with a functional update on the latest list.
  - Focus after Tag now, Confirm and Show more moves only when it was lost or is still where the request started.
  - The tagging section hands focus to the list summary when it leaves, and the batch offer stays up and busy until the batch start answers.
- Add page (r3-client-4): a leave dialog left open when Back or a swipe hides `/add` is now closed by a layout-effect cleanup. It cannot reopen on return and follow the old link (D-104).
- Docs (r3-tests-docs-1, -2, -3):
  - D-091 now says that only `/add` leaves a failed dry-run row out of the next batch; `/add/review` keeps that card waiting.
  - D-099 now says that leaving does not stop a batch start.
  - `E2E_TAG` is described as reserved for the planned Phase 4 smoke spec in `playwright.config.ts`, `test/app-env-vars.ts`, `.env.example`, `e2e/README.md` and the README variable table.

Integration:

- Buttons kept focusable while disabled looked fully enabled everywhere, because Base UI's `focusableWhenDisabled` sets only `aria-disabled`. The shared `Button` now styles `aria-disabled` like `disabled` (D-105).
- While a run or a batch start is going, "Tag N items" keeps the count it started with instead of reading "Tag 0 items" (D-103). A new unit test covers this and fails without the change.
- `add-flow-view.test.tsx` "keeps focus in the row after a Retry" failed in one full gate run and about once in ten parallel runs. Instrumented, the test showed focus falling to `<body>` and never moving. Cause: a passive effect still pending from the upload's failure commit used up the focus target that the Retry handler had just set. The focus effects on `/add` and `/add/review` are now layout effects (D-106), and 60 parallel runs then passed.
- A second flake that showed only under load: "lets links and reloads through once nothing is in flight" read `beforeunload` before the guard's passive cleanup ran. The test now waits for the cleanup.

Statements in the entries below that are no longer true:

- D-091 "both pages then mark only that row or card as failed … and leave it out of the next batch attempt": only `/add` leaves it out (corrected in place).
- D-099 "the leave dialog says the batch start would be cancelled": it now says that leaving does not stop it (corrected in place).
- README "`E2E_TAG` … Set to `1` to run the live tagging steps of the Playwright smoke test": no spec reads it yet (corrected).

### Decisions

D-103 to D-106 are new, under "Added in the Phase 3 third review". D-095, D-098 and D-099 point to the entries that refine them. D-091 and D-099 were corrected in place.

### Checks run

All on 2026-11-02, local time (UTC+1).

- 16:29:48 `pnpm exec tsc --noEmit` on the three groups' combined work: no errors.
- First gate, with `.env.local` moved out at 16:30:20:
  - 16:30:20 to 16:30:25 `pnpm typecheck`: passed.
  - 16:30:25 to 16:30:35 `pnpm lint`: passed with no findings.
  - 16:30:35 to 16:31:09 `pnpm test`: passed (67 files passed, 1 skipped; 1,150 tests passed, 1 skipped).
  - 16:31:09 to 16:31:23 `pnpm build`: passed.
  - `.env.local` restored at 16:31:23.
  - 16:31:35 grep of `.next/static`: no `ANTHROPIC_API_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, `sk-ant` or `vercel_blob_rw`. `BLOB_READ_WRITE_TOKEN` appears only as the `@vercel/blob` client library's own environment lookup.
- Database: Docker `guardaroba-ai-db-1` was already up and healthy.
  - 16:31:46 `pnpm db:generate`: "No schema changes, nothing to migrate".
  - 16:31:48 `pnpm db:migrate`: succeeded.
  - 16:31:49 `pnpm db:seed`: Hamburg updated, Bologna kept, `app_settings` kept.
- 16:31:54 to 16:32:39 `pnpm test:e2e` (headed): 28 of 28 passed in 43.4 s.
- 16:36:08 to 16:38:38 visible-browser check, first pass. Setup, the same for the final pass:
  - A script outside the repository started `next start` on port 3100 against `wardrobe_e2e`, with every app variable blank.
  - Blob, register and tag requests were answered in the browser. Where a test needed a slow request, a route held Server Action calls for 2 to 3 s.
  - Every seeded row was removed afterwards and the server was stopped.

  The first review-page run stopped on an invalid category in one of the script's own routed tag answers. The script was fixed and the run repeated. Results are under the final pass below.
- 16:40:24 `vitest run src/components/items/review-list.test.tsx` after the "Tag N items" change: 41 passed. With the label change reverted, the new test failed ("Unable to find … Tag 21 items"). The file was then restored and compared byte for byte.
- Second gate, from 16:41:03: typecheck, lint and build passed. `pnpm test` (16:41:20 to 16:41:50) failed one test, `add-flow-view.test.tsx` "keeps focus in the row after a Retry", with focus on `<body>`. Follow-up runs:
  - 16:42:16 to 16:42:46: the file alone passed three times.
  - 16:43:33 to 16:44:36: the full suite passed twice.
  - In 16 parallel runs of the file's focus tests, one failed.
  - An instrumented copy, run 10 at a time, failed in the first round. Its log showed focus leaving Retry and never reaching Remove.
  - After D-106, 16:47:25 to 16:48:10: 60 parallel runs passed.
  - 16:48:25 to 16:49:50, 20 parallel runs of both changed test files: one failure of "lets links and reloads through once nothing is in flight". This was fixed in the test.
  - 16:50:11 to 16:52:20: 30 parallel runs passed.
  - The test file was restored from its copy from before the instrumentation.
- Final gate, with `.env.local` moved out at 16:52:27:
  - 16:52:27 to 16:52:34 `pnpm typecheck`: passed.
  - 16:52:34 to 16:52:44 `pnpm lint`: passed with no findings.
  - 16:52:44 to 16:53:16 `pnpm test`: passed (67 files passed, 1 skipped; 1,151 tests passed, 1 skipped).
  - 16:53:16 to 16:53:29 `pnpm build`: passed.
  - `.env.local` restored at 16:53:29.
  - 16:56:58 grep of `.next/static`: same result as the first gate.
- 16:53:50 to 16:56:46 visible-browser check, final pass, on that build:
  - `/add` leave dialog, at 390 × 844 and 1280 × 800:
    - An upload was held open, and a click on the Settings link opened "Leave this page?".
    - Browser Back went to `/wardrobe` with no dialog, no `inert` and no scroll lock, and its nav still worked.
    - Returning to `/add` by the nav link and by Forward showed no dialog and an empty list (D-098). The old link was not followed.
  - `/add/review` at 1280 × 800, 12 tagged items:
    - Revisit: the 10th card was edited, then Add more, two uploads and "Review 2 items". The page then showed 14 items with 12 cards visible, the edited value kept and "Show 2 more".
    - Show more by keyboard focused the Visual 11 heading.
    - Tag now with focus left in the card focused the card's heading. Tag now followed by a click into another card's Notes kept focus in Notes.
    - Confirm on Visual 01, held 2 s, while typing in Visual 02's Notes: the card left, and focus and the typed text stayed.
    - Confirm on Visual 03 with focus left on it: focus went to Visual 04's heading. Both rows are `confirmed` in the database.
  - Tagging section:
    - "Tag 2 items", with answers held 0.6 s: the section read "Tagging… 0 of 2 items done" with "Tag 2 items" busy. Then the section left, with focus on the `review-summary` heading.
    - 21 waiting items, batch start held 3 s: "Starting the batch…" showed, and "Tag 21 items" and the busy "Tag as a batch" were both dimmed (opacity 0.5, `aria-disabled`), with focus on the batch button.
    - The start then failed with the expected CONFIG error (no API key), shown as one toast. The offer came back with focus still on the button, and `ai_batches` stayed empty.
  - Capped list of 201 tagged items:
    - The page read "Showing the newest 200 of 201". Show more was clicked until all 200 cards showed, and the oldest shown card ("Capped 200") was edited.
    - After one upload on `/add` and a return: "201 items to review", "Showing the newest 200 of 202", 201 cards, with the edited card last and its value kept.
  - `/add` with two uploads tagged by routed answers: once everything was tagged, "Start tagging" was dimmed (opacity 0.5) and still focused.
  - Screenshots looked at:
    - `/add`: the leave dialog at both widths, `/wardrobe` after Back at both widths, `/add` after the return at both widths, and `/add` with all items tagged.
    - Review page: before and after the revisit, and focus after Show more, Tag now and both confirms.
    - Tagging section: while running, after tagging both items, the batch offer, the batch start before and after D-105, and the failed start's toast.
    - Capped list: the summary and the edited card.
  - The first pass showed the enabled-looking disabled buttons and "Tag 0 items", both fixed above. Nothing else needed fixing. Seen and left as is: during a batch start, every waiting card's button reads "Tagging…", as it did before this round.
- 16:57:05 to 16:57:47 `pnpm test:e2e` (headed): 28 of 28 passed in 41.0 s. The server logged only the expected CONFIG errors and the forged-action test's "Failed to find Server Action". No server was left running.
- After that run, only Markdown changed (this entry, DECISIONS.md and README.md).
- Independent re-run before the commit, on the same working tree:
  - Gate, with `.env.local` moved out at 17:01:05:
    - 17:01:05 to 17:01:09 `pnpm typecheck`: passed.
    - 17:01:09 to 17:01:18 `pnpm lint`: passed.
    - 17:01:18 to 17:01:51 `pnpm test`: passed (67 files passed, 1 skipped; 1,151 tests passed, 1 skipped).
    - 17:01:51 to 17:02:02 `pnpm build`: passed, same route table.
    - `.env.local` restored at 17:02:02.
  - Database:
    - 17:02:08 `pnpm db:generate`: "No schema changes".
    - 17:02:09 `pnpm db:migrate`: succeeded.
    - 17:02:11 `pnpm db:seed`: Hamburg updated, Bologna kept, `app_settings` kept.
  - 17:02:17 to 17:02:59 `pnpm test:e2e` (headed): 28 of 28 passed. The server logged only the expected CONFIG errors and the forged-action message.
  - 17:06:42 to 17:07:03 visible headed Chromium check. Setup:
    - Playwright drove the browser from a script outside the repository.
    - The server was `next start` on port 3100 against `wardrobe_e2e`, with every app variable blank.
    - 13 rows were seeded (10 tagged, 3 pending), and 2 more were added during the revisit. All 15 were deleted afterwards and the server was stopped.
    - An earlier attempt at 17:06:06 went through the same steps but crashed in the script's own route cleanup before printing its results. The rows were reset and the run repeated.

    Results:
    - Revisit: the 10th card's Name was edited, then the owner left by the sidebar, 2 items were added and the page was opened again by client navigation. It showed "15 items to review" and 12 cards, with the edited card 12th and its value kept.
    - Confirm, held 2.5 s, while typing into another card's Notes: the card left, the summary read "14 items to review", and focus and the typed text stayed in Notes.
    - Confirm with focus left on the button: focus went to the next card's heading.
    - An untouched card's Save: `aria-disabled`, opacity 0.5, `pointer-events: none`.
    - Show more by keyboard ("Show 1 more (1 not shown)"): focus went to the newly shown card's heading.
    - Fill in by hand: the form opened with focus in Name, and Cancel returned focus to "Fill in by hand".
    - At 390 × 844: no horizontal scroll on `/add/review` or `/settings/usage`.
    - `/add` leave dialog: with an upload held, a click on Wardrobe opened "Leave this page?". Browser Back went to `/wardrobe` with no dialog and no `inert`. Returning by the Add link showed `/add` with no dialog and an empty list.
    - No browser console errors.
    - Screenshots looked at: the review page after the revisit (top and the edited card), Fill in by hand, the review page at phone width, the leave dialog, `/add` after the return, and the usage page at desktop width.
- Not run: anything against the live Anthropic API or a real Blob store.

### Migration and deploy state

No schema change. `drizzle/20261102094305_init` is applied to the Docker `wardrobe` and `wardrobe_e2e` databases. Not deployed.

### Open risks

- In a capped list, a dirty card that was in fact confirmed elsewhere stays until its own Save or Confirm answers (D-103).
- There is no deterministic unit test for the passive-effect focus race (D-106). The evidence is the parallel stress runs before and after the change.
- `aria-disabled` buttons now ignore pointer events, so a click on one lands on whatever is under it. Nothing under them has a click handler today (D-105).
- The risks in the entries below stand, including that the leave guard does not stop Back (D-082). The leave dialog now only closes when the page is hidden.

### Live checks pending

As in the entries below.

### Next steps

1. Phase 4 (wardrobe-a27): browse, stats and export.
2. Bump `next`, `eslint-config-next` and `@next/env` together once the announced Next.js security release is out (expected 2026-11-03).
3. The owner decides whether D-093 ("Fill in by hand") stays as built.

## 2026-11-02 — Phase 3 second review

### State

Phase 3 (wardrobe-6rd) after an independent second review of the code the first fix pass added. Four fix groups applied its findings; the integration run then fixed two e2e locators, removed a duplicated setup helper and updated the docs. The gate passes with no `.env.local`, Docker migrates and seeds with no schema change, the headed e2e suite passes 28 of 28, and the changed screens were checked in a visible browser. Still not committed.

Server (batches, polls, hand tagging):

- Batch starts claim their items in one locked transaction before any paid call (`claim:<uuid>` placeholder id, no migration), so two overlapping starts can no longer both pay for a dry run and a batch; a failed dry run or create releases the claim, and polls delete claims older than 15 minutes (D-089). Tests cover two overlapping starts, a start held at its budget check, a start on claimed items, and stale and fresh claims.
- A batch start has a 270 s deadline; each `batches.create` attempt gets min(60 s, time left), timeouts are not retried and keep `taggedItemId` (D-090).
- The dry run picks the first item without a stored tagging error, and a failed dry run names only its own item on both pages (D-091).
- Polls return counts plus per-batch `errors`; the cron keeps the counts when one batch fails, and the review page shows the applied count next to the problem notice (D-092).
- Pending items in no batch can be filled in by hand (`tagItemByHand`, "Fill in by hand" on `/add/review`), saved as tagged or confirmed without any AI spend (D-093). This resolves the owner question in D-066, decided under the run scope, so the owner can veto it.
- "Tag now instead" carries the card's batch id, and the server returns the batch's tags without a call if they were applied meanwhile (D-094).
- Tests that now exercise what they claim: the batch budget test sits between the batch-only and total estimates, the dry-run budget test between the standard and dry-run estimates, and the review page's poll asserts the 10 s timeout on a real open batch.

Pages:

- `/add/review` merges newer server props into the list instead of keeping the first render's items (Next keeps the page in a hidden `<Activity>`), keeps unsaved edits, and patches only the fields a run owns (D-095). Failed action calls no longer leave a form or "Confirm all untouched" stuck busy.
- Both pages re-read the budget from the new `GET /api/ai/tagging-setup` after a run or batch attempt instead of `router.refresh()`, whose failure replaced the page with the error screen (D-096).
- `/add` keeps working with a tagging CONFIG error: the "Tagging is unavailable" alert, a reduced bar with the Review link, and working pickers and uploads (D-097). `/add/review` now uses the same `getTaggingSetupResult` (the page's own copy was removed in this integration).
- Leaving `/add` hides it in an `<Activity>`; the flow now treats that as leaving and resets, so a return starts with an empty list (D-098). Removing an original re-checks its in-list duplicates, focus is kept after Remove, Retry, Start tagging and the batch start, and the leave dialog has its own text while a batch is starting (D-099).
- Toasts follow the bar's measured top edge (`--toast-bar-top`), so they clear it whether it is stuck or not (D-100).

Platform:

- Only the two hash-pinned onnxruntime files are `immutable`; `resources.json` is `no-cache`, and the asset folder and CDN base are built from `PINNED_VERSIONS`, now in `src/lib/images/bg-removal-assets.ts` (D-101).
- The e2e server starts with every app variable blank except its own database and auth values, so a real key or Blob token in `.env.local` cannot reach it (D-102). `e2e/add.spec.ts` now routes and aborts Blob API uploads to `vercel.com/api/blob` and asserts none happened.

Statements in the two entries below that are no longer true:

- "On `/add`, a CONFIG error in the tagging settings still shows the error page": it no longer does (D-097).
- "Toasts move above the add page's sticky tagging bar, measured, at every width": the lift by the bar's height only worked while the bar was stuck; placement now follows the bar's position (D-100).
- The runtime files "with the immutable cache header" (risks and live checks): only the `.wasm` and `.mjs` are immutable; `resources.json` revalidates (D-101).
- "None of the specs calls Claude or Blob" held only while `.env.local` had no real key or Blob token; the config now guarantees it (D-102).
- Phase 3 risk "`pollTaggingBatches` returns the first failing batch as an error, so the counts from the successful ones are not shown": fixed (D-092).
- Phase 3 risk "An item Claude refuses cannot be confirmed by hand (D-066, owner question)": resolved (D-093).
- "A tagging run or a started batch refreshes the page" (D-074) and D-082's "leaving unmounts the flow": replaced by D-096 and D-098.

### Decisions

D-089 to D-102 are new, under "Added in the Phase 3 second review". D-024, D-056, D-066, D-068, D-074, D-081, D-082, D-083, D-084 and D-088 now point to the entries that refine or replace them; D-066's open question is marked resolved by D-093. Two choices the fix groups flagged were kept: both pages also re-read the budget after a failed batch start, because the dry run may already have been paid for (D-096), and the hand-tag form prefills category, formality and condition only when the card already has them (D-093).

### Checks run

All on 2026-11-02, local time (UTC+1).

- 15:30:22 `pnpm exec tsc --noEmit` on the four groups' combined work: no errors. After the integration change to the review page, `tsc --noEmit` and `eslint` on the edited files: clean.
- Gate with `.env.local` moved out: 15:31:39 to 15:31:49 `pnpm typecheck` passed; 15:31:52 to 15:32:01 `pnpm lint` passed with no findings; 15:32:04 to 15:32:30 `pnpm test` passed (67 files passed, 1 skipped; 1,135 tests passed, 1 skipped, the opt-in real-Postgres test); 15:32:46 to 15:33:06 `pnpm build` passed (vendor step included). `/add`, `/add/review` and `/settings/usage` are partial prerenders and `/api/ai/tagging-setup` is dynamic. 15:33:11 grep of `.next/static`: no `ANTHROPIC_API_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, `sk-ant` or `vercel_blob_rw`; `BLOB_READ_WRITE_TOKEN` only as the `@vercel/blob` client library's own environment lookup. `.env.local` restored at 15:33:20.
- 15:33:33 `pnpm db:generate`: "No schema changes, nothing to migrate". 15:33:35 `pnpm db:migrate` succeeded. 15:33:37 `pnpm db:seed`: Hamburg updated, Bologna kept, `app_settings` kept. Docker `guardaroba-ai-db-1` was already up and healthy.
- 15:33:45 to 15:34:57 `pnpm test:e2e` (headed): 26 passed, 2 failed, both in new tests. The short-list toast test could not find "Close toast": Base UI marks a toast's close button `aria-hidden` until the toasts are hovered or focused, so the locator now passes `includeHidden`. The hand-tagging test's `getByRole("option", { name: "Casual" })` also matched "Smart casual"; the three option locators are now exact. 15:36:05 to 15:36:39 `pnpm test:e2e e2e/add-tagging.spec.ts e2e/review.spec.ts`: 12 of 12 passed.
- 15:39:37 to 15:39:56 visible-browser check (a script outside the repository, `next start` on port 3100 against `wardrobe_e2e` with every app variable blank, then a second server with `MONTHLY_AI_BUDGET_USD=abc`; Blob calls and register answered in the browser; every seeded row removed afterwards, both servers stopped):
  - `/add/review` at 1280 × 800: the "Batch results not checked" notice for an open batch with no API key; the batch card shows "In batch" and no "Fill in by hand"; the refused item shows both Retry and "Fill in by hand"; the tagged card does not.
  - "Fill in by hand" at 1280 × 800: focus on Name; Category, Formality and Condition read "Choose…"; Save with nothing filled marks the six required fields with "Required.", "Choose one of the options.", "Add at least one colour." and "Pick at least one season."; filled and saved, the card turned into the tagged review form with the values marked Edited. Database row: `tagged`, `ai_raw` and `tagging_error` null.
  - At 390 × 844: the same form on the refused item fits without sideways scrolling; Save and confirm removed the card and left the row `confirmed` with `ai_raw` null.
  - Re-sync: Add more, one photo uploaded on `/add` (its register inserted a real row), then "Review 1 item": the revisited review page listed the new item and kept the hand-tagged card.
  - CONFIG on `/add` at 390 and 1280 px: the "Tagging is unavailable" alert with the safe message; two photos picked and uploaded to Ready; the bar read "2 items uploaded; tagging is unavailable" with only "Review 2 items". `/add/review` with the same error: "Tagging several items at once is unavailable", with Tag now and "Fill in by hand" still on the cards.
  - Screenshots looked at: all fifteen from this script (review page at both widths, the hand-tag form open, with errors, filled and saved at 1280 px, open and with errors at 390 px, after confirming, after the return from `/add`, and the four CONFIG screens), plus the failed e2e run's short-list toast at 390 px (the toast above the unstuck bar, not on it). Nothing needed fixing. Seen but left as they are, since the existing review form behaves the same: the required-field errors also colour the "Add colour" button and the season chips red, and a colour added by name keeps the grey default swatch unless one is picked, so a hand-tagged "olive" is stored with `#808080` as its hex. Element screenshots of tall cards at 390 px show the fixed tab bar part-way down; that is the screenshot stitching, not the layout.
- Final gate with `.env.local` moved out: 15:41:47 to 15:41:52 `pnpm typecheck` passed; 15:41:52 to 15:42:02 `pnpm lint` passed; 15:42:02 to 15:42:29 `pnpm test` passed (same counts); 15:42:29 to 15:42:39 `pnpm build` passed; `.env.local` restored at 15:42:39. 15:42:45 grep of `.next/static`: same result as above.
- 15:42:53 to 15:43:34 `pnpm test:e2e` (headed): 28 of 28 passed in 40.4 s. The server logged only the expected CONFIG errors (no Blob token, no API key) and the forged-action test's "Failed to find Server Action".
- After that run, only code comments changed (decision numbers in four files); `eslint` on them was clean. Gate again with `.env.local` moved out: 15:48:39 to 15:48:46 `pnpm typecheck` passed; 15:48:46 to 15:48:56 `pnpm lint` passed; 15:48:56 to 15:49:22 `pnpm test` passed (67 files passed, 1 skipped; 1,135 tests passed, 1 skipped); 15:49:22 to 15:49:35 `pnpm build` passed; `.env.local` restored at 15:49:35. 15:49:40 grep of `.next/static`: none of the six names.
- Not run: anything against the live Anthropic API or a real Blob store.

### Migration and deploy state

No schema change (claims use a placeholder `anthropic_batch_id`, not a new column). `drizzle/20261102094305_init` is applied to the Docker `wardrobe` and `wardrobe_e2e` databases. Not deployed.

### Open risks

- During a batch start, the dry-run item is not linked to the claim: a per-item tag call for that item in that window can still pay once more (a fraction of a cent).
- The budget check before the claim is not locked: two starts on different items can both pass it, as D-020 already accepts.
- A batch whose create timed out or lost its connection, or whose id could not be recorded, may exist at Anthropic and be billed without ever being applied. The log names it (with the Anthropic id when known); the claim is deleted as stale after 15 minutes, so its items can be tagged again.
- Fresh claims are not counted as `pending` in the poll summary.
- On `/add`, tagging comes back after a CONFIG error only with a new server render (a reload or a return to the page); the budget re-read runs only after tagging.
- "Fill in by hand" saves the form's defaults (warmth 3, the switches off) as the owner's values, so a later Re-tag keeps them instead of Claude's (D-093). A colour added only by name keeps the grey `#808080` swatch as its hex.
- On `next start`, a missing file under the two immutable names gets `private, no-cache, no-store`; Vercel's 404 caching was not checked.
- Vitest prints a Vite notice that the planned `configLoader: 'native'` will not support `vitest.config.mts` importing `./test/app-env-vars` without an extension; the tests run.
- Base UI hides a toast's close button from assistive technology until the toasts are hovered or focused (library behaviour, found by the e2e test).
- The other risks in the two entries below stand: the leave guard does not cover Back, and an upload cancelled between `put()` and register leaves its original in Blob.

### Live checks pending

As in the two entries below, plus: on a deployed build, `ort-wasm-simd-threaded.wasm` and `.mjs` served `immutable` and `resources.json` served `no-cache`; a real batch start (the claim row receiving the Anthropic id, the dry-run item, the budget re-read afterwards); the cron's answer when one batch fails.

### Next steps

1. Close wardrobe-6rd at the Phase 3 commit.
2. Phase 4 is wardrobe-a27.

## 2026-11-02 — Phase 3 review fixes

### State

Phase 3 (wardrobe-6rd) after the review: all twelve findings were checked and applied, three of them with a difference stated below, and the new e2e test found one more bug, now fixed. The gate passes with no `.env.local`, Docker migrates and seeds, and the headed e2e suite passes 25 of 25.

Applied:

- Pricing: Sonnet 5.5 cache reads are 0.1x ($0.20 per MTok), not 0.05x; only Opus 5.5 is 0.05x (D-021 corrected). Usage logging, the budget and Sonnet estimates were understating cache-read spend.
- Background removal: the onnxruntime runtime (`.wasm` and the `.mjs` glue, which runs as script in the app's origin) is now served by the app, copied from `onnxruntime-web` 1.21.0 with pinned hashes by `pnpm vendor:bg-removal` before every build and dev start; only the model stays on IMG.LY's CDN (D-081).
- `/add` asks before a link, a reload or a tab close would cancel running uploads or queued tagging calls (D-082).
- `/add/review` has "Tag N waiting items ≈ $X" with the remaining budget, the budget stop and the batch offer above 20, and batch items have "Tag now instead" behind a confirmation (D-083). Both pages read their quote through `getTaggingSetup`.
- Batches: the batch quote includes the dry run at standard rates with the 1-hour cache write, as the server now reserves it; `batches.create` is retried after 429, 529 or `x-should-retry: true`; a failed create names the already tagged item, and a started batch shows its dry-run item as tagged (D-084).
- Batch polls have request timeouts: 10 s on the review page, 60 s in the cron (D-085).
- `src/app/(app)/error.tsx` keeps the sidebar and tab bar on a page error, with Try again and links to Settings and AI usage (D-086).
- Uppercase hex colours are lowercased instead of refused (D-087).
- Toasts move above the add page's sticky tagging bar, measured, at every width (D-088).
- Found by the new e2e test: the Blob client's throttled progress could fire after `put()` resolved and move a saving or ready photo back to "Uploading 100%"; with a fast register it stayed there. Late progress events are now dropped for originals and cut-outs (D-088).

Differences from the review's suggestions:

- The runtime comes from the already installed `onnxruntime-web` rather than a new `@imgly/background-removal-data` dependency, which this pass could not add. The model stays on the CDN, so 44 MB are neither committed nor deployed.
- The leave guard warns before an upload is cancelled between `put()` and register, but such orphaned originals still have no cleanup.
- On `/add`, a CONFIG error in the tagging settings still shows the error page (now inside the app layout). Only the review page limits it to the tagging controls, so confirming keeps working.

The headed spec `e2e/add-tagging.spec.ts` renders the tagging bar for the first time: it answers `/api/blob/upload`, the Blob store's PUT, register and tag inside the browser and runs against the real build.

### Decisions

D-081 to D-088 are new, under "Added in the Phase 3 review fixes". D-021 is corrected in place; D-024, D-034, D-063 and D-077 point to the entries that refine them. The approved plan's pricing row (outside the repository) still says Sonnet 5.5 cache reads are 0.05x and should be corrected the same way.

### Checks run

All on 2026-11-02, local time (UTC+1).

- During the fixes: targeted `vitest`, `tsc --noEmit` and `eslint` runs, all passing before the gate.
- 13:01 to 13:04 the first gate run with `.env.local` moved out passed, but `pnpm lint` reported 61 warnings, all in the copied `public/vendor/.../ort-wasm-simd-threaded.mjs`; `public/vendor/**` is now ignored by ESLint. 13:03:20 to 13:04:03 the gate again: typecheck, lint (no findings), test and build passed.
- 13:04:27 first `pnpm test:e2e` with the new spec: 21 passed, 4 failed. Three failures were the progress bug above, and one was the spec's own status filter, which missed "1 of 1 photo uploaded". After both fixes, 13:08 to 13:09 `pnpm test:e2e e2e/add-tagging.spec.ts` passed 4 of 4.
- 13:10 to 13:25 visible-browser check of background removal (a script outside the repository, `next start` on `wardrobe_e2e`, one seeded item whose photo and Blob upload were answered by `page.route`, row deleted afterwards). `resources.json`, `ort-wasm-simd-threaded.wasm` and `.mjs` came from `localhost:3000/vendor/bg-removal/imgly-1.7.0-ort-1.21.0/` and the 11 model chunks from `staticimgly.com`. The run took about 8 s and produced a 1024 × 1280 PNG with real alpha (0 to 254), whose garment was cut out cleanly. The save then failed with the expected CONFIG error, because there is no Blob token. The first attempts' capture script waited for the wrong text and left a server on port 3000; that server was stopped.
- Screenshots looked at, from the e2e run (in each test's output folder and the HTML report): the add page with 2 ready items and with 21 (batch offer) at 1280 × 800 and 390 × 844; an error toast above the sticky bar at both widths, also checked by bounding boxes in the test; the budget alert at 390 px; the leave dialog at 390 px; the review page's tagging panel at both widths. Nothing sat under the tab bar, and the toast never covered the bar.
- Final gate with `.env.local` moved out: 13:27:00 to 13:27:06 `pnpm typecheck` passed; 13:27:06 to 13:27:14 `pnpm lint` passed with no findings; 13:27:14 to 13:27:36 `pnpm test` passed (63 files passed, 1 skipped; 1,011 tests passed, 1 skipped, the opt-in real-Postgres test); 13:27:36 to 13:27:45 `pnpm build` passed (vendor step included). `/add`, `/add/review` and `/settings/usage` are partial prerenders. Grep of `.next/static`: no `ANTHROPIC_API_KEY`, `CRON_SECRET`, `sk-ant` or `vercel_blob_rw`. `staticimgly` appears only as the library's own default inside its chunk, which the app never uses.
- With `.env.local` restored: 13:28:01 `pnpm db:migrate` succeeded; 13:28:02 `pnpm db:seed`: Hamburg updated, Bologna kept, `app_settings` kept.
- 13:28:24 to 13:28:54 `pnpm test:e2e` (headed): 25 of 25 passed. That is the 20 earlier tests, the 4 in `add-tagging.spec.ts` and the new review test for tagging every waiting item at once. The server logged only the expected CONFIG errors and the forged-action test's "Failed to find Server Action".
- Not run: anything against the live Anthropic API or a real Blob store.

### Migration and deploy state

No schema change. Not deployed. Vercel runs `pnpm build`, which now runs `pnpm vendor:bg-removal` first (tsx is a dev dependency, which Vercel installs for the build).

### Open risks

- The Phase 3 risk "Background removal depends on IMG.LY's CDN" now covers only the 44 MB model; the runtime comes from the app. A changed model on the CDN could spoil masks but cannot run script (D-081).
- The leave guard does not cover the browser's Back button (D-082).
- An upload cancelled between `put()` and register (Leave anyway, or removing the photo) still leaves its original in Blob, with no cleanup.
- The other Phase 3 risks stand.

### Live checks pending

As in the Phase 3 entry, plus: background removal on a deployed build (the runtime from the app's own CDN with the immutable cache header, compressed transfer size), and the batch button's estimate against the dry run's logged cost.

### Next steps

1. Close wardrobe-6rd at the Phase 3 commit.
2. Phase 4 is wardrobe-a27.

## 2026-11-02 — Phase 3 (upload + tagging)

### State

Phase 3 is wardrobe-6rd. The code is complete and integrated; the gate passes with no `.env.local`, Docker migrates and seeds, the headed e2e suite passes 20 of 20, and the three new pages were checked in a visible browser. Nothing has run against the real Anthropic API or a real Blob store yet (no credentials exist); those checks are listed below.

Built in this phase:

- AI layer (`src/lib/ai/`): cost math and the tagging estimate, the zod-to-JSON-Schema converter, the retry policy, the client, call logging, the monthly budget, `callStructured()`, the tagging prompt `tag-v1` and the wire and strict tagging schemas; `aiSettingsEnv()` in `src/env.ts`; `scripts/ai-smoke.ts` (`pnpm ai:smoke`, live only); `test/fakes/anthropic.ts`.
- Contracts shared by client and server: `src/lib/items/contracts.ts` (patch schema, item card DTO, Blob payloads and paths, route bodies and responses) and `src/server/items/dto.ts`.
- Images: the browser pipeline (`client-pipeline.ts`, HEIC through `heic-to`), the sharp pipeline, Blob storage with the explicit token, and the shared browser upload helper `blob-upload-client.ts`.
- Routes: `/api/blob/upload`, `/api/items/check-hashes`, `/api/items/register`, `/api/items/[id]/tag`, `/api/items/[id]/nobg` and the cron `/api/cron/poll-batches` (`vercel.json`: daily at 04:00 UTC).
- Services: register, check-hashes, tag-item, batches (start, poll, cron entry), items (update, confirm, confirm many), nobg and usage; `computeUserEditedFields`; the actions `updateItemTags`, `confirmItem`, `confirmItems`, `startTaggingBatch` and `pollTaggingBatches`.
- UI: `/add` (pickers, drag and drop, folder import, upload queue, "Tag N items ≈ $X", the Batch offer above 20 items, the budget alert), `/add/review` (the tag form, low-confidence hints, Confirm, Confirm all untouched, Tag now, Retry, Re-tag), `/settings/usage` with a link from Settings, and the "Remove background" button on review cards (`@imgly/background-removal` 1.7.0 and `onnxruntime-web` 1.21.0, added after the compatibility spike passed in dev and production builds).
- E2E: `e2e/add.spec.ts`, `e2e/review.spec.ts` and `e2e/usage.spec.ts`, listed in `e2e/README.md`.

The integration run made these changes on top of the implementation agents' work:

- `test/boundaries.test.ts`: every module under `src/lib/ai` must start with `server-only` except the six pure ones, now listed with reasons; `blob.ts` and `server-pipeline.ts` too. Client code may not reach the AI log and budget or the server image modules, and a new test keeps the browser-only modules (`client-pipeline`, `bg-removal`, `heic-to`, the imgly library, `onnxruntime-web`) out of server code (D-079).
- The add flow and background removal each had their own copy of the Blob client-token request; both now use `src/lib/images/blob-upload-client.ts` (D-071).
- The add page's CONFIG hints spelled out `BLOB_READ_WRITE_TOKEN` and `ANTHROPIC_API_KEY`, so the secret-name grep of `.next/static` found them. The hints now describe the setting instead (D-074).
- The first e2e run passed but the server logged "encountered the unstable value `new Date()` while prerendering" for `/add`, `/add/review` and `/settings/usage`: with Partial Prefetching, link prefetches rendered the session-gated Suspense children, and the token check reads the clock. `verifySession()` now calls `connection()` first, so that content (including the review page's batch poll) renders only on real requests (D-078). The usage page's own `connection()` became redundant and was removed.
- Visual check fixes: the tag form's select triggers were 32 px tall because the shadcn trigger sets its height under `data-[size=default]`, which `h-11` did not override (now 44 px); the switches' hit area went from 34 to 46 px; on phones the upload queue now puts Retry under the status instead of squeezing the message into a narrow column; the usage page's recent-calls table now fits a 1280 px window (model and error code on a second line).
- `RemoveBackgroundButton` was already wired into `review-card.tsx` by the review stage, for every card with a processed photo; no change was needed.

README has a new "Adding items" section (add flow, review, background removal, usage page, batch polling cron), the tagging cost estimate and its method, updated Changing models, Testing, Project structure, Licences and Hobby-limit notes.

### Decisions

D-060 to D-080 are new, under "Added in Phase 3": item contracts, the wire schema and its conversion, retry outcomes (D-062 replaces D-019's RATE_LIMITED for Claude calls), cost and budget arithmetic, key-free AI settings, request shapes, tagging failures, edit tracking, batch processing, the cron route, confirming, direct Blob uploads, registering, browser pipeline details, add and review behaviour, usage figures, background removal setup, request-time session content, the boundary test and function durations. D-019, D-023, D-024 and D-034 now point to the entries that refine them. One question for the owner is open in D-066: an item Claude refuses stays pending and cannot be confirmed even with every tag filled in by hand.

### Checks run

All on 2026-11-02, local time (UTC+1).

- Before the integration changes: 11:59 `pnpm test` 61 files passed, 1 skipped (971 tests passed, 1 skipped); `pnpm lint` and `tsc --noEmit` clean.
- With `.env.local` moved out of the project:
  - 12:04 `pnpm build`: passed. The grep of `.next/static` found `ANTHROPIC_API_KEY` and `BLOB_READ_WRITE_TOKEN` in the add page's hint strings and `BLOB_READ_WRITE_TOKEN` inside the `@vercel/blob` client library chunk; the hints were changed.
  - 12:05:43 to 12:06:28 the gate after the first fixes: `pnpm typecheck`, `pnpm lint`, `pnpm test` (61 files passed, 1 skipped; 979 tests passed, 1 skipped) and `pnpm build` all passed.
  - 12:06 `pnpm build` with obviously fake values for `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `CRON_SECRET` in the environment: none of the three values, nor `sk-ant` or `vercel_blob_rw`, appears in `.next/static`.
- With the DB-only `.env.local` restored: 12:06:54 `pnpm db:generate` reported "No schema changes, nothing to migrate"; `pnpm db:migrate` succeeded; `pnpm db:seed` gave Hamburg updated, Bologna kept, `app_settings` kept.
- 12:07:02 `pnpm test:e2e` (headed): 20 of 20 passed, with the `new Date()` prerender errors in the server log; 12:08 again with the log captured: same. 12:09:20 after the `verifySession()` change: 20 of 20 passed and the errors were gone.
- 12:10 to 12:16 visual check in a visible Chromium against `next start` on `wardrobe_e2e` (a script outside the repository seeded 5 items, 1 batch and 7 `ai_calls` rows and removed them afterwards): `/add` empty and with 2 queued photos, `/add/review` and `/settings/usage` at 1280 × 800 and 390 × 844, light and dark, plus phone screenshots scrolled to the end. No page scrolled sideways and nothing sat under the tab bar. The fixes listed under State were made, the app rebuilt (12:14) and the check repeated (12:16). A probe confirmed that clicking a switch's label or 12 px above the switch toggles it and that the select trigger is 44 px tall. Remaining sub-44 px boxes are the switch itself and the toast's close button, both with larger invisible hit areas.
- Final gate with `.env.local` moved out again: 12:21:10 `pnpm typecheck` passed; 12:21:17 `pnpm lint` passed with no findings; 12:21:27 `pnpm test` passed (61 files passed, 1 skipped; 979 tests passed, 1 skipped: the opt-in real-Postgres test); 12:21:50 `pnpm build` passed. `/add`, `/add/review` and `/settings/usage` are partial prerenders (◐), the six API routes dynamic, every other page static, and the proxy present.
- 12:22:07 grep of `.next/static`: no `ANTHROPIC_API_KEY`, `CRON_SECRET`, `sk-ant` or `vercel_blob_rw`; `BLOB_READ_WRITE_TOKEN` appears only in the `@vercel/blob` client library's own environment lookup (a name, never a value).
- 12:22:07 with `.env.local` restored: `pnpm db:generate` no changes, `pnpm db:migrate` succeeded, `pnpm db:seed` Hamburg updated, Bologna kept, `app_settings` kept.
- 12:22:10 `pnpm test:e2e` (headed, `pnpm build && pnpm start`): 20 of 20 passed in 21.5 s. The server logged only the expected CONFIG errors (no Blob token, no API key) and the forged-action test's "Failed to find Server Action".
- Greps of `src`, `test`, `e2e` and `scripts`: no AI attribution, no `console.log` or `debugger` outside the scripts, no TODO lists, no `any`, no `eslint-disable` or `@ts-` suppressions, no `.only`.
- Not run: `pnpm ai:smoke` (no API key), any real upload, tagging or background removal against live services.

### Migration state

No schema change in this phase: `pnpm db:generate` reports nothing to migrate. `drizzle/20261102094305_init` is applied to the local Docker `wardrobe` and `wardrobe_e2e` databases. Neon does not exist yet.

### Deploy state

Not deployed. No Vercel project exists yet. `vercel.json` now declares the daily cron, so `CRON_SECRET` must be set in the dashboard before the first production deploy.

### Open risks

- The browser image pipeline is unit-tested only at the helper level. `createImageBitmap` orientation before resize, the canvas encode and HEIC through `heic-to` have not run on a real photo or an iPhone.
- The tagging schema, prompt caching and the batch flow are tested only against the fake Anthropic client. Schema acceptance (no "schema too complex" 400), cache reads and real costs are unknown until `ai:smoke` and the first live run.
- The client token request copies the `handleUpload` event shape (`blob.generate-client-token`) instead of using `upload()`. An `@vercel/blob` update that changes that protocol would break uploads; `src/lib/images/blob-upload-client.ts` is the one place to change.
- With Partial Prefetching, any request-time value read before a request API in a Suspense child logs a prerender error at runtime only; the build does not catch it. Pages must call `verifySession()` (which now waits for `connection()`) before anything else (D-078).
- Background removal depends on IMG.LY's CDN serving the 1.7.0 files, downloads about 53 MB on first use (worse on a phone's data plan), and the small model may leave artifacts on real photos (the spike used one synthetic image). The AGPL obligations apply as soon as anyone but the owner uses the app (README, Licences). Turbopack adds about 25 MB of unused onnxruntime files to the deployment.
- Starting a run with four parallel tagging calls can write the prompt cache up to four times (well under a cent per run).
- `pollTaggingBatches` returns the first failing batch as an error, so the counts from the successful ones are not shown, although they are saved.
- An item Claude refuses cannot be confirmed by hand (D-066, owner question).
- The forged-action e2e test still posts to `/wardrobe`, which renders no items until Phase 4.

### Live checks pending

None of these have been run; they need the cloud connection.

- `pnpm ai:smoke` (about $0.002): schema accepted, base64 and URL sources both work, the second call reads the cache, estimated against measured cost.
- First real upload: the client token, the direct `put()`, register, and a check that the Blob public URL host passes the `head()` validation in `/api/items/register`.
- Tagging cost per item measured against the estimate ($0.00078 first, $0.00055 after; about $0.055 per 100 items).
- Batch path: the synchronous dry run, `batches.create`, polling from the review page and from the cron with `CRON_SECRET`, exactly-once processing and the logged batch cost.
- Phone over HTTPS: camera, photo picker, HEIC from the Files app, the upload queue at phone width, and background removal (download prompt, time, result) on a real garment photo.
- Blob operations: the usage page's estimate against the Vercel dashboard after the first uploads.
- Earlier pending checks still stand: Neon migrate and seed, login and the rate limit on Vercel, relocation timing and cost, ZIP export, Open-Meteo caching.

### Next steps

1. Close wardrobe-6rd at the Phase 3 commit.
2. Phase 4 is wardrobe-a27: browse, stats and export. Phases 5 and 6 follow as wardrobe-evp and wardrobe-g4t.
3. A Next.js security release is expected on 2026-11-03. When it is out, bump `next`, `eslint-config-next` and `@next/env` together.

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
