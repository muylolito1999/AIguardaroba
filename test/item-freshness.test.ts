import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// D-107 and D-123: Next keeps visited pages in a hidden <Activity> and serves
// Back from its client cache, so every page that shows item data must read
// itself again when shown after an item changed elsewhere in the tab. The
// behaviour is unit-tested in the components; this guards the wiring in the
// pages, which are async Server Components no unit test renders.

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function source(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

describe("pages that show item data re-read after a change elsewhere", () => {
  it("covers the wardrobe, its item page and /stats", () => {
    expect(source("src/components/wardrobe/wardrobe-results.tsx")).toMatch(/useRefreshAfterItemChanges\(list, refresh\)/);
    expect(source("src/components/item-detail/item-detail.tsx")).toMatch(
      /<RefreshAfterItemChanges snapshot=\{serverItem\} refreshWhileShown=\{false\} \/>/,
    );
    expect(source("src/app/(app)/stats/page.tsx")).toMatch(/<RefreshAfterItemChanges snapshot=\{stats\.totals\} \/>/);
  });

  it("covers /add/review, after its batch-results marker and also when it lists nothing", () => {
    const page = source("src/app/(app)/add/review/page.tsx");
    const refresh = page.indexOf("<RefreshAfterItemChanges snapshot={cards} refreshWhileShown={false} />");
    // The marker credits the batch results to the cards the same render loaded (D-136).
    const marker = page.indexOf("<NoteServerItemChanges render={poll} includedIn={cards} />");
    const empty = page.indexOf("cards.length === 0 ?");
    expect(refresh).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(-1);
    // Effects of siblings run in order: the marker's note must be credited to
    // the cards before the refresh hook records when they were read.
    expect(refresh).toBeGreaterThan(marker);
    // Outside the empty-state conditional, so "All caught up" re-reads as well.
    expect(refresh).toBeLessThan(empty);
  });

  it("covers /settings/export, whose photo parts are planned from the items (D-138)", () => {
    expect(source("src/app/(app)/settings/export/page.tsx")).toMatch(/<RefreshAfterItemChanges snapshot=\{summaries\} \/>/);
  });

  it("covers /shopping, whose rows show linked items' names and photos", () => {
    // Inside the list view, through the refresh that keeps the rows saved there (D-180).
    expect(source("src/app/(app)/shopping/page.tsx")).toMatch(/<ShoppingListView list=\{list\} actions=\{ACTIONS\} \/>/);
    // A second hook on the page would read it twice per show (D-180).
    expect(source("src/app/(app)/shopping/page.tsx")).not.toContain("<RefreshAfterItemChanges");
    expect(source("src/components/shopping/shopping-list.tsx")).toMatch(/useRefreshAfterItemChanges\(list, copy\.refresh\)/);
  });

  it("covers a relocation result, whose cards show each item's current decision, name and photo", () => {
    // Its own overrides already show, so it does not refresh for them while shown;
    // the page's one refresh keeps the saves a copy read before them lacks (D-180).
    expect(source("src/components/relocate/relocation-results.tsx")).toMatch(
      /useRefreshAfterItemChanges\(view, copy\.refresh, \{ refreshWhileShown: false \}\)/,
    );
    expect(source("src/app/(app)/relocate/[id]/page.tsx")).toMatch(/<RelocationResults\s+view=\{view\}/);
    expect(source("src/app/(app)/relocate/[id]/page.tsx")).not.toContain("<RefreshAfterItemChanges");
  });
});

describe("pages that show relocation data re-read after a change elsewhere (D-173)", () => {
  it("covers the print page, which shows the packing ticks and the items' decisions (D-181)", () => {
    expect(source("src/app/(app)/relocate/[id]/print/page.tsx")).toMatch(
      /<RefreshPrintWhenShown read=\{\{ analysisId: view\.id \}\} \/>/,
    );
    const printCheck = source("src/components/relocate/packing-changes.ts");
    expect(printCheck).toMatch(/useRefreshAfterItemChanges\(read, refresh\)/);
    // It also listens while shown: a save on the plan can answer after "Print checklist" (D-184).
    expect(printCheck).not.toMatch(/refreshWhileShown/);
  });

  it("covers a relocation result, whose Gaps tab shows which gaps are on the shopping list", () => {
    expect(source("src/components/relocate/relocation-results.tsx")).toMatch(/useRefreshAfterShoppingChanges\(view, copy\.refresh\)/);
  });

  it("covers /shopping, whose budget and plan link follow the shopping-list changes", () => {
    expect(source("src/components/shopping/shopping-list.tsx")).toMatch(/useRefreshAfterShoppingChanges\(list, copy\.refresh\)/);
  });
});
