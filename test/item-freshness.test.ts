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
});
