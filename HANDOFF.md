# Handoff

Newest entry first. Each entry records the state at the end of a working session. Task tracking lives in Beads (`bd ready`, `bd show <id>`); the reasons behind choices are in [DECISIONS.md](DECISIONS.md).

## 2026-11-04 — Next.js 16.4.5, GitHub remote, production preparation

### State

- The Codex review fixes are committed as `960161c` (entry below).
- `next`, `eslint-config-next` and `@next/env` are bumped from 16.4.3 to the 16.4.5 security release (wardrobe-9ri, D-239). The lockfile changes only those packages and Next's own `@next/*` binaries; no app code changed.
- GitHub: the remote `origin` is https://github.com/muylolito1999/AIguardaroba.git, a **public** repository.
  - At 02:28 `main` was pushed with `960161c` on top, tracking set. The repo was empty before, and its default branch is now `main`.
  - The commit with this entry is pushed after it.
  - Everything in the history is public now, including the commit author email.
  - The history was checked for secrets before the push: `.env.example` is the only env file ever committed, and the only database URLs are test placeholders.
- Production preparation:
  - README "Connecting the cloud" now names the repository. It warns that once the Vercel project is connected to it, every push to `main` deploys to production without running migrations.
  - `ANTHROPIC_API_KEY` is described with Vercel's current "Secret" type, formerly "Sensitive".
  - Vercel supports Node 26.x and uses it as the default (docs read today), so `engines.node: 26.x` holds.
- An Anthropic API key that the owner pasted into the chat was not used, stored, written to any file or printed. Because it was exposed in plain text, the owner should revoke it and set a new one in Vercel themselves (see Production checklist).
- Not deployed. No Vercel project is linked from this machine (no `.vercel` folder), and the Vercel CLI is not installed here.

### Decisions

- D-239: Next.js 16.4.5, the security release D-007 waited for. Refines D-007.

### Checks run

All times local (CET, UTC+1), 2026-11-04, on the tree with the bump.

- 02:19: `pnpm add next@16.4.5` and `pnpm add -D eslint-config-next@16.4.5 @next/env@16.4.5`. `pnpm ls` shows all three at 16.4.5, and the lockfile has no 16.4.3 left.
- Gate with no `.env.local` (`scratchpad/gate-mine.ps1`), before the docs of this entry:
  - `pnpm typecheck` 02:20:44 to 02:20:59.
  - `pnpm lint` to 02:21:13.
  - `pnpm test` to 02:22:32: 162 files passed, 6 skipped; 2,554 tests passed, 8 skipped.
  - `pnpm build` to 02:23:01, "Next.js 16.4.5 (Turbopack)".
  - All four passed; the file was back afterwards.
- 02:23:01 to 02:25:28 `pnpm test:e2e`, headed, every app variable unset in the shell: 77 passed, 1 skipped (the smoke spec, "needs BLOB_READ_WRITE_TOKEN in the shell", read from the HTML report).
- Freshness re-check for D-180, D-183 and D-184 in a visible browser (`scratchpad/lead-cx/run-r4.ps1`), against `next start -p 3100` on the 16.4.5 build with every app variable blank:
  - Seeded into `wardrobe_e2e` at 02:26:07 to 02:26:11: the 300 demo items and one complete `reloc-v4` analysis, through the real relocation code with the scratch realistic fake for Claude (`scratchpad/vcheck5/reset.ps1 -Reseed`; no network).
  - `scratchpad/phase5-r4-visual/r4.mjs`, 02:26:13 to 02:27:35: 38 of 39 passed, with no console or page errors. Each race below was reproduced (reads and saves held over the network) and resolved as on 16.4.3:
    - dup: an extra added while Back's read was held shows once; the tab, status and group count it once; the page read once more.
    - shop: Bought pressed while the Shopping link's read was held stays shown, "5 still to buy", and the page read once more (D-183).
    - print and decision: a tick or Donate that answered after the print page's read made the page read again and print the change (D-184).
    - hidden: a tick with the print page kept hidden read neither page, and Forward read the print page once.
    - axe and sideways scroll were clean on the Packing tab, the print page and `/shopping`, at 1440 light and 390 dark.
  - The one failure, "climate rows unchanged by the check", compares against a snapshot file from 2026-11-03. The rows differ only in `id`, `created_at` and `updated_at`: the e2e global setup re-created them at 02:23 to 02:24, before the check started. All values are the same.
  - Clean-up: the server stopped by PID; both junctions removed as links; the demo items, the analysis, its shopping rows and `ai_calls`, and the `login_attempts` rows deleted. `wardrobe_e2e` then had 0 items and analyses.
- 02:28:52: `git ls-remote origin main` and the GitHub API both show `960161c` on `main`, and the repository reports `PUBLIC`, not empty.
- Final gate with no `.env.local`, on the tree as committed except this bullet (the docs of this entry, D-239 and the README edits included):
  - `pnpm typecheck` 02:30:06 to 02:30:12.
  - `pnpm lint` to 02:30:26.
  - `pnpm test` to 02:31:40: 162 files passed, 6 skipped; 2,554 tests passed, 8 skipped.
  - `pnpm build` to 02:31:53 (Next.js 16.4.5).
  - All four passed; the file was back and the aside folder empty afterwards.

### Migration and deploy state

- No new migration in this entry.
- Neon still needs `20261102210917_archived-from` and `20261104003955_item-deletion` before the first deploy of this `main` (wardrobe-c8x).
- Not deployed.

### Production checklist (owner, in this order)

1. Revoke the API key pasted into the chat (Claude Console, API keys) and create a new one. Never paste keys into chats, issues or commits.
2. `npm i -g vercel`, `vercel login`, `vercel link`: a new project, Function region fra1.
3. Neon: `vercel integration add neon`, region aws-eu-central-1, preview branching off.
4. Blob: `vercel blob create-store wardrobe --access public --region fra1 --yes`.
5. Vercel dashboard, Environment Variables:
   - `ANTHROPIC_API_KEY`: the new key, type Secret.
   - `APP_PASSWORD_HASH` and `SESSION_SECRET`: from `pnpm hash-password --with-secret`.
   - `CRON_SECRET`: a random value of at least 16 characters.
   - `ENABLE_EXPERIMENTAL_COREPACK=1`.
   - Optional: `MONTHLY_AI_BUDGET_USD` and `AI_CREDIT_USD`.
   - Leave unset: `OPEN_METEO_BASE_URL`, `E2E_TAG` and `FEATURE_SHOPPING_AI` (stays off until wardrobe-0j7).
6. `vercel env pull .env.local`, then `pnpm env:check`. If the Secret key is not written for Development, add it to `.env.local` by hand; the file is gitignored.
7. `pnpm db:migrate` (3 migrations), then `pnpm db:seed`, both against Neon (wardrobe-c8x).
8. Connect the Git integration only after steps 5 to 7, because connecting it deploys `main` at once. Or keep it unconnected and ask for `vercel --prod`.
9. After the first deploy, run the live checks:
   - `pnpm ai:smoke` (about $0.001);
   - wardrobe-aea: upload, Delete, the cleanup cron;
   - wardrobe-r67, wardrobe-izw and wardrobe-0j7 (paid; each needs the owner's approval);
   - wardrobe-5u9 and wardrobe-56n.
   - The first build log should show pnpm 11, Node 26 and Next.js 16.4.5.

### Next steps

1. The owner works through the Production checklist; deploying waits for the owner's request.
2. Then the live checks: wardrobe-c8x, wardrobe-aea, wardrobe-izw, wardrobe-r67, wardrobe-0j7, wardrobe-5u9 and wardrobe-56n.
3. Open follow-ups: wardrobe-z4n, wardrobe-1a5, wardrobe-2v1, wardrobe-1s2, wardrobe-yog, wardrobe-e1r, wardrobe-2n6, wardrobe-9hc, wardrobe-p11 and wardrobe-x0r.

## 2026-11-04 — Codex review fixes (item deletion, wear-log transfer) and their review

### State

An adversarial Codex review of the whole branch (at `b32082d`) reported two findings, and the owner asked for both to be fixed:

- **A** (high): deleting an item removed its Blob files before the transaction that deletes its rows. If that transaction failed, or the function stopped in between, the item stayed visible with dead photo URLs, and nothing recorded what to clean up.
- **B** (medium): two Saves of different suggestions with shared items could both move the same wear logs, so the second outfit took the first one's wear history.

Two implementation runs fixed them in separate files. This integration session then:

- joined the two runs and made the cross-file changes they asked for;
- resolved the decision-number clash;
- wrote the docs;
- ran the checks below.

A review of the integrated fixes then confirmed two more findings, both rated low (see Review), and a second session fixed them (D-237, D-238), regenerated the migration as one, and ran the checks again.

The lead re-ran the checks on the final tree (below), filed the follow-ups in Beads and committed it.

What changed:

- Item deletion (D-234, refines D-111):
  - `deleteItem` does three things in one transaction: it locks the item, records each photo URL in the new `blob_cleanup` table, and deletes the item (its rows cascade as before).
  - The Blob files are deleted only after the commit, through `runBlobCleanup` (`src/server/services/blob-cleanup.ts`): this item's files first, then up to three items that earlier deletes left queued.
  - A Blob failure at that point is logged and stored on the queued rows. It no longer keeps the item, so the old "…so the item was kept" refusal is gone.
  - A missing token still fails with CONFIG before anything is deleted or queued.
  - `BlobStorage.del` counts a blob the store does not have as deleted.
  - Every Blob call of the cleanup has a deadline (D-237): the cleanup after a delete's commit may take 8 s in all, and a call of the cron 30 s, all ending 30 s before its 300 s limit. A store that answers 5xx or not at all now ends in a stored `last_error` and an answer: the page shows "Item deleted" after 8 s, and the cron answers 502.
  - The transaction also lists the item id in the new table `deleted_items`, and `registerUpload` refuses a listed id with "That item was deleted. Upload the photo again." (D-238), before reading anything and again after its insert, so a Retry on the add page cannot bring a deleted item back on photos queued for deletion.
  - Migration `drizzle/20261104003955_item-deletion` creates both tables. It replaced the first version, `20261103230912_blob-cleanup`, which was never deployed (see Migration and deploy state).
- Cleanup cron (D-235, refines D-069): `GET /api/cron/blob-cleanup` runs daily at 05:00 UTC (`vercel.json`) and handles up to 100 items per run.
  - The Bearer `CRON_SECRET` check moved into `src/app/api/cron/_lib/cron-route.ts`. `poll-batches` now uses it too, with its behaviour and tests unchanged.
  - Vercel's cron usage page (read 2026-11-04) allows 100 cron jobs per project on Hobby, each once a day, within ±59 minutes.
- Wear-log transfer (D-236, refines D-222 and D-196):
  - `saveSuggestedOutfit` locks the outfit's items `FOR UPDATE` in id order before `saveOutfit`. This is the same order `logWear` and `undoWear` use.
  - The logs are then read under those locks, and only logs that still match are moved: no outfit, the same item and the same day.
  - If fewer logs move than were read, the whole Save is refused with CONFLICT (`wear_changed`) and rolled back.

Integration, by item:

- Decision numbers: both runs proposed D-234.
  - Deletion keeps D-234 and its cron becomes D-235.
  - The wear-log transfer becomes D-236; its five citations in `outfit-suggestions.ts`, `outfit-suggestions.test.ts` and `outfit-suggestions.pg.test.ts` were renumbered.
- `test/boundaries.test.ts`: added `runBlobCleanup` to `SESSIONLESS_SERVICE_FUNCTIONS`, with its reason. It is a cron entry checked by `CRON_SECRET`, and `deleteItem` calls it after its own session check.
- `src/server/services/export.test.ts`: `blob_cleanup` is now one of the tables the export leaves out.
- `src/server/actions/items.test.ts`: the no-token test also expects `blob_cleanup` to stay empty.
- `src/proxy.test.ts`: `/api/cron/blob-cleanup` is listed as public; the matcher already covered it.
- `danger-zone.test.tsx`: the mocked refusal is now the CONFIG one, because `deleteItem` no longer answers "…so the item was kept".
- `src/server/actions/items.ts`: the doc comment describes the queue.
- `e2e/item-detail.spec.ts`: the no-token Delete test also checks that none of the item's photos was queued, and `e2e/README.md` says so.
- Docs:
  - DECISIONS: D-234 to D-236 under "Added in the Codex review of the branch". D-069, D-111, D-196 and D-222 are marked refined, and D-111's Delete sentences, its Why and D-222's mechanism sentence are corrected.
  - README:
    - the architecture line;
    - the `CRON_SECRET` row;
    - the two bookkeeping tables in Database, and in Exporting data;
    - the item page's Delete;
    - a new "Photo cleanup cron" section;
    - the demo data note;
    - Deploy: the migration, and `CRON_SECRET` and `BLOB_READ_WRITE_TOKEN` before the crons;
    - the opt-in Postgres tests;
    - the Hobby cron limits.

The implementation runs' own checks are in their reports to the lead:

- A's fault injection: a trigger that fails the delete transaction leaves the item, its 4 images and all 4 files, and Blob is never called. With HEAD's `item-lifecycle.ts` the 6 new delete tests failed, and with HEAD's `blob.ts` the 3 not-found tests failed.
- B's real-Postgres reproduction: with HEAD's code two outfits each held some of the day's logs in round 0. Taking the locks in descending order, or after `saveOutfit`, deadlocked (40P01).
- Each run put the fixed files back and checked them with `cmp`.

Statements in the entries below that are no longer true:

- Phase 4, Open risks: "Delete removes blobs first". Since D-234 the rows go first in one transaction and the files are queued, then deleted after the commit. The success path has now also run against a local fake Blob API (below), though still not against a real store.
- D-116 says "Delete and the photo ZIP do not work on demo items". Without a token that is still true (CONFIG). With a token, Delete now deletes a demo item and queues its shared relative path `/icons/icon-192.png`; what a real store answers for that path is untested. README still says to remove demo items with `--clean`.
- D-069: "It is the only session-free service entry". Corrected in D-069; `runBlobCleanup` is the second.

### Decisions

New, under "Added in the Codex review of the branch":

- D-234: deleting an item queues its photos in the same transaction, and Blob deletes them after the commit. Refines D-111.
- D-235: a second daily cron drains the photo cleanup queue. Refines D-069.
- D-236: saving a suggestion locks its items for update first, and moves the day's wear only as it was read. Refines D-222 and D-196.

D-069, D-111, D-196 and D-222 are marked refined. D-111's Delete sentences, its Why and D-222's mechanism sentence ("whose item locks wait for a wear being logged") are corrected.

New, under "Added in the review of the Codex fixes":

- D-237: the photo cleanup's Blob calls have a deadline. Refines D-234 and D-235.
- D-238: deleted item ids are kept, and a register for one is refused. Refines D-234 and D-074.

D-074, D-234 and D-235 are marked refined. D-234 now names the new migration and says that its first version had no deadline.

### Review

A skeptical review of the integrated tree confirmed two findings; both verifiers rated them low. The second session fixed both.

- **cx-1, a Blob outage after the commit.** `runBlobCleanup` called `storage.del` with no deadline. On a 5xx or a network error, the SDK retries ten times with doubling waits, about 17 minutes or more. The delete had committed, but the action did not answer before the platform's limit. The dialog then said "Could not reach the server" for an item already gone, and `last_error` was never stored. One failing call also used up the cron's run.
  - Fix:
    - `src/lib/images/blob.ts`: `del(urls, { timeoutMs })` aborts one `AbortController`, with no reason, and races the SDK call against a timer. `AbortSignal.timeout()` would not stop the SDK: it retries a TimeoutError and stops only for an AbortError.
    - `src/server/services/blob-cleanup.ts`: a required `deadlineAt`. Each call gets at most 30 s or the time left, and no item starts with less than 1 s left.
    - `item-lifecycle.ts`: an 8 s budget after the commit (`cleanupBudgetMs` in tests).
    - The cron route: its start plus 300 s minus 30 s.
    - The danger-zone comment no longer claims a rejected call left the item untouched.
  - New tests:
    - `blob.test.ts`: 3 tests.
    - `blob.sdk.test.ts`: the real SDK against a 127.0.0.1 stub that answers 503 or never answers.
    - `blob-cleanup.test.ts`: 4 tests.
    - `item-lifecycle.test.ts`: 2 tests.
    - The cron route test: the 30 s margin.
- **cx-2, a register retried after a delete.** The add page's Retry re-sends the same item id and upload. After a register whose answer was lost, a delete from another tab while Blob failed, then Retry, the item came back on an original still queued in `blob_cleanup`, and the next cleanup run deleted the live item's only full-size photo.
  - Fix: `deleted_items` (in `schema.ts` and the migration) is filled in `deleteItem`'s transaction. `registerUpload` refuses a listed id twice: right after its "the item exists" check, and inside the insert transaction after the `items` insert. Only a read after the insert sees a delete that commits while the insert waits on the primary key.
  - New tests:
    - `register-upload.test.ts`: 2 tests.
    - The opt-in `register-upload.pg.test.ts`.
    - Tombstone assertions in `item-lifecycle.test.ts`, `src/server/actions/items.test.ts` and `e2e/item-detail.spec.ts`.
- **Seen failing without the fix** (`scratchpad/cx-fix/revert-checks.sh`, 01:44:48 to 01:47:19). Each case put the pre-fix file (from `scratchpad/cx-fix-orig/`) or a variant in place, ran the tests, and put the fixed file back, checked with `cmp`: identical every time.
  - `blob.ts` before the fix: 5 failed, both `blob.sdk.test.ts` cases among them (still waiting at 20 s).
  - `blob.ts` aborting with a TimeoutError reason: 3 failed, both real-SDK cases among them.
  - `blob.ts` without the race: 2 failed.
  - `blob-cleanup.ts` before the fix: 7 failed.
  - `item-lifecycle.ts` before the fix: 10 failed, the two register tests among them.
  - `item-lifecycle.ts` ignoring `cleanupBudgetMs`: 1 failed.
  - `register-upload.ts` before the fix: 3 failed, the opt-in Postgres test among them.
  - `register-upload.ts` without the early check: 1 failed.
  - `register-upload.ts` with the check before the insert: PGlite passed, but the opt-in Postgres test failed. Only real Postgres shows the order.
  - The cron route before the fix: 3 failed.
  - The cron route with no margin: 1 failed.
- **Not changed**:
  - A connection that drops after the commit still shows "Could not reach the server" for a deleted item, as at HEAD. Proposed copy for the owner: "Could not confirm the delete. Reload the page to see whether the item is gone." It is not shipped.
  - The other Blob calls (register `head`/`put`, the cut-out, the photo ZIP, `deleteBlobsQuietly`) still have no deadline.
  - The optional guard that leaves out queued URLs an image row still references was not added; the tombstone makes it unneeded for this path.

### Checks run

All times local (CET, UTC+1), 2026-11-04.

#### Final checks by the lead (the committed tree)

- Read the diff of `item-lifecycle.ts`, `blob.ts`, `blob-cleanup.ts`, `register-upload.ts`, `outfit-suggestions.ts`, the cron routes, `schema.ts`, the migration SQL and `vercel.json`.
- 02:10, Docker: `wardrobe` and `wardrobe_e2e` both list the three migrations, with `blob_cleanup` and `deleted_items` empty. The only databases are postgres, wardrobe and wardrobe_e2e.
- Gate with no `.env.local` (`scratchpad/gate-mine.ps1`, the file moved aside and put back in `finally`), on the tree before this bullet:
  - `pnpm typecheck` 02:11:27 to 02:11:33.
  - `pnpm lint` to 02:11:46.
  - `pnpm test` to 02:13:01: 162 files passed, 6 skipped; 2,554 tests passed, 8 skipped.
  - `pnpm build` to 02:13:13; the route list includes `ƒ /api/cron/blob-cleanup`.
  - All four passed. The file was back, and the aside folder empty, afterwards.
- 02:13:52 to 02:16:18 `pnpm test:e2e`, headed, with every app variable unset in the shell: 77 passed, 1 skipped. The skip is the smoke spec, "needs BLOB_READ_WRITE_TOKEN in the shell", read from the HTML report.
- Visible-browser check, headed Chromium. The same `check.cjs`, fake Blob API and server launcher as above, copied to `scratchpad/lead-cx/` with their own screenshot folder, and a new random `CRON_SECRET` that was never printed.
  - Run 02:17:51 to 02:18:51: 16 of 17 passed, with the same results as the 02:01 run:
    - Delete with the store silent: "Item deleted" after 8,098 ms.
    - The refused Retry.
    - Delete with the store answering 503 at 390 px dark: 8,138 ms, 3 SDK attempts and then none.
    - The cron: 401, then 502 after 30,052 ms, then 200 with 6 deleted.
    - No browser request left the machine.
  - The one failure is again axe `aria-hidden-focus` on the add page's error toast (wardrobe-1s2).
  - Screenshots looked at: "Deleting…" in the dialog, the refused Retry with its toast, and "Item deleted" on the empty wardrobe at 390 px dark.
  - Clean-up: the listeners on 3100 and 3924 stopped by PID, the junction removed as a link, and the check's 2 `deleted_items` rows deleted. `wardrobe_e2e` then had 0 items, images, queue rows and tombstones.

#### Review fixes (the tree before the lead's checks)

- 01:35:13 to 01:35:25, `blob.test.ts` and `blob.sdk.test.ts`: 20 passed.
- 01:39:54 to 01:39:55: removed `drizzle/20261103230912_blob-cleanup`, then `pnpm db:generate --name item-deletion` wrote `drizzle/20261104003955_item-deletion`.
  - Its `blob_cleanup` SQL is the same as before, plus `deleted_items`.
  - Its snapshot follows `20261102210917_archived-from`.
- 01:40:19 to 01:40:30, the 9 touched unit test files: 175 passed. The files: `blob.test.ts`, `blob.sdk.test.ts`, `blob-cleanup.test.ts`, `item-lifecycle.test.ts`, `register-upload.test.ts`, the cron route test, `export.test.ts`, `src/server/actions/items.test.ts` and `test/boundaries.test.ts`.
- 01:40:37 to 01:40:48 `pnpm typecheck`, then to 01:41:01 `pnpm lint`: both passed.
- Scratch database `wardrobe_cx_fix`:
  - 01:42:51 to 01:42:54: created, migrated (3 migrations, the new one last) and seeded.
  - 01:43:18 to 01:43:22: `register-upload.pg.test.ts` and `item-lifecycle.pg.test.ts`, 3 passed.
  - Afterwards: 0 rows in `items`, `item_images`, `blob_cleanup` and `deleted_items`, and no trigger left.
- 01:44:48 to 01:47:19: the revert checks under Review.
- 01:51:52 to 01:51:53, Docker `wardrobe` and `wardrobe_e2e` brought in line (see Migration and deploy state).
- Docker `wardrobe`, with both database URLs set in the shell for these commands only:
  - 01:52:02 `pnpm db:generate`: "No schema changes, nothing to migrate".
  - 01:52:04 `pnpm db:migrate`: applied `20261104003955_item-deletion`.
  - 01:52:05 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept.
- 01:52:43 to 01:55:13 `pnpm test:e2e`, headed, with `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `E2E_TAG`, `FEATURE_SHOPPING_AI` and `OPEN_METEO_BASE_URL` unset: 77 passed and 1 skipped.
  - The skipped test is the smoke spec, "needs BLOB_READ_WRITE_TOKEN in the shell" (read from the HTML report).
  - The global setup ran the new migration on `wardrobe_e2e`.
  - The no-token Delete test passed with its new `deleted_items` assertion.
- Visible-browser check, headed Chromium, `scratchpad/cx-fix-visual/check.cjs`, against `next start -p 3100` on the e2e run's build. The server ran with:
  - a fake Blob token;
  - `VERCEL_BLOB_API_URL` at a local fake Blob API (`fake-blob.cjs`, 127.0.0.1:3924, which answers ok, 503 `service_unavailable` or never);
  - a random `CRON_SECRET` made for the check.
  - The browser's own Blob upload was answered by the script, and every other request off localhost would have been stopped and counted: none was.
  - Fake store PID 5084 and server PID 15500, started at 02:01:06. The run went from 02:01:18 to 02:02:18: 16 of 17 checks passed.
  - `/add` at 1440 px light: one photo uploaded, and its register request aborted, as an answer lost after the server committed. The item that register would have made was inserted under the same id.
  - Its item page in a second tab, with the store never answering:
    - Delete showed "Deleting…" at 2 s, then "Item deleted" and `/wardrobe` after 8,136 ms.
    - The item was gone, its id listed in `deleted_items`, and its 3 files queued with `attempts` 1 and `last_error` "UPSTREAM: The photo store is not responding. Try again in a moment. (Vercel Blob did not answer within 7997 ms)".
  - Back on `/add`, Retry: "Failed: That item was deleted. Upload the photo again." with a "Check your input" toast.
    - No item or image row came back, and the 3 files stayed queued.
    - The server made no Blob API call for it.
  - 390 px dark, another item, with the store answering 503:
    - "Item deleted" after 8,144 ms, with no sideways scroll.
    - The SDK tried 3 times (attempts 0, 1 and 2), then stopped: no further request 6 s later.
    - Its 3 files were queued with the timeout error.
  - The cron:
    - 401 without a secret.
    - With the store never answering: 502 UPSTREAM after 30,052 ms, `pending` 6. The first item's files got `attempts` 2 and "within 30000 ms".
    - With the store working: 200 `{ deleted: 6, pending: 0, error: null }`, and both ids stayed in `deleted_items`.
  - The one failure: axe `aria-hidden-focus` on `/add`. `probe.cjs` (02:02:49 to 02:03:02) placed it: it is the error toast (`data-slot="toast"`, `aria-hidden="true"` with `tabindex="0"`). It shows the same way for a plain network error, which this work does not touch, and persists 4 s later.
  - The only console errors were the aborted register and the refused register's 400, both expected.
  - Screenshots in `scratchpad/cx-fix-shots/`, all looked at: 01 (the lost register with Retry), 02-* (the item page, "Deleting…", the wardrobe with "Item deleted"), 03 (the refused Retry), 04-390-dark-* (the same Delete on a phone, dark), 10 and 11 (the probes).
  - Clean-up:
    - 02:03:43: the server and the fake store stopped by PID with their process trees. Ports 3000, 3100, 3901, 3923 and 3924 were free at 02:03:46.
    - The junction was removed with `rmdir`, and the check's secret file was deleted.
    - 02:03:59 to 02:04:00: deleted the check's 2 `deleted_items` rows and 75 `login_attempts` rows from `wardrobe_e2e`.
    - Both `wardrobe` and `wardrobe_e2e` then held only `climate_profiles` (2) and `app_settings` (1).
- 02:04:06 to 02:04:11, all six opt-in Postgres files on `wardrobe_cx_fix`: 6 files and 8 tests passed. Afterwards only `climate_profiles` and `app_settings` had rows. Dropped at 02:04:18; left: postgres, template0, template1, wardrobe and wardrobe_e2e.
- Final gate with no `.env.local`, on the final tree with every change above, these docs included except this bullet (`scratchpad/cx-fix/gate.sh`). The file was moved to `scratchpad/envlocal-aside-cx2/`, created empty, and put back by a trap:
  - Moved at 02:06:15.
  - `pnpm typecheck` to 02:06:21.
  - `pnpm lint` to 02:06:34.
  - `pnpm test` to 02:07:47: 162 files passed, 6 skipped; 2,554 tests passed, 8 skipped. The skipped ones are the six opt-in Postgres files.
  - `pnpm build` to 02:07:59. The route list includes `ƒ /api/cron/blob-cleanup` and `ƒ /api/cron/poll-batches`.
  - Restored at 02:07:59, with the aside folder empty again. All four passed.
- 02:08:06 to 02:08:11, grep of `.next/static` (59 JS files, `scratchpad/cx-fix/grep-static.sh`). It looked for the integration's list plus `deleted_items`, "did not answer within", "That item was deleted", `item_deleted` and `CRON_MARGIN_MS`. None of them was found, except two names in one chunk, both `@vercel/blob`'s own lookups, as at 00:37:
  - `VERCEL_BLOB_API_URL`: the SDK's API-URL override.
  - `BLOB_READ_WRITE_TOKEN`: twice, its token lookup and its "No blob credentials found" message.
  - Controls found: "Wore this today" (3 files), "Delete item" (1), "including from photo storage" (1), "Not deleted" (3), "Could not reach the server" (13).
- 02:08:17: `git status` lists no `.env*` file, and ports 3000, 3100, 3901, 3923 and 3924 were free.

#### Integration (00:30 to 00:53, the tree before the review fixes)

- 00:30:32 to 00:30:39, targeted Vitest on 11 files: 254 passed. The files: `test/boundaries.test.ts`, `export.test.ts`, `src/server/actions/items.test.ts`, `src/proxy.test.ts`, `danger-zone.test.tsx`, `outfit-suggestions.test.ts`, `item-lifecycle.test.ts`, `blob-cleanup.test.ts`, `blob.test.ts` and both cron route tests.
- Gate with no `.env.local`, using `scratchpad/cx-int/gate.sh`. The file was moved to `scratchpad/envlocal-aside-cx/` (created empty) and put back by a trap.
  - Moved at 00:34:35.
  - `pnpm typecheck` to 00:34:42.
  - `pnpm lint` to 00:34:55.
  - `pnpm test` to 00:36:06: 161 files passed, 5 skipped; 2,540 tests passed, 7 skipped. The skipped ones are the five opt-in Postgres files.
  - `pnpm build` to 00:36:33. The route list includes `ƒ /api/cron/blob-cleanup` and `ƒ /api/cron/poll-batches`.
  - Restored at 00:36:33, with the aside folder empty again. All four passed.
- 00:37:04 to 00:37:09, grep of `.next/static` (59 JS files, `scratchpad/cx-int/grep-static.sh`). None of these were found:
  - the secret names, with `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `APP_PASSWORD_HASH`, `CRON_SECRET`, both `DATABASE_URL`s, `sk-ant` and `vercel_blob_rw` among them;
  - the system-prompt phrases and the prompt versions listed in the entry below;
  - the server-only strings `blob_cleanup`, "Missing or wrong cron secret", `wear_changed` and "The wear logged for this outfit changed".
  - `BLOB_READ_WRITE_TOKEN` appears in 1 file, twice, both `@vercel/blob`'s own: its lookup of the name and its "No blob credentials found" message. `VERCEL_BLOB_API_URL`, which this check added to the list, also appears in that file only as the client SDK's lookup of its API-URL override; it is not a secret.
  - Controls found: "Wore this today" (3 files), "Delete item" (1), "including from photo storage" (1), "Not deleted" (3).
- Docker `guardaroba-ai-db-1`, database `wardrobe`. Both database URLs were set in the shell for these commands only, so `.env.local` could not send them elsewhere.
  - 00:37:25 to 00:37:26 `pnpm db:generate`: "No schema changes, nothing to migrate", so the run's migration matches `schema.ts`.
  - 00:37:26 to 00:37:27 `pnpm db:migrate` applied `20261103230912_blob-cleanup`. `wardrobe` now has 3 migrations and `blob_cleanup` with the columns of the migration.
  - 00:37:27 to 00:37:28 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept.
- Opt-in Postgres tests on the scratch database `wardrobe_cx_int`:
  - 00:37:37: created, then migrated (3 migrations).
  - 00:37:38 to 00:37:40: seeded (Hamburg and Bologna inserted, app_settings created).
  - 00:37:49 to 00:37:53, `TEST_DATABASE_URL` at it, all five files: 5 files and 7 tests passed. The files are `rate-limit.pg.test.ts`, `relocation-apply.pg.test.ts`, `shopping-advice.pg.test.ts`, `item-lifecycle.pg.test.ts` and `outfit-suggestions.pg.test.ts`.
  - 00:38:04 to 00:38:07, the two new files again: 4 passed.
  - The database then held 0 items, images, queue rows, analyses, outfits, wear logs, shopping rows, `ai_calls` and login attempts.
  - Dropped at 00:38:07. Left: postgres, template0, template1, wardrobe and wardrobe_e2e.
- 00:38:17 to 00:40:44 `pnpm test:e2e`, headed, with `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `E2E_TAG`, `FEATURE_SHOPPING_AI` and `OPEN_METEO_BASE_URL` unset in the shell.
  - 77 passed, 1 skipped, none failed. The skipped test is the smoke spec, with the reason "needs BLOB_READ_WRITE_TOKEN in the shell", read from the HTML report.
  - "Delete without a Blob token shows a configuration error and keeps the item" passed with the new queue assertion.
  - What e2e covers for these fixes: only the no-token Delete. No spec runs a successful Delete, because one needs a Blob token, and the smoke spec, the only one with a token, never presses Delete (its `afterAll` deletes blobs directly). No spec saves a suggestion after a wear (D-222/D-236) or calls a cron route.
- Visible-browser check: headed Chromium, `scratchpad/cx-visual/check.cjs`, against `next start -p 3100` on the e2e run's build.
  - Environment: the e2e server's, plus `OPEN_METEO_BASE_URL` at `e2e/open-meteo-stub.ts` on 3901 (`start.ts`).
  - Seeded into `wardrobe_e2e` at 00:45:36 to 00:45:38 by `seed.test.ts` (vitest with the repo's aliases, through a `node_modules` junction):
    - the 17-item outfit wardrobe ("CX visual …") and one complete suggestion for today in Bologna, as `today.spec.ts` does;
    - "CX visual delete local", whose three photos point at the app's icon;
    - "CX visual delete ok" and "CX visual delete fail", whose photos live on a local fake Blob API (127.0.0.1:3924, `fake-blob.cjs`).
  - Run 1, no Blob token. The stub (PID 3340) and the server (PID 39932) started at 00:45:57; the run went from 00:46:13 to 00:46:16 and passed 12 of 13 checks, with no console or page errors.
    - 1440 × 900 light, the item page's Delete: the dialog says "including from photo storage". Delete showed "Not deleted / The server is misconfigured. Check the server logs." and stayed on the item. The database was unchanged: the item, its 3 image rows and nothing in `blob_cleanup`. axe found no serious or critical violation.
    - 390 × 844 dark, `/today`: three cards. "Wore this today" on "Layered for drizzle" logged its 3 items with no outfit. Save moved exactly those 3 logs to the new outfit, and each item counted once. The outfit page read "Worn once, last on 4 Nov 2026"; its "Wore this today" answered "Already logged" and logged nothing. No sideways scroll.
    - The one failure: axe flagged `color-contrast` on that outfit page right after the press. Three probes (`probe.cjs` and `probe2.cjs`, 00:46:37 to 00:47:08) placed it:
      - The page was clean when opened, and clean right after a press with a single toast.
      - Repeating the run's path on the second card, the node was the earlier "Outfit saved" toast title fading behind the newer toast (foreground #1b1b1b on #171717), flagged right away and clean 2 s later.
      - The toasts are unchanged by this work; this is a transient animation state.
    - Server stopped by PID at 00:47:21.
  - Run 2, fake Blob. The fake store (PID 11744) and the server (PID 5296) started at 00:47:32. The server had a fake `BLOB_READ_WRITE_TOKEN` (store id `cxfakestore`), `VERCEL_BLOB_API_URL` at the fake (the SDK's own override, so nothing left the machine) and a random `CRON_SECRET` made for this check. The run went from 00:47:39 to 00:47:43 and passed 14 of 15 checks, with no console or page errors.
    - Delete succeeds: the item page showed its photo loaded from the fake store. Delete gave the toast "Item deleted" and `/wardrobe`. The item and its image rows are gone and `blob_cleanup` is empty. The fake received exactly one delete call, with the item's 3 URLs, a Bearer token and the store id.
    - Delete while the store fails (the fake answered 400 `bad_request`, which the SDK does not retry): the delete still succeeded (toast, `/wardrobe`). The item is gone, and its 3 files are queued with `attempts` 1 and `last_error` "UPSTREAM: The photo store is not responding. Try again in a moment. (Vercel Blob: fake store: failure forced by the check)".
    - The cron route: without a secret 401; with a wrong secret 401; `poll-batches` without a secret 401 (the shared check).
      - With the secret while the store still failed: 502 with `{ ok: false, error: UPSTREAM, data: { deleted: 0, pending: 3 } }`, and the rows at `attempts` 2.
      - With the store working: 200 with `{ ok: true, data: { deleted: 3, pending: 0, error: null } }` and the queue empty; the fake's call named exactly those 3 URLs.
      - A repeated run: 200, nothing deleted, no Blob call.
    - The one failure was the script's: it searched the page for "CX visual delete fail", which the "Item deleted" toast contains ("… and its photos are gone."). `probe3.cjs` (00:48:01, a fresh `/wardrobe`) found "18 items" (the 17 plus the local one) and no card for either deleted item. Screenshot 09 shows the same.
  - Screenshots in `scratchpad/cx-shots/`, all looked at:
    - 01, 02: the item page and the dialog's error, readable over the blurred page.
    - 03 to 06: the worn card, the saved card with "Open saved outfit" and both toasts, then the outfit page with "Worn once" and the "Already logged" toast.
    - 07: the item with the fake store's photo.
    - 08, 09: `/wardrobe` loading, then 18 items with the "Item deleted" toast.
    - 10 to 12: the probes.
  - Clean-up:
    - 00:48:08: the server, the fake store and the stub stopped by PID, each with its process tree. Ports 3000, 3100, 3901, 3923 and 3924 were free at 00:48:11.
    - 00:48:44 to 00:48:45: removed the check's 6 wear logs, 2 outfits, 1 analysis and 18 items, plus the 77 `login_attempts` rows (the e2e run's and the check's sign-ins).
    - `wardrobe` and `wardrobe_e2e` then had 0 rows in every table except `climate_profiles` (Hamburg the default, Bologna) and `app_settings` (Bologna the home city).
    - 00:48:52: the junction removed with `rmdir` (the link only; the project's `node_modules` is intact).
- Final gate with no `.env.local` on the final tree, after every change above including these docs except this bullet (`gate.sh`; the same aside folder, empty before and again after):
  - Moved at 00:51:29.
  - `pnpm typecheck` to 00:51:35.
  - `pnpm lint` to 00:51:48.
  - `pnpm test` to 00:53:01: 161 files passed, 5 skipped; 2,540 tests passed, 7 skipped.
  - `pnpm build` to 00:53:13.
  - Restored at 00:53:13. All four passed.
  - 00:53:13 to 00:53:18, the same grep of `.next/static` (59 JS files): the same results as at 00:37:04.
  - `git status` lists no `.env*` file. At 00:53:18 ports 3000, 3100, 3901, 3923 and 3924 were free.

### Migration and deploy state

This tree ships one new migration, `drizzle/20261104003955_item-deletion`, which creates `blob_cleanup` and `deleted_items`. It replaces `20261103230912_blob-cleanup`, which only the two Docker databases had:

- Docker `wardrobe` and `wardrobe_e2e` were brought in line at 01:51:52, without touching any other data. In one transaction per database:
  - a check that `blob_cleanup` held no rows (it held none);
  - `drop table blob_cleanup`;
  - `delete from drizzle.__drizzle_migrations where name = '20261103230912_blob-cleanup'`.
- Then the new migration was applied: `wardrobe` with `pnpm db:migrate` at 01:52:04, `wardrobe_e2e` by the e2e global setup at 01:52.
- Both now list `20261102094305_init`, `20261102210917_archived-from` and `20261104003955_item-deletion`. The migrator matches migrations by name, so the old row had to go.
- Neon has neither this migration nor the Phase 4 one. Both must reach Neon before the next deploy (wardrobe-c8x). Without this one, Delete on the item page fails, the cleanup cron answers 500, and a register fails.
- `CRON_SECRET` and `BLOB_READ_WRITE_TOKEN` must be set in Vercel before the deploy that adds the second cron (`vercel.json`).
- Not deployed.

### Open risks

- When Blob fails after the commit, a deleted item's photos stay in the public store, reachable by their (unguessable) URLs, until a cleanup run deletes them: at the next delete or the daily cron. A store outage longer than that keeps them longer.
- During a Blob outage, Delete takes 8 s before it answers "Item deleted", and a cron run that meets the outage answers 502 after 30 s. The deadline has run only against local stubs and the real SDK, not against a real store.
- A connection that drops after the commit still shows "Could not reach the server" for a deleted item (D-237). The proposed copy is under Review; it is the owner's call.
- Blob calls outside the cleanup (register `head` and `put`, the cut-out, the photo ZIP, `deleteBlobsQuietly`) have no deadline; during an outage they wait for the SDK's retries until the function's limit, as before.
- `deleted_items` keeps one row per deleted item for good. An id listed there can never be registered again, which a browser-made random uuid never needs.
- The "Item deleted" toast still says "… and its photos are gone." even when the files are only queued (seen again in this check). This wording is the owner's call; it was not changed.
- A wrong or revoked token is found only after the commit. The item is deleted, its files wait with a CONFIG `last_error`, and the cron answers 500 every day until the token is fixed. No page shows the queue; the only signals are the cron's answer, the server log and `select … from blob_cleanup`.
- Other Blob deletes stay best-effort and are logged. A failed delete of a replaced cut-out after its commit (`nobg.ts`) leaves an orphan file, never a dead URL. If a COMMIT reply were lost after the server committed, the clean-up of a failed register or cut-out could delete a referenced file; that is rare and was not changed.
- With a token, Delete on a demo item deletes it and asks the store to delete the shared path `/icons/icon-192.png`; what a real store answers is untested.
- Delete's success path and the cron have run against PGlite with a fake store, against Docker Postgres in the opt-in test, and against a local fake of the Blob API in the browser. They have never run against a real store or on Vercel.
- D-236: of two Saves with shared items, the one that waits is saved without the wear, as D-222's rule says. The UPDATE's CONFLICT path can only be reached by a future code path that changes those logs without the item locks. Any new code that locks several items must take them in id order.
- axe flags a stacked toast while it fades (`color-contrast`, transient; seen in run 1). The toasts are not part of this change.
- axe flags the add page's error toast with `aria-hidden-focus` (`aria-hidden="true"` with `tabindex="0"`), for a network error as well as for the new refusal. The toasts are not part of this change.
- The risks in the entries below stand.

### Live checks pending

- A real Delete with a Blob token, after the migration on that database: the item's blobs are gone (`vercel blob list`, which costs advanced operations, or a `head` of each URL) and `blob_cleanup` is empty.
- On a deployment, a forced Blob failure drained by the cron. For example, queue a row for a file uploaded for the purpose, then run the cron (`vercel crons` or the 05:00 UTC run). The row and the file should be gone, the cron log should show 200 for `blob-cleanup`, and `poll-batches` should still answer as before.
- The live checks in the entries below (wardrobe-r67, wardrobe-0j7, wardrobe-5u9, wardrobe-izw, wardrobe-aea, wardrobe-56n).

### Next steps

1. Bump `next`, `eslint-config-next` and `@next/env` to the 16.4.5 security release (wardrobe-9ri).
2. Apply both pending migrations to Neon before the next deploy (wardrobe-c8x, updated for the second one): the Phase 4 one and `20261104003955_item-deletion`. Set `CRON_SECRET` and `BLOB_READ_WRITE_TOKEN` in Vercel before it.
3. The two live checks above, added to wardrobe-aea.
4. Follow-ups filed:
   - wardrobe-1a5: route the replaced cut-out's delete (`nobg.ts`) through the queue;
   - wardrobe-yog: a pending-cleanup count on the usage page;
   - wardrobe-2v1: the owner's call on the "Item deleted" toast wording when the files are only queued, and on the dialog's wording when the connection drops after the commit;
   - wardrobe-z4n: deadlines for the other Blob calls;
   - wardrobe-1s2: the toasts' axe flags (`aria-hidden-focus`, and `color-contrast` while a toast fades).
5. The earlier steps stand (wardrobe-56n, wardrobe-e1r, wardrobe-2n6, wardrobe-9hc, wardrobe-p11, wardrobe-x0r, wardrobe-izw, wardrobe-r67, wardrobe-0j7, wardrobe-5u9).

## 2026-11-03 — Owner decisions (D-093, D-134, D-218, D-219, D-225)

### State

The owner read the five decisions left open by Phase 6 and earlier, and the code behind them, and decided on 2026-11-03: D-218 confirmed with a correction (aria-current), D-219 confirmed in meaning with a wording requirement, D-225 confirmed with a wording requirement and a later footwear issue, D-093 confirmed with a correction (the form's starting values), and D-134 accepted as a compromise whose priority depends on the owner's phone. Three implementation runs made the changes on disjoint files (navigation, copy, the hand-tagging form); an integration session joined them, made the cross-file changes they asked for, wrote the docs and ran the checks below. A review of the joined tree confirmed one finding: the line explaining the estimated remaining budget promised that an older plan's gap added to the list later counts, which the code never did. A review fix session corrected the wording, without any logic change (D-233, under Review), and ran the checks again on the final tree.

The lead then checked the final tree independently: the gate with no `.env.local`, the bundle grep, Docker, the headed e2e suite, and a visible-browser check with its own script (see "Final checks by the lead"). The lead filed these Beads issues:

- wardrobe-e1r: footwear.
- wardrobe-2n6: purchase date and amount.
- wardrobe-56n: D-134 on the owner's phone.
- wardrobe-9hc: Keep from the edit form.
- wardrobe-x0r: a stray favicon request.

It also narrowed wardrobe-p11 to the Undo gap. This entry is committed, and wardrobe-any and wardrobe-7oq are closed with it.

What changed:

- Navigation (D-230, refines D-218): a marked link says `aria-current="page"` only when its own page is open, and `aria-current="true"` when the open page lies inside its section. The visible mark is unchanged and still depends on the pathname alone. `navItemCurrent` in `nav-items.ts`, used by the tab bar and both sidebar groups. On a phone the Wardrobe tab says "true" on `/today`, `/outfits/*`, `/stats` and item pages; on a desktop Today and Outfits are their own rows.
- Wording (D-231, refines D-219 and D-225; no logic change): the `/relocate` budget is "What you can still spend on new clothes from now on. Earlier purchases are not subtracted, so enter only what is left."; the plan summary reads "€150 to spend from 3 Nov 2026"; the `/shopping` budget box adds "purchases since then are not subtracted"; "What to buy next" shows "Estimated remaining budget: €N" with its source and one line on why it is an estimate ("…and only if it came from that plan or you added it by hand since.", D-233), and every outfit count reads "about N (new) outfits" or "likely none" under one note that the counts are estimates, not a measure of what a purchase is worth. The used-up blocker no longer invites a new plan "with a new budget"; it says "by the app's estimate" and "If you can still spend more, plan the move again and enter only what you have left." The prompt stays `shop-v2` (it already calls the counts "a strong signal rather than exact truth").
- "Fill in by hand" (D-232, refines D-093 and D-067): warmth 3, the three switches off and breathable unknown, when the item has no value, show "Default, not checked: Re-tag may change it." with a Keep toggle. Saved values still at their start and not kept are sent as `uncheckedDefaults`; the server accepts only those five names, each once, and only while the submitted value is the default, stores them, and leaves them out of `user_edited_fields`, so a later Re-tag may replace them. Values set, changed or kept stay protected as before.
- D-134: no code change.

Integration, by item:

- Decision numbers: each run had proposed D-230. Navigation keeps D-230, the copy run's citations became D-231 (11 in 7 files), the hand form's D-232 (15 in 10 files); `nav-items.ts` and two nav test names now cite D-230.
- `src/server/services/shopping-advice.ts`: the used-up blocker text above, asked for by the copy run (it did not own the file); `shopping-advice.test.ts` now also expects "by the app's estimate" and "enter only what you have left" and no "with a new budget".
- `advice-panel.tsx` and `budget-panel.tsx` had been written with CRLF line endings; converted to LF (`.gitattributes` sets `eol=lf`).
- e2e: `review.spec.ts`'s hand-tagging test now expects the five "Default, not checked" notes, presses Keep on Windproof, and checks in the database that Windproof is in `user_edited_fields` while the untouched warmth, waterproof, insulated and breathable are stored (3, off, off, unknown) but not in it. `today.spec.ts` has two new tests: at 390 px `/today` reached from Settings and from the wardrobe header marks Wardrobe "true" and only that link; at desktop width Today says "page" on `/today` with no primary row marked, Outfits "true" on `/outfits/new`, Wardrobe "true" on `/stats`. No existing e2e assertion checked `aria-current` or the changed strings. `e2e/README.md` describes the additions.
- Docs: DECISIONS D-093, D-134, D-218, D-219 and D-225 accepted by the owner with an "Owner, 2026-11-03" line each; D-230 to D-232 under "Added for the owner's decisions of 2026-11-03"; D-067, D-093, D-218, D-219 and D-225 marked refined, and the sentences of D-093 and D-219 that are no longer true corrected. README: the navigation paragraph, "Fill in by hand", the relocation budget field and plan summary, the shopping budget box, "What to buy next" (estimated counts and budget, the blocker) and the Phase 6 row of the features table.

Statements in the entries below that are no longer true:

- Phase 6, Open risks: "The Wardrobe tab is marked on `/today` and `/outfits` on a phone (D-218); the owner may prefer no marked tab there." The owner kept it (D-218, D-230). "The counts are a signal for the ranking, not shown as exact": until now the rows read "unlocks 12 outfits"; they read as estimates since D-231.
- Phase 6, Next steps item 1 (the owner's decisions on D-093, D-134, D-218, D-219, D-225; wardrobe-any, wardrobe-7oq): done.
- Phase 4 second review: D-134 "awaits the owner's acceptance". Accepted as a compromise.
- Phase 3 second review: D-093 "decided under the run scope, so the owner can veto it". Accepted, and refined by D-232.

### Decisions

D-093, D-134, D-218, D-219 and D-225 are accepted by the owner (D-134 as a compromise), each with the owner's reasons. New, under "Added for the owner's decisions of 2026-11-03": `aria-current` "page" only on the open page's own link, "true" inside its section (D-230, refines D-218); the plan's budget as what is still left to spend and the advice's figures as estimates (D-231, refines D-219 and D-225); values left at the hand-tagging form's start are not the owner's (D-232, refines D-093 and D-067). From the review, under "Added in the review of the owner's decisions": the estimate line counts by date only the rows added by hand (D-233, refines D-231; wording only, D-219's rule unchanged). The `aria-current` token was checked against the WAI-ARIA 1.2 definitions as MDN's `aria-current` page quotes them (`page`: the current page within a set of pages; `true`: the current item within a container or set of related elements).

### Review

The review of the joined tree reported one confirmed finding and one rejected; the review fix session re-checked the confirmed one against the code before changing it.

- **od-1** (low, confirmed): the line explaining the estimated remaining budget said a bought item counts "only if it came from that plan or was added to the list since". `adviceBudget` (D-219) places only rows without a plan id by the day they were added; a row with a plan id counts only when that id is the latest plan's. So a gap of an older plan, added to the list from that plan's `/relocate/[id]` page after the latest plan finished and then bought, is never subtracted, although the line said it counts. Re-checked in the code (`boughtUnderLatestPlan` in `shopping-advice.ts`; the Gaps tab and `addGapsToShoppingList` accept any complete plan) and in the browser (below).
  - Changed: `REMAINING_BUDGET_NOTE` in `src/components/shopping/advice-model.ts` now reads "It is an estimate: each bought item counts at its lowest estimated price, and only if it came from that plan or you added it by hand since." ("add an item by hand" is the list's own wording), and its comment says why. No logic change. The quotation in D-231, its Why line and README's "What to buy next" follow; D-233 records the choice. Counting such a row instead (any bought row added since the latest plan, whatever plan it came from) would change D-219's rule, which the owner confirmed as it stands, so it is left to the owner and to the purchase-date issue under Next steps.
  - Tests: `advice-panel.test.tsx` "shows the outfits per month, the budget, the estimate and the candidates before any ranking" expects the new sentence exactly. It failed with D-231's first wording, before the source change and again with the old `advice-model.ts` put back; the fixed file was restored and `cmp` found it identical. `shopping-advice.test.ts` (PGlite) "subtracts only what was bought under the latest plan, not under an older one" now also adds a bought gap of plan A created after plan B finished and expects the budget unchanged (€110 bought, €40 left), pinning the rule the sentence describes; it passes with and without the wording change, since the logic did not change.
- **od-2** (rejected, for the record): Claude's own reasons may still say "Unlocks 12 outfits", the `shop-v2` prompt's example. Not a defect: the prompt does not call the counts exact, every count the app renders reads as an estimate under one note, and D-231 and Next steps item 3 already leave `shop-v3` to the owner. Nothing changed.

### Checks run

All times local (CET, UTC+1), 2026-11-03. The three implementation runs' own checks (targeted Vitest, `tsc`, `eslint`, and their regression tests failing with the change reverted) are in their reports to the lead. The bullets up to the integration's last gate are the integration session's, on the tree before the review fix: they differ from the final tree only in `advice-model.ts`, `advice-panel.test.tsx`, `shopping-advice.test.ts` and the docs, and the 1440 advice check below expected D-231's first wording. The review fix session's checks, on the final tree, follow under "Review fix".

- 22:59:39 to 22:59:43 `pnpm exec vitest run src/server/services/shopping-advice.test.ts`: 22 passed. At 22:59:47 with HEAD's `shopping-advice.ts` in place: 1 failed ("names what blocks a run…": the blocker lacked "by the app's estimate"); the file was put back and `cmp` found it identical.
- Gate with no `.env.local` (moved to `scratchpad/envlocal-aside-od/`, created empty; put back by a trap; `scratchpad/od-docs/gate.sh`): moved 23:00:05; `pnpm typecheck` to 23:00:18, `pnpm lint` to 23:00:31, `pnpm test` to 23:01:46 (159 files passed, 3 skipped; 2,514 tests passed, 3 skipped), `pnpm build` to 23:02:08; restored 23:02:08. All passed.
- 23:02:22 to 23:02:26 grep of `.next/static` (59 JS files): no `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `APP_PASSWORD_HASH`, `CRON_SECRET`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `OPEN_METEO_BASE_URL`, `FEATURE_SHOPPING_AI`, `CLAUDE_OUTFIT_MODEL`, `CLAUDE_TAGGING_MODEL`, `CLAUDE_ANALYSIS_MODEL`, `MONTHLY_AI_BUDGET_USD`, `AI_CREDIT_USD`, `sk-ant`, `vercel_blob_rw` or the visual check's fake key; none of "practical personal stylist", "DRESSING FOR THE WEATHER", "Feels-like bands", "frugal shopping adviser", "THE UNLOCK COUNTS", "never recount or invent them", "one day can count more than once", "each piece suits the month on its own", "Monthly normals, January to December", "arrival month first", "strong signal rather than exact truth", nor `outfit-v1`, `outfit-v2`, `shop-v1`, `shop-v2`, `reloc-v4` or `tag-v1`. `BLOB_READ_WRITE_TOKEN` appears once, as `@vercel/blob`'s own lookup of the name. Controls found: "Estimated remaining budget", "Default, not checked", "likely none", "Earlier purchases are not subtracted", "purchases since then are not subtracted" (1 file each), "Wore this today" (3).
- Docker (`guardaroba-ai-db-1`, `wardrobe`): 23:02:35 `pnpm db:generate` "No schema changes"; 23:02:37 to 23:02:38 `pnpm db:migrate` applied nothing new; 23:02:39 `pnpm db:seed` (Hamburg updated, Bologna and app_settings kept).
- 23:02:48 to 23:05:17 `pnpm test:e2e`, headed, with `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `E2E_TAG`, `FEATURE_SHOPPING_AI` and `OPEN_METEO_BASE_URL` unset in the shell: 77 passed, 1 skipped (the smoke spec, "needs BLOB_READ_WRITE_TOKEN in the shell"), none failed.
- E2E revert check (`scratchpad/od-docs/e2e-revert.sh`): HEAD's 19 navigation and hand-form files (sources and their unit tests) put back, the same shell variables unset, a production build each time. 23:06:28 to 23:07:11: the hand-tagging test failed (5 notes expected, 0 found) and the phone navigation test failed (Wardrobe on `/today`: "true" expected, "page" received); the desktop test did not run, because the spec is serial. Run alone, to 23:07:52: it failed (Outfits on `/outfits/new`: "true" expected, "page" received). Each time all 19 files were put back and `cmp` found them identical.
- 23:08:02 to 23:10:36 `pnpm test:e2e` again on the restored tree (which also rebuilt `.next` from it), the same variables unset: 77 passed, 1 skipped (the smoke spec, same reason). `wardrobe_e2e` then held no app rows.
- Visible-browser check: headed Chromium, `scratchpad/od-visual/check.cjs`, against `next start -p 3100` on that build with the e2e server's environment, `OPEN_METEO_BASE_URL` at the e2e Open-Meteo stub on 3901, `FEATURE_SHOPPING_AI=true` and a fake key with `ANTHROPIC_BASE_URL` at a local fake Messages endpoint on 3923 (nothing left the machine; no real Claude call). Seeded into `wardrobe_e2e`: 300 demo items (23:11:00), and at 23:11:18 (`seed.ts`) an older plan A (€300, both gaps bought), the latest plan B (€150, a snapshot built by the real payload and chunk code, gaps: a shell, linen shorts bought for €25 under B, sandals), one list row still to buy, and two pending items. Run 23:11:24 to 23:12:04, the first and only run: 88 of 88 checks passed, no page or console errors. Screenshots `scratchpad/od-shots/` 01 to 28, all looked at.
  - 1440 × 900 light, sidebar marks (link=token per landmark): `/wardrobe` Wardrobe=page; `/wardrobe/[id]` Wardrobe=true; `/today` Today=page with nothing in the primary group, the same reached from Settings' "Get dressed" and from the sidebar after `/wardrobe`; `/outfits` Outfits=page; `/outfits/new` Outfits=true; `/stats` Wardrobe=true; `/relocate` Relocate=page; `/relocate/[id]` and its print page Relocate=true; `/settings` Settings=page; `/shopping` Shopping=page.
  - 390 × 844 dark (mobile emulation), tab bar marks: `/wardrobe` Wardrobe=page; `/wardrobe/[id]`, `/today` (direct, from the wardrobe header, from Settings: identical), `/outfits`, `/outfits/new`, `/stats` and a pending item's page Wardrobe=true; `/add/review` Add=true; `/relocate` Relocate=page; `/relocate/[id]` and print Relocate=true; `/settings` Settings=page; `/settings/usage` Settings=true; `/shopping` Shopping=page. Exactly one marked link each time.
  - `/relocate`: the budget field is described by "What you can still spend on new clothes from now on. Earlier purchases are not subtracted, so enter only what is left. Leave it empty for no budget." (its `aria-describedby`). Plan B's summary: "Purchase budget €150 to spend from 3 Nov 2026".
  - `/shopping` with the flag on: "Estimated remaining budget: €125" (plan B's €150 minus the €25 bought under it; plan A's €300 of purchases not subtracted), "Purchase budget €150 from your latest relocation plan, minus at least €25 for items bought under it.", the estimate line and the counts note; "Outfits your wardrobe makes now" read "about 97,940 outfits" and so on; the candidates' toggle "See the 3 candidates and their estimated outfit counts"; sandals "January: likely none … July: about 3,476 new outfits"; the budget box "purchases since then are not subtracted". "Rank 3 purchases" through the fake: one complete `shop-v2` row and one `ai_calls` row, the request carried €125, and the ranking read "estimated €125 left then" with four "Estimated new outfits per season" lists ("January: about 9,007 new outfits"). At 390 dark the same texts, and the ranking marked out of date, because the hand-tagged item had changed the wardrobe since (D-213).
  - "Fill in by hand" on `/add/review` (1440): five "Default, not checked" notes, five Keep toggles 44 px tall; Waterproof switched on removed its note; Keep on Insulated read "Default, kept: Re-tag keeps it."; Save stored the item as tagged with no Claude output, warmth 3, waterproof on, windproof and insulated off, breathable unknown, and `user_edited_fields` name, category, colors, color_hex, waterproof, insulated, seasons, formality, condition: not warmth_level, windproof or breathable.
  - "Fill in by hand" on a pending item's page (390 dark): five notes, Keep toggles 44 px, no sideways scroll; Keep on Warmth, Save: warmth 3 and the switches off stored, `user_edited_fields` with warmth_level and without waterproof, windproof, insulated and breathable.
  - No sideways scroll at 390 on `/wardrobe`, `/today`, `/relocate`, `/relocate/[id]`, `/shopping` and the item page with the form open. axe (WCAG 2.0 and 2.1 A and AA): no serious or critical violation on `/wardrobe`, `/today`, `/relocate`, `/relocate/[id]`, `/shopping` (advice and candidates open) and `/add/review` with the form open at 1440, and on `/wardrobe`, `/today`, `/relocate`, `/relocate/[id]`, `/shopping` and the item page with the form open at 390 dark.
  - Seen in the screenshots: the marked tab and rows look as before (the bar over Wardrobe on `/today`); the hints wrap cleanly at 390; the Keep toggle's pressed state matches the other pressed toggles in both themes. Full-page captures draw the sticky sidebar part way down the page, as before.
- Clean-up: the server and stubs stopped by PID (35716 and 39656, each with its process tree) at 23:12:49, ports 3000, 3100, 3901 and 3923 free at 23:12:51; 23:13:05 the check's analyses, shopping rows, `ai_calls` and two items deleted, `pnpm db:seed:demo --clean` removed 300; `wardrobe` and `wardrobe_e2e` then held no items, images, analyses, parts, packing rows, outfits, wear logs, shopping rows or `ai_calls`, with Hamburg the default profile and Bologna the home city; the `node_modules` junction removed with `rmdir` (link only; the project's `node_modules` intact).
- The integration's last gate with no `.env.local`, on its tree before the review fix (moved to `scratchpad/envlocal-aside-od/`, empty before and again after): moved 23:14:59; `pnpm typecheck` to 23:15:04, `pnpm lint` to 23:15:17, `pnpm test` to 23:16:30 (159 files passed, 3 skipped; 2,514 tests passed, 3 skipped), `pnpm build` to 23:16:43; restored 23:16:43. All passed. 23:16:50 to 23:16:53 grep of `.next/static` (59 JS files): none of the secret names, prompt phrases, versions or the fake key listed above; `BLOB_READ_WRITE_TOKEN` once as `@vercel/blob`'s lookup; "Estimated remaining budget" in 1 file. `git status` lists no `.env*` file. At 23:16:55 ports 3000, 3100, 3901 and 3923 were free.

Review fix (the review fix session, on the final tree):

- Regression test: 23:28:57 to 23:29:01 `pnpm exec vitest run src/components/shopping/advice-panel.test.tsx` with the new expectation and D-231's first wording still in `advice-model.ts`: 1 failed, 11 passed (the sentence not found). 23:29:08 to 23:29:12, after the change, with `src/server/services/shopping-advice.test.ts`: 2 files, 34 tests passed. 23:29:17 to 23:29:21 with the old `advice-model.ts` put back: the same test failed again; the fixed file was restored and `cmp` found it identical.
- Gate with no `.env.local` (moved to `scratchpad/envlocal-aside-od2/`, created empty; put back by a trap; `scratchpad/od-fix/gate.sh`): moved 23:30:38; `pnpm typecheck` to 23:30:46, `pnpm lint` to 23:31:02, `pnpm test` to 23:32:14 (159 files passed, 3 skipped; 2,514 tests passed, 3 skipped), `pnpm build` to 23:32:29; restored 23:32:29. All passed.
- 23:32:47 to 23:32:51 grep of `.next/static` (59 JS files; `scratchpad/od-fix/grep-static.sh`): none of the secret names, prompt phrases, versions or the fake key listed above. `BLOB_READ_WRITE_TOKEN` in 1 file, twice, both `@vercel/blob`'s own: its lookup of the name and its "No blob credentials found" message. "or you added it by hand since" in 1 file, "or was added to the list since" in none; "Estimated remaining budget", "Default, not checked" and "likely none" in 1 file each, "Wore this today" in 3.
- Docker (`guardaroba-ai-db-1`, `wardrobe`): 23:33:04 to 23:33:06 `pnpm db:generate` "No schema changes, nothing to migrate"; 23:33:06 to 23:33:07 `pnpm db:migrate` succeeded with no new migration file to apply; 23:33:07 to 23:33:08 `pnpm db:seed` (Hamburg updated, Bologna and app_settings kept).
- 23:33:18 to 23:35:42 `pnpm test:e2e`, headed, with the same five variables unset in the shell: 77 passed, 1 skipped (the smoke spec, same reason), none failed. Ports 3000, 3100, 3901 and 3923 free afterwards.
- Visible-browser check: headed Chromium, `scratchpad/od-fix-visual/check.cjs`, against `next start -p 3100` on the e2e run's build of the final tree, with the same environment, stubs and fake Claude as the integration's check (`start.ts`, `stubs.ts`; nothing left the machine, and no ranking was run). Seeded into `wardrobe_e2e`: 300 demo items (23:38:21 to 23:38:22), and at 23:38:38 (`seed.ts`) an older plan A (€300: shell and boots on the list and bought, a down parka gap not on the list), "Umbrella" added by hand and bought before plan B (€30 at least), the latest plan B (€150, finished two hours earlier; linen shorts bought, €25), "Gloves" added by hand and bought after plan B (€20 at least) and one row still to buy. Server and stubs started 23:38:54 (PIDs 21560 and 38556). Run 23:39:03 to 23:39:10, the first and only run: 20 of 20 checks passed, no page or console errors. Screenshots `scratchpad/od-fix-shots/` 01 to 07, all looked at.
  - 1440 × 900 light: "Estimated remaining budget: €105", "Purchase budget €150 from your latest relocation plan, minus at least €45 for items bought under it." (the shorts and the gloves; plan A's rows and the umbrella not subtracted), the new sentence exactly once, and D-231's first wording nowhere.
  - The case the sentence now describes, done in the browser: on `/relocate/[plan A]`, Gaps tab, "Add 1 to shopping list" added the down parka (in the database: on plan A, created after plan B finished); on `/shopping` its status was set to Bought and saved. After a reload the figures were unchanged (€105, at least €45), so the older plan's parka is not subtracted, as the sentence says. axe (WCAG 2.0 and 2.1 A and AA): no serious or critical violation.
  - 390 × 844 dark (mobile emulation): the same three lines; the sentence wraps to three lines inside the 16 px gutters (x 16 to 374), no sideways scroll, axe clean.
  - Seen in the screenshots: the sentence sits in the muted colour under the source line in both themes, as before, and nothing else in the section moved. At 1440, screenshots taken with the page scrolled half-way (03, 04, and probe 09) show a thin line above and below the sidebar's Shopping row. Three probes (`probe.cjs`, `probe2.cjs`, `probe3.cjs`, sign-ins and page loads only, 23:39 to 23:40) found no focus, hover, outline or box-shadow on that link then, and a fresh load (probe 08) shows no line. It is in the sidebar, not in the section D-233 touched, and was not investigated further.
- Clean-up: 23:40:49 the server and stubs stopped by PID (21560 and 38556, each with its process tree); ports 3000, 3100, 3901 and 3923 free at 23:40:53. 23:41:01 the check's 7 list rows and 2 plans deleted; 23:41:01 to 23:41:03 `pnpm db:seed:demo --clean` against `wardrobe_e2e` removed 300; 23:41:15 the 76 `login_attempts` rows in `wardrobe_e2e` (the e2e run's and the check's sign-ins) deleted. `wardrobe` and `wardrobe_e2e` then had 0 rows in every table except `climate_profiles` (Hamburg the default, Bologna) and `app_settings` (Bologna the home city). 23:41:20 the `node_modules` junction removed with `rmdir` (link only; the project's `node_modules` intact).
- Final gate with no `.env.local` on the final tree (after every change above, including these docs, except this bullet; `scratchpad/od-fix/gate-final.sh`, moved to `scratchpad/envlocal-aside-od2/`, empty before and again after): moved 23:43:20; `pnpm typecheck` to 23:43:26, `pnpm lint` to 23:43:41, `pnpm test` to 23:44:55 (159 files passed, 3 skipped; 2,514 tests passed, 3 skipped), `pnpm build` to 23:45:07; restored 23:45:07. All passed. 23:45:08 to 23:45:12 the same grep of `.next/static` (59 JS files): the same results as at 23:32:47. `git status` lists no `.env*` file. At 23:45:12 ports 3000, 3100, 3901 and 3923 were free.

Final checks by the lead, on the final tree (git tree `97bdb04`; nothing changed between them except this entry):

- Gate, 23:46:20 to 23:48:07, with `.env.local` moved to `scratchpad/envlocal-mine/` (empty before) and restored at 23:48:07:
  - `pnpm typecheck` to 23:46:26 and `pnpm lint` to 23:46:41: passed.
  - `pnpm test` to 23:47:54: 159 files passed, 3 skipped; 2,514 tests passed, 3 skipped.
  - `pnpm build` to 23:48:07: passed.
- Grep of `.next/static`: none of the three system prompts' first sentences, and none of `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `APP_PASSWORD_HASH`, `DATABASE_URL`, `CRON_SECRET`, `OPEN_METEO_BASE_URL`, `FEATURE_SHOPPING_AI` or `sk-ant-`.
- Docker, from 23:48:19: `pnpm db:generate` reported "No schema changes"; `pnpm db:migrate` applied nothing new; `pnpm db:seed` updated Hamburg and kept Bologna and app_settings.
- 23:48:22 to 23:50:50 `pnpm test:e2e`, headed, with the five variables unset: 77 passed, 1 skipped (smoke). It includes `review.spec.ts`'s hand-tagging test, which checks `user_edited_fields` in the database.
- Visible-browser check: headed Chromium, `scratchpad/vcheck7/check-od.cjs`, the lead's own script, against `next start -p 3100` with the e2e env and the Open-Meteo stub.
  - Setup: 300 demo items, plus one pending item inserted for the hand form.
  - Runs 1 and 2 were script errors: the desktop check also read the hidden phone tab bar.
  - Runs 3 and 4, 23:53, passed 27 of 27.
  - Run 5 passed 26 of 27. Its one failure was a console 404 for `/favicon.ico`, which Chrome requested on its own on `/today` at 390 px. The app has no `favicon.ico`; this predates these changes and is filed as wardrobe-x0r.
  - What the checks covered:
    - Phone tab bar: `aria-current` on 12 routes, exactly as D-230 says. `/wardrobe` is page; the item page, `/stats`, `/today`, `/outfits` and `/outfits/new` are true; `/add` is page and `/add/review` true; `/relocate`, `/shopping` and `/settings` are page; `/settings/climate` is true.
    - `/today` is marked the same when reached from Settings and from the wardrobe header.
    - Desktop sidebar on 7 routes: Today=page and Outfits=page on their own pages, Outfits=true on `/outfits/new`, Wardrobe=true on `/stats`, Settings=true on `/settings/climate`.
    - The `/relocate` budget hint has the new text.
    - The hand form at 390 dark shows five "Default, not checked" notes. Keep pressed on Windproof leaves four and reads "Default, kept". Keep is 44 px, with no sideways scroll and no serious axe violation.
  - The lead looked at the screenshots in `scratchpad/vcheck7/shots/`.
- Cleanup at 23:54:12: the server, its wrapper and the stub stopped by PID; nothing listened on 3000, 3100 or 3901. The pending item and the demo items were removed and the junction removed with `rmdir`. Both databases held 0 items, analyses, outfits, wear logs, shopping rows and `ai_calls`, with Hamburg the default and Bologna the home city.

### Migration and deploy state

No new migration: `pnpm db:generate` reported no schema changes at 23:02:35, again at 23:33:04 on the final tree, and at 23:48:19 (the lead's check), and `pnpm db:migrate` found nothing new on the Docker `wardrobe` database; `wardrobe_e2e` is migrated by the e2e global setup. Neon still lacks the Phase 4 migration (wardrobe-c8x). Not deployed.

### Open risks

- A "Fill in by hand" form opened before a deploy of this tree sends no `uncheckedDefaults` and gets "Some fields are missing or invalid." until the page is reloaded (D-232).
- Items tagged by hand before D-232 keep every field marked, so their untouched starting values stay protected from Re-tag; old rows cannot tell untouched from chosen, so nothing was migrated.
- On an item already tagged by hand, the normal edit form cannot mark an unchanged starting value as chosen, since it sends only changes (D-232); Keep while tagging by hand, or setting the value again after a Re-tag, does.
- The remaining budget stays an estimate (D-219, D-231): no purchase date or amount is recorded. A gap of an older plan added to the list after the latest plan and bought is not subtracted; the explaining line now says so (D-233), but the owner may prefer it counted, which would change D-219's rule.
- Canvas shoes and sandals are both warmth 1, so the shoe rule treats them alike (D-225).
- Claude's own reasons may still say "unlocks N outfits", as the `shop-v2` prompt's example does; the section's note covers it, and changing it means `shop-v3` and one paid re-run (the owner's call).
- `aria-current="true"` was checked in the DOM and with axe, not with a real screen reader.
- "What to buy next" has still been seen only with a fake Claude.
- The risks in the entries below stand.

### Live checks pending

- D-134 on the owner's own phone (wardrobe-56n): open an item from a filtered, scrolled `/wardrobe` and press "Back to wardrobe". If the filters and position are lost every time (a browser without the Navigation API, such as Safari before 26.2), an explicit in-app return context becomes a near fix.
- The live checks in the entries below (wardrobe-r67, wardrobe-0j7, wardrobe-5u9, wardrobe-izw, wardrobe-aea).

### Next steps

Committed with this entry. wardrobe-any and wardrobe-7oq are closed.

1. Check D-134 on the owner's phone (wardrobe-56n).
2. Tell footwear apart (canvas shoes and sandals, both warmth 1) before relaxing D-225's shoe rule (wardrobe-e1r).
3. Record each purchase's date and amount, tied to the budget it belongs to, so the remaining budget is no longer an estimate (D-219, D-231). This also settles D-233's case: an older plan's gap added and bought after the latest plan (wardrobe-2n6).
4. Optional, the owner's call: `shop-v3`, so that Claude's own reasons also word the counts as estimates (one paid re-run).
5. Low priority:
   - marking an unchanged starting value as chosen from the edit form (wardrobe-9hc);
   - Undo clearing a last-worn date that no log backs (wardrobe-p11);
   - a `/favicon.ico` for Chrome's own request (wardrobe-x0r).
6. The earlier steps stand:
   - the live runs, once the owner sets `ANTHROPIC_API_KEY` and approves the spend (wardrobe-izw, wardrobe-r67, wardrobe-0j7);
   - the Neon migration before the next deploy (wardrobe-c8x);
   - the Blob and tagging live checks (wardrobe-aea);
   - the forecast cache on a deployment (wardrobe-5u9);
   - the Next security release (wardrobe-9ri).

## 2026-11-03 — Phase 6 (outfits, today, wear tracking, shopping advice)

### State

Phase 6 (wardrobe-g4t) is built, integrated and reviewed, not yet committed. A review then reported 13 findings; this session confirmed all 13, fixed each with a regression test and re-ran every check (see Review and Checks run). Four implementation runs wrote it on disjoint files against one shared contract: core (the pure modules: slot rules and the outfit form schema, the wear contracts, the Open-Meteo URL, schema and snapshot, the suggestion's eligibility, lines, schemas, prompt and estimate, the shopping combinatorics and advice, the shared fixtures), outfits + wear (the outfit and wear services and actions, `/outfits`, `/outfits/new`, `/outfits/[id]`, "+1 worn today" on the item page, `e2e/outfits.spec.ts`), today (the `weather` env group, the cached forecast, the settings and suggestion services, `POST /api/outfits/suggest`, `/today`, Settings' Home city, the Open-Meteo stub and `e2e/today.spec.ts`) and shopping-ai (the advice service, `POST /api/shopping/advice`, the "What to buy next" section, Settings' Features row, `e2e/shopping-advice.spec.ts`). The integration session joined the pieces, added the navigation, the guards and the docs, ran the gate with no `.env.local`, Docker, the headed e2e suite, a visible-browser check with the 300-item demo seed and one suggestion seeded through the real service, and one short run against the real Open-Meteo API (see Checks run). No migration was needed. Nothing called the real Anthropic API.

The lead then checked the final tree independently: the gate with no `.env.local`, a grep of the client bundle, Docker, the headed e2e suite, and a visible-browser check with its own script, which compares each screen with the database. All passed (see "Final checks by the lead" under Checks run). The follow-ups are now Beads issues: wardrobe-r67, wardrobe-0j7, wardrobe-5u9, wardrobe-p11 and wardrobe-7oq. The review ran one round. The lead capped it there after the owner asked why the work was slow, since Phase 5 had taken four rounds. A second round would have run only if this one had found something high-severity. Phase 6 is committed with this entry, and wardrobe-g4t is closed at that commit.

What Phase 6 adds:

- `/outfits`, `/outfits/new` and `/outfits/[id]`: the outfit list (collage, occasion, weather range, rating, "Fine in rain", AI badge, times worn, "Wore this today"), and the builder with one Dialog picker per slot (base layer included, a dress in the top slot with the bottom optional, up to three accessories), checked in the browser and again on the server in the save's transaction; edit and delete (D-195, D-199, D-201).
- Wear tracking: `logWear` and `undoWear` (one transaction, items locked in id order, one log per item, day and target, Undo of exactly the logs a press created within 10 minutes), "+1 worn today" on the item page, "Wore this today" on outfits and suggestions, all through one `useWearLogger` with its Undo toast (D-194, D-196 to D-198, D-200).
- `/today`: the home city's forecast from Open-Meteo in a `'use cache'` function keyed by place and day, with the attribution; "Suggest outfits" through `POST /api/outfits/suggest` (`maxDuration` 120, Claude stopped at 110 s), three validated outfits from the eligible items, stored as an `outfit_suggestion` analysis with its cost, reused at no cost while nothing changed; Save and "Wore this today" on each card (D-186 to D-190, D-203 to D-208).
- Settings: Home city (Bologna or Hamburg), a read-only Features row for `FEATURE_SHOPPING_AI`, and a "Get dressed" section linking Today and Outfits (D-209, D-215, D-218).
- "What to buy next" on `/shopping`, only with `FEATURE_SHOPPING_AI=true`: unlock counts computed by the app for four Hamburg months, ranking and budget split by Claude, `POST /api/shopping/advice` (404 with the flag off) (D-191 to D-193, D-210 to D-217).
- `OPEN_METEO_BASE_URL` (test only) and the local Open-Meteo stub the e2e run starts (D-202).

Integration, by item:

- Settings page: the two runs' edits merged (one `Suspense` import, Home city after Appearance, Features after "Your data"), plus the new "Get dressed" section at the top; the page description now reads "Your home city, appearance, data and account." `src/env.ts`: only the today run edited it (the `weather` group); nothing to resolve.
- Navigation (D-218): `nav-items.ts` gains `SECONDARY_NAV` (Today, Outfits), `SECONDARY_NAV_LABEL` ("Get dressed"), `SECONDARY_NAV_TAB` and `tabActiveOn`. The sidebar shows a second group with its own navigation landmark; the phone keeps five tabs, the wardrobe header shows Today and Outfits below `md` (`secondary-nav-links.tsx`), Settings links both at the top, and the Wardrobe tab stays marked on `/today` and `/outfits/*`. New tests: `nav-items.test.ts` (3), `mobile-tab-bar.test.tsx` (4 paths), `app-sidebar.test.tsx` (3).
- `/outfits/new` now re-reads its slot pickers after an item change elsewhere in the tab (`useRefreshAfterItemChanges(candidates, refresh)` in `new-outfit.tsx`): the pickers show wear counts and leave archived items out, and nothing else re-read them (D-200).
- `test/boundaries.test.ts`: the five new services and `src/server/weather.ts` are in the server-only and session-check guard lists (a new `SESSION_CHECKED_FILES`); a new test finds every `'use cache'` function in `src`, asserts that `fetchForecast` is the only one, is not exported, and is called only from `loadTodayWeather` after `requireSession()` (with a unit test of the detector); `@/lib/outfits/suggestion` and `@/lib/shopping/advice` are forbidden in client bundles, the `-result` modules allowed (D-187, D-203).
- `test/item-freshness.test.ts`: a new block guards that every confirmed wear and Undo notes an item change (and an outfit change for an outfit's wear), that every wear button goes through the logger, and the re-read wiring of `/outfits`, `/outfits/[id]`, `/outfits/new`, `/today` (both its view and its states without one) and the item page's counts (D-200).
- `playwright.config.ts`: `webServer` is an array; the stub (`node e2e/open-meteo-stub.ts`, ready at `/health`) starts first, and the app server gets `OPEN_METEO_BASE_URL` pointing at it after the blanked variables (D-202).
- `e2e/a11y.spec.ts` seeds one outfit of its coat and boots and scans `/today`, `/outfits`, `/outfits/new` and the outfit's page, and `/today`, `/outfits` and the outfit's page again at 390 px.
- Found by the first e2e run and fixed (the specs had never run): `outfits.spec.ts`'s `getByText("Already logged")` also matched the toast's description ("is already logged as worn today"), now exact; its "Worn once" on the outfit page also matched the chosen item's "Worn once · last …", now `/^Worn once, last on /`; `today.spec.ts`'s `getByLabel("Home city", { exact: true })` also matched the Settings section labelled by its heading, now `getByRole("combobox", { name: "Home city" })`. No assertion was loosened.
- Docs: DECISIONS D-186 to D-218 under "Added in Phase 6", with D-039, D-040 and D-107 marked as refined; README completed as the final reference (intro, features, architecture diagram and navigation, the env table with `CLAUDE_OUTFIT_MODEL`, `FEATURE_SHOPPING_AI` and `OPEN_METEO_BASE_URL`, new Outfits, Wear tracking, Today, "What Claude sees for outfits" and "What to buy next" sections, costs, models, testing, project structure, function limits); `e2e/README.md` describes the stub, the three new specs and the wider axe scan.

Deviations from `design.md` Phase 6 and from the shared contract, as the runs reported them (all recorded in the decisions):

- Core: the stored-result schemas live in client-safe `suggestion-result.ts` and `advice-result.ts` (D-187); `buildSuggestionSnapshot(items, weather)` takes the weather and also returns `droppedCount` and `snapshotHash` (D-188); the strict outfit check outputs item ids; `isEligibleForToday` also leaves out category `other`; `scenariosFromProfile` refuses incomplete profiles (D-192); the shopping strict check takes 1 to min(candidates, 10) recommendations (D-193); scenarios carry `outfitsNow`; `toWeatherSnapshot` throws UPSTREAM itself (D-190); `OutfitItemDto.category` and `.status` can be null; WMO 97 is "Heavy thunderstorm"; extra helpers (`canSuggestOutfits`, `noonOn`, `resolveWornOn`, `estimateShoppingAdviceUsd`, deadline constants).
- Outfits + wear: one responsive Dialog picker, not a Drawer on phones; the builder reads every slot's items once (no read action; `listSlotCandidates` exists unused) (D-201); `saveOutfit` takes a fourth argument `{ source, aiReasoning }`; `outfit-actions.ts` imports the `UndoWearResultDto` type from the wear service (type only).
- Today: `fetchForecast` takes a fifth argument `day` and is not exported; `loadTodayWeather(db, { now })` returns `{ profile, today, weather }` and answers NOT_FOUND without a home city (D-203); extra service functions (`quoteOutfitSuggestion`, `getHomeProfile`, `getHomeCitySettings`, `getTodaySuggestion(db, { now })`); `getAppSettings` reports no home city when the row is missing and `setHomeProfile` answers CONFIG (D-209); the `/today` DTOs live in `src/components/today/today-model.ts`; the suggest button is disabled when three outfits are impossible (D-189).
- Shopping-ai: the client-safe advice types live in `.ts` files (`advice-model.ts`, `advice-api.ts`); the route reads the body itself after the flag check (D-215); the model comes from `aiSettingsEnv()` (D-186); "Add to shopping list" reuses `addGapsToShoppingList` (D-217).
- design.md: the file names, the pure `open-meteo.ts` with the cached fetch in `src/server/weather.ts`, the profile's time zone instead of `auto`, `why` instead of `reasoning` and no `weather_fit`, `key` instead of `gap_key`, Undo by log ids, Settings' Home city (D-216).

Review fixes in this entry's tree, in short: unlock counts that check each piece against the month (D-225); the shopping prompt `shop-v2` (the whole year's climate, D-226) and the outfit prompt `outfit-v2` (worn:N counts logs, D-227); the advice's budget counts only what was bought under the latest plan (D-219); one shopping ranking at a time (D-220); a suggestion run looks for a stored one again under its lock (D-221); a saved suggestion takes over the card's wear (D-222); a wear or Undo answering on another page re-reads the page shown (D-223); Try again on the weather error moves focus and announces (D-224); `/today` ignores an asked suggestion for another city or day (D-228) and keeps room for the toasts (D-229); full-colour small text on the builder's error rows; the advice's budget line names its source.

Statements in the entries below that are no longer true:

- Next steps item 1 of the Phase 5 entry ("Phase 6 (wardrobe-g4t)") is done, apart from the commit.
- README's Features table no longer lists Phase 6 as one line each for outfits and shopping AI; the sections above replace that.

### Decisions

D-186 to D-218 are new, under "Added in Phase 6": effort low, one output cap and a 110 s deadline for both new Claude calls (D-186), client-safe stored-result schemas (D-187), the outfit prompt's item lines (D-188), no paid call unless three outfits are possible (D-189), the weather snapshot (D-190), outfit counting for the advice (D-191), complete profiles only (D-192), the advice's strict check (D-193), wear dates (D-194), the outfit form's rules (D-195), wear locking and Undo by log ids (D-196), a wear is not an edit (D-197), archived items and empty outfits (D-198), deleting an outfit keeps the wear history (D-199), the outfit change count and the pages that re-read after a wear (D-200), the builder (D-201), `OPEN_METEO_BASE_URL` and the stub (D-202), the forecast cache (D-203), suggestion runs (D-204), reuse (D-205), today's suggestion (D-206), saving a suggestion (D-207), "Wore this today" on a suggestion (D-208), the home city (D-209), the remaining purchase budget (D-210), the advice's candidates (D-211), the wardrobe the counts use (D-212), advice reuse (D-213), the checks before paying (D-214), the flag off (D-215), the deviations from design.md (D-216), the advice as one plain request (D-217) and the navigation (D-218). They refine D-039 (D-190, D-202, D-203), D-040 (D-191, D-215) and D-107 (D-200); those entries now say so.

D-219 to D-229 are new, under "Added in the Phase 6 review": the remaining budget counts only purchases under the latest plan (D-219), shopping rankings run one at a time under an advisory lock and a 130 s lease (D-220), a suggestion run looks for a stored suggestion again under its lock (D-221), saving a suggestion already worn that day moves that wear to the outfit (D-222), a wear or Undo answering after its page was left re-reads the page shown (D-223), Try again on the weather error moves focus to the forecast and announces the outcome (D-224), per-piece warmth limits in the unlock counts (D-225), the shopping prompt `shop-v2` (D-226), the outfit prompt `outfit-v2` (D-227), an asked suggestion only for the city and day shown (D-228), and room for the toasts on `/today` (D-229). They refine D-188, D-191, D-193, D-196, D-200, D-204, D-205, D-206, D-208, D-209, D-210 and D-214; those entries now say so, and D-188, D-191, D-193, D-208 and D-210 had statements corrected.

### Review

The review reported 13 findings (none rejected); an independent check had confirmed each, two at a lower severity. This session re-checked each one against the code before changing it, and all 13 were real. Each got the smallest fix and a regression test, and each regression test was seen failing with its fix reverted: `scratchpad/r6fix/revert-check.sh` puts the pre-fix source files back, runs the named tests, restores the fixed files and compares them by sha256 (identical every time). No migration was needed.

- **p6-ai-1** (medium, confirmed): the unlock counts only summed warmth, so a heavy coat made up for linen shorts or sandals in January, and a shell over a mid-layer knit with jeans (7) never counted.
  - Changed: `WARMTH_BANDS` rows gain `pieceMin`, `outerRequired` and `outerMax`; the cold band's minimum is 7 (was 8). `enumerate()` checks each piece; unknown warmth fits any allowed level (D-225). The shopping prompt describes the rule (part of `shop-v2`, D-226).
  - Tests: `combinatorics.test.ts` "each piece suits the month on its own" (fixture wardrobe: shorts and sandals 0 in January, shorts 0 in October, the shell 2 in January, the parka 0 in July; hand-computed shell over a w3 knit counts 1; unknown warmth). All five failed without the fix (shorts 3, shell 0, parka counted). Three existing expectations changed: the cold band minimum (twice) and "freezing with no outerwear" (now needs outerwear).
- **p6-ai-2** (low, confirmed): purchases made under an older plan were subtracted from the latest plan's budget.
  - Changed: `adviceBudget` counts a bought row only when it belongs to the latest run or was added by hand once that run finished; the panel and the blocker say "under that plan" / "since the latest relocation plan" (D-219).
  - Test: `shopping-advice.test.ts` "subtracts only what was bought under the latest plan, not under an older one" (plan A €300 fully bought, plan B €150: €150 left; then €110 bought under B leaves €40). Without the fix the section was blocked ("€150 … used up").
- **p6-ai-3** (low, confirmed): every advice request said the stay starts in January.
  - Changed: `describeClimateForPrompt` takes an optional heading (the relocation default and its pins and cache keys unchanged); `describeAdviceClimate` sends January to December under "Monthly normals, January to December:"; `SHOPPING_PROMPT_VERSION` is `shop-v2`, both hashes re-pinned, and the template pin now renders the real climate block (D-226).
  - Tests: `shopping-advice.test.ts` "sends the climate of the whole year, never a stay that starts in January" and `range.test.ts` "heads the table as the stay's months unless another heading is given"; both failed without the fix.
- **p6-ai-4** (low, confirmed): the outfit prompt called worn:N "the number of days" although it counts logs.
  - Changed: the sentence now reads "how many times the item was logged as worn (one day can count more than once)"; `OUTFIT_PROMPT_VERSION` is `outfit-v2`, system hash re-pinned, template hash unchanged; `outfit-suggestions.test.ts` uses the constant (D-227).
  - Tests: `suggestion.test.ts` "calls worn:N a count of logs, never of days" and the version pin; both failed without the fix.
- **p6-srv-1** (medium in the review, low after verification; confirmed): nothing stopped a reload or a second tab from paying for a second identical ranking.
  - Changed: `startAdviceRun` inserts the running row under `pg_advisory_xact_lock(0x10618, 1)`; a running `shopping` row younger than 130 s answers CONFLICT, with `force` too; without `force` a complete row with the same key stored meanwhile is reused (D-220).
  - Tests: `shopping-advice.test.ts` "refuses a reload's request and a second tab's Run again with CONFLICT, so only one call is paid" (failed without the fix: both "ran") and "lets a new run start once a cut-off run's lease has passed". New opt-in `shopping-advice.pg.test.ts` on real Postgres (six requests at once: one paid, five CONFLICT): failed without the fix (six paid) and also with the running check but without the lock (six paid, three runs).
- **p6-srv-2** (low, confirmed): a click that passed the stored-suggestion check just before another run completed paid again.
  - Changed: `startRun` looks for a complete suggestion with the same cache key again under the settings-row lock, after the running check, unless `force` (D-221).
  - Test: `outfit-suggestions.test.ts` "answers the suggestion another request stored meanwhile instead of paying for it again" (the second request held in its budget check through a pass-through mock of `@/lib/ai/budget`); without the fix it got a second analysis and call.
- **p6-ui-1** (medium in the review, low after verification; confirmed): `/today` showed the previous home city's suggestion under the new city's weather.
  - Changed: `TodaySuggestionDto` (and its schema) carries `profileId`; the view ignores an asked suggestion for another profile or day and announces only one it shows (D-228).
  - Tests: `today-view.test.tsx` "a suggestion for another home city or day" (four tests in StrictMode and Activity: city changed during a run, after a finished run, Hamburg's own suggestion kept, another day) and the `profileId` assertions in `outfit-suggestions.test.ts`; all six failed without the fix.
- **p6-ui-2** (medium, confirmed): wearing a suggestion and then saving it let the outfit page count the same day's wear again.
  - Changed: `saveSuggestedOutfit` moves the card's no-outfit logs of that day to the new outfit when every item has one (D-222).
  - Tests: `outfit-suggestions.test.ts` "moves the card's wear of that day to the saved outfit, so wearing the outfit again counts nothing twice" (failed without the fix: the outfit read "Never worn") and "attaches nothing when only some of the outfit's items were logged that day".
- **p6-ui-3** (medium, confirmed): the 10-minute Undo toast covered the last suggestion card's Save.
  - Changed: the suggestion list has `pb-32` (none in print) (D-229).
  - Test: `e2e/today.spec.ts` "the Undo toast of a wear never covers the last card's Save at desktop or phone width" (1280 × 720, 1440 × 900, 390 × 844; a trial click after the toast has settled). With the padding removed it failed ("toast-portal subtree intercepts pointer events"). Its first versions passed without the fix because they measured while the toast was still sliding in; the test now waits for the toast's animations to end, and for a closed toast to leave before the next size.
- **p6-ui-4** (low, confirmed): an Undo pressed while `/today` or the item page was shown left stale counts.
  - Changed: `useWearLogger` knows whether its button's page is shown and, when it is not, refreshes the page shown after a confirmed log or Undo; `onCounts` gets `{ shown }` and `/today` refreshes itself only when shown, so the page is read once (D-223). `worn-today.test.tsx` now mocks `next/navigation`.
  - Tests: `worn-today.test.tsx` "an Undo that answers while another page is shown" (reads the shown page once; failed without the fix: 0 refreshes) and "leaves the reading to the button's own page while it is shown"; `today-view.test.tsx` "reads the page shown once when Undo answers after /today was left".
- **p6-ui-5** (low, confirmed): a successful Try again on the weather error dropped focus to `<body>` and announced nothing.
  - Changed: new `TodayWeatherFrame` around both branches of `/today`, with a status region that stays mounted and focus to the weather heading (`tabIndex={-1}`) when the forecast replaces the error after a press, only if focus was lost; `WeatherUnavailable` reports the press and a failed read (D-224).
  - Test: `today-weather-frame.test.tsx` (four tests, StrictMode and Activity). Without the frame the file cannot load; with only the wiring reverted (the old alert and card), three of four failed (focus on `<body>`, no announcement).
- **p6-ui-6** (low, confirmed): "Required" and the category line on a slot row with a message measured 4.33:1 in light mode.
  - Changed: those two small texts use `text-foreground` on rows with a message; the tint stays.
  - Tests: `outfit-form.test.tsx` "shows a row's small text in full colour on its error tint" and a new `e2e/a11y.spec.ts` scan of `/outfits/new` after an empty Save at 1440 light and 390 dark; both failed without the fix (axe: color-contrast on the two rows).
- **p6-ui-7** (low, confirmed): with no budget, "What to buy next" said no budget is set right under a filled-in budget box.
  - Changed: `budgetSummary` names the source ("Your latest relocation plan sets no purchase budget" or "No relocation plan sets a purchase budget") and says the list's "Budget for new purchases" box only compares prices and is not used here (copy only, no prompt change).
  - Test: `advice-panel.test.tsx` "explains a missing purchase budget, where it would come from, and that the list's budget box is not used"; failed without the fix.

Owner decisions this review raises (options only, nothing chosen): whether the advice's budget should keep meaning "for new purchases under this plan" (D-219, as the relocation prompt says) or become a total that includes everything bought (the blocker and the relocation budget hint would then ask for a total); and whether the per-piece warmth limits of D-225 suit the owner, who could prefer, for example, allowing canvas sneakers (warmth 1) in April and October.

### Checks run

All times are local (CET, UTC+1), 2026-11-03. The four implementation runs' own checks are in their reports to the lead.

Final checks by the lead, on the final tree (git tree `88f5bea`; nothing changed between them except this entry):

- Gate, 16:53:13 to 16:54:57, with `.env.local` moved to `scratchpad/envlocal-mine/` (empty before) and restored at 16:54:57:
  - `pnpm typecheck` to 16:53:19 and `pnpm lint` to 16:53:32: passed.
  - `pnpm test` to 16:54:45: 158 files passed, 3 skipped; 2,451 tests passed, 3 skipped.
  - `pnpm build` to 16:54:57: passed. `/today`, `/outfits`, `/outfits/new` and `/outfits/[id]` are partial prerenders; the two new API routes are dynamic.
- Grep of `.next/static` (61 files) found none of these:
  - the three system prompts' first sentences;
  - `outfit-v2`, `shop-v2` or `reloc-v4`;
  - `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `APP_PASSWORD_HASH`, `DATABASE_URL`, `CRON_SECRET`, `OPEN_METEO_BASE_URL`, `FEATURE_SHOPPING_AI` or `sk-ant-`.
  - `BLOB_READ_WRITE_TOKEN` appears once, as `@vercel/blob`'s lookup of the name. The control string "Suggest outfits" was found.
- Docker: 16:55:20 `pnpm db:generate` reported "No schema changes"; `pnpm db:migrate` applied nothing new; 16:55:22 `pnpm db:seed` updated Hamburg and kept Bologna and app_settings.
- 16:55:25 to 16:57:57 `pnpm test:e2e`, headed. `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `E2E_TAG`, `FEATURE_SHOPPING_AI` and `OPEN_METEO_BASE_URL` were unset in the shell. Result: 75 passed, 1 skipped (the smoke spec).
- Visible-browser check: headed Chromium, `scratchpad/vcheck6/check6.cjs`, the lead's own script, against `next start -p 3100` with the e2e env and `OPEN_METEO_BASE_URL` pointing at `e2e/open-meteo-stub.ts`.
  - Setup each time: the demo seed (300 items) and one suggestion for today, through the real `suggestOutfits` with the integration session's realistic fake Claude (`scratchpad/phase6-visual/seed-suggestion.test.ts`, copied).
  - Runs 1 to 3 stopped on the script's own locators and were reset and re-seeded:
    - a second `<main>`, because Next keeps the login page hidden after sign-in;
    - "Save outfit" returning to `/outfits`, not the new outfit's page;
    - the Home city heading region matching its label.
  - Final run, 17:01:56 to 17:02:16: 38 of 38 checks passed, with no console or page errors.
    - The suggested 18 items are all eligible in Bologna.
    - `/today`: "in Bologna, Italy", the weather card with feels-like, rain and gusts, and the attribution linking open-meteo.com. Three cards. The stub received Bologna's coordinates.
    - "Wore this today" wrote 7 logs for 7 items, each count +1 with last worn set; Undo removed the logs and restored the counts.
    - Save stored an AI outfit with the card's reason and 5 items.
    - "Suggest again" with no key showed the configuration message and added no `ai_calls` row.
    - The builder refused an empty save on screen with no row written. It saved a dress with shoes and no bottom.
    - The outfit's "Wore this today" wrote 2 logs linked to it. Delete removed the outfit and kept its items.
    - The item page's "+1 worn today" went 0 to 1 on screen and in the database; Undo restored it.
    - Home city Hamburg: saved; `/today` asked the stub for 53.633, 9.988, and did not show Bologna's suggestion. Bologna was restored.
    - `/shopping` had no "What to buy next" and `POST /api/shopping/advice` answered 404.
    - At 390 × 844 dark: the wardrobe header links Today and Outfits. `/today`, `/outfits`, `/outfits/new` and Settings had no sideways scroll and no serious axe violation.
  - The lead looked at the screenshots in `scratchpad/vcheck6/shots/`.
  - Cleanup at about 17:02:51:
    - The app server, its wrapper and the stub were stopped by PID; nothing listened on 3000, 3100 or 3901.
    - The seeded rows were removed and the junction removed with `rmdir`.
    - Both databases held 0 items, analyses, outfits, wear logs, shopping rows and `ai_calls`, with Hamburg the default and Bologna the home city.

Review session (earlier; the same tree):

- Targeted runs while fixing, 15:53 to 16:15: `pnpm exec vitest run` on each changed test file, `pnpm exec tsc --noEmit` and `pnpm exec eslint` on the changed files after each fix; all passed at the end. Each regression test was run against the pre-fix source with `revert-check.sh` (15:54 to 16:15) and failed as described under Review, and the fixed files came back identical by sha256.
- Real Postgres (opt-in): `TEST_DATABASE_URL=…/wardrobe_e2e pnpm exec vitest run src/server/services/shopping-advice.pg.test.ts` at 16:00:50: 1 passed; with the guard reverted at 16:01:00: failed (6 paid); with only the advisory lock removed, three runs at about 16:01: failed each time (6 paid). `wardrobe_e2e` held no shopping rows, analyses or `ai_calls` afterwards.
- Pre-check with `.env.local` in place: `pnpm typecheck` 16:15:59 to 16:16:04, `pnpm lint` to 16:16:17, `pnpm test` 16:16:22 to 16:17:35 (158 files passed, 3 skipped; 2,451 tests passed, 3 skipped: the three opt-in Postgres tests). All passed.
- Gate with no `.env.local` (moved to `scratchpad/envlocal-aside6b/`, created empty, put back by a trap; `scratchpad/gate6b.sh`): moved 16:20:23; `pnpm typecheck` to 16:20:29, `pnpm lint` to 16:20:42, `pnpm test` to 16:21:54 (158 files passed, 3 skipped; 2,451 tests passed, 3 skipped), `pnpm build` to 16:22:15 (34 routes, as before); restored 16:22:15. All passed.
- 16:22:27 to 16:22:30 grep of `.next/static` (59 JS files): no `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `APP_PASSWORD_HASH`, `CRON_SECRET`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `OPEN_METEO_BASE_URL`, `FEATURE_SHOPPING_AI`, `CLAUDE_OUTFIT_MODEL`, `MONTHLY_AI_BUDGET_USD`, `sk-ant` or `vercel_blob_rw`; none of "practical personal stylist", "DRESSING FOR THE WEATHER", "Feels-like bands", "frugal shopping adviser", "THE UNLOCK COUNTS", "never recount or invent them", "one day can count more than once", "each piece suits the month on its own", "Monthly normals, January to December", "arrival month first", nor `outfit-v1`, `outfit-v2`, `shop-v1`, `shop-v2` or `reloc-v4`. `BLOB_READ_WRITE_TOKEN` appears once, as `@vercel/blob`'s own lookup. Controls found: "Wore this today" (3 files), "What to buy next" (1), "Weather data by Open-Meteo.com" (4), "Forecast loaded." (1), "Budget for new purchases" (1).
- Docker (`guardaroba-ai-db-1`): `pnpm db:generate` at 16:22:39 reported no schema changes; `pnpm db:migrate` 16:22:41 to 16:22:42 applied nothing new; `pnpm db:seed` at 16:22:43 (Hamburg updated, Bologna and app_settings kept). No `wardrobe_r6*` database existed (only `wardrobe` and `wardrobe_e2e`), so none was dropped.
- E2E revert checks (headed, shell without `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `E2E_TAG`, `FEATURE_SHOPPING_AI`, `OPEN_METEO_BASE_URL`): with the padding and the contrast fix reverted, 16:24 and 16:26: the new axe test failed (color-contrast); the toast test needed the waits described under Review, and with them, 16:30:20 to 16:30:45, it failed with the padding reverted. On the fixed tree, 16:30:54 to 16:31:21: both passed.
- `pnpm test:e2e` (headed, all specs, the same shell variables unset), 16:31:29 to 16:33:58: 75 passed, 1 skipped (the smoke spec, "needs BLOB_READ_WRITE_TOKEN in the shell"), none failed. `wardrobe_e2e` was empty of app rows before and after.
- Visible-browser check (headed Chromium, `scratchpad/phase6-fix-visual/check.cjs`, against `next start -p 3100` on the e2e build with the e2e server's environment plus `OPEN_METEO_BASE_URL` pointing at a switch in front of the Open-Meteo stub that can answer 500, `FEATURE_SHOPPING_AI=true`, and a fake key with `ANTHROPIC_BASE_URL` pointing at a local fake Messages endpoint, so nothing left the machine and no real Claude call was made; 300 demo items and two seeded relocation plans in `wardrobe_e2e`). Two earlier runs stopped on script errors (a toast animation promise, a missing request folder, an item looked up by a name the demo repeats) and were reset from scratch. Final run 16:45:42 to 16:46:16: 34 of 34 checks passed, no page or console errors. Screenshots `scratchpad/phase6-fix-shots/` 01 to 15, all looked at:
  - Weather error (stub failing): Enter on Try again kept focus on it and announced "The forecast is still unavailable."; with the stub working, Enter again showed the forecast, focus on "Weather in Bologna" (with its focus ring) and "Forecast loaded." announced.
  - "Suggest outfits" through the fake: the request's system prompt had the `outfit-v2` wording, the stored row `outfit-v2`.
  - At 1440 × 900, 1280 × 720 and 390 × 844 dark, after "Wore this today" on the third card the element at the centre of its Save is Save; the toast sits below the cards.
  - "Wore this today" on card 1, then Save, then "Open saved outfit": "Worn once, last on 3 Nov 2026"; the outfit's "Wore this today" answered "Already logged"; each item's count went up by one and its single log carries the outfit.
  - "+1 worn today" on an item page, then the sidebar's Today, then Undo: the card read "Never worn", as in the database. "Wore this today" on `/outfits`, then the item page through the wardrobe search, then Undo: the page read "Once", as in the database.
  - "Suggest again" with an 8 s fake delay, then Settings, Home city Hamburg, then Back: after Bologna's run answered (the newest analysis, Bologna's profile), `/today` showed Hamburg's weather, no cards and "Suggest outfits"; Hamburg then got its own three.
  - `/outfits/new` after an empty Save: no serious or critical axe violation at 1440 light or 390 dark.
  - `/shopping` with the flag on: "Purchase budget €150 from your latest relocation plan. Nothing is bought under that plan yet, so all of it is left." although plan A's €300 is bought; linen shorts and sandals unlock 0 in January, April and October, the waterproof shell 9,007 in January. A second tab's "Rank 3 purchases" while the first ranked (6 s fake delay) showed "Purchases are already being ranked in another tab or window. Try again in a minute."; one complete ranking, one `ai_calls` row; the request held "Monthly normals, January to December:", no "arrival month", "€150 left for all purchases together." and the per-piece rule; the stored row `shop-v2`. With a newest plan that has no budget: "Your latest relocation plan sets no purchase budget, so only what the climate makes necessary is recommended. The "Budget for new purchases" box on this page only compares the list's prices and is not used here."
  - Nothing scrolled sideways on `/today` or `/shopping` at 390 dark.
  - Full-page captures show the sticky sidebar and the fixed tab bar part way down the page; that is how full-page screenshots draw them.
- Clean-up: the stubs and the 3100 server stopped by PID (their own process trees) at 16:47:07, ports 3000, 3100, 3901, 3911, 3912 and 3923 free; at 16:47:17 `wardrobe` and `wardrobe_e2e` held no items, analyses, outfits, wear logs, shopping rows or `ai_calls`, Hamburg the default profile and Bologna the home city.
- Final gate with no `.env.local` on the final tree (written after everything above except this bullet; moved to `scratchpad/envlocal-aside6b/`, empty before and again after): moved 16:49:40; `pnpm typecheck` to 16:49:46, `pnpm lint` to 16:49:59, `pnpm test` to 16:51:10 (158 files passed, 3 skipped; 2,451 tests passed, 3 skipped), `pnpm build` to 16:51:30 (34 routes); restored 16:51:30. All passed. 16:51:37 to 16:51:39 grep of `.next/static` (59 JS files): none of the secret names, prompt phrases or versions listed above, nor the visual check's fake key; `BLOB_READ_WRITE_TOKEN` once as `@vercel/blob`'s lookup; the five control strings found as before. `git status` lists no `.env*` file except `.env.example`. At 16:51:43 ports 3000, 3100, 3901, 3911, 3912 and 3923 were free.

Integration session (earlier, before the review; superseded where the review re-ran a check):

- 14:40:27 to 14:40:32 `pnpm exec tsc --noEmit` on the tree as the runs left it: exit 0.
- Targeted runs while integrating: `pnpm exec vitest run src/components/layout` at 14:43:27 (2 files, 17 tests) and 14:43:51 (3 files, 20 tests, with the new sidebar test); `test/boundaries.test.ts` at 14:45:08 (50 tests); `test/item-freshness.test.ts` at 14:45:36 (13 tests); `pnpm exec eslint` on every file the integration touched and `pnpm exec tsc --noEmit` at about 14:47: no findings, exit 0. All passed.
- Pre-check with `.env.local` in place: `pnpm typecheck` 14:45:43 to 14:45:50, `pnpm lint` to 14:46:03, `pnpm test` to 14:47:14 (157 files passed, 2 skipped; 2,425 tests passed, 2 skipped). All passed.
- Cost estimates at about 14:47 with a scratch tsx script over the 300-item demo generator and the fixture forecast (`estimateOutfitSuggestionUsd`, `estimateShoppingAdviceUsd`): outfit suggestion for the 187 items eligible in Bologna $0.048 on Sonnet 5.5 and $0.0024 on Haiku 5.5 (12,001 input tokens), $0.059 and $0.0029 for all 294 usable items, $0.039 and $0.0020 for 100; shopping advice $0.030, $0.031 and $0.032 on Sonnet for 5, 10 and 20 candidates. README's Costs has them.
- Gate with no `.env.local` (moved to `scratchpad/envlocal-aside6/`, created empty; put back by a trap): moved 14:48:22; `pnpm typecheck` 14:48:22 to 14:48:28, `pnpm lint` to 14:48:41, `pnpm test` to 14:49:55 (157 files passed, 2 skipped; 2,425 tests passed, 2 skipped), `pnpm build` to 14:50:20 (34 routes; `/today`, `/outfits`, `/outfits/new`, `/outfits/[id]` partial prerender, the two new API routes dynamic); restored 14:50:20. All passed.
- 14:50:48 to 14:51:00 grep of `.next/static` (60 JS files): no `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `APP_PASSWORD_HASH`, `CRON_SECRET`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `OPEN_METEO_BASE_URL`, `FEATURE_SHOPPING_AI`, `CLAUDE_OUTFIT_MODEL`, `MONTHLY_AI_BUDGET_USD`, `sk-ant` or `vercel_blob_rw`; none of the prompt phrases "practical personal stylist", "DRESSING FOR THE WEATHER", "Feels-like bands", "frugal shopping adviser", "THE UNLOCK COUNTS", "never recount or invent them", nor `outfit-v1`, `shop-v1` or `reloc-v4`. `BLOB_READ_WRITE_TOKEN` appears in one file only as `@vercel/blob`'s own environment lookup (a name, no value), as in earlier phases. Control strings found: "Wore this today" (3 files), "What to buy next" (1), "Weather data by Open-Meteo.com" (4).
- Docker (`guardaroba-ai-db-1`, `wardrobe`): `pnpm db:generate` at 14:51:06 reported no schema changes; `pnpm db:migrate` 14:51:07 to 14:51:09 applied nothing new; `pnpm db:seed` at 14:51:10 (Hamburg updated, Bologna and app_settings kept).
- `pnpm test:e2e` (headed, all specs; `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `E2E_TAG`, `FEATURE_SHOPPING_AI` and `OPEN_METEO_BASE_URL` unset in the shell), first run ended 14:53:32: 70 passed, 2 failed, 1 skipped (the smoke spec, "needs BLOB_READ_WRITE_TOKEN in the shell"), 1 did not run (the second test of the serial outfits spec). The two failures were the ambiguous locators listed under Integration. After the fixes: `e2e/outfits.spec.ts` and `e2e/today.spec.ts` to 14:54:40 (4 passed, 1 failed: the "Worn once" locator), then `e2e/outfits.spec.ts` 14:54:49 to 14:55:14 (2 passed).
- Second full `pnpm test:e2e` after the visible-browser check (same shell variables unset), 15:06:42 to 15:08:52: 73 passed, 1 skipped (the smoke spec, with its reason "needs BLOB_READ_WRITE_TOKEN in the shell"), none failed. It includes the axe scans of `/today`, `/outfits`, `/outfits/new` and the outfit page at 1440 and 390 px, all of `outfits.spec.ts`, `today.spec.ts` (weather from the stub, proven by its request log; the no-key configuration error with no `ai_calls` row; Save, "Wore this today" and Undo on a seeded suggestion; the Hamburg switch and back) and `shopping-advice.spec.ts`. Afterwards `wardrobe_e2e` held no items, analyses, outfits, wear logs, shopping rows or `ai_calls`.
- Visible-browser check (headed Chromium from `scratchpad/phase6-visual/check6.cjs`, against `next start -p 3100` on the e2e build with the e2e server's environment plus `OPEN_METEO_BASE_URL` pointing at the stub, started with `node e2e/open-meteo-stub.ts` at about 14:57; a `node_modules` junction in the folder, removed with `rmdir` at 15:06): 300 demo items seeded into `wardrobe_e2e` at 14:57:29 (`pnpm db:seed:demo` with `DATABASE_URL` for that command only); one complete suggestion for today seeded at 14:57:32 through the real `suggestOutfits` (real eligibility, snapshot, prompt, strict check, budget check, `callStructured` with its `ai_calls` row) with a fake Claude that read the 187 alias lines it was sent and answered three outfits (a layered rain outfit, a dress with no bottom, a knit outfit marked not for rain); the strict check accepted the first reply, the row stored $0.0476 against an estimate of $0.048. The first two script runs (15:00:07, 15:01:53) stopped on errors in the script (a rain figure, a page reload that dropped the Undo toast, a locator matching the hidden kept `/outfits/new` form) and were reseeded from scratch (`reset.sh --reseed`). The final run, 15:03:13 to 15:04:02, passed 90 of 92 checks; the two failures were the script's own assertions and the screen was right in both: Hamburg's latitude is 53.633, not 53.5…, and the toast's Undo measured 43.9999 px in mobile emulation (44 px in the follow-up below). What it saw, compared with the database where possible:
  - 1440 × 900 light, `/today`: "Tuesday 3 November in Bologna, Italy"; the weather card with light rain, 9 °C now, feels like 2 to 8 °C, air 6 to 11 °C, 80 % chance of rain (the hourly maximum, above the daily 78 %), 3.4 mm, gusts up to 53 km/h, "Forecast from 15:00." and the "Weather data by Open-Meteo.com" link to https://open-meteo.com/; the three cards with the items' wear counts, "Rain-ready" or "Not for rain", and the reasons. Tab from the top reaches the credit link, Suggest again and the first Save, each with a visible focus ring, never `<body>`. Save made one `outfits` row (source ai, `ai_reasoning` the card's why, 2.1 to 7.6 °C, rain OK, 7 items as suggested), recorded in `params.savedOutfitIds[0]`, and focus moved to "Open saved outfit". "Wore this today" on the dress card wrote 5 logs for today with the weather snapshot and no outfit and added 1 to each count; the button read "Worn today"; Undo removed the logs and restored the counts. "Suggest again" without a key showed "Configuration problem … The server is misconfigured. Check the server logs." with no new `ai_calls` row or analysis, and the cards stayed. Sidebar: "Get dressed" with Today marked current, Wardrobe not.
  - `/outfits/new`: Save on the empty form marked Top or dress ("Choose a top or a dress.") and Bottom ("Choose a bottom, or a dress as the top.") and the name, focus on "Choose top or dress"; a sweater alone still flagged Bottom; changing the top to a dress made Bottom "Optional with a dress" and the message went; Escape in a picker returned focus to its Choose button; outerwear, base layer, shoes, hat, gloves, scarf and two accessories (a bag and an umbrella) filled in, "9,5" typed with a comma. Saved: 3.0 to 9.5 °C, rain OK, rating 5, source user, 9 items, no bottom, the dress in the top slot. Listed on `/outfits` with "Rainy office day" and "3 to 9.5 °C" next to the saved suggestion. Edited on its page (name and rating 3, saved in the database), deleted after the confirmation; the 300 items stayed.
  - Item page: "+1 worn today" on a top with 3 wears showed "4 times" and the database said 4; on `/wardrobe` (reached through the sidebar and the search box, so the toast stayed) its card read "Worn 4×"; Undo pressed there brought the database back to 3 and the card, read again while shown, to "Worn 3×"; the item page then showed "3 times".
  - Settings: "Get dressed" with Today and Outfits, the AI usage, Climate profiles and export links, Features with Shopping advice "Off". Home city set to Hamburg: saved, `/today` showed "in Hamburg, Germany" and "Weather in Hamburg", the stub received one request for 53.633, 9.988, Europe/Berlin, and Bologna's suggestion was not shown; a reload made no new stub request (the cache); Bologna restored.
  - `/shopping` with the flag off: no "What to buy next", and `POST /api/shopping/advice` answered 404.
  - 390 × 844 dark: the wardrobe header shows Today, Outfits and Add items (each 44 px tall), the tab bar five tabs; on `/today` the Wardrobe tab is marked; three cards; a wear and its Undo left no logs; the builder and the open picker (searching "dress") fit; `/outfits`, the saved suggestion's page with "Why Claude suggested it", the item page ("+1 worn today" 44 px), Settings and `/shopping` fit. No page scrolled sideways at either width. axe (WCAG 2.0 and 2.1 A and AA): no serious or critical violation on `/today` (also with the error), the builder, `/outfits`, the outfit page, the item page, Settings and `/shopping` at 1440, and on the wardrobe, `/today`, the builder, the picker, `/outfits`, the outfit page and Settings at 390 dark. No console errors besides the expected 500 of the no-key suggestion.
  - Follow-up `check6b.cjs` at 15:05:21, 390 dark: 1.2 s after "Wore this today" the toast sits above the tab bar (Undo at y 691 to 735, the bar from y 793), Undo is 44 px tall, and Undo left no logs.
  - Screenshots in `scratchpad/phase6-shots/` (01 to 31), all looked at. Full-page captures show the sticky sidebar and the fixed tab bar part way down the page; that is how full-page screenshots draw sticky and fixed elements, not the page.
- Real Open-Meteo, once, with the server restarted without `OPEN_METEO_BASE_URL` (`check6-live.cjs`): 15:06:08 `/today` for Bologna parsed and showed "Overcast, 15 °C now", feels like 6 to 13 °C, air 8 to 15 °C, 3 % chance of rain, 0 mm, gusts up to 22 km/h, "Forecast from 15:06." with the credit link; 15:06:09, after switching the home city, Hamburg showed "Light rain showers, 10 °C now", feels like 5 to 8 °C, air 6 to 11 °C, 50 %, 0 mm, gusts 19 km/h, with the credit; home city back to Bologna at 15:06:10. Two forecast requests; no error in the server log.
- Clean-up: the 3100 server's process chain stopped by PID at 15:05 and 15:06 (the stub run and the live run), the stub (PID 29524) at 15:06:29; ports 3000, 3100 and 3901 free at 15:06:29; `reset.sh` at 15:06:29 removed the 300 demo items, the analyses, outfits, wear logs and `ai_calls` the check made, and left the home city Bologna.
- Final gate with no `.env.local` on the final tree (moved to `scratchpad/envlocal-aside6/`, empty before, empty again after): moved 15:09:11; `pnpm typecheck` to 15:09:18, `pnpm lint` to 15:09:36, `pnpm test` to 15:10:51 (157 files passed, 2 skipped; 2,425 tests passed, 2 skipped), `pnpm build` to 15:11:04; restored 15:11:04. All passed. 15:11:09 grep of `.next/static` (60 JS files): the same result as above (no secret name or prompt phrase; `BLOB_READ_WRITE_TOKEN` only as `@vercel/blob`'s lookup; the control string in 3 files). `git status` lists no `.env*` file except `.env.example`. At 15:11:17 ports 3000, 3100 and 3901 were free, and both Docker databases (`wardrobe` and `wardrobe_e2e`) held no items, analyses, outfits, wear logs, shopping rows or `ai_calls`, with Bologna as the home city.

### Migration and deploy state

No new migration: `pnpm db:generate` reported no schema changes at 14:51:06, again at 16:22:39 after the review fixes, and at 16:55:20 (the lead's final check), and `pnpm db:migrate` found nothing new on the Docker `wardrobe` database; `wardrobe_e2e` is migrated by the e2e global setup. Neon has not been migrated: the Phase 4 `archived_from` migration is still pending there (wardrobe-c8x). Not deployed. `OPEN_METEO_BASE_URL` must stay unset in Vercel.

### Open risks

- No outfit suggestion or shopping advice has called Claude. Unmeasured: whether the API accepts both wire schemas, the real cost against the estimates ($0.048 for a typical wardrobe on Sonnet, $0.031 for the advice), the latency against the 110 s deadline at effort low, refusals, and the quality of the outfits and the ranking under `outfit-v2` and `shop-v2`. The browser check's outfits came from a scripted fake, which chose items crudely (shorts at 2 °C); the strict check accepts any valid combination, so dressing well depends on the prompt.
- Undo recomputes `last_worn_at` from the item's remaining logs (D-196). An item whose last worn day has no log behind it loses it on Undo: only the demo seed makes such rows today (seen in the browser check: 2 of the dress outfit's 5 demo items went from a seeded date to none), but any future import of wear history would behave the same.
- The forecast cache is Next's default handler: on Vercel that is per function instance and in memory, so each cold instance fetches again. Harmless for one owner, but "a second load within 30 minutes makes no new request" is confirmed only locally against the stub, and the live API was asked only twice.
- A suggestion or shopping run whose function is killed leaves its `analyses` row "running"; another request gets CONFLICT for up to 130 s (D-204, D-220). Not exercised outside the tests.
- The per-piece warmth limits (D-225) are a judgement on the tagging rubric's scale: canvas sneakers tagged warmth 1 no longer count in April or October, and an outfit of a t-shirt and shorts (2) still does not reach the mild band's 3 without a layer. The counts are a signal for the ranking, not shown as exact.
- A hand-added shopping row bought after the latest plan but added before it is not subtracted from that plan's budget (D-219): rows have no bought-at date.
- After the `outfit-v2` and `shop-v2` bumps, the first "Suggest outfits" and "Rank" make a paid call even where an older stored result exists (none was paid yet).
- "What to buy next" with the flag on has been seen in a browser only with a fake Claude (the review session's visible check); the flag stays off until the owner decides (D-040).
- The Wardrobe tab is marked on `/today` and `/outfits` on a phone (D-218); the owner may prefer no marked tab there.
- Next keeps `/outfits/new` alive but hidden after a save (Activity), so a script or test that looks up "the outfit form" by label finds two; the hidden one is not exposed to assistive technology. The e2e specs scope to the page they are on.
- The risks in the entries below stand.

### Live checks pending

- A real "Suggest outfits" on the owner's wardrobe once the owner approves the spend (about $0.05 on Sonnet, $0.003 on Haiku): three valid outfits from owned items only, one `ai_calls` row, the stored cost against the estimate, a second click answered from the stored suggestion with no new row, and "Suggest again" making one new call (wardrobe-r67).
- With `FEATURE_SHOPPING_AI=true` in a test environment and a real key: one ranking with its cost, unlock counts matching the app's, the budget split within the remaining budget, "Add to shopping list", "Run again", and a second tab refused while it runs (wardrobe-0j7).
- On a Vercel deployment: `/today` for Hamburg and Bologna from the real Open-Meteo, and a second load within 30 minutes on the same instance making no new request (the function log, D-203) (wardrobe-5u9).
- The live checks in the entries below.

### Next steps

Phase 6 is committed with this entry, and wardrobe-g4t is closed. All six phases of the plan are built. What remains is live checks, owner decisions and the deploy, which happens only when the owner asks.

1. The owner decides on D-093 and D-134 (wardrobe-any). Also on the phone navigation of D-218, the meaning of the advice budget (D-219) and the per-piece warmth limits (D-225) (wardrobe-7oq).
2. Once the owner sets `ANTHROPIC_API_KEY` and approves the spend:
   - the live relocation run (wardrobe-izw);
   - the live outfit suggestion (wardrobe-r67);
   - the shopping advice with the flag on, and the owner's decision on enabling `FEATURE_SHOPPING_AI` (wardrobe-0j7).
3. Before the next deploy, run `pnpm db:migrate` against Neon for the Phase 4 migration (wardrobe-c8x).
4. The Blob and tagging live checks (wardrobe-aea).
5. On a deployment, check the forecast cache (wardrobe-5u9).
6. Bump `next`, `eslint-config-next` and `@next/env` together once the announced security release is out, and re-check D-180, D-183 and the Activity behaviour D-200 relies on (wardrobe-9ri).
7. Low priority: Undo clears a last-worn day with no log behind it, and shopping rows have no bought-at date (wardrobe-p11).

## 2026-11-03 — Phase 5 (relocation)

### State

Phase 5 (wardrobe-evp) is built and integrated, not yet committed. Four implementation runs wrote it on disjoint files: core (the pure relocation modules, the climate range and prompt text, the fixtures), server (the relocation service, the parts route and the actions), relocate-ui (the `/relocate` pages and components) and lists (the shopping list, the climate editor, their services, actions, pages and e2e specs). The integration session then joined the pieces, ran the whole flow once through the real code paths with a fake Claude, ran the gate with no `.env.local`, Docker, the headed e2e suite and a visible-browser check with the 300-item demo seed, fixed what those found, and re-ran every check on its tree (see Checks run). No migration was needed. Nothing called the real Anthropic API.

A review then reported 14 findings, and an independent check confirmed all 14 and rejected none. They are 12 distinct defects, because p5-sec-1 repeats p5-ai-2 and p5-sec-2 repeats p5-ai-1. A review-fix session fixed all 12. Each fix has a regression test that failed with the fix reverted and passed again once the file was restored byte for byte. One more fix went in on top of the p5-ux-1 change, found while preparing the browser check (see Review, round 1). The session then re-ran the gate with no `.env.local`, Docker, the headed e2e suite, and a visible-browser check of every screen the fixes touched.

A second review, with lenses the first did not cover (the Anthropic API contract, Postgres concurrency, the fixes themselves, Next's kept routes, scale, and the docs), then reported 24 findings; an independent check confirmed all 24 and rejected none. The round-2 fix session re-checked each against the code and found all real. It fixed 23 in code or docs, each code fix with a regression test seen failing with the fix reverted (36 scripted revert cases run in three batches, plus two checks by hand; every file restored byte for byte, checked by sha256), and left one for the lead: p5r2-doc-5 needs Beads issues, which this session may not create. Two of the fixes were completed after the visible-browser check showed the first version failing in a real browser (the Gaps tab's own refresh, and the focus after removing a packing extra; see Review round 2). The prompt is now `reloc-v3`. No migration. The session then re-ran the gate with no `.env.local`, Docker, the headed e2e suite and a visible-browser check of every screen a fix touched, all on its tree (see Checks run). Still not committed; Beads not touched.

A third review then looked for regressions and incomplete fixes from round 2 and took a fresh end-to-end look: 17 findings, all confirmed by an independent check, none rejected (p5r3-ai-1 to -3, p5r3-ui-1 to -5, p5r3-ui-cr7, p5r3-journey-1 to -4, p5r3-doc-1 to -4). The round-3 fix session re-checked each against the code, found all 17 real and fixed all 17: code findings with a regression test seen failing with the fix reverted (19 scripted revert cases, every file restored byte for byte and checked by sha256), p5r3-ui-4 in a visible browser (its fix is CSS, which jsdom cannot see) with the old row seen failing in the live DOM, and the documentation findings in the docs. Three were incomplete round-2 fixes in the shared AI layer and the part costs (p5r3-ai-1 to -3), and p5r3-ui-1 was partly a regression from round 2's plan refresh; wardrobe-cr7, the toast close button, is fixed (the lead closes the issue). The prompt is now `reloc-v4` (D-179). No migration. The session re-ran the gate with no `.env.local`, Docker, the headed e2e suite and a visible-browser check of every screen a fix touched, on its tree (see Checks run). Still not committed; Beads not touched.

A fourth review then looked only at what the round-3 fix pass changed (tree e3a8a28 to tree 9e5796d) and at defects those changes expose: 6 findings, all confirmed by an independent check, none rejected (p5r4-state-1 to -3, p5r4-rest-1 to -3). The round-4 fix session re-checked each against the code, found all 6 real and fixed all 6: the four code findings each with regression tests that failed on the unfixed tree and again with the fix reverted, p5r4-rest-2 in D-177 with tests that pin the documented tagging behaviour and fail with the round-3 change reverted (9 scripted revert cases in all, every file restored byte for byte and checked by sha256), and p5r4-rest-3 in this entry. One was a regression from round 3 (p5r4-state-1, an extra counted twice), three were incomplete round-3 fixes (p5r4-state-2 and -3 in the plan's and `/shopping`'s freshness, p5r4-rest-1 in the shared AI layer), and one was a decision text round 3 had left untrue (p5r4-rest-2). The p5r4-state-3 fix was completed after the visible-browser check showed its first version, the one the finding proposed, doing nothing in a real browser (see Review round 4). wardrobe-cr7, the toast close button, stays fixed since round 3 (the lead closes the issue). No prompt change (still `reloc-v4`), no migration. The session re-ran the gate with no `.env.local`, Docker, the headed e2e suite and a visible-browser check of every screen a fix touched, on the final tree (see Checks run). Still not committed; Beads not touched.

The lead then checked the final tree independently: the gate with no `.env.local`, a grep of the client bundle, Docker, the headed e2e suite, and a visible-browser check with its own script, which compares each screen with the database. All passed (see "Final checks by the lead" under Checks run). The lead created wardrobe-izw (the live relocation run) and wardrobe-cr7 (the toast close button). Phase 5 is committed with this entry; wardrobe-evp and wardrobe-cr7 are closed at that commit.

What Phase 5 adds:

- `/relocate`: the form (climate profile, dates, constraints with the spec's three example chips, purchase budget with a €600 example, "Confirmed items only"), a live cost estimate that needs no API key, the placeholder-data consent, the cached-result banner with "Re-run anyway", and the list of earlier analyses (D-142, D-152).
- `/relocate/[id]`: while unfinished, the progress page that runs the parts from the browser (chunks of at most 70 items, four at a time, then the synthesis) and resumes after navigation; when finished, the summary and the Items, Gaps, Layering, Packing and Warnings tabs with overrides, "Apply AI decisions to N undecided items", gaps to the shopping list, and the persisted packing checklist with extras (D-146, D-150).
- `/relocate/[id]/print`: the packing checklist alone, for paper.
- `POST /api/analyses/[id]/parts/[partId]`: one part per request, `maxDuration` 300, Claude stopped at 270 s, a 5-minute lease (D-145).
- `/shopping`: the list fed by the gaps, plus entries added by hand, status, linking to an owned item, delete, and the budget panel (D-154).
- `/settings/climate`, linked from Settings: the 12-month editor for each profile and the default switch (D-153).
- `src/lib/relocation/*` and `src/lib/climate/range.ts`: contracts, the item lines and snapshot hash, the chunk plan and cache key, the wire, strict and final schemas, the prompts (`reloc-v2` since the first review, D-160, `reloc-v3` since the second, D-171, and `reloc-v4` since the third, D-179) and the cost estimate; `src/lib/saved-since-read.ts` (since the third review: saves kept over a server copy and one read per show, D-180); `test/relocation-fixtures.ts`.
- New e2e specs `relocate`, `shopping` and `climate`; the axe spec now covers the Phase 5 pages.

Integration, by item:

- Print: the sidebar, the mobile tab bar and the toast viewport are `print:hidden`, and the main area is `print:p-0 print:bg-white` (`app-sidebar.tsx`, `mobile-tab-bar.tsx`, `toast.tsx`, `src/app/(app)/layout.tsx`), as the relocate-ui run asked. The visible-browser check then showed the dark theme printing black text on a dark page, so `globals.css` makes the body white in print (D-155). The compiled CSS puts the print block after the `md:` block, so `print:hidden` wins over the sidebar's `md:flex` (checked in the built stylesheet).
- Gaps to `/shopping`: the result page now calls `noteShoppingListChange()` after gaps were added, so Back to a `/shopping` that Next kept shows them (new assertion in `relocation-results.test.tsx`, seen failing without the call).
- Climate editor to `/relocate`: the form's placeholder warning links to Settings, Climate profiles, and a saved profile now notes a change (`noteClimateProfileChange` in `run-changes.ts`, called by `climate-profiles.tsx`), so Back to a kept `/relocate` reads the profiles again and the placeholder mark goes (new test in `climate-profile-editor.test.tsx`, seen failing without the call; seen in the browser).
- `test/item-freshness.test.ts` covers `/shopping`; the relocate-ui run had added the result page (D-151).
- `test/boundaries.test.ts`: client code may not import `@/lib/relocation/payload`, `chunks`, `prompts` or `estimate` (a scratch client file importing the prompts made the test fail); the three new services are in the `server-only` and session-check guard lists, and the parts route in the browser-only walk (D-156).
- The unused `getRelocationRun` Server Action is removed, with its three assertions in `src/server/actions/relocation.test.ts`; the service function stays (the pages use it).
- `e2e/a11y.spec.ts` seeds a finished and an unfinished relocation run (snapshots built with the real payload and chunk code) and two shopping entries, and scans `/relocate`, the print page, the progress page stopped by the configuration error, the relocation not-found page, `/shopping`, `/settings/climate`, each of the five result tabs, and the result at 390 px.
- Found by the first e2e run and fixed:
  - The axe scan of the progress page found the destructive Alert's red at 4.49:1 (below 4.5:1); `alert.tsx`'s destructive variant now uses `--destructive-strong` (D-155 a). Every destructive alert in the app changes with it.
  - `relocate.spec.ts`'s "On your shopping list" text also matched the button "All gaps are on your shopping list"; it now matches exactly.
  - `shopping.spec.ts`'s `getByRole("dialog")` also matched the "Linked" toast; it now names the link dialog.
- Found by the visible-browser check and fixed:
  - Muted counts in the result tabs (4.3:1 on the muted tab list) and the stale estimate's 60 % opacity failed the axe contrast check; the counts take the trigger's colour and a stale estimate is greyed instead (D-155 b, c).
  - At 390 px the result tabs wrap onto two rows, and each trigger took the full height of the two-row list (87 px), so the second row (Packing, Warnings) was drawn over the "Apply AI decisions" button. The triggers are `h-auto` now (44 px, both rows inside the list, measured before and after in the browser), and the phone-width test in `relocate.spec.ts` checks that every trigger lies inside the tab list and is the top element at its centre.
  - "Bring items not in the checklist" listed 57 items that were already in Hamburg or on their way. `RelocationItemRefDto` gains `location` (the item's current location, null when deleted), the service fills it, and the Packing tab leaves those items out (new test seen failing without the filter; in the browser the list showed 23 items, matching a database query of the same rule). Since round 2 "already there" is relative to the run's destination (D-170).
- `README.md` has new Relocation, Shopping list and Climate profiles sections, the relocation estimate in Costs, the new specs in Testing, and the new folders in Project structure; `e2e/README.md` describes the three new specs and the wider axe scan.

Deviations from `design.md` Phase 5 and the shared contract, as the runs reported them (all recorded in the decisions below):

- Line caps are tighter than the contract's (name 40, subcategory 20, entries 20, at most 3 colours and 3 materials) and the low-confidence marker uses short codes (`lc:mat,w`), because the contract's caps allowed lines of about 205 tokens (D-141).
- `buy_before_or_after_move` uses `after_move`, not `after_move_in_hamburg` (D-027). `togglePackingItem` is `setPackingItemPacked`. "Unassigned bring items" is titled "Bring items not in the checklist".
- `WardrobeSummary` has two extra fields (`unconfirmed`, `alreadyMoved`); `RelocationViewDto.completedAt` and `effort` are nullable; `ShoppingItemInputSchema` has defaults; `defaultRelocationDates` takes a time zone (Europe/Berlin); `RelocationItemRefDto` has `location` (integration).
- The strict schemas check more than the contract listed (every object strict, duplicate `gap_key`s, a packing group listed twice; blanks cleaned up instead of retried) (D-144).
- Gap keys: the integration's category-and-type slugs lost the run's order on `/shopping`; since the review they are `g<position>-<slug>`, from one `makeGapKey` that the service and the fixtures share (D-159).
- `estimateRelocation` and `startRelocation` take an options object (`now`, `force`); `RelocationPartDeps.anthropic` is a getter (D-064).
- The chunk plan is greedy in snapshot order, giving 6 chunks for 300 items where an optimal packing gives 5 (D-143).
- The shared climate and shopping schemas (`ClimateProfileUpdateSchema`, `ShoppingItemUpdateSchema`, the shopping order and totals) live in client-safe component modules (`src/components/climate/climate-model.ts`, `src/components/shopping/shopping-model.ts`) that the services import, rather than in `contracts.ts`.
- `/settings` lost its "Coming soon" section, whose only entry was the climate profiles.
- When nothing is left to do, the buttons say "No undecided items left" and "All gaps are on your shopping list" instead of showing 0.

Statements in the entries below that are no longer true:

- Next steps item 4 of the Phase 4 entry ("Phase 5 (wardrobe-evp)") is done, apart from the commit.
- D-138 said `/shopping` showed no item data; its rows show linked items and it reads itself again after item changes (D-138 corrected, D-151).

### Decisions

D-183 to D-185 are new, under "Added in the Phase 5 fourth review": a copy no refresh asked for counts as read when the previous copy was, and an extra the plan's view lists shows once (D-183), the print page counts its read from the press of "Print checklist" and reads again when a change is noted while it is shown (D-184), and once a call has had a reply, a retry after an HTTP or connection error also needs the longest reply's time (D-185). They refine D-164 and D-177 (D-185), D-173 and D-181 (D-184) and D-180 (D-183); those entries now say so. The text of D-154 (a copy a navigation brought), D-164 (a), D-173 (c), D-177 (HTTP and connection errors, and what changed for tagging, p5r4-rest-2), D-180 (unrequested copies, extras) and D-181 (changes noted while shown) was corrected to what the code now does, as were README's relocation, Packing, results and Shopping list paragraphs.

D-177 to D-182 are new, under "Added in the Phase 5 third review": retries need time for the longest reply of the call and an SSE error event counts as a broken reply (D-177), part costs rounded by Postgres (D-178), prompt `reloc-v4` (D-179), saves kept over a server copy until a read asked after them arrives, and one read per show (D-180), checklist items no longer coming and the print layout (D-181), and five focus and accessibility fixes, the toast close button among them (D-182). They refine D-050 and D-153 (D-182), D-136, D-151 and D-154 (D-180), D-140 (D-179), D-150 and D-173 (D-180, D-181), D-155 (D-181), D-162, D-172 and D-174 (D-182), D-164 (D-177), D-168 (D-178) and D-171 (D-179); those entries now say so. The text of D-019 (status), D-050 (the toast edit), D-139 and D-170's heading (the moved ids and the profile's slug since D-170, p5r3-doc-3), D-140 (`reloc-v4`), D-150 (saves kept, the print page), D-151 (the item check now runs inside the components), D-154 (a status kept), D-164 (a), D-168 (rounding), D-173 (`copy.refresh`) and D-175 (its own reason and the tested limits, p5r3-doc-2) was corrected to what the code now does.

D-163 to D-176 are new, under "Added in the Phase 5 second review": broken streams retried and their reported usage recorded (D-163), retries only when they can finish and one output cap per relocation call (D-164), case-insensitive enum checks (D-165), the ordered lock of "Apply AI decisions" (D-166), parts that run to their end when the tab closes (D-167), part costs written per attempt (D-168), completed placeholder profiles (D-169), "already there" relative to the destination (D-170), prompt `reloc-v3` (D-171), two focus fixes (D-172), three more pages that read again (D-173), the result page's render cost (D-174), the synthesis size check (D-175) and the yearly rain in whole millimetres (D-176). They refine D-012 (D-169, D-176), D-019 and D-062 (D-163, D-164), D-020 (D-163), D-140 (D-170, D-171, D-176), D-141 and D-148 (D-170), D-144 (D-165), D-145 (D-164, D-167), D-147 (D-168, D-175), D-150 (D-166, D-170, D-174), D-151 (D-173), D-153 (D-169), D-157 (D-167), D-160 (D-171), D-161 (D-163, D-168) and D-162 (D-172); those entries now say so. D-021 is re-corrected (Sonnet 5.5 cache reads are 0.05x, $0.10 per MTok, per the live pricing page fetched on 2026-11-03; the 2026-11-02 change followed a stale bundled reference). The text of D-113 (the a11y spec's progress scan skips with a key), D-140 (version, marker, prompt size), D-141 (marker), D-144 (enums), D-145 (the request signal), D-147 (synthesis output, input tokens, the high range), D-148 and D-150 (destination), D-153 (source), D-157 (reload) and D-062 (the `stream_interrupted` label) was corrected to what the code now does.

D-157 to D-162 are new, under "Added in the Phase 5 review". They refine D-140 and D-144 (D-160), D-145 and D-146 (D-157), D-147 (D-161), D-149 and D-154 (D-159), D-150 and D-155 (D-162) and D-152 (D-158); those entries now say so. The text of D-140 (version and pin), D-144 (a repeat within a packing group), D-145 and D-146 (a failed part needs the owner's Retry), D-149 (the key format) and D-152 (the budget field) was corrected.

D-139 to D-156 are new, under "Added in Phase 5". They refine D-012 (D-153), D-019 (D-144), D-025 (D-139, D-143, D-145, D-146), D-026 (D-147), D-027 (D-144, D-149), D-028 (D-139, D-141, D-142, D-150), D-029 (D-149), D-050 (D-155), D-057 (D-153), D-080 (D-145), D-107, D-123, D-129 and D-138 (D-151) and D-117 (D-155); those entries now say so. D-026's figure, D-050's list of edits to generated files, D-080's list of route durations, D-113's list of specs that skip with a key and D-138's list of pages without item data were corrected to what the code now does.

### Review (round 1)

The review reported 14 findings, and an independent check confirmed all 14 and rejected none. This session re-checked each one against the code before changing it, and all were real. Each got the smallest fix and a regression test. Every test was seen failing with its fix reverted (`scratchpad/revert5b.py` reverts one fix, runs the named tests, and restores the file byte for byte, checked by sha256). Severities are the verifier's.

- **p5-ai-1** and **p5-sec-2** (low, confirmed; the same defect): gaps added from a real run lost Claude's order on `/shopping`. The service's gap keys had no position, and only the fixtures wrote `g1-` keys.
  - Changed: one `makeGapKey(index, gap)` in `schemas.ts` writes `g<n>-<category and type slug>` for the service and the fixtures. The service's `slugify` and `gapKeysFor` are gone (D-159).
  - Test: `relocation.test.ts` "keeps the synthesis's most-important-first order on the shopping list" (a real run on PGlite with four gaps of one priority, then `addGapsToShoppingList` and `getShoppingList`). Without the fix the rows came back in alphabetical order.
- **p5-ai-2** and **p5-sec-1** (low, confirmed; the same defect): a part's stored cost left out the paid attempts of a call that gave up.
  - Changed: `callStructured` gains `onAttemptCost`, and the service adds every paid attempt as it is logged (D-161).
  - Tests: `call.test.ts` "reports each paid attempt's cost as it is logged, also when the call gives up".
  - In `relocation.test.ts`, "stores the cost of every paid attempt of a call that gave up, and adds a Retry's to it" ($0.03, then $0.04 after the Retry) and "stores the chunk call and every paid repair attempt when the repair gives up" ($0.04).
  - The synthesis all-invalid test now expects $0.03. All four failed without the fix.
- **p5-ai-3** (low, confirmed): a gap note over 300 characters (a limit Claude was never told) and an alias repeated within one packing group each cost a paid synthesis retry.
  - Changed: the wire descriptions and the synthesis instruction state the 300-character gap-note limit and the 120-character extras limit. A repeat within one group passes. The prompt version is now `reloc-v2` (D-160).
  - Tests in `schemas.test.ts`: a guard that every text cap of the synthesis check is stated in the wire schema (failed with the old gap_note and extras descriptions), plus "accepts a gap note of up to 300 characters" and "accepts an alias repeated within one packing group".
  - Test in `relocation.test.ts`: "keeps an item listed twice in one packing group once". It and the repeat test failed with the old check.
  - Test in `prompts.test.ts`: the instruction phrases, which failed with the old instruction.
- **p5-ai-4** (low, confirmed): the version pin covered only the system prompt.
  - Changed: `prompts.test.ts` pins, per version, a second sha256 over the instructions, the shared-context template, the legend, the summary format and both wire schemas (D-160).
  - Seen failing: with the p5-ai-3 instruction edit and the version still at `reloc-v1`, the new pin failed, while the old test file still passed on the same code.
- **p5-ux-1** (confirmed; the reviewer rated it medium, the verifier low): a part that failed in another tab, or in a request a reload cut off, was run again automatically, a paid call nobody asked for.
  - Changed: the parts route takes `{ "retry": true }`. Without it the service answers a failed part as it is, needing no key or budget. The page sends the flag only after Retry, "Retry failed parts" or "Try again", and it shows a failure the server reports for a part it was waiting on (D-157).
  - Tests: `relocation.test.ts` "records a failed call on the part…" (a re-ask without the flag makes no call, does not ask for the key and leaves attempts at 1; the Retry completes the part).
  - `route.test.ts`: "answers a failed part as it is unless the body asks for a Retry" and "refuses a body with unknown keys or a non-boolean retry".
  - `run-orchestrator.test.ts`: "shows a part that failed elsewhere while this tab waited on it as failed…", "takes a failure the server reports while paused…", and the flag assertions in "resumes a run…" and "flags only the parts that failed when Try again follows a stop".
  - `run-progress.test.tsx`: the request-body assertion.
  - Reverting the service check, the route, the orchestrator's merge, the flag, and the pass-through in `run-progress.tsx` and in `run-api.ts`, one at a time, each failed its tests.
  - Found while preparing the browser check: in the first version of this fix, a Retry answered by a stop (no API key) used up the flag, so "Try again" afterwards showed the part as failed again instead of running it. A stop answer now keeps the flag, since nothing ran. Test: "keeps a Retry that a stop answered before anything ran…" (failed without the line).
- **p5-ux-2** (low, confirmed): Retry, "Try again" and "Retry failed parts" dropped keyboard focus to `<body>`.
  - Changed: focus moves to the progress page's status line (D-162 a).
  - Tests in `run-progress.test.tsx`: the focus assertion in "leaves a failed part alone until Retry…" and "moves focus to the status line after Try again and after Retry failed parts". Both failed without the focus call.
- **p5-ux-3** (low, confirmed): focus was lost after "Apply AI decisions".
  - Changed: `focusableWhenDisabled` on the trigger (D-162 b).
  - Test: the apply test now expects focus on "No undecided items left" with `aria-disabled`, and checks that pressing it opens nothing. It failed without the fix.
- **p5-ux-4** (low, confirmed): focus was lost after linking an owned item.
  - Changed: the link and Unlink buttons share the ref the dialog returns focus through (D-162 d).
  - Test: `shopping-list.test.tsx` "puts focus on Unlink after linking, not on <body> or another row" (opening and cancelling another row's Delete dialog first). It failed without the fix.
- **p5-ux-5** (low, confirmed): a budget the browser could not read became "no budget".
  - Changed: the budget is a text field with the numeric keyboard (D-158).
  - Test: `relocation-form.test.tsx` "never reads a budget it cannot parse as no budget". It failed with `type="number"`.
- **p5-ux-6** (low, confirmed): the kept form ignored a new default profile.
  - Changed: an untouched form follows the new default and clears the placeholder consent (D-158).
  - Test: "follows a new default profile while kept hidden, unless the owner chose a profile". It failed without the fix.
- **p5-ux-7** (low, confirmed): the Packing tab's count ignored extras added or removed on the page.
  - Changed: `RelocationResults` keeps the added and removed rows and counts them (D-162 e).
  - Test: "adds an extra to a group and removes it again" now checks "Packing N+1" and back. It failed without the fix.
- **p5-ux-8** (low, confirmed): the apply confirmation came back after Back and Forward.
  - Changed: it resets when Next hides the page, unless the request is still out (D-162 c).
  - Test: "closes the confirmation and forgets its error when Next hides the page". It failed without the fix.

Not changed in round 1: two places where focus also falls to `<body>`, of the same kind as p5-ux-2 but not among the findings: the climate editor's "Set as default" and a packing extra's Remove. Round 2 fixed both (p5r2-fix-5, p5r2-fix-6, D-172).

### Review round 2

The second review reported 24 findings with an independent check of each: all 24 confirmed, none rejected. This session re-checked each against the code before changing it, and all were real. "Seen failing" means the regression test failed with the fix reverted (`scratchpad/r2fix5/revert5c.py`, which patches one fix out, runs the named tests and restores every file byte for byte, checked by sha256); its 36 cases are listed below by finding, and the Checks run say when they ran. Severities are the verifier's.

- **p5r2-api-1** (medium, confirmed): a streamed reply cut off mid-body, or ended before `message_stop`, came out of the SDK as a plain `AnthropicError`, so `classifyError` called it INTERNAL: no retry, "Something went wrong", and an `ai_calls` row with no tokens although message_start had reported 6,000 input tokens.
  - Changed: `callStructured` rewraps exactly that case as `StreamInterruptedError` (retried, AI_UNAVAILABLE, label `stream_interrupted`, with the stream's request id) and logs the usage the stream had reported, which also counts toward the call, the part and the budget; `MessageStreamLike` gained `on("streamEvent")`, and the fake client a `broken` step (D-163).
  - Tests: `call.test.ts` drives the real SDK with a scripted body (no network): a socket closed mid-body and a body ended early are retried and log `stream_interrupted` with 6,000 input and 2,000 cache-write tokens; three broken streams give AI_UNAVAILABLE "(gave up after 3 attempts)"; a deadline abort mid-stream is still `deadline`; a `TypeError` from `create()` is still INTERNAL. `retry.test.ts` covers the classification and request id; `relocation.test.ts` "retries a chunk whose stream broke off…" checks the part's cost. Seen failing: without the rewrap (4 tests) and without the usage (3 tests).
- **p5r2-api-2** (low, confirmed): Sonnet 5.5 cache reads were priced at 0.1x ($0.20 per MTok). The live pricing page, fetched again this session, says 0.05x ($0.10).
  - Changed: `models.ts` sets 0.05; D-021 re-corrected. Existing rows keep their cost (no live Sonnet rows exist).
  - Tests: `models.test.ts` and two `cost.test.ts` cases (1M cache-read tokens cost $0.10, $0.05 in a batch). Seen failing with 0.1.
- **p5r2-api-3** (low, confirmed): the strict checks compared enum values case-sensitively, so "Bring" or "Suitcase" cost a whole paid retry.
  - Changed: a `looseEnum` in the strict chunk and synthesis schemas trims and lower-cases before comparing; the wire schemas are unchanged (D-165).
  - Tests: two `schemas.test.ts` cases ("Bring", " LEAVE ", "Outerwear", "Before_Move", "Suitcase", "Duplicate" accepted and stored lower-case; "pack", "br ing", "outer wear" and a group named twice in two cases still fail). Seen failing with plain `z.enum`.
- **p5r2-pg-1** (low, confirmed): two applies of different runs at once could deadlock.
  - Changed: `applyAiDecisionsToUndecided` first locks every candidate row ordered by id `FOR NO KEY UPDATE` (D-166).
  - Tests: `relocation.test.ts` records the SQL through a drizzle logger and checks the ordered lock comes before the first update; the new opt-in `relocation-apply.pg.test.ts` applies two crossing runs at once for 20 rounds. Seen failing: the SQL test without the lock, and the Postgres test on a scratch Docker database (`wardrobe_r2fix5_pg`, created 04:04:40, dropped 04:11:41) with "40P01 deadlock detected" in round 1; with the lock it passed.
- **p5r2-fix-1** (low, confirmed): on Vercel a closed tab never aborted a part (cancellation is opt-in per path), but the page, README and D-145 said it stopped the running parts.
  - Changed: the parts route no longer passes `request.signal`, so a part finishes or fails on the server everywhere; the progress hint, the route and page comments, README, D-145 and D-157 say so (D-167). `supportsCancellation` stays off for this route.
  - Tests: `route.test.ts` "runs a part to its end when the browser has gone…" (a request whose signal already fired completes its chunk), and `run-progress.test.tsx` checks the new hint. Seen failing: the route test answered 504 with the signal passed on; the hint test with the old text.
- **p5r2-fix-2** (low, confirmed): after a lease takeover, a part's stored cost left out the attempts of the request that was cut off.
  - Changed: `onAttemptCost` may return a promise, which `callStructured` awaits; the service adds each attempt's cost to its part as soon as it is logged (rounded as `ai_calls` stores it, no lease check), and the completion, failure and synthesis writes no longer set the cost (D-168).
  - Test: `relocation.test.ts` "keeps on the part the cost of a request cut off before it could record anything" (a hanging repair, a takeover 5 minutes later; the part's cost equals the `ai_calls` sum, $0.02). Seen failing with the previous service file (the part read $0 while its first attempt was already logged). The browser check's seeded run also showed the parts summing to the run's `ai_calls` total on Docker Postgres ($0.51538).
- **p5r2-fix-3** (low, confirmed): a completed Bologna still told Claude its data was a placeholder, through `source` and the seeded notes.
  - Changed: the save that clears the mark sets the source to "Monthly values entered by the owner in Settings, Climate profiles." and replaces the notes when they are still exactly as seeded; the toast says when the notes still mention placeholder data (D-169).
  - Tests: two `climate.test.ts` cases (the rendered climate text of the completed profile has no "placeholder"; owner-written notes and Hamburg's source are kept). Seen failing without the change.
- **p5r2-fix-4** (low, confirmed): with a non-Hamburg profile, the prompt called Hamburg items "already at the destination" and the app's packing checks skipped them.
  - Changed: "already there" is relative to the run's profile slug (`placeAtDestination`); the marker is `now:there`, the legend, summary, system prompt and synthesis instruction say so, `moved` and the computed warnings follow it, the snapshot keeps the slug and the view carries `destination` for the Packing tab (D-170).
  - Tests: two `payload.test.ts` cases, `relocation.test.ts` "marks what is already at the run's own destination, not Hamburg, for a Bologna run", and `relocation-results.test.tsx` "leaves out bring items already at a Bologna run's destination…". Seen failing: the line marker (3 tests), the `moved` set and the Packing tab, each reverted alone.
- **p5r2-fix-5** (low, confirmed) and **p5r2-fix-6** (low, confirmed): focus fell to `<body>` after "Set as default" and after removing a packing extra.
  - Changed: focus moves to the card's hint and to the "N of M things packed" line, in a layout effect after the removing commit and only when it was lost; Remove stays focusable while busy (D-172). The first version used an animation frame; the visible-browser check showed focus still on `<body>` after Remove (the frame came before React removed the row), so both moved to a layout effect.
  - Tests: `climate-profile-editor.test.tsx` (focus on the hint; a failed request leaves focus on the button) and `relocation-results.test.tsx` ("adds an extra…" now checks focus on the count; "keeps focus on Remove while the delete runs and when it fails"). Seen failing without each focus line, and without `focusableWhenDisabled` (after the test was made to check the busy button is not natively disabled: jsdom keeps focus on a disabled button, so the first form of that test passed with the fix reverted).
- **p5r2-fix-7** (low, confirmed): the template pin did not cover `formatDecisionLine`.
  - Changed: the pin renders the synthesis's decision lines through `formatDecisionLine`; recorded with the `reloc-v3` pins (D-171).
  - Seen failing: with `p` added to the priority in `formatDecisionLine`, the new pin failed, while the old literal pin passed on the same edit.
- **p5r2-fix-8** (low, confirmed): a kept `/shopping` kept the previous run's budget after a run finished in the same tab.
  - Changed: the progress page notes a shopping-list change when an answer shows the run complete, from the answer itself, so it also counts while Next keeps the page hidden (D-173).
  - Test: `run-progress.test.tsx` "tells a kept /shopping to read again once the run finishes, also while this page is hidden". Seen failing without the note.
- **p5r2-fix-9** (low, confirmed): the print page could print old ticks after Back or Forward.
  - Changed: ticks and extras note a packing change (`packing-changes.ts`); the print page renders `RefreshPrintWhenShown` (D-173).
  - Tests: `packing-changes.test.tsx`, two `relocation-results.test.tsx` assertions (a tick and a removed extra make a print read stale), and a wiring check in `test/item-freshness.test.ts`. Seen failing with the note disabled (3 tests) and without the component on the page.
- **p5r2-next-1** (low, confirmed): after deleting a plan gap on `/shopping`, Back showed it still "On your shopping list".
  - Changed: deleting a gap row notes a shopping-list change that `/shopping` itself counts as seen (`noteShoppingListChangeShownIn`), and the result page reads itself again when shown after one (D-173). The visible-browser check then showed Back still stale when "Open list" was pressed at once after adding gaps: the Gaps tab's own `router.refresh()` landed while the plan was hidden, after the delete, and its copy counted as current. The Gaps tab no longer refreshes after adding; its overlay shows the added gaps.
  - Tests: `relocation-results.test.tsx` "reads the plan again when Next shows it after a shopping-list change elsewhere" and "…after adding gaps and then deleting one on /shopping", `shopping-list.test.tsx` "tells a kept plan page that a gap row is gone, without reading /shopping itself again", and a wiring check in `test/item-freshness.test.ts`. Seen failing without the plan's hook (2 tests), without the note on delete, without the "seen" bookkeeping, and with the Gaps tab's refresh put back (2 tests).
- **p5r2-next-2** (low, confirmed) and **p5r2-scale-3** (low, confirmed): every card and packing row re-rendered on each change, and the result page's cost grew steeply with the wardrobe.
  - Changed: `memo` decision cards and packing rows with stable props, memoised Gaps, Layering and Warnings panels, and `content-visibility: auto` on cards and rows (D-174). Not done: virtualisation, a leaner toggle class, one shared live region; the page still holds every card (see Open risks).
  - Test: `relocation-results-render.test.tsx` counts renders: one override re-renders one card's thumbnail (at most 3 renders for 60 cards) and one tick one row's checkbox (at most 4). Seen failing without `memo`: 61 renders each.
- **p5r2-scale-1** (medium, confirmed): the doubled `max_tokens` retry, and a long synthesis's invalid-output retry, could not finish before 270 s but were sent, paid for, aborted and reported as "Try again".
  - Changed: an invalid-output or broken-stream retry is sent only when the time left covers the failed attempt's own latency, otherwise the call ends with its own error; the relocation caps equal their ceilings (chunk 24,000, repair 16,000, synthesis 24,000), each sized to finish in 270 s at 110 tokens per second; `RELOCATION_PART_DEADLINE_MS` moved to `prompts.ts` for the route (D-164).
  - Tests: four `retry.test.ts` cases, two `call.test.ts` cases with an injected clock (a 30 s invalid attempt with 20 s left is not retried and ends AI_INVALID_OUTPUT), `relocation.test.ts` "ends a chunk at once when the reply hits the output cap…" (one request, the part failed with "Claude's reply was cut off by the output limit."), and the `prompts.test.ts` cap rule. Seen failing with the doubled ceilings (2 tests) and without the guard (3 tests).
- **p5r2-scale-2** (low, confirmed): at effort high, a wardrobe of about 1,600 or more bring items (1,800 by the estimate's own model, p5r3-doc-2) could not fit the synthesis's cap, and the form still offered Run.
  - Changed: the synthesis output is estimated as 2,600 plus 3 per item (3,500 for 300, so the 300-item figures stay); `synthesisFitsOutputCap` flags `tooLarge` in the estimate, the form disables Run with the reason, and `startRelocation` refuses VALIDATION `too_many_items` before writing (D-175).
  - Tests: `estimate.test.ts` (the output per item count and the 1,800 limit at high; the 3,133 limit at medium and 5,287 at low were not asserted until round 3, p5r3-doc-2), `relocation.test.ts` "refuses a run whose synthesis would not fit its output cap…" (3,134 items at medium: nothing written, no call), and `relocation-form.test.tsx` "disables Run with the reason…". Seen failing: the start check, the estimate change (2 tests) and the form check, each reverted alone.
- **p5r2-doc-1** (medium, confirmed): the system prompt sent items to be shipped to Leave ("follows later", "leave or ship"), while the synthesis packs only bring items.
  - Changed: the decisions are defined by where an item ends up: bring includes shipping later, leave means not moved; the chunk instruction and the synthesis's ship_later say the same; `reloc-v3` (D-171).
  - Test: `prompts.test.ts` "defines the decisions by where an item ends up…". Seen failing with the old leave line.
- **p5r2-doc-2** (low, confirmed): "bring the best one or two" fell on items worn in rotation.
  - Changed: bring as many as the stay needs, about a week's worth of items worn in rotation; the gap rule counts "the quantity needed" (D-171).
  - Test: `prompts.test.ts` "keeps enough of the items worn in rotation…". Seen failing with the old duplicates line.
- **p5r2-doc-3** (low, confirmed): every request carried 770.4 mm (computed) and 770.5 mm (the notes) for Hamburg's year.
  - Changed: the computed line gives "about 770 mm" (D-176).
  - Test: `range.test.ts` (no "770.4", the notes' "770.5 mm" kept). Seen failing with the old line.
- **p5r2-doc-4** (low, confirmed): this entry counted 12 findings and 10 defects for round 1; it was 14 and 12. Changed in State and Review (round 1). No test applies.
- **p5r2-doc-5** (low, confirmed): next step 2 has no Beads id, and the two focus losses lived only in HANDOFF prose. The focus losses are fixed now (D-172), so no issue is needed for them. The live relocation check still needed a Beads issue, which only the lead may create: the lead has since created wardrobe-izw (p5r3-doc-1).
- **p5r2-doc-6** (low, confirmed): `a11y.spec.ts` seeded and opened an unfinished run without the no-key guard, so a full run with `E2E_TAG=1` and a key would have run its parts against the real API.
  - Changed: with `SHELL_TAGGING` the unfinished run is not inserted and the progress page is left out, with an annotation giving `NEEDS_NO_API_KEY`; D-113, `e2e/README.md` and README say so.
  - Test: `test/e2e-guards.test.ts` checks that every spec seeding relocation parts, or waiting for the relocation stop, references both. Seen failing with the old spec.

Contract changes: `buildSnapshot(items, { includeOnlyConfirmed, destination })` and `itemLineBody(item, destination)` take the destination; `RelocationViewDto.destination`, `RelocationEstimateDto.tooLarge`; the stored snapshot's `profile.slug` (optional); `onAttemptCost` may return a promise; `MessageStreamLike.on`; the orchestrator's `onAnswer(run)`; `noteShoppingListChangeShownIn`, `packing-changes.ts`; `RELOCATION_PART_DEADLINE_MS` and `RELOCATION_MIN_OUTPUT_TOKENS_PER_SECOND` in `prompts.ts`; `withThinkingAllowance`, `synthesisOutputTokens` and `synthesisFitsOutputCap` in `estimate.ts` (`RELOCATION_ESTIMATE.synthesisOutputTokens` is gone).

### Review round 3

The third review reported 17 findings with an independent check of each: all 17 confirmed, none rejected. This session re-checked each against the code before changing it, and all were real. "Seen failing" means the regression test failed with the fix reverted (`scratchpad/r3fix6/revert6.py`, which patches one fix out, runs the named tests and restores every file byte for byte, checked by sha256; a sha256 manifest of `src`, `test` and `e2e` matched before and after each batch). Its 19 cases are listed by finding; the Checks run say when they ran. Severities are the verifier's.

- **p5r3-ai-1** (low, confirmed; an incomplete fix of p5r2-scale-1): an SSE `event: error` late in a reply (overloaded_error 200 s into a part's stream) was retried with only the 2 s check, cut off at 270 s and reported as "Claude did not answer in time".
  - Changed: `classifyError` marks failures with a reply under way (`replyStarted`), SSE error events included, and `planNextAttempt` applies the time check to all of them (D-177).
  - Tests: `retry.test.ts` "applies to an SSE error event that broke a reply off late…" and `call.test.ts` "does not send another attempt after an SSE error event late in a reply…" (the real SDK reading a scripted `event: error` body, an injected clock). Seen failing: case `ai1-sse` (both tests).
- **p5r3-ai-2** (low, confirmed; an incomplete fix of p5r2-scale-1): after a 130 s invalid reply and a stream dropped after 20 s, a third attempt went out with 120 s left.
  - Changed: `callStructured` passes the longest reply of the call (`longestReplyMs`) instead of the last attempt's latency (D-177).
  - Test: `call.test.ts` "measures the time a retry needs by the longest reply of the call…" (2 requests, AI_UNAVAILABLE, `reason: "no_time_for_retry"`). Seen failing: case `ai2-longest` (3 requests).
  - The Phase 3 tagging path shares this layer: `call.test.ts` (tagging requests through `callStructured`, retries, deadlines, refusals), `retry.test.ts`, `src/server/services/tag-item.test.ts` and the tag route's `route.test.ts` ran in every full `pnpm test` below and passed, and at 11:45:21 also on their own with the rest of `src/lib/ai` (11 files, 250 tests passed); tagging does not stream, so it never meets an SSE error event, and its max_tokens retry is unchanged. Its invalid-output retry did change: it needs the longest reply of the call, so an invalid reply after 24 s and another after 5 s now end after two attempts where the old rule sent a third; none of those tests covered that (p5r4-rest-2; D-177 now says so, and `call.test.ts` checks it).
- **p5r3-ai-3** (low, confirmed; an incomplete fix of p5r2-fix-2): a part's cost could be $0.000001 below its `ai_calls` rows (JS rounding against `numeric(12,6)`).
  - Changed: `addPartCost` lets Postgres round the decimal text `ai_calls` receives (D-178).
  - Test: `relocation.test.ts` "stores on the part exactly the sum of its ai_calls rows…" (usage 1,764 in, 6,017 out, 6,145 cache reads: $0.064313 on both, compared exactly). Seen failing: case `ai3-round` (0.064312). The browser check's seeded run summed to its `ai_calls` exactly on Docker Postgres ($0.515380).
- **p5r3-ui-1** (medium, confirmed; partly a regression from p5r2-next-1): on the plan, a refresh read before a save that landed after it undid the save on screen: an override back to Undecided, a packing tick or untick, added gaps or extras.
  - Changed: `src/lib/saved-since-read.ts`: saves are numbered when the server confirms them, the page's refreshes record which saves they will hold, a new copy keeps the newer saves and the page reads once more; the setters no longer depend on the view; every read of the plan goes through one page refresh (D-180). `view-overlay.ts` is gone.
  - Tests: `relocation-results.test.tsx` "keeps an override when a refresh read before it lands after it, and reads once more", "keeps an override that answers after a refresh read before it landed" and "keeps a packing untick when a refresh read before it lands after it". Seen failing: case `ui1-drop` (the overlay dropping every save on a new copy: 4 tests across the plan and `/shopping`) and case `ui1-orig` (the round-2 components restored from tree e3a8a28: 4 tests, among them the save that answers after the copy).
  - In the browser (reads held 2.5 s after the server answered them): an override and a packing tick pressed during the older read stayed shown to +12 s and matched the database, and the page read once more.
- **p5r3-ui-2** (confirmed; the reviewer rated it medium, the verifier low): `/shopping` replaced a saved status, link, delete or added row with a list read before the save.
  - Changed: `ShoppingListView` lays its saves over the server's rows through the same overlay (D-180).
  - Tests: `shopping-list.test.tsx` "keeps a status saved after a read was asked for when that read lands, and reads once more" and "keeps a row deleted, and one added…". Seen failing: cases `ui1-drop` and `ui1-orig`.
  - In the browser: Bought pressed while a held read of `/shopping` was on its way stayed pressed to +9 s, the summary was right once the read landed, the database said bought, and the list read once more.
- **p5r3-ui-3** (low, confirmed; for the plan a regression from p5r2-next-1): Back to a kept plan or `/shopping` with an item change and a shopping-list change behind read the page twice.
  - Changed: both checks run inside `RelocationResults` and `ShoppingListView` through `useSharedRefresh`, at most one read per effect flush; the pages no longer render `RefreshAfterItemChanges`; the print page shares one refresh between its checks (D-180).
  - Tests: "reads once when Next shows it after both an item change and a shopping-list change" in `relocation-results.test.tsx` and `shopping-list.test.tsx`, the print page's "…once for both kinds of change" in `packing-changes.test.tsx`, and `test/item-freshness.test.ts`, which now also checks that neither page renders a second `RefreshAfterItemChanges`. Seen failing: case `ui3-dedupe` (3 tests, two reads each) and case `ui3-pages` (the two pages from tree e3a8a28). Restoring the old components alone did not double the read, because the second check lived in `page.tsx`, which no component test renders; that case passed at 11:03, as it had to, and was dropped.
  - In the browser: one read after Back to the plan and one after Forward to `/shopping`, each with both counts behind.
- **p5r3-ui-4** (low, confirmed): `content-visibility` on packing rows clipped the focus rings of the checkbox, Open and Remove, and the checkbox's hit area on its left.
  - Changed: the row keeps 14 px of room inside its own box (`-mx-3.5 px-3.5 py-1`, intrinsic size 3.25rem) (D-182 a).
  - Test: the headed check measures, with keyboard focus, that the checkbox's and Remove's boxes inflated by 3 px lie inside the row and that a point 12 px left of the checkbox hits it; with the round's three classes taken off the row in the live DOM both checks failed (seen failing). Screenshots `ui4-ring-*-fixed.png` and `ui4-ring-*-old-row.png` show the whole ring and the cut one.
- **p5r3-ui-5** (low, confirmed): Unlink moved focus to the link button when it answered, even from a field the owner had moved to.
  - Changed: a layout effect after the commit that removes Unlink, only when focus was lost, and nothing when the answer comes while Next hides the page (D-182 b).
  - Test: `shopping-list.test.tsx` "moves focus after Unlink only when it was lost…" (the field kept, Unlink's own focus moved, hidden page, failed unlink). Seen failing: case `ui5-unlink` (the animation frame put back). The first form of this test waited only for microtasks, so the frame had not run and the reverted fix passed (11:02); it now waits for a frame.
  - In the browser: after Unlink answered (held 2 s), focus stayed in "What to buy" and typing went on there; with focus left on Unlink it landed on "Link to an item I own".
- **p5r3-ui-cr7** (low, confirmed; wardrobe-cr7, predates Phase 5): Base UI 1.9.0's toast close button was `aria-hidden` but focusable while the stack was collapsed (axe `aria-hidden-focus`).
  - Changed: `toast.tsx` renders the close button with `tabIndex -1` while it is hidden (D-182 e, D-050).
  - Test: `toast.test.tsx` (hidden: `tabIndex -1`; the stack expanded: `aria-hidden` false and `tabIndex 0`; a click closes the toast). Seen failing: case `cr7-toast`. In the browser: axe `aria-hidden-focus` gave no violation and no incomplete with a toast showing, and F6, Tab, Tab still reached "Close toast".
- **p5r3-journey-1** (medium, confirmed): the Packing tab and its printout listed items the owner had decided not to bring, unmarked and counted.
  - Changed: such a row is marked "Yours: Donate · not coming" (or "AI: …" where the owner has not decided) and leaves the counts; the print page lists it under "Not bringing" and reads itself again after an item change (D-181).
  - Tests: `relocation-results.test.tsx` "marks a packed item the owner no longer brings…", the new `print-checklist.test.tsx` "lists items no longer brought apart…", `packing-changes.test.tsx` "reads it again after a decision changed elsewhere…", and the `e2e/relocate.spec.ts` print assertions. Seen failing: cases `journey1-tab`, `journey1-print` and `journey1-printfresh`. The first headed e2e run also failed on the old expectation (it ticked and printed an item the AI had decided sell), which the spec now replaces with a bring item and the "Not bringing" list.
  - Existing counts changed on purpose: the result-page tests' fixture packs items the AI decided leave, donate or sell, so their "Packing N" and "N of M" now count only the rows still coming (`comingRows` in the test), and the render-cost test counts its 60-item fixture the same way.
- **p5r3-journey-2** (low, confirmed): a Suitcase group longer than a page left the printed first sheet with the title alone.
  - Changed: groups may break; rows are kept whole and headings stay with their first row (D-181).
  - Test: `print-checklist.test.tsx` "lets a long group flow…". Seen failing: case `journey2-breaks`. Headless `page.pdf` of the 300-item seed (A4, default and 1 cm margins): 3 pages with Suitcase on page 1; with the old rule injected, 4 pages with a title-only page 1.
- **p5r3-journey-3** (low, confirmed): the constraint chips, the €600 button and a packing group's Add dropped keyboard focus to `<body>` when pressed.
  - Changed: `focusableWhenDisabled` on all three (D-182 c).
  - Tests: `relocation-form.test.tsx` "keeps focus on a chip and on the €600 button…" and the Add assertions in "adds an extra to a group and removes it again" (not natively disabled, `aria-disabled`, still focused). Seen failing: cases `journey3-chips` and `journey3-add`. In the browser: Enter on a chip, on €600 and on Add left focus on each.
- **p5r3-journey-4** (low, confirmed): a lone "-" typed into an emptied climate cell saved as unknown with no error.
  - Changed: the cell also reads `validity.badInput` on `onInput` (D-182 d).
  - Test: `climate-profile-editor.test.tsx` "treats text an emptied cell cannot read…" (an input event with an unchanged value and `badInput`). Seen failing: case `journey4-input`. In the browser: the row error showed, the cell was `aria-invalid` and Save left the database row unchanged.
- **p5r3-doc-1** (low, confirmed; an incomplete close-out of p5r2-doc-5): HANDOFF named neither wardrobe-izw nor wardrobe-cr7 and said the live run had no issue. Changed in Review round 2, Checks run, Open risks, Live checks pending and Next steps. No test applies.
- **p5r3-doc-2** (low, confirmed): D-175's reason (about 1,600 items at high) contradicted its 1,800 limit, and HANDOFF claimed tests for the 3,133 limit that no test made.
  - Changed: D-175 states the model's limits and the round-2 sample range; HANDOFF's round-2 line says what was tested then.
  - Test: `estimate.test.ts` "puts the limits D-175 states at 1,800 items at high, 3,133 at medium and 5,287 at low", with the next count up for each. Seen failing: case `doc2-limits` (a medium thinking allowance of 1.05×), while the old test passed on the same change (case `doc2-old-test`, expected to pass).
- **p5r3-doc-3** (low, confirmed): D-139 and a `contracts.ts` comment still said the snapshot holds the items "in Hamburg or in transit". Changed: D-139 (text and status), D-170's heading, this entry's Decisions and the comment. Docs and a comment only; no test applies.
- **p5r3-doc-4** (low, confirmed): `reloc-v3`'s chunk instruction defined leave as "not moved", against the system prompt's meaning for items marked `now:there` or `now:in_transit`.
  - Changed: the chunk line gives both meanings; `RELOC_PROMPT_VERSION` is `reloc-v4`, the templates pin `304765df…`, the system pin unchanged (D-179).
  - Tests: `prompts.test.ts` "gives leave the system prompt's meaning for items already there or on their way" and the pins. Seen failing: at 10:44 by hand, the edited line with the version still `reloc-v3` failed the templates pin and the old phrase test; case `doc4-chunk` (the old line under `reloc-v4`) failed the new test and the pin.

Contract changes: `ErrorClassification.replyStarted`; `PlanInput.lastAttemptMs` is now `longestReplyMs`; `src/lib/saved-since-read.ts` (`useServerCopy`, `useSavedOverlay`, `useSharedRefresh`) replaces `src/components/relocate/view-overlay.ts`; `GapsTab` and `PackingTab` take `copy`, `ItemsTab` takes `refresh`; `notComingNote` in `format.ts`; `RefreshPrintWhenShown` also checks item changes.

### Review round 4

The fourth review looked only at the round-3 fix pass (tree e3a8a28 to tree 9e5796d) and at defects those changes expose. It reported 6 findings; an independent check confirmed all 6 and rejected none. This session re-checked each against the code before changing anything (the working tree matched tree 9e5796d, all 462 files), and all were real: the new tests of the four code findings failed on the unfixed tree (12:38:29 to 12:38:36: 6 tests failed in 5 files, 129 passed), and p5r4-rest-2's tests passed there, as tests of the documented behaviour should. "Seen failing" also means the test failed with its fix patched out by `scratchpad/r4fix/revert7.py`, which reverts one fix at a time, runs the named tests and restores every file byte for byte, checked by sha256; a sha256 manifest of `src`, `test` and `e2e` matched before and after each batch. Severities are the verifier's.

- **p5r4-state-1** (low, confirmed; a regression from p5r3-ui-1, D-180): with a read of the plan asked for before an extra was added and reaching the database after the insert, the extra showed twice and the tab, "N of M things packed" and the group heading counted it twice, until the next read landed.
  - Changed: `RelocationResults` leaves out an added row whose id the view already lists, as `/shopping`'s `withSaves` does; removals apply after that (D-183 b).
  - Test: `relocation-results.test.tsx` "shows an extra once when a read asked for before it was added already holds it" (one checkbox, "Packing N+1", "0 of N+1 things packed", the group's "(0 of k+1)", no duplicate-key warning). Seen failing: case `state1-dup-extra` (two checkboxes).
- **p5r4-state-2** (low, confirmed; an incomplete fix of p5r3-ui-2, D-180): on `/shopping`, the Shopping link pressed on the list read it while the list stayed usable; a Bought pressed meanwhile was undone on screen when that copy landed, and nothing read again.
  - Changed: `useServerCopy` counts a copy no refresh asked for as read when the previous copy was, and the first copy as holding none of the page's saves, so the saves made since stay and the page reads once more (D-183 a). The module comment, D-180, D-154 and the open risk are corrected.
  - Test: `shopping-list.test.tsx` "keeps a status saved before a copy no refresh of the page asked for, and reads once more" (Bought kept, "3 entries on your list, 1 still to buy.", one read, and none more after a copy that holds it). Seen failing: case `state2-unasked-copy` ("To buy").
  - Changed on purpose: "moves focus after Unlink only when it was lost…" reset its row with copies nobody asked for, which now keep the unlink; it now shows copies read after the unlink (`linkedAgain`). It still fails with the round-3 Unlink fix reverted: case `r3-ui5-unlink-still`.
- **p5r4-state-3** (low, confirmed; incomplete fixes of p5r2-fix-9 and p5r3-journey-1, D-173 and D-181): a tick or an override pressed on the plan just before "Print checklist" and answering after the print page's read was not read again, so the page printed the box unticked or the item under its group instead of "Not bringing".
  - Changed: (a) "Print checklist" notes its press (`notePrintAsked`), and the first print read shown after it counts from the press, not from its first show; (b) `RefreshPrintWhenShown` listens while shown, to packing changes (`notePackingChange` calls the listeners it adds from its effect) and to item changes (the default `refreshWhileShown`); a hidden print page does not listen (D-184).
  - Found in the browser check: the first version was (b) alone, as the finding proposed. Its jsdom tests passed, but in the headed run the print page still did not read again after the tick or the decision. A probe showed why: the print read was answered at 1,538 ms, but React committed the navigation only at 3,491 ms, right after the held tick answered at 3,450 ms, so the save was noted before the page's first show. (a) was added for that order.
  - Tests: `packing-changes.test.tsx` "counts a read from the press of Print checklist…" (a tick and a decision noted between the press and the first show each read once; a press with nothing saving reads nothing and counts once) and "reads it again when a save from the plan answers while it is shown, and only listens while shown" (one read per change while shown, none while hidden, one on the next show), `relocation-results.test.tsx` "notes the press of Print checklist…" (the link's handler), and `test/item-freshness.test.ts`'s print-page wiring. Seen failing: cases `state3-print-press-effect`, `state3-print-press-link`, `state3-print-packing` (no read after a tick while shown) and `state3-print-items` (no read after an override while shown; the wiring test).
- **p5r4-rest-1** (low, confirmed; an incomplete fix of p5r3-ai-2, D-177): after a long invalid reply, an early 529, 429, 5xx or connection error let a third attempt out with less time left than that reply had taken; the deadline cut it off and the part ended as "Claude did not answer in time".
  - Changed: `planNextAttempt`, after its wait check, ends a retryable failure other than max_tokens with its own error and `reason: "no_time_for_retry"` once the call has had a reply and the time left cannot hold the longest one (D-185). The comments in `retry.ts` and `call.ts`, D-164 (a), D-177 and README's relocation paragraph say so.
  - Tests: `retry.test.ts` "does not retry a transport error after a reply of the call…" (a 529 and a connection error with a 40 s reply behind and 10 s left fail; a `retry-after` of 200 s still says "Claude is busy. Try again in about 200 s.") and "leaves transport errors before any reply…", which replaces the round-3 test that pinned the gap; `call.test.ts` "does not send another attempt after an HTTP error…" (invalid after 130 s, then a 529 with retry-after 15 s after 1 s: 2 requests, AI_UNAVAILABLE "Claude is overloaded right now (HTTP 529 overloaded_error). Try again shortly.") and "does the same after a connection error…". Seen failing: case `rest1-http-after-reply` (all three; the call tests sent a third attempt).
- **p5r4-rest-2** (low, confirmed): D-177 said the tagging path was unchanged, but since round 3 tagging's invalid-output retry follows the longest-reply rule.
  - Changed: D-177 says what changed for tagging, and so does the round-3 p5r3-ai-2 bullet above.
  - Tests: `call.test.ts` "applies the longest reply to tagging's 50 s too…" (not streamed, 50 s, invalid after 24 s and after 5 s: 2 requests, AI_INVALID_OUTPUT, `reason: "no_time_for_retry"`) and "counts a tagging reply cut off by max_tokens as the longest reply too" (the max_tokens retry sent at 8,192 tokens, then no third). They pin the documented behaviour, so they pass on the unfixed tree; seen failing: case `rest2-tagging-longest` (the round-3 change reverted, `callStructured` passing the failed attempt's own latency: 3 requests).
- **p5r4-rest-3** (low, confirmed): this entry's integration checks still said "Final checks on the final tree (… no code changed since)", and the round-2 summary said its checks ran "all on the final tree".
  - Changed: those lines and the round-3 labels now say whose tree they ran on; only the round-4 checks are marked as the final tree's. No test applies; the grep is under Checks run.

Contract changes: `PlanInput.longestReplyMs` is 0 before any reply and now also applies after HTTP and connection errors; `notePackingChange` calls listeners, which `RefreshPrintWhenShown` adds while shown, and `notePrintAsked` (the Print link's click handler) records the counts the next print read starts from; `useServerCopy` counts the first copy as read at 0 and a copy no refresh asked for as read with the previous one (the `ServerCopy` type is unchanged).

### Checks run

All on 2026-11-03, local time (UTC+1). The integration session's checks come first, then the round-1, round-2 and round-3 review-fix sessions'; all four are earlier and ran before the round-4 fixes. The round-4 session's checks follow; they ran on the final tree. The lead's own checks on the same tree, just before the commit, come last.

Earlier, by the integration session:

- Before any change: 01:10:55 to 01:10:59 `pnpm exec tsc --noEmit` (whole project): passed.
- Targeted runs while integrating, each passing after its change:
  - 01:13:40 `pnpm exec vitest run src/components/relocate/relocation-results.test.tsx src/server/actions/relocation.test.ts`: 2 files, 18 tests.
  - 01:14:30 `pnpm exec vitest run src/components/climate src/components/relocate` and `pnpm exec eslint` on the touched folders: 7 files, 62 tests; lint clean.
  - `pnpm exec vitest run test/boundaries.test.ts`: 41 tests; `test/item-freshness.test.ts`: 5 tests.
  - Reverse checks, each file restored afterwards (checked with grep): without `noteShoppingListChange()` the gaps test failed; without `noteClimateProfileChange()` the new climate test failed; a scratch client file importing `@/lib/relocation/prompts` failed the boundary test ("@/components/relocate/zz-probe -> @/lib/relocation/prompts") and was deleted; without the location filter the new packing test failed.
- End-to-end flow through the real code paths, outside the repo (`scratchpad/phase5-flow/flow.test.ts` with a vitest config rooted there; only the session check, `getDb` and the Anthropic client are stand-ins, and Claude is a fake that reads each request's item lines and answers like a Hamburg-minded stylist):
  - 01:18:34 and 01:18:42 on PGlite with Hamburg, Bologna and the 300 demo items: passed. The `estimateRelocation` action gave 300 items, 6 chunks, months Nov to Oct, $0.55 (range $0.39–0.83) at medium; `startRelocation` refused Bologna without consent (`placeholder_not_accepted`) and started the run; the route refused the synthesis before the chunks (409 `chunks_incomplete`); the six chunks (26, 69, 53, 64, 66, 22 items, four at a time) and the synthesis ran through `POST` of the real route handler (Origin check, params promise, deadline), with one alias left out of a chunk reply, which made exactly one repair call; `ai_calls` held 6 chunk, 1 repair and 1 synthesis rows, and the run's cost equalled their sum. Re-posting a finished part answered 200 with the real client getter (no key needed). The stored result passed `makeRelocationAnalysisSchema` for the snapshot's ids; the view had 300 items, 4 layering systems, 6 gaps, 101 packing rows and `meta.repair_calls` 1. The estimate then offered the cached run and `startRelocation` returned `{ kind: "cached" }`; "Apply AI decisions" updated all 171 undecided items; adding the 6 gaps twice gave `added 6`, then `alreadyThere 6`; `getShoppingList` had 6 rows, budget 600 and the run's id; a packing tick, an extra and its removal worked and an item row could not be removed; the history listed the run; "Re-run anyway" with the real client getter answered 500 CONFIG with the generic message and left the part pending with 0 attempts; a malformed id answered 404 and a cross-site POST 403.
  - 01:23:24 the same harness priced a typical 300-item wardrobe (`makeTypicalWardrobe`) as the service does: 6 chunks (65, 45, 55, 51, 64, 20), 58,183 input tokens; low $0.40 ($0.28–0.60), medium $0.55 ($0.39–0.83), high $0.77 ($0.54–1.15).
- First gate, with `.env.local` moved to `scratchpad/envlocal-aside5/` (restored by a trap, confirmed back, the folder empty afterwards):
  - 01:20:58 to 01:21:02 `pnpm typecheck`: passed.
  - 01:21:02 to 01:21:13 `pnpm lint`: passed.
  - 01:21:13 to 01:22:05 `pnpm test`: 124 files passed, 1 skipped; 1,810 tests passed, 1 skipped.
  - 01:22:05 to 01:22:26 `pnpm build`: passed; the new routes `/relocate`, `/relocate/[id]`, `/relocate/[id]/print`, `/settings/climate` and `/shopping` are partial prerenders, the parts route dynamic.
  - 01:22:36 grep of `.next/static` for `ANTHROPIC_API_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, `APP_PASSWORD_HASH`, `sk-ant`, `vercel_blob_rw` and seven phrases of the relocation system prompt and legend ("frugal relocation stylist", "READING THE CLIMATE", "Reason from the numbers for the months", "insulated footwear with grip", "alias|category/subcategory", "now:hamburg = already", "Return exactly"): no file matched any of them.
- 01:22:58 `pnpm db:generate`: "No schema changes"; 01:23:00 `pnpm db:migrate`: applied (nothing new); 01:23:01 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept.
- 01:23:08 to 01:24:57 `pnpm test:e2e` (headed; `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `E2E_TAG` unset): 58 passed, 3 failed, 1 skipped (smoke, "needs BLOB_READ_WRITE_TOKEN in the shell"), 3 did not run (the rest of the serial relocate spec). The failures: the progress page's contrast (fixed in `alert.tsx`) and the two ambiguous locators (fixed in the specs), see State.
- 01:25:57 to 01:26:55 `pnpm test:e2e e2e/a11y.spec.ts e2e/relocate.spec.ts e2e/shopping.spec.ts`: 16 passed.
- Visible-browser check (headed Chromium from `scratchpad/phase5-visual/p5.cjs`, against `next start -p 3100` with the e2e environment: every app variable blank, `wardrobe_e2e`, a throwaway session secret):
  - 01:27:27 `DATABASE_URL=…/wardrobe_e2e pnpm db:seed:demo`: 300 inserted. 01:27:34 the flow harness with `FLOW_TARGET=docker` seeded one complete analysis over them through the real start, chunk and finalize code (6 chunks, 1 synthesis).
  - 01:29:33, 01:31:27 and 01:32:42: three partial runs. They found the contrast failures and the script's own selector mistakes (a decision group named by `aria-labelledby`, the budget input's value); the app fixes are in State.
  - 01:34:04: 126 of 126 checks passed. Looking at the 52 screenshots found the tab overlap at 390 px, the 57 already-moved items listed for packing and the dark print; all three fixed, then `next build` and the server restarted at 01:38:38.
  - 01:39:25 to 01:40:17, on a fresh seed (reset 01:39:14): 130 of 130 passed, no browser console errors or page errors. At 1440 × 900 and 390 × 844, light and dark:
    - The form: "≈ $0.55 with Sonnet 5.5 · 7 parts · 300 items", range $0.39–0.83, budget left $19.48 of $20.00 (the seeded run's fake calls are logged spend); the three chips appended their sentences and disabled themselves; €600 filled the budget; with the seeded run's inputs the "Unchanged since 3 Nov 2026" banner offered View result (linking the seeded run) and "Re-run anyway"; Bologna showed the placeholder badge and warning with the Settings link, and Run waited for the consent; no sideways scroll.
    - Starting a run with no API key (1440 light and 390 dark): the progress page showed "Configuration problem — The server is misconfigured. Check the server logs." with "No part can run until the server's AI settings are fixed…" and Try again, 7 parts "Not started", and the database had all 7 parts pending with 0 attempts; Try again stopped the same way; Back to `/relocate` listed the run as "Not finished". The task brief expected "the part marked failed with Retry"; by design (D-145, D-146) a missing key stops the run before any part is taken.
    - The results: tabs "Items 300 | Gaps 6 | Layering 4 | Packing 101 | Warnings 2"; at 390 px the segmented control showed one column at a time and both tab rows sat inside the list (44 px each). An override (Leave) survived a reload, showed "Yours: Leave" and was in the database; "Apply AI decisions to 170 undecided items" left 0 undecided; "Add 6 to shopping list" added 6 rows; `/shopping` (visited before, so kept by Next) showed them with the budget field prefilled 600 and "Could go over: the high end is €50 over budget"; a packing tick and an extra survived a reload and Remove deleted the extra; "Bring items not in the checklist" showed 23, matching the database (57 bring items already moved, left out).
    - Keyboard: ArrowRight moved focus from Items to Gaps; Tab reached the first card's decision toggles, with the focus ring visible in the screenshot.
    - Print (`page.emulateMedia({ media: "print" })`): no sidebar, tab bar, Print button or back link, main padding 0, white paper with black text in both themes, packed rows ticked.
    - The climate editor: filling all 72 Bologna values and saving cleared the badge and `is_placeholder`; Back to `/relocate` listed "Bologna, Italy" without the placeholder mark and showed no warning; Bologna was then restored column by column and matched its saved row exactly.
    - axe (WCAG 2.0/2.1 A and AA) found no serious or critical violation on the form (also with the placeholder warning), the progress page with the stop alert, each result tab (1440 light and 390 dark), `/shopping` and `/settings/climate`.
    - Screenshots looked at: the form, cached banner and placeholder warning in all four views, the progress page (1440 light, 390 dark), every result tab, the apply dialog, the gaps after adding, `/shopping`, the keyboard focus, the climate editor before and after, the form after Back, and the print page on screen and in print media in all four views. In full-page phone screenshots the fixed tab bar shows mid-page; that is how the capture works.
  - 01:40:37 cleanup: every analysis (with parts, packing rows and logged calls) and shopping row deleted from `wardrobe_e2e`, `pnpm db:seed:demo --clean` removed 300; both databases then held 0 items, analyses, parts, shopping rows, packing rows and `ai_calls`; the climate rows matched the copy saved before the check; the server was stopped and nothing listened on 3000 or 3100.
- Closing checks on the integration session's tree (after its docs; the review rounds changed code since):
  - Gate with `.env.local` aside again (restored, confirmed back, the folder empty): 01:45:04 to 01:45:09 `pnpm typecheck` passed; 01:45:09 to 01:45:21 `pnpm lint` passed; 01:45:21 to 01:46:12 `pnpm test`: 124 files passed, 1 skipped; 1,811 tests passed, 1 skipped; 01:46:12 to 01:46:22 `pnpm build` passed (Turbopack's cache made it quick), same route table.
  - 01:46:31 grep of `.next/static` for the same secrets and prompt phrases: no match.
  - 01:46:38 `pnpm db:generate`: "No schema changes"; 01:46:39 `pnpm db:migrate`: applied (nothing new); 01:46:41 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept.
  - 01:46:46 to 01:48:29 `pnpm test:e2e` (headed, same shell): 64 passed and 1 skipped, the smoke spec, with its reason "needs BLOB_READ_WRITE_TOKEN in the shell" (confirmed at 01:48:47 by running it alone with the JSON reporter). Covered: the three new specs, the wider axe scan and the new tab-layout check at 390 px. At 01:49:06 both databases held no items, analyses, parts, shopping rows, packing rows or `ai_calls`, and nothing listened on 3000 or 3100.
- Not run: anything against the live Anthropic API or a real Blob store; the smoke spec with a token; a real print dialog or paper; the progress page with real Claude answers (the browser check used seeded results and the CONFIG stop).

Earlier, by the round-1 review-fix session:

- While fixing, targeted runs passed after each change: `pnpm exec vitest run` on the touched test files, then `src/components/relocate` (51 tests) and `src/lib/relocation` with `src/server/services/relocation.test.ts` (157 tests). `pnpm exec tsc --noEmit` passed, and `pnpm exec eslint` on the 24 changed source and test files passed with no warnings.
- Reverse checks, 02:19 to 02:40 (`scratchpad/revert5b.py`, cases in `revert5b-cases.json`): each case reverted one fix, ran its tests, saw them fail, and restored the file, matching its sha256 from before. There were 20 cases, listed in Review. The first try of the packing case reverted it wrongly and passed; corrected, it failed as expected.
- First gate, 02:34:20 to 02:35:45, with `.env.local` moved to `scratchpad/envlocal-aside5b/` (it was empty before; the file was put back at 02:35:45 and the folder is empty again). Typecheck, lint, test and build passed. Tests: 124 files passed and 1 skipped; 1,829 tests passed and 1 skipped. At 02:35:50, a grep of `.next/static` found no match for the same seven secret names and seven prompt phrases as before, nor for "gap_note: what is missing". The follow-on fix to p5-ux-1 came after this run, so the gate ran again (final, below).
- 02:35:57 to 02:36:01: `pnpm db:generate` ("No schema changes"), `pnpm db:migrate` and `pnpm db:seed` (Hamburg updated; Bologna and app_settings kept).
- 02:36:06 to 02:37:48 `pnpm test:e2e` (headed): 64 passed, 1 skipped. At 02:37:56 to 02:38:10 the smoke spec ran alone with the JSON reporter: skipped, "needs BLOB_READ_WRITE_TOKEN in the shell".
- Visible-browser check (headed Chromium, `scratchpad/phase5-fix-visual/fix.cjs`, against `next start -p 3100` built with the e2e environment, at 1440 × 900 light and 390 × 844 dark):
  - 02:40:01 to 02:40:06: `wardrobe_e2e` was reset and seeded with the 300 demo items. The flow harness then made one complete analysis through the real start, chunk, route and finalize code, with the scripted fake. Its stored keys were `g1-outerwear-waterproof-breathable-shell-jacket` to `g6-accessory-high-visibility-reflective-vest`, and every part's cost equalled its `ai_calls` row.
  - 02:42:19 to 02:44:51: six runs stopped on mistakes in the script, not the app: two enum casts in its SQL, a dialog locator that also matched the "Linked" toast, two locators that also matched a hidden copy of the content, and a console-error filter that counted the script's own 400 probe. The hidden copy sits in React's streaming container (`div#S:0`, `hidden`) right after a full page load and disappears moments later; a probe at 02:45 saw only one copy after 1.5 s in four reloads at each width. The locators now take visible elements only, and the run logs every copy.
  - 02:46:18 to 02:47:03, final run: 74 of 74 checks passed, with no browser console or page errors. In both views:
    - The form kept "600€" in the budget field, showed "Enter whole euros…", asked for no estimate, and left Run disabled with "Fix the fields marked above first."
    - Setting Bologna as default in Settings, then the Relocate tab, switched the kept form to Bologna, with the placeholder warning and the consent unticked. A profile picked by hand stayed after Hamburg was made default again.
    - The progress page of a copied run (2 chunks failed, 4 done) sent no request on load. Retry posted `{"retry":true}`, Try again posted both parts with it, and "Retry failed parts" did the same after a reload. Each ended at the CONFIG stop with focus on the status line (ring visible in the screenshots).
    - The route itself answered `{}` for a failed part with 200 and the part still failed, `{"retry":true}` with 500 CONFIG, and an unknown key with 400. The part's status and attempts in the database did not change.
    - On the result page, the apply confirmation was gone after Back and Forward. After applying 171 decisions, focus was on "No undecided items left" (`aria-disabled`).
    - Adding the extra "Umbrella" made the tab "Packing 102" and the panel "0 of 102 things packed"; removing it brought the tab back to "Packing 101".
    - Adding the 6 gaps gave `/shopping` Must have (shell jacket, boots) and Should have (rain trousers, merino base layer, gloves) in the run's order, not alphabetically. After linking "Charcoal merino sweater", focus was on "Unlink Charcoal merino sweater from Rain trousers for cycling".
    - No page scrolled sideways. axe found no serious or critical violation on the form with the budget error, the progress page with failed parts, the Packing tab, or `/shopping` after linking (1440 light).
    - All 20 screenshots in `scratchpad/phase5-fix-shots/` were looked at. In full-page phone screenshots the fixed tab bar shows mid-page; that is how the capture works.
  - 02:48:21 cleanup: the check server stopped; `wardrobe_e2e` was emptied (analyses, shopping rows, logged calls, and the 300 demo items removed); Hamburg is the default; the flow harness's `node_modules` junction was removed again.
- Final gate, 02:48:51 to 02:50:10, with `.env.local` aside again (put back at 02:50:10; the aside folder is empty):
  - `pnpm typecheck` 02:48:51 to 02:48:55, passed.
  - `pnpm lint` 02:48:55 to 02:49:08, passed.
  - `pnpm test` 02:49:08 to 02:49:59: 124 files passed and 1 skipped; 1,830 tests passed and 1 skipped.
  - `pnpm build` 02:49:59 to 02:50:10, passed, with the same route table (the parts route dynamic).
- 02:50:15 grep of `.next/static` for the secrets and prompt phrases: no match.
- 02:50:22 `pnpm db:generate`: "No schema changes". 02:50:23 `pnpm db:migrate`: applied, nothing new. 02:50:24 `pnpm db:seed`: Hamburg updated; Bologna and app_settings kept.
- 02:50:25 to 02:52:09 `pnpm test:e2e` (headed, same shell): 64 passed and 1 skipped, the smoke spec, unchanged since its reason was confirmed at 02:38.
- 02:52:14: both databases hold 0 items, analyses, parts, shopping rows, packing rows and `ai_calls`, with Hamburg the default. Nothing listens on 3000 or 3100.
- Not run: anything against the live Anthropic API or a real Blob store; two real tabs running one part against a real Claude failure (covered by the service, route and orchestrator tests and the route probe above).

Earlier, by the round-2 review-fix session:

- While fixing, targeted runs passed after each change: `pnpm exec vitest run` on the touched folders (`src/lib/ai`, `src/lib/relocation`, `src/lib/climate`, `src/server/services`, `src/app/api`, `src/components/relocate`, `src/components/climate`, `src/components/shopping`, `test`), `pnpm exec tsc --noEmit` and `pnpm lint`. At 04:04:40 to 04:04:44 a scratch database `wardrobe_r2fix5_pg` was created on the Docker container, migrated, and `TEST_DATABASE_URL=…/wardrobe_r2fix5_pg pnpm exec vitest run src/server/services/relocation-apply.pg.test.ts` passed (1 test, 20 rounds).
- 04:05 `WebFetch` of the live pricing page: Sonnet 5.5 "Cache hits and refreshes $0.10 / MTok", footnote "priced at 0.05x the base input price" (no API call).
- Revert checks (`scratchpad/r2fix5/revert5c.py`, `PYTHONIOENCODING=utf-8`), each case reverting one fix, running its tests and restoring every file by sha256; a sha256 manifest of `src`, `test` and `e2e` matched before and after each batch:
  - 04:08:31 to 04:09:17, 16 cases: 15 failed as expected; `fix6-disabled` passed (jsdom keeps focus on a disabled button), so that test was strengthened.
  - 04:09:50 to 04:10:39, 20 cases (the strengthened `fix6-disabled` included): all failed as expected, and `fix7-pin-old` passed as expected (the old pin missed a `formatDecisionLine` edit).
  - 04:11:30 to 04:11:36: the reverted apply on the scratch database failed with "40P01 deadlock detected"; restored, it passed. 04:11:41 the scratch database was dropped.
  - About 04:15, the form's too-large check reverted by hand and restored by sha256: its test failed.
  - 04:27:58 to 04:28:11, 4 cases after the browser-found changes (both focus fixes in their layout-effect form, the Gaps tab's removed refresh, the form check): all failed as expected.
- First gate, 04:16:01 to 04:17:30, with `.env.local` moved to `scratchpad/envlocal-aside5c/` (empty before; put back by a trap, the folder empty again): `pnpm typecheck` 04:16:01 to 04:16:07, `pnpm lint` to 04:16:19, `pnpm test` to 04:17:13 (127 files passed, 2 skipped; 1,876 tests passed, 2 skipped), `pnpm build` to 04:17:30, all passed. 04:17:36 grep of `.next/static` (70 files) for the seven secret names, the seven earlier prompt phrases ("now:there = already" in place of "now:hamburg = already"), "gap_note: what is missing" and the new phrases "Decide by where the item ends up", "worn in rotation" and "bring includes items to ship later": no match (a control string from the progress hint was found in 1 file, so the grep reads the bundle).
- 04:17:43 `pnpm db:generate`: "No schema changes"; 04:17:44 `pnpm db:migrate`: applied, nothing new; 04:17:45 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept.
- 04:17:56 to 04:19:40 `pnpm test:e2e` (headed; `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `E2E_TAG` unset): 64 passed, 1 skipped; 04:19:44 to 04:19:57 the smoke spec alone with the JSON reporter: skipped, "needs BLOB_READ_WRITE_TOKEN in the shell".
- Visible-browser check (headed Chromium, `scratchpad/phase5-r2-visual/r2.cjs`, against `next start -p 3100` with the e2e environment, 1440 × 900 light and 390 × 844 dark):
  - 04:21:22 `pnpm db:seed:demo` into `wardrobe_e2e` (300 items); 04:21:28 to 04:21:31 the flow harness (copied to `phase5-r2-visual`, its fake given `on()` and the `now:there` marker) made one complete analysis through the real start, route, chunk and finalize code: `reloc-v3`, profile slug hamburg, 7 parts whose costs sum to the run's `ai_calls` total ($0.51538, written per attempt on Docker Postgres).
  - 04:23:48 to 04:25:11, first run: it found two app problems. Back to the plan after deleting a gap on `/shopping` still showed it on the list (the Gaps tab's refresh landing while hidden), and focus after Remove was on `<body>` (the animation frame came before React removed the row). Both were fixed (Review round 2), the revert checks re-run, the gate re-run (below) and the server restarted. The phone view of that run stopped on the script's own click under the tab bar.
  - Second gate, 04:28:57 to 04:30:19, `.env.local` aside again and restored: typecheck, lint, test (127 files passed, 2 skipped; 1,877 tests passed, 2 skipped) and build passed.
  - 04:30:30 to 04:31:32: 52 of 54 checks. One was the script's (it wanted "Running elsewhere…" while the part still read "Working…"). The other was axe `aria-hidden-focus` on a success toast's close button on the progress page (1440 light), which Base UI 1.9.0's `ToastClose` marks `aria-hidden` while the stack is collapsed but leaves focusable; 04:32:28 to 04:33:04 a re-run with axe detail confirmed the node. It was outside that round's fixes; the lead filed wardrobe-cr7, and round 3 fixed it (D-182).
  - 04:33:38 to 04:34:40, final run: 54 of 54 checks passed, with no browser console or page errors (the progress page is scanned after closing leftover toasts; the toast check is logged as a note, 0 nodes in that run). In both views:
    - 3,135 confirmed items at effort medium: the estimate read "≈ $5.14 with Sonnet 5.5 · 57 parts · 3,135 items" and Run was disabled with "Too many items to plan in one pass at medium effort: the packing list would not fit in one part. …"; back at 300 items Run was enabled again (1440 only).
    - Gaps: "Add 6 to shopping list", the toast's "Open list", Delete "Waterproof breathable shell jacket" on `/shopping`, Back: the plan read itself again, showed that gap unlocked and the button "Add 1 to shopping list".
    - A copy of the run with a €800 budget, its synthesis "running" under a fresh lease: the progress page showed "Running elsewhere…" and the new hint "Closing or reloading this tab does not stop parts already running; they finish on the server and show here when you come back." After the run was completed in the database, the page asked again, showed the results, and Back twice to the kept `/shopping` changed the budget from 600 to 800 with the "latest relocation plan" link to the new run.
    - Packing: after adding "Umbrella" and pressing Remove from the keyboard, focus was on "0 of 101 things packed" (ring visible); rows and cards have `content-visibility: auto`.
    - Print: Print checklist, Back, a tick on the plan, Forward: the kept print page read itself again and showed the tick.
    - Items: 300 cards; an override saved; tab switches showed the cards.
    - Climate: Set as default from the keyboard put focus on "The relocation form starts with this profile. …" in the Bologna card; completing all 72 Bologna values (1440) changed its source to "Monthly values entered by the owner in Settings, Climate profiles." and its notes to "Owner's description: hot humid summers …"; the rows were then restored from the copy saved before the check.
    - axe (WCAG 2.0 and 2.1, A and AA) found no serious or critical violation on `/shopping` after a delete, the Gaps tab after Back, the progress page, the Packing tab and the climate editor; no page scrolled sideways.
    - All 16 screenshots in `scratchpad/phase5-r2-shots/` were looked at.
  - The check server (pid 16852, and its wrapper processes) was stopped by pid; nothing listened on 3000 or 3100. 04:35:47 to 04:35:49 cleanup: the analyses, their `ai_calls` and the shopping rows deleted from `wardrobe_e2e`, `pnpm db:seed:demo --clean` removed 300, the climate rows matched the copy saved before the check exactly, and the harness's `node_modules` junction was removed (link only).
- Final gate, 04:36:22 to 04:37:43, `.env.local` aside again (put back at 04:37:43; the aside folder empty): `pnpm typecheck` 04:36:22 to 04:36:27, `pnpm lint` to 04:36:39, `pnpm test` to 04:37:33 (127 files passed, 2 skipped; 1,877 tests passed, 2 skipped: the two opt-in Postgres tests), `pnpm build` to 04:37:43, all passed; the relocation routes are partial prerenders and the parts route dynamic, as before.
- 04:37:43 to 04:37:45 grep of `.next/static` for the same secret names and prompt phrases: no match (control string found in 1 of 70 files).
- 04:37:51 `pnpm db:generate`: "No schema changes"; 04:37:53 `pnpm db:migrate`: applied, nothing new; 04:37:54 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept. The container lists only `postgres`, `template0`, `template1`, `wardrobe` and `wardrobe_e2e`: no `wardrobe_r2*` scratch database remains.
- 04:38:04 to 04:39:48 `pnpm test:e2e` (headed, same shell, no credentials): 64 passed, 1 skipped; 04:39:48 to 04:40:01 the smoke spec alone: skipped, "needs BLOB_READ_WRITE_TOKEN in the shell".
- 04:40:01: both databases hold 0 items, analyses, parts, shopping rows, packing rows and `ai_calls`, with Hamburg the default; nothing listens on 3000 or 3100.
- Not run: anything against the live Anthropic API or a real Blob store; a closed tab on a Vercel deployment; a real network drop mid-stream (the SDK path is covered with scripted bodies); a 2,000-item result page timed in a browser after the render changes.

Earlier, by the round-3 review-fix session:

- While fixing, targeted runs passed after each change: `pnpm exec vitest run` on the touched files and folders (`src/lib/ai`, `src/lib/relocation`, `src/server/services/relocation.test.ts`, `src/components/relocate`, `src/components/shopping`, `src/components/climate`, `src/components/ui/toast.test.tsx`, `test/item-freshness.test.ts`), `pnpm exec tsc --noEmit` and `pnpm exec eslint` on the touched files. 10:44 by hand: the edited chunk line with the version still `reloc-v3` failed the templates pin; then `reloc-v4` and its pins were recorded.
- Revert checks (`scratchpad/r3fix6/revert6.py`, `PYTHONIOENCODING=utf-8`; a sha256 manifest of `src`, `test` and `e2e` matched before and after every batch):
  - 11:00:03 to 11:00:56: the first batch stopped at its last case, whose anchor missed a CRLF file; nothing was reported and every file was restored (manifest matched). The script now handles CRLF.
  - 11:01:40 to 11:02:36, 20 cases: 18 as expected; `ui5-unlink` passed (the test did not wait for an animation frame; strengthened) and `ui3-orig` passed (it cannot see the page composition; replaced by `ui3-pages`).
  - 11:03:18 to 11:03:26: `ui5-unlink` and `ui3-pages` failed as expected; `ui3-orig` passed again and was dropped.
  - 11:36:39: a batch on that session's last tree stopped at an anchor that still named the old D-number after the comments were renumbered; every file was restored (manifest matched).
  - 11:37:39 to 11:38:32, that session's last tree, 19 cases: the 18 expected to fail failed and `doc2-old-test` passed, as expected.
- First gate, 11:06:18 to 11:07:50, with `.env.local` moved to `scratchpad/envlocal-aside5d/` (empty before; put back by a trap, the folder empty again): `pnpm typecheck` 11:06:18 to 11:06:23, `pnpm lint` to 11:06:36, `pnpm test` to 11:07:32 (129 files passed, 2 skipped; 1,900 tests passed, 2 skipped), `pnpm build` to 11:07:50, all passed. 11:07:55 grep of `.next/static` (71 files) for the seven secret names, the eleven earlier prompt phrases and the new "that it is not needed there": no match (control string in 1 file).
- 11:08:02 `pnpm db:generate`: "No schema changes"; 11:08:03 `pnpm db:migrate`: applied, nothing new; 11:08:05 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept; no `wardrobe_r3*` database.
- 11:08:12 to 11:10:05 `pnpm test:e2e` (headed; `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `E2E_TAG` unset): 61 passed, 1 failed, 1 skipped, 2 did not run. The failure was `relocate.spec.ts`'s print step expecting an item the AI had decided sell under Suitcase, which D-181 now lists under "Not bringing"; the spec was updated (p5r3-journey-1). 11:10:51 to 11:11:24 `pnpm test:e2e e2e/relocate.spec.ts`: 9 passed.
- Visible-browser check (headed Chromium, `scratchpad/phase5-r3-visual/r3.cjs`, against `next start -p 3100` with the e2e environment, pid 2412):
  - 11:12:09 `pnpm db:seed:demo` into `wardrobe_e2e` (300 items); 11:12:19 to 11:12:21 the flow harness (copied to `phase5-r3-visual`) made one complete analysis through the real start, route, chunk and finalize code: `reloc-v4`, 7 parts whose costs sum exactly to the run's `ai_calls` ($0.515380).
  - 11:15 to 11:29, partial runs that fixed the script, not the app: two locators (a toast is also a dialog; a `has:` locator must be relative), Playwright's history navigation waiting for a held read, and a `/shopping` race setup a pending Server Action serialised (Next queues a navigation behind it); that run was stopped by its task and its one changed item decision restored by hand. 11:16:14 with reads held 1 s: two plan reads (three with 2.5 s, see D-180).
  - 11:29:51 to 11:31:34, full run: 38 of 39 checks, no browser console or page errors. The one failure was axe `color-contrast` on the sidebar's pressed "System" theme button on `/shopping` at 1440 light, scanned while that button's colour transition ran after hydration (the same scan passed on the earlier runs, and `/settings/climate` showed it once at 11:29:15); 11:31:46 to 11:32:07 the view checks again with 800 ms before each scan: 16 of 16.
  - Covered (1440 × 900 light; axe and sideways scroll also at 390 × 844 dark): the races of p5r3-ui-1 and -2 (reads held 2.5 s after the server answered them; saves pressed after that), one read per show (p5r3-ui-3), the toast close button (cr7), Unlink focus (p5r3-ui-5), "not coming" on the Packing tab and the print page, also after Back, an override and Forward (p5r3-journey-1), keyboard focus on a chip, €600 and Add (p5r3-journey-3), the focus-ring room, at 3× scale, with the old row seen failing (p5r3-ui-4), "-" in an emptied Hamburg cell (p5r3-journey-4), and axe (WCAG 2.0 and 2.1, A and AA) with no serious or critical violation on the Packing tab with not-coming rows, the print page, `/shopping`, `/relocate` after a chip and `/settings/climate`; no page scrolled sideways.
  - 11:32:25 headless `page.pdf` of the print page (A4; default and 1 cm margins), read with PyMuPDF: 3 pages, Suitcase on page 1; with the old rule injected, 4 pages, page 1 only the title (p5r3-journey-2).
  - All screenshots and PDFs in `scratchpad/phase5-r3-shots/` were looked at.
  - The server (pid 2412 and its child processes) was stopped by pid at 11:33:24; nothing listened on 3000 or 3100. 11:33:32 cleanup: the analysis, its parts, packing rows and `ai_calls` and the shopping rows deleted from `wardrobe_e2e`, `pnpm db:seed:demo --clean` removed 300, the climate rows matched the copy saved before the check, and the harness's `node_modules` junction was removed (link only).
- That session's final gate, 11:38:38 to 11:40:08, `.env.local` aside again (put back at 11:40:08; the aside folder empty): `pnpm typecheck` 11:38:38 to 11:38:43, `pnpm lint` to 11:38:57, `pnpm test` to 11:39:57 (129 files passed, 2 skipped; 1,900 tests passed, 2 skipped: the two opt-in Postgres tests), `pnpm build` to 11:40:08, all passed; the relocation and shopping routes are partial prerenders and the parts route dynamic, as before.
- 11:40:14 grep of `.next/static` (71 files) for the same secret names and prompt phrases: no match (control string in 1 file).
- 11:40:21 `pnpm db:generate`: "No schema changes"; 11:40:23 `pnpm db:migrate`: applied, nothing new; 11:40:24 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept. The container lists only `postgres`, `template0`, `template1`, `wardrobe` and `wardrobe_e2e`: no `wardrobe_r3*` scratch database.
- 11:40:30 to 11:42:19 `pnpm test:e2e` (headed, same shell, no credentials): 64 passed, 1 skipped; 11:42:26 to 11:42:40 the smoke spec alone with the JSON reporter: skipped, "needs BLOB_READ_WRITE_TOKEN in the shell".
- 11:42:47: both databases hold 0 items, analyses, parts, shopping rows, packing rows and `ai_calls`, with Hamburg the default; nothing listens on 3000 or 3100.
- 11:45:21 `pnpm exec vitest run src/lib/ai src/server/services/tag-item.test.ts "src/app/api/items/[id]/tag/route.test.ts"` (the shared AI layer and the Phase 3 tagging path, same tree): 11 files, 250 tests passed.
- Not run: anything against the live Anthropic API or a real Blob store; a real network drop or SSE error event mid-stream (scripted bodies only); a real browser print dialog or paper (the PDF came from headless Chromium); the 2,000-item result page timed in a browser.

Review round 4, by this session (the checks for the final tree):

- Before any change: every one of the 462 files of tree 9e5796d matched the working tree (`git hash-object`, which writes nothing), and no other file was present.
- 12:38:29 to 12:38:36 `pnpm exec vitest run` on the five touched test files, with the new tests and no fix yet: 6 tests failed in 5 files (129 passed), one or more for each of p5r4-state-1, -2, -3 and p5r4-rest-1; the two tagging tests of p5r4-rest-2 passed.
- While fixing, targeted runs: 12:39:46 to 12:39:57 the relocate, shopping and AI folders with `test/item-freshness.test.ts`: two tests failed as they had to (the print page's wiring test pinned `refreshWhileShown: false`; the Unlink focus test reset its row with copies nobody asked for) and were updated; 12:40:36 to 12:40:46: 22 files, 342 tests passed. 12:43:09 to 12:43:21 `pnpm exec tsc --noEmit` and `pnpm exec eslint` on the 11 touched files: clean. 13:01:26 to 13:01:44, after the press fix (below): 13 files, 120 tests passed; `tsc` and `eslint` on the touched files clean.
- Revert checks (`scratchpad/r4fix/revert7.py`, `PYTHONIOENCODING=utf-8`; a sha256 manifest of `src`, `test` and `e2e` matched before and after every batch):
  - 12:41:37 to 12:42:00, 7 cases: all failed as expected.
  - 12:47:43 to 12:48:05, the same 7 after the decision numbers in the comments were split into D-183 to D-185: all failed as expected.
  - 13:02:01 to 13:02:13, the 4 print cases, two of them new for the press: all failed as expected.
  - 13:10:52 to 13:11:21, final tree, all 9 cases (`state1-dup-extra`, `state2-unasked-copy`, `state3-print-packing`, `state3-print-items`, `state3-print-press-effect`, `state3-print-press-link`, `rest1-http-after-reply`, `rest2-tagging-longest`, `r3-ui5-unlink-still`): all failed as expected.
- First gate, 12:48:13 to 12:49:41, with `.env.local` moved to `scratchpad/envlocal-aside5e/` (created empty; put back by a trap at 12:49:41, the folder empty again): `pnpm typecheck` 12:48:14 to 12:48:19, `pnpm lint` to 12:48:30, `pnpm test` to 12:49:27 (129 files passed, 2 skipped; 1,908 tests passed, 2 skipped), `pnpm build` to 12:49:41, all passed. 12:49:54 grep of `.next/static` (71 files) for the seven secret names, `BLOB_READ_WRITE_TOKEN`, and the twelve prompt phrases of round 3: no match, except `BLOB_READ_WRITE_TOKEN` in one file, only as `@vercel/blob`'s own environment lookup (`b("BLOB_READ_WRITE_TOKEN")`, a name and no value; the Phase 3 and 4 entries record the same); the control string was found in 1 file.
- 12:50:15 `pnpm db:generate`: "No schema changes"; 12:50:16 `pnpm db:migrate`: applied, nothing new; 12:50:18 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept.
- 12:50:27 to 12:52:12 `pnpm test:e2e` (headed; `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `E2E_TAG` unset): 64 passed, 1 skipped; 12:52:19 to 12:52:33 the smoke spec alone with the JSON reporter: skipped, "needs BLOB_READ_WRITE_TOKEN in the shell".
- First visible-browser check (headed Chromium, `scratchpad/phase5-r4-visual/r4.mjs`, against `next start -p 3100` with the env of `scratchpad/vcheck/start.ts`, node pid 32676 and its wrapper processes):
  - 12:53:46 `pnpm db:seed:demo` into `wardrobe_e2e` (300 items; the climate rows saved first); 12:53:48 to 12:53:50 the flow harness (copied to `phase5-r4-visual`, its `node_modules` a junction) made one complete analysis through the real start, route, chunk and finalize code: `reloc-v4`, 7 parts summing exactly to the run's `ai_calls` ($0.515380).
  - 12:56:21 to 12:56:41: the plan's extra check passed (below); the run then stopped on the script's own locator for a shopping row. 12:56:52 to 12:57:40, the other checks: 17 of 19. The two failures were the app's: with the first form of the p5r4-state-3 fix, the print page did not read again after a tick held 1.5 s or a decision held 4 s, and printed both as before.
  - 12:59:52 a probe (`probe-commit.mjs`) logged the order: tick sent 1,432 ms, print read sent 1,491 ms and answered 1,538 ms, tick answered 3,450 ms, the URL and the print heading at 3,491 ms. React committed the navigation only after the save, so the press fix (D-184 a) was added.
  - 13:02:36 the server's processes stopped by pid; 13:02:44 the analysis, its parts, packing rows, `ai_calls` and the shopping rows deleted and `pnpm db:seed:demo --clean` removed 300; the climate rows matched the copy.
- Final gate, 13:03:42 to 13:05:08, `.env.local` aside again (the folder empty before; put back at 13:05:08, empty again): `pnpm typecheck` 13:03:42 to 13:03:47, `pnpm lint` to 13:03:59, `pnpm test` to 13:04:56 (129 files passed, 2 skipped; 1,910 tests passed, 2 skipped: the two opt-in Postgres tests), `pnpm build` to 13:05:08, all passed; the relocation and shopping routes are partial prerenders and the parts route dynamic, as before.
- 13:05:15 to 13:05:17 grep of `.next/static` (71 files): the same result (only `@vercel/blob`'s lookup of `BLOB_READ_WRITE_TOKEN`; no other secret name or prompt phrase; control string in 1 file).
- 13:05:24 to 13:05:30 `pnpm exec vitest run src/lib/ai src/server/services/tag-item.test.ts "src/app/api/items/[id]/tag/route.test.ts"` (the shared AI layer and the Phase 3 tagging path): 11 files, 255 tests passed.
- 13:05:30 `pnpm db:generate`: "No schema changes"; 13:05:31 `pnpm db:migrate`: applied, nothing new; 13:05:33 `pnpm db:seed`: Hamburg updated, Bologna and app_settings kept. The container lists only `postgres`, `template0`, `template1`, `wardrobe` and `wardrobe_e2e`: this session made no scratch database, and no `wardrobe_r4*` database exists.
- 13:05:41 to 13:07:30 `pnpm test:e2e` (headed, same shell, the three variables unset): 64 passed, 1 skipped; 13:07:30 to 13:07:44 the smoke spec alone with the JSON reporter: skipped, "needs BLOB_READ_WRITE_TOKEN in the shell".
- Final visible-browser check, on the e2e build of the final tree (the same script and server env; node pid 27252 and its wrapper processes):
  - 13:07:53 `pnpm db:seed:demo` (300) and 13:07:54 to 13:07:56 the flow harness: one complete analysis, `reloc-v4`, 7 parts and `ai_calls` both $0.515380. The climate rows were saved again first: the e2e run's setup had recreated the two profiles with new ids since the first check.
  - 13:08:22 to 13:09:43: 39 of 39 checks passed, with no browser console or page errors. At 1440 × 900 light, with Playwright holding reads or actions:
    - p5r4-state-1: an override, Settings, Back to the kept plan with its read held 5 s before the server, "R4 umbrella" added in Carry-on meanwhile. The add was answered at 5,371 ms and the read reached the server at 10,049 ms, so its copy held the extra. In seven samples to +12 s, before and after that copy and the reread: one "R4 umbrella" row, "Packing 78" (77 before), "0 of 78 things packed" and "Carry-on (0 of 7)" (6 before); two plan reads (the one asked on Back and the overlay's one more), and one database row.
    - p5r4-state-2: on `/shopping`, the sidebar's Shopping link with its answer held 4 s; the list stayed usable; Bought on "Waterproof breathable shell jacket" was sent at 20,673 ms and answered at 20,684 ms, the link's copy landed at 24,250 ms. Bought stayed pressed to the end (+11 s), the summary read "6 entries on your list, 5 still to buy." and the budget "To buy: 5 items", the list read once more right after the copy (24,263 ms) and no more, and the database said bought.
    - p5r4-state-3: a tick on "Beige hoodie" held 1.5 s, then "Print checklist": the print read was answered at 32,451 ms and the tick at 33,861 ms; the page first showed the row unticked, read again at 33,929 ms (two print reads) and printed it ticked; the database said packed. Donate on "Charcoal oxford shirt" held 4 s, then Packing and "Print checklist" (print read answered at 42,182 ms, the decision at 46,038 ms): first under Suitcase, then, after one more read at 46,090 ms, under "Not bringing" with "(Yours: Donate · not coming)"; the database said donate.
    - D-184's hidden page: with the print page kept hidden behind the plan, a tick read neither page; Forward read the print page once and printed the tick.
    - axe (WCAG 2.0 and 2.1, A and AA) found no serious or critical violation on the Packing tab, the print page and `/shopping`, at 1440 × 900 light and 390 × 844 dark; no page scrolled sideways.
  - All 12 screenshots in `scratchpad/phase5-r4-shots/` were looked at. `state1-extra-once-carry-on.png`, an element capture of the Carry-on group, shows only its heading and input: the group is stretched to the Suitcase's height and its rows (`content-visibility: auto`) were not painted in that capture; `state1-extra-once-counts-1440.png` shows the same group with one "R4 umbrella" row, "Packing 78" and "0 of 78 things packed". In full-page phone screenshots the fixed tab bar shows mid-page; that is how the capture works.
  - 13:10:26 the server stopped by pid (its wrapper processes exited with it); nothing listened on 3000 or 3100. 13:10:38 to 13:10:40 cleanup: the analysis, its parts, packing rows and `ai_calls` and the shopping rows deleted from `wardrobe_e2e`, `pnpm db:seed:demo --clean` removed 300, the climate rows matched the copy saved before this check; both databases then held 0 items, analyses, parts, shopping rows, packing rows and `ai_calls`, with Hamburg the default. 13:10:45 the harness's `node_modules` junction removed with `rmdir` (link only).
- 13:12:49 `grep -n "final tree" HANDOFF.md` within this entry: only the round-4 summary under State, the p5r4-rest-3 bullet (which quotes the old lines), this section's intro and this round's own checks (p5r4-rest-3).
Final checks by the lead, on the final tree (git tree `bbae426`, no file changed between them except this entry):

- Gate, 13:14:36 to 13:16:01, with `.env.local` moved to `scratchpad/envlocal-mine/` (empty before) and restored at 13:16:01:
  - `pnpm typecheck` to 13:14:41 and `pnpm lint` to 13:14:53: passed.
  - `pnpm test` to 13:15:50: 129 files passed, 2 skipped; 1,910 tests passed, 2 skipped.
  - `pnpm build` to 13:16:01: passed. `/relocate`, `/relocate/[id]`, its print page, `/shopping` and `/settings/climate` are partial prerenders; the parts route is dynamic.
- Grep of `.next/static` (54 files) at about 13:16 found none of these: two system-prompt phrases ("You are a frugal relocation stylist", "Prefer layering over single heavy items"), `reloc-v4`, `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `APP_PASSWORD_HASH`, `DATABASE_URL`, `CRON_SECRET` or `sk-ant-`. `BLOB_READ_WRITE_TOKEN` appears in one file, as the name `@vercel/blob` looks up, with no value. The control string "Re-run anyway" was found.
- Docker: 13:16:34 `pnpm db:generate` reported "No schema changes"; `pnpm db:migrate` applied; 13:16:37 `pnpm db:seed` updated Hamburg and kept Bologna and app_settings.
- 13:16:43 to 13:18:31 `pnpm test:e2e`, headed, with `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `E2E_TAG` unset in the shell: 64 passed, 1 skipped (the smoke spec, which needs a Blob token).
- Both databases afterwards held 0 items, analyses, parts, shopping rows, packing rows and `ai_calls`, with Hamburg the default.
- Visible-browser check: headed Chromium, `scratchpad/vcheck5/check5.cjs`, the lead's own script, against `next start -p 3100` with the e2e env.
  - Setup: 300 demo items in `wardrobe_e2e` (13:19:52), then one complete analysis through the real start, part and finalize code with the realistic fake Claude: `reloc-v4`, 7 parts, parts and `ai_calls` both $0.515380, estimate $0.555378.
  - Runs 1 to 5 stopped on the script's own mistakes, fixed before each next run, with the data reset and re-seeded:
    - an ambiguous locator, twice: the placeholder consent text, and a budget field momentarily duplicated while streaming settled;
    - an enum comparison in SQL;
    - one browser window that closed mid-run;
    - two assertions that were wrong. Apply compared items the owner had already decided with the AI's decision, and "white" did not accept Chrome's `lab(100 0 0)`.
  - Final run, 13:25:35 to 13:26:11: 53 of 53 checks passed, with no console or page errors. Each check compares the screen with the database.
    - The form: "≈ $0.55 with Sonnet 5.5 · 7 parts · 300 items" with 300 confirmed items in the database. The chips rebuilt the seeded run's constraints, and with €600 the "Unchanged since" banner linked the seeded run and offered "Re-run anyway". Bologna asked for the placeholder consent and blocked Run.
    - A run with no API key: the progress page said "Configuration problem"; all 7 parts stayed pending with 0 attempts and no `ai_calls` row was added.
    - The result's tab counts equal the stored result: 300 items, 6 gaps, 4 layering systems, 2 warnings. The summary has 575 characters, every item is decided once, and the cost shows "$0.52 (estimated $0.56)".
    - An override to Donate was written to `items.decision` and survived a reload.
    - "Apply AI decisions to 170 undecided items": all 170 got the AI's decision, and the 130 decisions the owner had made were unchanged.
    - "Add 6 to shopping list" wrote 6 rows.
    - A packing tick was saved and survived a reload. An extra was added once and removed, and focus went to "1 of 77 things packed".
    - The print page in print media had no navigation and a white page. `/shopping` had the budget 600. `/wardrobe?decision=donate` showed 90 items, as the database had.
    - At 390 × 844 dark, `/relocate`, the result, its print page, `/shopping` and `/settings/climate` had no sideways scroll and no serious axe violation, and the result tabs fit (358 px). The lead looked at the screenshots in `scratchpad/vcheck5/shots/`.
  - Cleanup, right after the final run: the server stopped by pid, and nothing listened on 3000, 3100 or 3200; the analyses, shopping rows and `ai_calls` were deleted and `pnpm db:seed:demo --clean` removed 300. Both databases then held 0 of every Phase 5 table and 0 items, with Hamburg the default and Bologna still a placeholder. The junction was removed with `rmdir`.
- 13:27:04 `npm view next@16.4 version`: 16.4.4 is still the newest, so the security release is not out (wardrobe-9ri stays open).
- Not run: anything against the live Anthropic API or a real Blob store; a real slow network or cold function (the races were made with Playwright holding requests and answers); a real browser print dialog or paper; the progress page with real Claude answers.

### Migration and deploy state

No new migration: `pnpm db:generate` reported no schema changes at 01:22:58, 01:46:38, 02:35:57, 02:50:22, 04:17:43, 04:37:51, 11:08:02, 11:40:21, 12:50:15, 13:05:30 and 13:16:34 (the lead's final check), and `pnpm db:migrate` found nothing new on the Docker `wardrobe` database. `wardrobe_e2e` is migrated by the e2e global setup. Neon has not been migrated: the Phase 4 `archived_from` migration is still pending there (wardrobe-c8x). Not deployed.

### Open risks

- No relocation run has called Claude. Unmeasured: whether the API accepts the chunk and synthesis output schemas, each part's latency against the 270 s stop and the 300 s limit (since D-164 the caps assume at least 110 tokens per second), the real cost against the estimate ($0.55 for 300 items at medium, D-147), cache reads between parallel chunks, refusals, and the quality of the decisions, layering systems, gaps and packing under `reloc-v4` (shipped items as bring, items worn in rotation, leave for items already there). The browser check used answers from a scripted fake, not Claude's.
- The estimate is above D-026's earlier band; the default monthly budget of $20 covers about 30 runs at that figure. The synthesis size limits of D-175 (1,800 items at high, 3,133 at medium, 5,287 at low) are projections from the same estimate; the round-2 sample replies put the high-effort break between about 1,600 and 2,150 items.
- Whether Anthropic bills a stream our own deadline or cancel aborts is not documented; such attempts are still logged without usage. A broken stream's row is a lower bound (D-163).
- A part whose function is killed (or a dev server restarted) stays "running" until its 5-minute lease ends and is then taken over without a Retry; its paid attempts now stay on the part (D-168), and its partial decisions are paid for again. Since D-167 a closed tab no longer cuts a part off; that is unverified on a Vercel deployment.
- The result page still renders every card and keeps every panel mounted: the render and layout costs are lower (D-174), but a 2,000-item wardrobe still means about 60,000 DOM nodes and the long toggle class; not measured in a browser after the change.
- Base UI 1.9.0 itself still marks the collapsed toast's close button `aria-hidden` while leaving it focusable; the generated `toast.tsx` now takes it out of the tab order while hidden (wardrobe-cr7, fixed in round 3, D-182 e). A `shadcn add toast --overwrite` would drop that; `toast.test.tsx` would then fail.
- D-180 relies on Next 16.4.3 and React behaviour the docs do not promise: overlapping `router.refresh()` calls bring one copy, the newest (React renders the router's queued transition updates together). The round-4 review reproduced a navigation racing a save (the Shopping link pressed on `/shopping`, then Bought); since D-183 a copy no refresh asked for counts as read when the previous copy was, so the save stays and the page reads once more, at the cost of one more read after a navigation that follows saves on a kept plan or `/shopping`. Still possible, reasoned from the code and not reproduced: a navigation that started before one of the page's own refreshes and lands after it is counted from that refresh, so it can show the older state until the refresh's own copy lands. While a read is pending, a tick's or a status's count follows only when that read lands, and with slow answers D-136's own read can add a third read after an override (both seen in the round-3 browser check). Re-check after a Next upgrade (wardrobe-9ri).
- The print page counts a read from the press of "Print checklist" (D-184). A fresh print read reached another way while a save runs (Forward to a print page Next no longer keeps) still counts from its first show, the rule of every page since D-107, so such a save shows only on the next show (not reproduced). Two saves that answer in separate tasks while the print page is shown read it twice. D-184 (a) relies on React holding the navigation until the save's transition ends (seen with Next 16.4.3 and React 19.3); either order is covered, but re-check at wardrobe-9ri.
- Since D-177 and D-185 a call near its deadline sends fewer last attempts, tagging's 50 s included: the owner gets the real error and Retry instead of a paid attempt the deadline would cut off. How often that happens is unmeasured until live runs (wardrobe-izw, wardrobe-aea).
- The axe scan in the browser check twice measured the sidebar's pressed theme button during its colour transition after hydration (`color-contrast`, once each on `/shopping` and `/settings/climate`); settled, the same pages passed. Not a Phase 5 change.
- Runs finished before D-159 keep slug gap keys, and runs before D-170 have no profile slug (read as Hamburg runs); only test and dev data. `reloc-v3`, `reloc-v4` and the new climate line change the cache key, so earlier runs are never offered as cached.
- `in_transit` means "on the way to Hamburg": on a Bologna run an item in transit is treated like any other (D-170).
- Every destructive Alert in the app now uses `--destructive-strong` (D-155 a); only the pages in the axe scan and the browser checks were looked at.
- The relocate e2e spec completes its run in the database with the shared fixture, not through finalize; finalize is covered by the service tests and by the scratch flow runs reported above, which are not part of the repo.
- The risks in the entries below stand.

### Live checks pending

- A real run on the owner's wardrobe (wardrobe-izw), which needs the owner's approval for its cost (about $0.40–0.80 by the estimate, D-147): every part well under 300 s by `ai_calls.latency_ms`; the actual cost against the estimate, recorded in HANDOFF and in README's Costs; the cached result offered on a second click with no new `ai_calls` rows; "Re-run anyway" starting a new run; no "schema too complex" 400s and no refusals.
- A print of the checklist from a real browser print dialog, in light and dark mode: the groups flow across sheets and "Not bringing" comes last (D-181); and, on a phone network, "Print checklist" pressed right after a tick and after an override: the print page shows both once they are saved (D-184).
- On a Vercel deployment: close the tab while a part runs, open the run again, and confirm the part completed (D-167).
- The first live run's Console cost for its cache-reading calls (chunks 5 and 6, the synthesis, a repair) against `ai_calls`, which now prices Sonnet 5.5 cache reads at $0.10 per MTok (D-021).
- Socks, base layers and work shirts not mostly donated or sold, items to ship decided bring, items already in Hamburg that are needed decided bring or kept, not left, and no gap that buys back a type the chunks let go (D-171, D-179).
- The live checks in the entries below.

### Next steps

Phase 5 is committed with this entry. wardrobe-evp is closed, and so is wardrobe-cr7 (the toast close button, fixed in round 3, D-182 e).

1. Phase 6 (wardrobe-g4t).
2. Run the live relocation check above once the owner approves the spend: wardrobe-izw.
3. Before the next deploy, run `pnpm db:migrate` against Neon (the Phase 4 migration): wardrobe-c8x.
4. The Blob and tagging live checks: wardrobe-aea.
5. Bump `next`, `eslint-config-next` and `@next/env` together once the announced security release is out (16.4.4 was still the newest at 13:27:04), and re-check the assumptions of D-180 and D-183 about refreshes and navigations then: wardrobe-9ri.
6. The owner decides on D-093 and D-134: wardrobe-any.

## 2026-11-02 — Phase 4 (browse, stats, export)

### State

Phase 4 (wardrobe-a27) is built, integrated and reviewed, not yet committed. Five implementation runs wrote it: contracts, browse, detail, stats and export. An earlier integration run stopped at a usage limit partway through. The integration session reviewed every edit that run left in the working tree, kept or fixed each one, finished the remaining steps and re-ran every check itself; nothing below comes from the interrupted run. A review then confirmed 13 findings (none rejected); a fix session fixed all 13, each with a regression test that fails without the fix, and re-ran every check (see Review and Checks run). After that round the gate passed with no `.env.local`, Docker migrated and seeded with no schema change, the headed e2e suite passed 47 tests and skipped the smoke spec with its reason, the visible-browser re-check of every screen a fix touched passed 7 of 7 (all archived) and 43 of 43 (with the 300-item demo seed), and two reverse checks in a production build showed the old code failing where the new code passes. A second review then confirmed 15 more findings (none rejected). The round-2 fix session fixed 14 and partly fixed 1 (p4r2-rules-9: the Beads ids wait for a session allowed to touch Beads). Each of its 10 code and test fixes (p4r2-data-1, -data-2, -client-1 to -4, -rules-1 to -4) has a regression test seen failing without it (12 revert cases); p4r2-rules-5 to -7 were docs only, and the e2e spec additions of p4r2-rules-8 were run and passed but not seen failing without the change. That session added one migration (`items.archived_from`, applied to the local Docker databases only) and re-ran every check: the gate with no `.env.local`, Docker, the headed e2e suite (48 passed, the smoke spec skipped with its reason) and a visible-browser re-check of every screen the fixes touched (27 of 27), plus a reverse build that showed the old grid and refresh code failing where the new code passes (see Review, round 2, and Checks run). A third review then confirmed 5 findings and rejected 1. The round-3 fix session fixed all 5: each of the 3 code fixes (p4r3-cli-1, -3, -4) has regression tests seen failing without it (6 revert cases), and p4r3-srv-1 and -2 are docs only, checked with grep before and after. Running the gate showed the p4r3-cli-3 fix as first written to be incomplete; it was completed and the gate re-run. That session added no migration and re-ran every check: the gate with no `.env.local`, Docker, the headed e2e suite (48 passed, the smoke spec skipped with its reason) and a visible-browser re-check of the item page, the export page and the review page (24 of 24), plus a reverse build that showed the round-2 tag form and export page failing where the new code passes (see Review, round 3, and Checks run). Before the commit, the session that ran the reviews re-ran every check itself on the final tree, independently of the fix sessions' reports: the gate with no `.env.local`, Docker, the headed e2e suite and a visible-browser pass over every Phase 4 page with the 300-item demo seed (see "Final checks before the commit" under Checks run). It also created the Beads issues the next steps lacked, which completes p4r2-rules-9. Phase 4 is committed with this entry.

What Phase 4 adds:

- `/wardrobe`: a virtualised grid (2 columns on a phone, 6 at 1440 px) with search, category chips with counts, a filter panel (bottom drawer on a phone, side drawer on a wider screen) and sort. Every filter lives in the URL, and the list is capped at 2,000 items (D-108, D-109). The page has a Stats link.
- `/wardrobe/[id]`: the item page. It has the photo with a cut-out switch and a link to the original, plan and location toggles that save at once, the tag form in a new `detail` mode, tagging in place for pending items, details, Archive or Unarchive, and Delete (D-110, D-111).
- `/stats`: overview counts, the winter-ready checklist with evidence links, and bar tables (D-112). The Wardrobe tab stays marked on this page.
- `/settings/export`: JSON and CSV downloads and photo ZIP parts of at most 100 photos (D-114, D-115). Settings links to it under "Your data".
- `pnpm db:seed:demo [--clean]`: 300 local-only demo items (D-116).
- New e2e specs: `a11y`, `wardrobe`, `item-detail`, `stats`, `export`, and the opt-in `smoke` (D-113).

Integration, by item:

- The list no longer shows stale data after a change on an item page (D-107):
  - The interrupted run's per-tab change count (`src/lib/items/wardrobe-changes.ts`) is kept, with every save call site noting a change. So is the list's refresh when Next shows it again, and the back link always going back in history to the list.
  - This session generalised the helper to `shownDataIsStale`. It added `RefreshAfterItemChanges` (`src/components/items/refresh-after-item-changes.tsx`, with a unit test) to `/stats`, because Back from an item opened from the checklist showed the old checklist. `e2e/stats.spec.ts` now covers that case.
  - Reverse check: with both refresh calls disabled, Back showed stale data on both pages, and the browser sent no request for either page. So the mechanism is needed, not just harmless.
- Every Link styled with `buttonVariants({ variant: "outline" })` had no border in light mode. This hit the Stats button, the Download links, the back links, and Settings' AI usage and Export links. `buttonVariants` now returns a merged class list (D-117 d).
- `test/boundaries.test.ts`:
  - The D-013 session check now also covers the server read functions in `src/server/items` (`loadItemDetail`, `loadItemCard(s)`).
  - The new Phase 4 server modules are in the walk's guard list.
- The wardrobe component tests stub jsdom's `scrollTo`, which printed "Not implemented" twelve times per run. The virtualizer scrolls the window when measured rows differ from its estimates.
- DECISIONS.md:
  - D-107, D-109, D-115 and D-117 were corrected to what this session measured and saw.
  - D-036 and D-037 now point to the entries that refine them.
- Kept from the interrupted run after review:
  - The Stats link in the toolbar, and `alsoActiveOn` in `nav-items.ts` (no sixth tab).
  - The a11y fixes D-117 a to c, and the offline page form (D-118).
  - `e2e/live-env.ts` and the `playwright.config.ts` pass-through (D-113).
  - The skips in `add`, `item-detail` and `review` for runs with real credentials.
  - The auth spec's canary item, now deleted after its test, because the stats spec counts confirmed items.
  - `add-flow-view.test.tsx` now links to Settings instead of Wardrobe, because of the lint rule in D-118.
  - `vercel.json` `supportsCancellation` for the images route.
  - The README sections and `e2e/README.md`.

Deviations from `design.md` Phase 4, as the implementation runs reported them:

- Names follow the shared contract:
  - `parseItemFilters` and `serializeItemFilters` are hand-written; there is no zod `ItemFiltersSchema`.
  - `listWardrobeItems` returns `counts`; there is no separate `categoryCounts()`.
  - `loadItemDetail` replaces `getItemDetail`.
  - `item-lifecycle.ts` with `deleteItem` replaces `delete-item.ts`.
  - The DTO uses `thumb`, `warmthLevel` and `multipleItemsDetected`.
- The filter panel is one Base UI Drawer. There is no Popover or Sheet.
- The demo seed uses `/icons/icon-192.png`, not `/demo/thumb.webp`.
- The item page has no thumbnail strip.
- The stats checklist comes second, not last.
- `planZipParts` takes `kind` as an option.
- The JSON adds `analysisParts`, and export routes refuse cross-site requests.
- ZIP parts are cut by count only, not by predicted time (D-115 refines D-036).

Statements in the entries below that are no longer true:

- "`E2E_TAG` is described as reserved for the planned Phase 4 smoke spec": the smoke spec exists and reads it (D-113). All five places named there were updated.
- Next steps item 1 of the Phase 3 third review entry ("Phase 4 … browse, stats and export") is done, apart from the commit.
- "The forged-action e2e test still posts to `/wardrobe`, which renders no items until Phase 4" (Phase 3 entries, Open risks): `/wardrobe` renders items now, and `e2e/auth.spec.ts` seeds a canary item for that test and deletes it right after, so the check that no item data comes back means something.

### Decisions

D-107 to D-118 are new, under "Added in Phase 4". D-036 is refined by D-115, D-037 by D-108 and D-109, and D-102 by D-113.

The review fixes added D-119 to D-127, under "Added in the Phase 4 review". They refine D-020 (D-127), D-107 (D-123), D-108 (D-119, D-120, D-125), D-109 (D-119, D-124), D-110 (D-123), D-111 (D-127) and D-116 (D-126); those entries now say so. D-108's colour sentence, D-109's measuring sentence, D-110's "shown again" sentence and D-116's guard were corrected to what the code now does.

The second review's fixes added D-128 to D-135, under "Added in the Phase 4 second review". They refine D-107 (D-129, D-130, D-134), D-110 (D-132), D-111 (D-128), D-114 (D-135), D-117 (D-133), D-123 (D-129, D-130, D-132) and D-124 (D-131); those entries now say so, and the sentences the fixes made untrue were corrected (D-111's unarchive rule, D-110's "unsaved edits are kept", D-124's "measured by its ref callback"). D-123's Decision and Why were corrected to what the browser showed: the late-save gap is real for fetch saves and for Server Actions called from plain handlers (Archive, measured in this session), while the plan toggles hold Back through their async transition. D-113 names the pages the axe scan covers. D-050 lists the Phase 4 edits to generated shadcn files and is "refined by D-117". D-134 (the back link without the Navigation API) awaits the owner's acceptance.

The third review's fixes added D-136 to D-138, under "Added in the Phase 4 third review". They refine D-107 (D-138), D-123 (D-136), D-129 (D-136, D-138), D-130 (D-136) and D-132 (D-137); those entries now say so, and the sentences the fixes made untrue were corrected (D-129's "sibling effects run in order, so its own batch results count as seen" and "changes noted while it is shown … do not refresh it", D-132's adoption rule). D-128 now says "Deviates from spec: yes (additions only)" and calls `items.archived_from` an addition beyond D-011 and D-058, and D-011's status reads "accepted; extended by D-058 and D-128" (p4r3-srv-1).

### Review

13 findings, all confirmed by the verifiers and re-checked against the code before any change; none rejected. Each fix has a regression test, and each test was seen to fail with that fix undone (temporarily, files restored byte for byte afterwards).

- p4-ux-1, confirmed (chip badges wrong in the Untagged and archived views). The counts query now leaves out both category and status, groups by both, and derives each badge with `statusesAfterChip` (shared with `applyChip`); new `CategoryCounts.untagged` and `.archived`; `chipCount` drives the badges. Tests: `items-query.test.ts` checks every chip against the list it stands for in seven views, plus a capped Untagged view; `category-chips.test.tsx` renders an archived and an Untagged view. D-119.
- p4-ux-2, confirmed (choosing a colour hid the others). New server colour facet `WardrobeListDto.colors` (every filter except colour, up to 24) and `colorOptionsWithChosen`; the panel hint says where the colours come from. Tests: four facet tests in `items-query.test.ts`, a panel test in `wardrobe-results.test.tsx`. D-120.
- p4-ux-3, confirmed (Untagged pressed while a category filter was hidden). `isUntaggedView` (now in `filters.ts`) requires no category. Tests in `category-chips.test.tsx` and `filters.test.ts`. D-119.
- p4-ux-4, confirmed (all archived read as "No items yet"). New "All N items are archived" state with "Show archived items". Tests in `items-query.test.ts` and `wardrobe-results.test.tsx`. D-121.
- p4-ux-5, confirmed (focus fell to `<body>` after Reset filters). Focus moves to the result count once the new list arrives, only when lost, once per reset; `focusWasLost` moved to `src/lib/focus.ts`. Tests: three cases in `wardrobe-results.test.tsx`. D-121.
- p4-ux-6, confirmed (two names for one status). Card badges use `STATUS_LABELS`. Test: `virtualized-grid.test.tsx` checks every status. D-122.
- p4-sec-1, confirmed (`?host=` slipped past the demo seed's guard). `nonLocalReason` refuses `host` and `hostaddr` in the query string. Test in `scripts/seed-demo.test.ts`, which also shows `pg` would connect to the query's host. D-126.
- p4-sec-2, confirmed (a NUL in `q` or a colour crashed the page). The normalisers strip U+0000. Tests in `filters.test.ts` and `items-query.test.ts`. D-125.
- p4-sec-3, confirmed (a delete during a tagging call lost the spend row). `logAiCall` retries once with `item_id` null on that foreign key only. Tests: new `src/lib/ai/log.test.ts` and a race test in `tag-item.test.ts` (NOT_FOUND, one row, cost kept). D-127.
- p4-client-1, confirmed (a refresh after Back moved the list). Rows are keyed by their tiles' ids; `measure()` only on a tile width change; the no-op re-measure loop is gone. Tests: new `virtualized-grid-changes.test.tsx` (refresh, a changed plan, a filter change, with a ResizeObserver fake that reports sizes). D-124.
- p4-client-2, confirmed (a save answering after Back left the list stale). `subscribeWardrobeChanges`; `useRefreshAfterItemChanges` listens while the page is shown. Tests in `wardrobe-changes.test.ts`, `refresh-after-item-changes.test.tsx` and `wardrobe-results.test.tsx`. D-123.
- p4-client-3, confirmed (a column change dropped keyboard focus). The focused card is tracked by id and focus is put back on it after new columns or rows. Tests: four cases in `virtualized-grid-changes.test.tsx`. D-124.
- p4-client-4, confirmed (the item page showed old data after a change elsewhere). `ItemDetail` renders `RefreshAfterItemChanges` (on show only, not for its own saves). The verifier's related gap is closed too: `/add/review` notes a change when its render applied batch results (`NoteServerItemChanges`). Tests: two cases in `item-detail.test.tsx`, new `note-server-item-changes.test.tsx`. D-123.

What the browser added to the unit tests:

- p4-client-2 in the real app: Back after a plan change waited until the toggle's save answered, so a late plan change already showed on the list without the fix (checked with a build without the listener call). Round 2 traced the hold to the toggles saving inside an async transition, which Back's transition waits for, not to Next's router queue; Archive, called from a plain handler, does not hold Back (measured in round 2, D-123). The gap was real for fetch-based saves, which do not go through the router: with a "Tag now" answer held 2.5 s and Back pressed at once, the build without the listener call left the card on "Waiting for tags"; the fixed build re-read the list when the answer came and showed "Tagged".
- p4-client-1 in the real app at 390 px: with the pre-fix grid, the card above the one changed moved by 78 px (scrolled to 6,000 px) and 126 px (9,000 px) when the list refreshed after Back; with the fix it stayed at the same position, 0 px.

### Review, round 2

15 findings, all confirmed by the verifiers and re-checked against the code before any change; none rejected. None re-opens a round-1 finding except where noted (p4r2-client-1 and p4r2-client-2 complete the round-1 fixes for p4-client-4 and p4-client-1). Each code fix has a regression test that was seen to fail with that fix undone and pass with it (script `scratchpad/r2fix/revert_checks.py`, 12 cases, every file restored byte for byte).

- p4r2-data-1, confirmed (Archive then Unarchive confirmed a tagged item's unchecked tags). New nullable column `items.archived_from` (migration `20261102210917_archived-from`): archive records the status it leaves in the same conditional update; unarchive returns `pending_tagging` for incomplete tags, `tagged` when archived from `tagged` or from `pending_tagging` (a batch or Re-tag tagged it meanwhile), `confirmed` only when archived from `confirmed`, and the old rule for legacy rows. The unarchive toast says where the item went. Tests: `item-lifecycle.test.ts` (each status through `archiveItem`, a waiting item tagged while archived, a legacy row, a repeated archive), `batches.test.ts` (a batch result for an item archived meanwhile keeps it archived with `archived_from`, then unarchives as tagged), `danger-zone.test.tsx` (toast). D-128.
- p4r2-data-2, confirmed (no test tied the JSON export's table list to the schema). `EXPORT_JSON_TABLES` and `EXPORT_FORMAT_VERSION` moved to the pure `src/lib/export/json-tables.ts`; `export.test.ts` requires every schema table to be exported except `item_images` and `login_attempts`. Test fails naming `wear_logs` when that key is removed. D-135.
- p4r2-client-1, confirmed, completes p4-client-4 (Save after the item page's re-read sent the old values of fields changed elsewhere). `useTagForm` adopts every new item once no request runs; a dirty form is reset with `keepDirtyValues`, `keepDirty` and `keepErrors`. Tests: four cases in `item-detail.test.tsx` (notes draft with a rename elsewhere, an edited Name keeping its draft, a re-tag elsewhere, a clean form); `item-tag-form.test.tsx`'s "keeps unsaved edits" case now also expects the untouched Name to follow the newer card (it had asserted the old behaviour). D-132.
- p4r2-client-2, confirmed, completes p4-client-1 (a refresh adding or removing an item above the screen made the list jump). The grid remembers the first card whose row starts on screen and puts it back at the same distance when the same results (same `resultsKey`, same columns) come back. Tests: four cases in `virtualized-grid-changes.test.tsx` (insert at the top and removal above, both within 1 px; same items and an append, 0 px; at the top the new item shows first). In the browser the old grid moved the card 102 px at 390 px and 277 px at 1440 px; the fixed one 0.4 px. D-131.
- p4r2-client-3, confirmed (a shown list re-read once per noted change, so a Tag-all run caused dozens of full reads). `useRefreshAfterItemChanges` refreshes at once for the first change and at most once per 5 s after that while shown; refreshed data counts as read when the refresh was asked for. Tests: six burst cases in `refresh-after-item-changes.test.tsx` (fake timers) and one in `wardrobe-results.test.tsx`. In the browser, 20 tag answers over 15 s caused 20 list reads with the old hook and 4 with the new one. D-130.
- p4r2-client-4, confirmed (`/add/review` did not re-read on Back). The page renders `RefreshAfterItemChanges` with its cards (`refreshWhileShown={false}`), after its batch-results marker and outside the empty state. Tests: new `review-list-return.test.tsx` (the list in an Activity: no read for its own changes, one read on show after a change elsewhere, the archived card gone, unsaved edits kept) and new `test/item-freshness.test.ts`, which checks the wiring in every page that shows item data and fails when the line is removed. D-129.
- p4r2-rules-1, confirmed (pressing the pressed Untagged chip at 0 items dropped focus to `<body>`). Focus moves to All, once, only when lost. Test in `wardrobe-results.test.tsx` through the real wiring, including an Activity return that must not move focus. D-133.
- p4r2-rules-2, confirmed (filter hints not exposed to their controls). `Section` gives the hint an id; the Status and Colour groups, the warmth group and "Another colour" are described by it. Test in `filter-panel.test.tsx`. D-133.
- p4r2-rules-3, confirmed (the once-per-reset focus guard was untested). Two tests in `wardrobe-results.test.tsx`: focus lost again before a later list, and an Activity return after a reset; both fail with the guard removed. Test-only change.
- p4r2-rules-4, confirmed (the toolbar test printed React's "suspended inside an act scope, not awaited" warning). The two tests that start a suspending navigation now await their acts; the file fails a test on any `console.error`, so the warning cannot come back unseen. `vitest run --silent=false` on the file prints nothing. Test-only change.
- p4r2-rules-5, confirmed (D-123 stated a Server Action failure the browser check disproved). D-123's Decision and Why rewritten per the verifier: fetch saves and Server Actions from plain handlers answer after Back (Archive measured in this session: list shown 37 ms after the press, card gone at 2.6 s through the listener); the plan toggles hold Back through their async transition. The round-1 Review lines and the open risk in this entry were corrected the same way. Docs only.
- p4r2-rules-6, confirmed (D-050 missed the Phase 4 edits to generated shadcn files). D-050 lists the `button.tsx`, `badge.tsx` and `globals.css` edits and is "refined by D-117"; D-117 points back to D-050. Docs only.
- p4r2-rules-7, confirmed ("Back to wardrobe" silently needs the Navigation API). Recorded as D-134 (Chromium 102+, Safari 26.2+, Firefox 147+, from MDN compatibility data) and in README, awaiting the owner's acceptance. Docs only; no component test was added (the helper's null-navigation case is already unit-tested).
- p4r2-rules-8, confirmed (e2e docs claimed more coverage than the specs had). `e2e/export.spec.ts` checks the file's keys against `EXPORT_JSON_TABLES` in order; `e2e/a11y.spec.ts` also scans `/offline` signed out and the not-found page of an unknown item id. D-113, README and `e2e/README.md` name the scanned pages.
- p4r2-rules-9, confirmed (HANDOFF next steps without Beads ids; a resolved risk still said to stand). The forged-action risk is in the "no longer true" list and "The risks in the entries below stand" names the exception. Beads was not touched (forbidden in this session), so the next steps without an issue say so instead of carrying an id; partly fixed. Completed before the commit: next steps 2, 3, 5 and 6 now carry Beads ids (wardrobe-c8x, wardrobe-aea, wardrobe-9ri, wardrobe-any).
- Also changed while running the gate: `review-list.test.tsx`'s capped-list case (fourteen full forms, about 2.2 s alone) timed out at 5.7 s under the full parallel suite; it now has a 15 s timeout. Its timing is the same with the round-1 tag form.

### Review, round 3

6 findings on the code the round-2 fixes changed: 5 confirmed by the verifiers and re-checked against the code before any change (the reviewers' scratch tests still failed on the tree as received), 1 rejected. Each code fix has a regression test that was seen to fail with that part of the fix undone and pass with it (script `scratchpad/r3fix/revert_checks.py`, 6 cases, every file restored byte for byte).

- p4r3-srv-1, confirmed (D-128 added a column beyond the spec but said "Deviates from spec: no", and D-011 did not point to it). D-128 now says "yes (additions only)" and calls `items.archived_from` an addition beyond D-011 and D-058; D-011's status reads "accepted; extended by D-058 and D-128" (a status note, not an edit of the Phase 1 decision). Docs only: `awk '/^### D-128/{getline; print}' DECISIONS.md` printed "Deviates from spec: no" before and "yes (additions only)" after, and D-011 and D-128 name each other.
- p4r3-srv-2, confirmed (State said the round-2 session had fixed every one of its 15 findings, each with a regression test seen failing). The State paragraph now matches "Review, round 2": 14 fixed and 1 partly fixed, 10 code and test fixes with 12 revert cases, p4r2-rules-5 to -7 docs only, the e2e changes of p4r2-rules-8 run but not seen failing. Docs only: a grep for the old State wording found it on line 9 before the fix and nowhere after.
- p4r3-cli-1, confirmed in part (back on `/add/review` after a change elsewhere, a refresh whose server render applied finished batch results refreshed the page a second time 5 s later, so the batch poll and the 200-card read ran again and the "Applied N finished batch results" notice disappeared). Fixed as the verifier proposed, not with the finding's `if (refreshWhileShown)` guard: `noteWardrobeChangeIn(data)` records that a server data object already holds a change, `noteDataReadAt` adds those, and `NoteServerItemChanges` takes `includedIn`, which the review page sets to its cards. The finding's second case, about one refresh every 5 s while the page's own tag answers land during its refreshes, stays on purpose and is now documented, because refreshed cards can predate an answer and would replace the newer local card until the next refresh (D-136). Tests: three cases in `refresh-after-item-changes.test.tsx` with the marker and the hook in an `<Activity>` as the page renders them (its own batch results: 1 refresh in all; an own answer during the refresh: exactly 2; both at once: 2), three in `wardrobe-changes.test.ts`, and `test/item-freshness.test.ts` now requires `includedIn={cards}` before the hook. A scratch copy of the verifier's router harness (modelled on Next 16.4.3's `startTransition` and `use(state)` dispatch) gave 1 refresh with the fix; it gave 2 without it. In the production build, one server object passed to two client components arrived as one object, which the fix relies on. D-136.
- p4r3-cli-3, confirmed (the round-2 reset of a form with unsaved edits cleared `isSubmitted`, so a field error kept from the last Save, with its `aria-invalid`, stayed after the owner fixed the field). The reset now also keeps the submit state (`keepIsSubmitted`, `keepSubmitCount`, `keepTouched`). The first gate run then failed on the new test under the full parallel suite (it passed alone). The trace showed the toggle's newer item reaching the form 20 ms after the owner's change, while that change was still being checked, and react-hook-form 7.91 drops the result of a check that a reset overtakes, so the old error stayed. `useTagForm` therefore also waits for a running field check (`isValidating`) before it takes a newer item, as it already waited for a request. Tests: two cases in `item-detail.test.tsx`, each failing with its half of the fix undone: the toggle's answer taken before the fix, and a newer item arriving in the same act as the fix. Both passed twice under the parallel component suite. D-137.
- p4r3-cli-4, confirmed (`/settings/export` was not re-read on Back, so new photos fell into a ZIP part the page did not link, and `test/item-freshness.test.ts` and D-129 claimed every page that shows item data). `PhotoExportsContent` renders `RefreshAfterItemChanges` with the photo overview; the freshness test checks it; README's export section says so. D-138.
- p4r3-cli-2, rejected by the verifier (a second refresh asked for before the first one's data arrives would lose the read count). In Next 16.4.3 both refreshes update the router's one state in entangled transitions, so React commits only the later data, recorded at the later request's count; a change noted during that request still makes it stale. Nothing changed.

### Checks run

All on 2026-11-02 unless a date is given, local time (UTC+1).

Final checks before the commit (the session that ran the reviews, on the tree the commit holds; nothing was changed between these checks and the commit except HANDOFF.md):

- Read the round-3 diff against the round-2 tree (`git diff fd79baa…` to a snapshot tree of the working copy): 13 files, the code changes as described under "Review, round 3".
- Gate with `.env.local` moved to `scratchpad/envlocal-mine/` (restored in `finally`, confirmed back, the aside folder empty):
  - 23:54:13 to 23:54:17 `pnpm typecheck`: passed.
  - 23:54:17 to 23:54:28 `pnpm lint`: passed.
  - 23:54:28 to 23:55:12 `pnpm test`: passed (102 files passed, 1 skipped; 1,505 tests passed, 1 skipped). Vite printed its notice that `configLoader: 'native'` will not support the extension-less import in `vitest.config.mts`; no test is affected.
  - 23:55:12 to 23:55:23 `pnpm build`: passed, same route table as above.
- Database, Docker `guardaroba-ai-db-1` (not restarted): 23:56:48 `pnpm db:generate` "No schema changes, nothing to migrate"; 23:56:50 `pnpm db:migrate` applied successfully, nothing new; 23:56:51 `pnpm db:seed` Hamburg updated, Bologna kept, `app_settings` kept.
- 23:57:03 to 23:58:14 `pnpm test:e2e` (headed; `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `E2E_TAG` and `DATABASE_URL` unset in the shell): 48 passed, 1 skipped, the skipped test being `e2e/smoke.spec.ts`. The server log's CONFIG errors for `ANTHROPIC_API_KEY` come from the specs that check the missing-key path.
- Visible-browser pass, headed Chromium from `scratchpad/vcheck4/check.ts` and `check2.ts`, against `next start -p 3100` on the e2e build with every app variable blank, `wardrobe_e2e`, the e2e password and a throwaway session secret; 23:58:50 `pnpm db:seed:demo` on `wardrobe_e2e` only (300 inserted, `wardrobe` still 0).
  - 23:59:06 to 23:59:30, `check.ts` at 1440 px: 300 items in 6 columns; search "navy" 29, the Shoes chip 39, the drawer's Waterproof Yes 37, each equal to a SQL count of the same rows; focus back on Filters after the drawer; no overlapping cards at the top, the bottom or after Back. On the item page Sell and a rename saved (the row read back as "VC4 renamed item", `sell`), and after Back the renamed card was on the list. Tab from the search box went through Filters, sort, Stats and All, then the cards in order, with a visible ring on the focused card (screenshot). `/stats` in dark mode showed "6 of 6 ready". The JSON download had the 14 keys of `EXPORT_JSON_TABLES` in order, 300 items and none of the secret names; the CSV started with a BOM and had 301 lines. At 390 px no page scrolled sideways (`/wardrobe`, an item page, `/stats`, `/settings/export`), the grid had 2 columns, the filter drawer filled the width, and Escape put focus back on Filters. No console errors.
  - That run's scroll check opened the 14th rendered card, which Playwright scrolled into view before clicking, so it measured nothing. 00:00:20 to 00:00:45 (2026-11-03), `check2.ts` opened the card in the middle of the screen instead: Back restored the scroll position exactly, 4,268 px at 1440 px and 6,092 px at 390 px, with the card at the same height on screen (387 px and 293 px).
  - 00:01:05 to 00:01:07 (2026-11-03), the export page with its photo parts loaded: "300 photos in 3 parts" with three download links at 1440 and 390 px, no sideways scroll, no console errors.
  - Screenshots looked at (`scratchpad/vcheck4-shots/`): the wardrobe at 1440 px light and after Back, the keyboard focus ring, the item page, `/stats` dark, the export page loaded at 390 px, the phone grid and drawer. Nothing needed changing.
  - 00:01:18 `pnpm db:seed:demo --clean`: 300 removed; the server was stopped; nothing listened on 3000 or 3100; `wardrobe` and `wardrobe_e2e` held no items, image rows or AI calls.
- `.next/static` (the e2e build): no `ANTHROPIC_API_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, `APP_PASSWORD_HASH`, `sk-ant` or `vercel_blob_rw`; `BLOB_READ_WRITE_TOKEN` only in `@vercel/blob`'s environment lookup. `git status` lists no `.env*` file except `.env.example` (a comment change). No attribution text in the changed files.

Round-3 fix session (the earlier sessions' checks follow under "Earlier"):

- 23:19:20 the round-3 reviewers' scratch tests on the tree as received: the review-page marker cases failed as reported (2 refreshes instead of 1, and 9 instead of 1) and the field-error case failed ("error still shown after the fix: true aria-invalid: true").
- Targeted runs while fixing (23:21 to 23:23): `item-detail.test.tsx` passed; the refresh, change-count, marker, freshness and review-return tests (5 files, 28 tests) passed; `pnpm typecheck` passed (23:22:21 to 23:22:27); ESLint on every touched file had no findings (23:22:32); the scratch router harness with `includedIn` passed 4 of 4 (23:22:11).
- 23:22:51 to 23:23:04: the first revert checks, 5 cases, all failed as expected, every file restored byte for byte.
- 23:23:08 docs before their fixes: D-128's status line read "Deviates from spec: no"; a grep found the old round-2 wording of the State on line 9.
- First gate with `.env.local` moved to `scratchpad/envlocal-aside4d/` (23:26:00): typecheck and lint passed; `pnpm test` had 1 failure, the new p4r3-cli-3 test (the error still shown under the parallel suite); build not reached. `.env.local` restored at 23:26:58.
- 23:28:18 to 23:28:57 the component suite twice: the same test failed both times. Traced with a scratch copy of the tag form (23:29 to 23:33): the newer item's reset came 20 ms after the change, while that change was still being checked. Fixed by waiting for the field check (D-137), and the tests were rewritten so each order is forced.
- 23:34:31 to 23:35:12 the component suite twice: 352 passed each time.
- 23:35:56 to 23:36:16: the revert checks (`scratchpad/r3fix/revert_checks.py`), 6 cases, one part of a fix undone at a time (the read count ignoring included changes, the marker ignoring `includedIn`, the review page's marker without `includedIn`, the round-2 reset options, the reset not waiting for a field check, the export page without its refresh). All 6 failed on the expected test, and every file was restored byte for byte.
- Gate with `.env.local` moved to `scratchpad/envlocal-aside4d/` at 23:36:45:
  - 23:36:45 to 23:36:50 `pnpm typecheck`: passed.
  - 23:36:50 to 23:37:00 `pnpm lint`: passed.
  - 23:37:01 to 23:37:48 `pnpm test`: passed (102 files passed, 1 skipped; 1,505 tests passed, 1 skipped).
  - 23:37:48 to 23:38:03 `pnpm build`: passed, same route table (`/wardrobe`, `/wardrobe/[id]`, `/stats`, `/settings/export`, `/settings/usage`, `/add`, `/add/review` partial prerenders; the API routes dynamic).
  - `.env.local` restored at 23:38:03 and confirmed back (same size, the aside folder empty).
- 23:38:08 grep of `.next/static`: no `ANTHROPIC_API_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, `APP_PASSWORD_HASH`, `sk-ant` or `vercel_blob_rw`. `BLOB_READ_WRITE_TOKEN` appears in one file, only as `@vercel/blob`'s own environment lookup.
- Database, Docker `guardaroba-ai-db-1` healthy (not restarted):
  - 23:38:20 `pnpm db:generate`: "No schema changes, nothing to migrate".
  - 23:38:21 `pnpm db:migrate`: "migrations applied successfully", nothing new (2 migrations recorded).
  - 23:38:23 `pnpm db:seed`: Hamburg updated, Bologna kept, `app_settings` kept.
- 23:38:35 to 23:39:47 `pnpm test:e2e` (headed; `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `E2E_TAG` unset): 48 passed, 1 skipped. The skip is the smoke spec with "needs BLOB_READ_WRITE_TOKEN in the shell", read from the HTML report. At 23:40:12 `wardrobe_e2e` and `wardrobe` held no items, image rows or AI calls, with 2 migrations each.
- Visible-browser re-check, headed Chromium from `scratchpad/phase4-r3-visual/r3.cjs`, against `next start -p 3100` with every app variable blank, `wardrobe_e2e`, the e2e password and a throwaway session secret:
  - 23:42:12 `pnpm db:seed:demo` on `wardrobe_e2e` only: 300 inserted (`wardrobe` still 0). 23:42:24 server up on the e2e run's build.
  - First runs (23:42:29 and 23:42:35) stopped on the script's own locators ("Price" matched the form and the field; a demo-item query used too large an offset); both fixed in the script. 23:42:47 to 23:43:09: 22 of 22. 23:43:15 to 23:43:25, the export check alone from 300 photos: 10 of 10. The first "fixed" screenshot caught the field's colour transition halfway, so 23:43:49 to 23:43:58 retook it after the transition, with a computed-style check that the blurred field matches its neighbour: 12 of 12.
  - Reverse build (23:44:50 to 23:45:10): `item-tag-form.tsx` and the export page taken from the round-2 tree, built and started with the same environment. 23:45:15 to 23:45:54, 16 of 16 reverse expectations: after the toggle, typing 49.90 left the error and `aria-invalid` in place (1440 px light, 390 px dark), and Back to the export page read nothing and kept the old parts. 23:45:59 to 23:46:25, the export check alone: "300 photos in 3 parts" stayed on screen with 301 in the database, so part 4 was not linked. Both files restored byte for byte at 23:46:41, rebuilt and up at 23:47:02.
  - Final run, 23:47:09 to 23:47:35, 24 of 24:
    - Item page at 1440 px light and 390 px dark: "abc" as Price and Save showed "Enter an amount such as 49.90." with `aria-invalid`; Donate saved and the draft stayed; typing 49.90 removed the error and `aria-invalid`; the blurred field had its neighbour's border and text colour; Save stored 49.90 and kept Donate. No serious or critical axe violation with the error shown.
    - Export page at 1440 px light and 390 px dark: Back with nothing changed sent no request; after a new photo row and a plan change on an item page, Back re-read the page once, "300 photos in 3 parts" became "301 photos in 4 parts" with 4 download links (301 to 302 at 390 px). No serious or critical axe violation, no sideways scroll.
    - Review page: an item archived on its page left the list after Back, with exactly one re-read in 6.5 s.
  - No browser console errors in any run.
  - Screenshots looked at (`scratchpad/phase4-r3-shots/`): the price error and the fixed field at 1440 px light and 390 px dark, the same with the round-2 form (error still shown), the export page after Back at both sizes (four parts, and the reverse build's three), and the review page after Back. Nothing needed changing.
  - 23:48:02 the 3 rows the script added were deleted; `pnpm db:seed:demo --clean`: 300 removed. `wardrobe_e2e` and `wardrobe` held no items, image rows or AI calls. 23:48:02 server stopped; nothing listened on 3000 or 3100.
  - 23:51:56 to 23:52:09, the same build started again for `scratchpad/phase4-r3-visual/identity.cjs`: with a stub React DevTools hook, `/add/review`'s cards reached `ReviewList` (`items`) and `RefreshAfterItemChanges` (`snapshot`) as one object, which `includedIn={cards}` relies on (D-136). Its one row was deleted; at 23:52:09 the server was stopped, nothing listened on 3000 or 3100, and both databases held no items, image rows or AI calls.
- The last build in `.next` is the e2e-environment build of the final code (23:47:02). After that only HANDOFF.md changed.
- Not run: the review page's batch-results case in a browser (applying batch results needs an Anthropic key; covered by the unit tests and the router harness), a newer item arriving during a field check in a browser (unit test only), the smoke spec with a real token, anything against the live Anthropic API or a real Blob store, the migration on Neon, a browser without the Navigation API.

Earlier, round-2 fix session:

- 22:09:17 `pnpm db:generate --name archived-from`: wrote `drizzle/20261102210917_archived-from/migration.sql` (one `ADD COLUMN`).
- Targeted runs while fixing (22:10 to 22:24): every touched test file passed; `pnpm typecheck` passed after adding `archivedFrom` to the full item row in `user-edited-fields.test.ts`; `pnpm lint` passed.
- 22:23:32 to 22:24:28: the revert checks (`scratchpad/r2fix/revert_checks.py`): 12 cases, one fix undone at a time (the unarchive rule, `archived_from` not written, the toast, a table left out of the export, the dirty-form reset, the grid anchor, the round-1 refresh hook, the review page's refresh line, the All focus, the hint ids, the once-per-reset guard, the un-awaited acts). All 12 failed as expected, and every file was restored byte for byte.
- First gate with `.env.local` moved to the scratchpad (22:28:03): typecheck and lint passed; `pnpm test` had 2 failures: `item-tag-form.test.tsx` still asserted the old dirty-form behaviour (updated to D-132), and `review-list.test.tsx`'s capped-list case timed out at 5.7 s under the parallel suite (2.2 s alone, the same with the round-1 tag form; now a 15 s timeout); build passed. `.env.local` restored at 22:29:34.
- Gate with `.env.local` moved to the scratchpad at 22:31:06:
  - 22:31:06 to 22:31:12 `pnpm typecheck`: passed.
  - 22:31:12 to 22:31:26 `pnpm lint`: passed.
  - 22:31:26 to 22:32:21 `pnpm test`: passed (102 files passed, 1 skipped; 1,496 tests passed, 1 skipped).
  - 22:32:21 to 22:32:34 `pnpm build`: passed, same route table (`/wardrobe`, `/wardrobe/[id]`, `/stats`, `/settings/export`, `/settings/usage`, `/add`, `/add/review` partial prerenders; the API routes dynamic).
  - `.env.local` restored at 22:32:34 and confirmed back at 22:32:40.
- 22:32:40 grep of `.next/static`: no `ANTHROPIC_API_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, `APP_PASSWORD_HASH`, `sk-ant` or `vercel_blob_rw`. `BLOB_READ_WRITE_TOKEN` appears in one file, only as `@vercel/blob`'s own environment lookup.
- Database, Docker `guardaroba-ai-db-1` healthy (not restarted):
  - 22:32:51 `pnpm db:generate`: "No schema changes, nothing to migrate".
  - 22:32:52 `pnpm db:migrate`: applied `archived-from`; `items.archived_from` is a nullable `item_status`, 2 migrations recorded.
  - 22:32:54 `pnpm db:seed`: Hamburg updated, Bologna kept, `app_settings` kept.
- 22:33:09 to 22:34:31 `pnpm test:e2e` (headed; `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `E2E_TAG` unset): 48 passed, 1 skipped. The skip is the smoke spec with "needs BLOB_READ_WRITE_TOKEN in the shell", read from the HTML report. New in the run: the `/offline` and not-found axe scans, and the export spec's full key check. The server logged only the expected CONFIG errors and the forged action's "Failed to find Server Action". Afterwards `wardrobe_e2e` held no items, image rows or AI calls, with 2 migrations recorded.
- Visible-browser re-check, headed Chromium from `scratchpad/phase4-r2-visual/r2.cjs`, against `next start -p 3100` on the e2e run's build, `wardrobe_e2e`, every app variable blank, the e2e password and a throwaway session secret:
  - 22:38:04 `pnpm db:seed:demo` on `wardrobe_e2e` only: 300 inserted. 22:38:10 server up.
  - First runs (22:38:17 to 22:39:26) stopped on the script's own locators twice ("Name" and "Save" matched two elements; the bulk button is "Tag N items" in the Tagging region) and once on its request count, which included Next's prefetches; each was fixed in the script.
  - Reverse build (22:41:38 to 22:42:47): the grid anchor disabled and the round-1 refresh hook restored, built and started with the same environment. The card at the top of the screen moved from 260 to 158 px at 390 px (scrolled to 6,000 px) and from 128 to -149 px at 1440 px (3,000 px) when the list refreshed after Back with a new upload; 20 tag answers over 14.8 s caused 20 list reads. Both files were restored byte for byte at 22:42:47 and rebuilt (up 22:43:08).
  - Final run, 22:43:15 to 22:44:09, 27 of 27 passed:
    - Item page, light and dark at 1440 px: Archive recorded `archived_from = tagged`; Unarchive brought the tagged item back as Tagged with Confirm offered, `archived_from` cleared, and the toast "… is back on the review page, with its tags still to check."
    - Item page with a draft: Notes typed, left unsaved, the item renamed on `/add/review`, Back: one re-read, Name showed the rename, Notes kept the draft, and Save stored both (name "Visual renamed jacket", notes "Needs dry cleaning").
    - Review page: an item archived on its page left the list after Back, with one re-read.
    - Grid: after Back with a plan change and a new upload, the card at the top of the screen stayed within 0.4 px at 390 px (6,000 px) and 1440 px (3,000 px); at the top of the list the new upload showed first.
    - Untagged chip at 0 items in `?q=navy&status=pending_tagging`: Enter on it moved focus to "All, 29 items", and Tab and Shift+Tab stayed in the chip row.
    - Filter drawer at 1440 px light and 390 px dark: the Status, Warmth and Colour groups are described by their hints; no serious or critical axe violation with the drawer open.
    - Late Archive with its answer held 2.5 s: Back showed the list after 37 ms and the card left it at 2.6 s ("306 items" to "305 items").
    - Tag-all: 20 answers (3 s each, four at a time) over 14.8 s while `/wardrobe` was shown caused 4 list reads after it was shown (prefetches not counted).
  - 22:44:36 the unarchive screenshots were retaken after the toast finished sliding in: 8 of 8 passed again.
  - No browser console errors in any run.
  - Screenshots looked at (`scratchpad/phase4-r2-shots/`): the unarchive toast and header (light and dark), the item page after the re-read, the review page after Back, the grid before and after the refresh at 390 and 1440 px and at the top, the All chip with its focus ring, the open filter drawer (1440 light, 390 dark), and the wardrobe during the Tag-all run. Nothing needed changing.
  - 22:45:15 the rows the script added were deleted; `pnpm db:seed:demo --clean`: 300 removed. `wardrobe_e2e` and `wardrobe` held no items, image rows or AI calls. 22:45:18 server stopped; nothing listened on 3000 or 3100.
- The last build in `.next` was then the e2e-environment build of the round-2 code (22:42:56). After that only DECISIONS.md and HANDOFF.md changed.
- Not run: the smoke spec with a real token, anything against the live Anthropic API or a real Blob store, the migration on Neon, a browser without the Navigation API.

Earlier, review fix session (round 1; the integration session's checks follow under "Earlier"):

- Targeted runs while fixing (times not recorded): every touched test file passed, ESLint on every touched file had no findings, and `tsc --noEmit` had no errors.
- 21:03:47 to 21:04:55: the revert checks, a script that undid one fix at a time and ran its tests. All 16 cases failed as expected (both halves of p4-ux-1 and p4-ux-2, and the item page's own-save case of p4-client-4 separately), and every file was restored byte for byte. About 21:05, the same for the batch-results marker: it failed as expected and the file was restored.
- Gate with `.env.local` moved to the scratchpad at 21:08:47:
  - 21:08:47 to 21:08:52 `pnpm typecheck`: passed.
  - 21:08:52 to 21:09:04 `pnpm lint`: passed.
  - 21:09:04 to 21:09:45 `pnpm test`: passed (100 files passed, 1 skipped; 1,466 tests passed, 1 skipped; no "Not implemented" output).
  - 21:09:45 to 21:10:04 `pnpm build`: passed, same route table (`/wardrobe`, `/wardrobe/[id]`, `/stats`, `/settings/export`, `/add/review` partial prerenders; the export routes dynamic).
  - `.env.local` restored at 21:10:04.
- 21:10:13 grep of `.next/static`: no `ANTHROPIC_API_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, `APP_PASSWORD_HASH`, `sk-ant` or `vercel_blob_rw`. `BLOB_READ_WRITE_TOKEN` appears in one file, only as `@vercel/blob`'s own environment lookup.
- Database, Docker `guardaroba-ai-db-1` healthy:
  - 21:10:20 `pnpm db:generate`: "No schema changes, nothing to migrate".
  - 21:10:22 `pnpm db:migrate`: succeeded.
  - 21:10:23 `pnpm db:seed`: Hamburg updated, Bologna kept, `app_settings` kept.
- 21:10:35 to 21:11:49 `pnpm test:e2e` (headed, `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `E2E_TAG` unset): 47 passed, 1 skipped. The skip is the smoke spec with "needs BLOB_READ_WRITE_TOKEN in the shell", read from the HTML report. `e2e/wardrobe.spec.ts` now also checks the badges in the Untagged view. The server logged only the expected CONFIG errors and the forged action's "Failed to find Server Action". Afterwards `wardrobe_e2e` held no items, image rows or AI calls.
- Visible-browser re-check, headed Chromium from `scratchpad/phase4-fix-visual/`, against `next start -p 3100` on `wardrobe_e2e` with every app variable blank, the e2e password and a throwaway session secret:
  - 21:15:23 server up on the e2e run's build.
  - 21:15:28 to 21:15:32, every item archived (3 rows): 7 of 7 passed. "All 3 items are archived" in light and dark at 1440 px and dark at 390 px, no "No items yet", no serious or critical axe violation, "Show archived items" listed the 3, no sideways scroll.
  - 21:15:43 `pnpm db:seed:demo` on `wardrobe_e2e` only: 300 inserted. 21:15:44 the same with `?host=example.invalid` in the URL: refused ("sets the host in its query string"), exit code 1, nothing written.
  - With the demo items plus 3 waiting, 2 tagged and the 3 archived rows: run 1 (21:15:49) stopped on the script's own test rows (a tagged row lacked fields the database requires); run 2 (21:16:05 to 21:16:37) 41 of 42, the failure being the script's late-save assertion, which assumed the list shows before a pending plan toggle answers. Timing runs at 21:17:05 showed it does not (the toggle's async transition holds Back, D-123); the assertion was corrected.
  - Reverse check of p4-client-2: build without the listener call (21:18:04 to 21:18:25). The late plan-toggle case refreshed anyway (21:18:31); the late fetch case ("Tag now" held 2.5 s) stayed stale (21:19:32). File restored byte for byte at 21:19:50 and rebuilt (up 21:20:10): the fetch case refreshed and showed "Tagged" (21:20:30); the Server Action case showed "Sell" once it answered (21:20:35).
  - Run 3, 21:21:17 to 21:21:49: 43 of 43 passed. At 1440 px light: Untagged view with All 305 and Shoes 40 (both matching the database, Shoes not muted), pressing Shoes listed 40; `?category=shoes&status=pending_tagging` with Shoes pressed and Untagged not; the archived view offering Untagged 3; choosing a colour kept all 16 colours on offer and a second could be added from the list; no serious or critical axe violation with a colour chosen; card badges "Waiting for tags", "Tagged", "Archived" with none clipped; after Reset filters focus on "305 items"; focus kept on the same card from 6 to 3 columns and back, and Tab went on to the next card; `?q=%00` and `?color=na%00vy` rendered the list (29 navy items, matching the database); the late plan change showed after Back; the item page showed "Confirmed" and no Confirm button after Back from confirming it on `/add/review` (via the Wardrobe tab, Stats and its review link). In dark at 1440 px and in both themes at 390 px: the same colour, badge and sideways-scroll checks. At 390 px: after Back and the refresh, a card scrolled to 6,016 px stayed at 220 px from the top, with one list request.
  - Reverse check of p4-client-1: at 21:22:45 to 21:23:51 the fixed build held steady at scroll 6,000 and 9,000 (0 px). Pre-fix grid built and started at 21:23:58 to 21:24:19: moved by 78 px and 126 px. Fixed grid restored byte for byte at 21:24:37, rebuilt (up 21:24:59): steady again, and the fetch case refreshed again.
  - No browser console errors in any run.
  - Screenshots looked at (`scratchpad/phase4-fix-shots/`): the archived state (light, dark, 390 px dark), the archived list, the Untagged view chips (light, dark, 390 px both), Shoes with waiting items, the colour panel (1440 px light and dark, 390 px light and dark), the status badges (1440 px and 390 px, both themes), the focus ring on the result count, the focus ring on a card after the column change, the item page after the review confirm, the late answers before and after (fixed and reverse builds), and the 390 px list after the refresh. Nothing needed changing.
  - 21:25:14 the 9 rows the check added were deleted; 21:25:15 `pnpm db:seed:demo --clean`: 300 removed. `wardrobe_e2e` and `wardrobe` held no items, image rows or AI calls. 21:25:17 server stopped; nothing listened on 3000 or 3100.
- The last build in `.next` is the e2e-environment build of the final code (21:24:59). After that only HANDOFF.md changed.

Earlier (integration session, before the first review):

- On the tree as the interrupted run left it:
  - 19:54:20 to 19:54:30 `pnpm typecheck`: passed.
  - 19:54:32 to 19:54:50 `pnpm lint`: passed.
  - 19:54:53 to 19:55:35 `pnpm test`: passed (96 files passed, 1 skipped; 1,421 tests passed, 1 skipped). jsdom printed "Not implemented: Window's scrollTo()" 12 times, from `virtualized-grid.test.tsx` and `wardrobe-results.test.tsx`, fixed above.
- Targeted runs after the edits (times not recorded):
  - The wardrobe component tests: 6 files, 51 tests passed, no scrollTo output.
  - `test/boundaries.test.ts`: 34 passed.
  - The refresh, change-count and results tests: 3 files, 9 passed.
  - ESLint on every edited file: no findings.
  - After the button change: `tsc --noEmit` with no errors, ESLint with no findings, and `vitest run src/components` with 32 files and 302 tests passed.
- First gate, with `.env.local` moved out at 20:00:28:
  - 20:00:28 to 20:00:36 `pnpm typecheck`: passed.
  - 20:00:36 to 20:00:48 `pnpm lint`: passed.
  - 20:00:48 to 20:01:32 `pnpm test`: passed (97 files passed, 1 skipped; 1,424 tests passed, 1 skipped).
  - 20:01:32 to 20:01:51 `pnpm build`: passed. `/wardrobe`, `/wardrobe/[id]`, `/stats` and `/settings/export` are partial prerenders, and the three export routes are dynamic.
  - `.env.local` restored at 20:01:51.
  - 20:01:59 grep of `.next/static`: no `ANTHROPIC_API_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, `sk-ant` or `vercel_blob_rw`. `BLOB_READ_WRITE_TOKEN` appears only as the `@vercel/blob` client library's own environment lookup.
- Database: Docker `guardaroba-ai-db-1` was up and healthy.
  - 20:02:05 `pnpm db:generate`: "No schema changes, nothing to migrate".
  - 20:02:07 `pnpm db:migrate`: succeeded.
  - 20:02:09 `pnpm db:seed`: Hamburg updated, Bologna kept, `app_settings` kept.
- 20:02:16 to 20:03:31 `pnpm test:e2e` (headed, with `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY` and `E2E_TAG` unset in the shell):
  - 47 passed and 1 skipped.
  - The skip is the smoke spec, with "needs BLOB_READ_WRITE_TOKEN in the shell", read from the HTML report.
  - The server logged only the expected CONFIG errors and the forged action's "Failed to find Server Action".
  - The e2e database was empty afterwards.
- Visible-browser check. Setup:
  - A script outside the repository drove headed Chromium.
  - The server was `next start -p 3100` on that build against `wardrobe_e2e`, with every app variable blank, the e2e password and a throwaway session secret.
  - 20:04:25 `pnpm db:seed:demo` with `DATABASE_URL` set to `wardrobe_e2e` for that command only: 300 inserted.
  - Run 1, 20:05:51 to 20:06:24: 41 passed and 1 failed. The failure was the script's own check: after a search it compared the chips with the unfiltered database counts. The script was fixed.
  - Run 2, 20:06:33 to 20:07:05: 42 of 42 passed.
  - The screenshots showed the outline links without a border in light mode. A probe of computed styles confirmed a transparent border on Stats, AI usage, Export your data, the Download links and the back links, while the checklist links (already merged with `cn`) had one. Fixed as D-117 d.
- Reverse check of D-107:
  - Both refresh calls were disabled and the app rebuilt and started at 20:09:46 (`next build`, then `next start -p 3100`, e2e environment).
  - Wardrobe: after a plan change to Sell on an item page, Back showed the card without "Sell".
  - Stats: after marking a checklist item Donate, Back still linked it.
  - The browser requested only the icon during either Back.
  - Both files were restored at 20:09:58 from copies and compared byte for byte (`cmp`).
- Final gate, with `.env.local` moved out at 20:11:45:
  - 20:11:45 to 20:11:50 `pnpm typecheck`: passed.
  - 20:11:50 to 20:12:00 `pnpm lint`: passed.
  - 20:12:00 to 20:12:40 `pnpm test`: passed (97 files passed, 1 skipped; 1,424 tests passed, 1 skipped; no scrollTo output).
  - 20:12:40 to 20:12:51 `pnpm build`: passed, same route table.
  - `.env.local` restored at 20:12:51.
  - 20:12:57 grep of `.next/static`: same result as the first gate.
- Database:
  - 20:12:58 `pnpm db:generate`: "No schema changes".
  - 20:12:59 `pnpm db:migrate`: succeeded.
  - 20:13:01 `pnpm db:seed`: same result as above.
- 20:13:07 to 20:14:21 `pnpm test:e2e` (headed, same shell): 47 passed and 1 skipped (the smoke spec, same reason).
  - Covered: the a11y scan (`/login`, `/wardrobe`, an item page, `/stats`, `/settings`, `/settings/export`, `/settings/usage`, `/add`, `/add/review`, and `/wardrobe` at 390 × 844, with no serious or critical violations) and the stats spec's new Back check.
  - The e2e database was empty afterwards.
- Visible-browser check, final pass, on that build:
  - 20:14:32 demo seed again: 300 inserted.
  - 20:14:48 to 20:15:20: 45 of 45 passed.
  - Results at 1440 × 900 (light, then dark):
    - Layout and counts:
      - 6 columns.
      - "300 items", matching the database.
      - Every category chip count matched the database. Under `?q=navy` (29 items) they did too.
    - Search and filters:
      - Search wrote `?q=navy`. Waterproof Yes in the drawer, which opened from the right, wrote `?q=navy&waterproof=true`, and its 3 items matched the database.
      - The drawer closed with focus on "Filters, 1 active".
      - The Shoes chip wrote `?category=shoes` (39, matching).
      - Warmest first put a warmth-5 shoe first.
    - Scrolling:
      - A full scroll at one frame per 60 px step reached item 300 of 300 with 42 cards in the page.
      - The slowest frame took 12 ms in light mode and 18 ms in dark (95th percentile 9 and 10 ms). No frame took over 50 ms.
    - Back and the tab:
      - Back from an item at `?category=top` returned to scroll position 1600 from 1600.
      - The Wardrobe tab, after `/stats`, opened at the top.
    - Keyboard: Tab reached the first card in 2 presses from Stats, then cards 1 to 26 in order, past the first screen, with the focus ring drawn (2 px and 5 px rings).
    - Changes on the item page:
      - Sell and Hamburg were saved and survived a reload.
      - After "Back to wardrobe" the card read Sell, and after browser Back it read Bring.
      - A rename through the form's Save showed on the card after Back.
      - Archive then Back gave "299 items" with the card gone. Unarchive gave 300 again.
    - Stats:
      - The Wardrobe tab was marked.
      - A checklist item marked Donate on its page was no longer linked after Back.
    - Borders: the Stats and Download JSON links had a visible border in both themes.
    - Exports:
      - The JSON was version 1 with 300 items, and an item renamed "Cappotto écru — Größe M, «lana»" kept its accents.
      - The CSV had a BOM, CRLF rows and 300 data rows, with the same accents.
  - Results at 390 × 844:
    - 2 columns in both themes.
    - No sideways scroll on `/wardrobe`, `/stats`, `/settings/export` or the item page.
    - A full scroll reached item 300 with 14 cards in the page. The slowest frame took 12 ms (95th percentile 8 ms).
    - Back returned to scroll position 3000 from 3000.
    - The filter drawer opened from the bottom.
  - No browser console errors or page errors in any context.
  - Screenshots looked at:
    - At 1440 px: the wardrobe top and bottom in light and dark, the filter drawer, keyboard focus, the item page in light and dark, stats in light and dark, and export.
    - At 390 px: the wardrobe top and bottom, the drawer, stats in light and dark, export, the item page, and the wardrobe in dark.
    - Apart from the border fix, nothing needed changing. In full-page phone screenshots the fixed tab bar shows mid-page; this is how the screenshot is captured, not the page.
  - 20:15:40 `pnpm db:seed:demo --clean` on `wardrobe_e2e`: 300 removed. Both databases held no items afterwards; the demo seed never ran against the dev database `wardrobe`.
  - 20:15:47 server stopped; nothing listened on 3000 or 3100.
- After that, only HANDOFF.md changed.
- Not run:
  - The smoke spec with a real token.
  - Anything against the live Anthropic API or a real Blob store.
  - A ZIP part download, because the seeded photo URLs are not Blob hosts and the route refuses them by design.
  - Delete's success path.
  - Opening the CSV in Excel; only its bytes were checked.

### Migration and deploy state

One new migration, `drizzle/20261102210917_archived-from` (`ALTER TABLE "items" ADD COLUMN "archived_from" "item_status"`, nullable, D-128), generated by `pnpm db:generate --name archived-from`. It and `drizzle/20261102094305_init` are applied to the Docker `wardrobe` database (`pnpm db:migrate`, 22:32:52) and to `wardrobe_e2e` (the e2e global setup, 22:33); both list 2 migrations. The third review added no migration (`pnpm db:generate` reported no schema changes at 23:38:20 and again at 23:56:48, and `pnpm db:migrate` found nothing new at 23:56:50). Neon has not been migrated: run `pnpm db:migrate` against it before the Phase 4 deploy (wardrobe-c8x). Not deployed. `vercel.json` now also sets `supportsCancellation` for `src/app/api/export/images/route.ts`, which takes effect on the next deploy.

### Open risks

- The item page's "Last changed" comes from the last full read, so it does not move after a toggle or a Save until the page is read again (D-110). Fixing it means adding `updatedAt` to `ItemCardDto`.
- The change count is per tab (D-107). A change made in another tab or on another device reaches a list Next keeps in this tab only on a fresh navigation or a reload.
- The ZIP route, client-zip on the server and `supportsCancellation` have only run in Vitest and the build, never against real blobs or on Vercel. Content-Length and the archive layout were checked in unit tests only.
- Delete removes blobs first; its success path and the blob removal were only unit-tested with the fake store.
- `buttonVariants` now merges classes for every button-styled Link. The e2e suite and the screenshots showed no other change, but every such link's classes now go through `cn`.
- The axe scan covers each page in its default state, `/offline` and the item not-found page (round 2), and the review checks added the all-archived state, the wardrobe with a colour chosen and the open filter drawer at 1440 and 390 px (browser check only, not in the e2e suite). The delete dialog is still not scanned.
- Demo items cannot be deleted or zipped (D-116); remove them with `--clean`.
- A list load now runs three queries at once (tiles, chip counts, colour facet, D-120), the whole node-postgres pool of 3; a second request in the same instance waits for a connection. Fine for one owner; watch it on Neon.
- A successful "Tag now" notes the change twice (the request helper and the item page's patch), so a list shown at that moment re-reads twice, the second time up to 5 s later (D-130). Harmless, one extra read.
- Back waits for a pending plan or location toggle to answer (seen with a save held 2.5 s): the toggles save inside an async transition, which Back's transition waits for (D-123). On a slow network Back can feel stuck for that long. Archive, Unarchive and Delete do not hold Back (Archive measured in round 2; Unarchive and Delete by code trace).
- A page shown while changes keep coming (a tagging run left going on the review page) shows them up to 5 s late (D-130).
- The grid keeps the card on screen in place only for the same results with the same columns (D-131); a refresh that lands during a resize or zoom, or that removes the card itself, can still move the list. Checked in the browser at 390 and 1440 px with the demo seed only.
- After the item page re-reads itself with a draft, a field the owner edited keeps the draft even when it was also changed elsewhere, so Save writes the draft over that change (the last save wins, as before D-132).
- `/add/review` now re-reads itself on Back after any change noted elsewhere in the tab (D-129); each re-read runs the batch poll and loads up to 200 cards. One of its own answers or saves landing while that re-read runs brings one more re-read after 5 s, so a "Tag N waiting items" run started right after Back re-reads the page about every 5 s while answers land during its re-reads (D-136). Until that re-read, a card tagged meanwhile can show its older "Waiting for tags" copy from the server.
- The review page's own batch results counting as already seen (D-136) is checked by unit tests and a scratch router model only; no browser run applied batch results.
- The `archived_from` migration must reach Neon before a deploy that ships this code: the item queries name the new column, so without it every item read and every archive would fail. Rows archived before it existed fall back to the old rule (only local databases have such rows).
- D-134: "Back to wardrobe" opens the list afresh in browsers without the Navigation API (Safari before 26.2, Firefox before 147); the owner has not accepted that degraded path yet.
- The p4-client-2 fix for fetch-based saves was checked in the browser with "Tag now" answered from the tag cache (no Claude call). Real registers and Claude tagging answering after Back were not run, since they need a Blob token and an API key.
- The risks in the entries below stand, except the forged-action one listed under "no longer true" above.

### Live checks pending

- A real ZIP part (processed and originals) finishes well under 300 s on Vercel, opens, and its `manifest.json` matches. A cancelled download stops the fetches (`supportsCancellation`).
- `BLOB_READ_WRITE_TOKEN=… pnpm test:e2e e2e/smoke.spec.ts` in a visible browser, and once with `E2E_TAG=1` and `ANTHROPIC_API_KEY` (about $0.002). Check afterwards that it left no blobs.
- Delete removes the item's blobs: check by hand with `vercel blob list`, which costs advanced operations.
- The CSV opens in Excel with the accents intact.
- With finished batch results waiting, Back to `/add/review` after a change elsewhere: one re-read, and the "Applied N finished batch results" notice stays (D-136).
- The live checks in the entries below.

### Next steps

1. Phase 4 is committed with this entry as "Phase 4: wardrobe browsing, stats and data export"; wardrobe-a27 is closed.
2. Before the Phase 4 deploy, run `pnpm db:migrate` against Neon (the `archived_from` migration): wardrobe-c8x.
3. Run the live checks above once a Blob token is available in the shell: wardrobe-aea.
4. Phase 5 (wardrobe-evp).
5. Bump `next`, `eslint-config-next` and `@next/env` together once the announced Next.js security release is out (expected 2026-11-03): wardrobe-9ri.
6. The owner decides whether D-093 ("Fill in by hand") stays as built, and whether D-134 (the back link without the Navigation API) is accepted: wardrobe-any.

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
