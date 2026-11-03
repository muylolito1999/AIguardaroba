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

describe("pages that show wear counts re-read after a wear or an Undo (D-107, D-200)", () => {
  it("notes an item change after every confirmed wear and Undo, and an outfit change for an outfit's wear", () => {
    const logger = source("src/components/outfits/use-wear-logger.ts");
    expect(logger).toMatch(/function noteChanges\(outfit: boolean\): void \{\s*noteWardrobeChange\(\)\s*if \(outfit\) noteOutfitChange\(\)/);
    // Once after a log the server confirmed, once after an Undo it confirmed.
    expect(logger.match(/noteChanges\(outfit\)/g)).toHaveLength(2);
    // Every wear button logs through it, so none can skip the notes.
    for (const file of [
      "src/components/item-detail/worn-today.tsx",
      "src/components/outfits/wore-outfit-button.tsx",
      "src/components/today/today-view.tsx",
    ]) {
      expect(source(file), file).toMatch(/useWearLogger\(/);
    }
  });

  it("covers the item page, which shows the new count at once and re-reads when shown again", () => {
    expect(source("src/components/item-detail/item-detail.tsx")).toMatch(/onCountsChange=\{applyWearCounts\}/);
    // The wardrobe cards and /stats follow through the item change (first describe above).
  });

  it("covers /outfits, whose cards show each item's photo and the outfit's times worn", () => {
    const list = source("src/components/outfits/outfit-list.tsx");
    expect(list).toMatch(/useRefreshAfterItemChanges\(outfits, refresh\)/);
    expect(list).toMatch(/useRefreshAfterOutfitChanges\(outfits, refresh\)/);
    expect(source("src/app/(app)/outfits/page.tsx")).toMatch(/<OutfitList outfits=\{outfits\}/);
  });

  it("covers an outfit page and the new-outfit builder, whose pickers show wear counts", () => {
    const detail = source("src/components/outfits/outfit-detail.tsx");
    expect(detail).toMatch(/useRefreshAfterItemChanges\(outfit, refresh\)/);
    expect(detail).toMatch(/useRefreshAfterOutfitChanges\(outfit, refresh\)/);
    expect(source("src/app/(app)/outfits/[id]/page.tsx")).toMatch(/<OutfitDetail key=\{outfit\.id\} outfit=\{outfit\}/);
    expect(source("src/components/outfits/new-outfit.tsx")).toMatch(/useRefreshAfterItemChanges\(candidates, refresh\)/);
  });

  it("covers /today, whose cards know which outfits were already worn today", () => {
    const view = source("src/components/today/today-view.tsx");
    // Its own wears show through its overlay (D-180), so it re-reads only when shown after a change elsewhere.
    expect(view).toMatch(/useRefreshAfterItemChanges\(data, copy\.refresh, \{ refreshWhileShown: false \}\)/);
    expect(view).toMatch(/useRefreshAfterOutfitChanges\(data, copy\.refresh\)/);
    expect(view).toMatch(/useRefreshAfterHomeCityChange\(data, copy\.refresh\)/);
    // The states without the view (no home city, no weather) re-read after a new home city.
    expect(source("src/app/(app)/today/page.tsx").match(/<RefreshTodayWhenShown snapshot=\{settings\} \/>/g)).toHaveLength(2);
  });
});
