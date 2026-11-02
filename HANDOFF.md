# Handoff

Newest entry first. Each entry records the state at the end of a working session. Task tracking lives in Beads (`bd ready`, `bd show <id>`); the reasons behind choices are in [DECISIONS.md](DECISIONS.md).

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
