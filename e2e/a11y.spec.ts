import { randomUUID } from "node:crypto"

import { AxeBuilder } from "@axe-core/playwright"
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import {
  analyses,
  analysisParts,
  climateProfiles,
  items,
  packingChecklistItems,
  shoppingListItems,
  type Item,
} from "@/lib/db/schema"
import { planChunks } from "@/lib/relocation/chunks"
import type { RelocationParams } from "@/lib/relocation/contracts"
import { buildSnapshot } from "@/lib/relocation/payload"
import { RELOC_PROMPT_VERSION } from "@/lib/relocation/prompts"
import type { RelocationInputSnapshot } from "@/server/services/relocation"

import { makeImage, makeItem, makeTaggedItem } from "../test/factories"
import { makeRelocationResult } from "../test/relocation-fixtures"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"
import { NEEDS_NO_API_KEY, SHELL_TAGGING } from "./live-env"

// An axe scan (WCAG 2.0 and 2.1, levels A and AA) of every page built so far,
// against the production build: /login and /offline signed out, every
// signed-in page, an item page's not-found state, and /wardrobe at 390 px. A
// serious or critical violation fails the test; the full results are attached
// to the report either way. A few items are inserted straight into
// wardrobe_e2e so the wardrobe, detail, stats, export and review pages show
// real content, with photos pointing at a static file the app serves itself.
// For the relocation pages, two analyses over those items are inserted too: a
// finished one (its result from the shared fixture, packing rows and two
// shopping rows) and an unfinished one, whose progress page stops with the
// configuration error because the e2e server has no API key. With E2E_TAG=1
// and a key in the shell the server has one, and opening that page would run
// the parts against the real API, so the unfinished run is neither inserted
// nor scanned then (D-113). Every row is deleted again in afterAll.

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]
const FAILING_IMPACTS = new Set(["serious", "critical"])

const COAT = "E2E a11y wool coat"
const BOOTS = "E2E a11y rain boots"
const SOCKS = "E2E a11y wool socks"

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []
const createdAnalysisIds: string[] = []
const createdShoppingIds: string[] = []
let coatId = ""
let finishedRunId = ""
let unfinishedRunId = ""

const MONTHS = [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

/**
 * Inserts a relocation analysis over the seeded items: finished, with the
 * fixture result, or running with every part pending. The snapshot is built
 * by the real payload and chunk code, so a part request reads it like any
 * run's; a random cache key keeps the form from offering it as the cached
 * result.
 */
async function insertRelocationRun(snapshotItems: Item[], finished: boolean): Promise<string> {
  const [hamburg] = await db.select().from(climateProfiles).where(eq(climateProfiles.slug, "hamburg"))
  if (hamburg === undefined) throw new Error("The e2e setup seeds Hamburg")
  const params: RelocationParams = {
    climateProfileId: hamburg.id,
    dateFrom: "2026-11-03",
    dateTo: "2027-11-02",
    constraints: "I commute by bike every day.",
    purchaseBudgetEur: 600,
    includeOnlyConfirmed: false,
    acceptPlaceholder: false,
  }
  const snapshot = buildSnapshot(snapshotItems, { includeOnlyConfirmed: false, destination: "hamburg" })
  const names = Object.fromEntries(snapshotItems.map((item) => [item.id, item.name ?? "Item"]))
  const inputSnapshot: RelocationInputSnapshot = {
    lines: snapshot.lines,
    legend: snapshot.legend,
    aliasMap: snapshot.aliasMap,
    summaryText: snapshot.summaryText,
    climateText: "Hamburg, Germany: monthly climate (e2e).",
    months: MONTHS,
    chunks: planChunks(snapshot.lines),
    names,
    moved: [],
    profile: {
      id: hamburg.id,
      city: hamburg.city,
      country: hamburg.country,
      isPlaceholder: hamburg.isPlaceholder,
      slug: hamburg.slug,
    },
  }
  const result = makeRelocationResult(snapshot.lines.map((line) => line.itemId))
  const [row] = await db
    .insert(analyses)
    .values({
      kind: "relocation",
      status: finished ? "complete" : "running",
      climateProfileId: hamburg.id,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      params,
      model: "claude-sonnet-5-5",
      effort: "medium",
      promptVersion: RELOC_PROMPT_VERSION,
      inputSnapshotHash: snapshot.snapshotHash,
      cacheKey: `e2e-a11y-${randomUUID()}`,
      inputSnapshot,
      result: finished ? result : null,
      estimatedCostUsd: 0.02,
      costUsd: finished ? 0.02 : 0,
      completedAt: finished ? new Date() : null,
    })
    .returning({ id: analyses.id })
  if (row === undefined) throw new Error("analysis not inserted")
  createdAnalysisIds.push(row.id)
  if (!finished) {
    await db.insert(analysisParts).values([
      ...inputSnapshot.chunks.map((chunk) => ({
        analysisId: row.id,
        kind: "chunk" as const,
        partIndex: chunk.index,
        input: { aliases: chunk.aliases },
      })),
      { analysisId: row.id, kind: "synthesis" as const, partIndex: 0, input: {} },
    ])
    return row.id
  }
  let sortOrder = 0
  await db.insert(packingChecklistItems).values(
    result.packing_checklist.flatMap((group) => [
      ...group.item_ids.map((itemId) => ({
        analysisId: row.id,
        itemId,
        label: names[itemId] ?? "Item",
        group: group.group,
        sortOrder: (sortOrder += 1),
      })),
      ...group.extras.map((label) => ({ analysisId: row.id, label, group: group.group, sortOrder: (sortOrder += 1) })),
    ]),
  )
  const [gap] = result.gaps
  if (gap === undefined) throw new Error("The fixture result has gaps")
  const shopping = await db
    .insert(shoppingListItems)
    .values([
      {
        analysisId: row.id,
        gapKey: gap.gap_key,
        itemType: gap.item_type,
        category: gap.category,
        priority: gap.priority,
        reason: gap.why_needed,
        specs: gap.specs,
        quantity: gap.quantity,
        estPriceMinEur: gap.est_price_range_eur.min,
        estPriceMaxEur: gap.est_price_range_eur.max,
        buyTiming: gap.buy_before_or_after_move,
      },
      { itemType: SOCKS, priority: 2, quantity: 3, status: "bought", linkedItemId: coatId },
    ])
    .returning({ id: shoppingListItems.id })
  createdShoppingIds.push(...shopping.map((entry) => entry.id))
  return row.id
}

test.beforeAll(async ({ baseURL }) => {
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  const photoRow = { blobUrl: photo, contentType: "image/png", width: 192, height: 192, bytes: 4_000 }

  const coat = await makeTaggedItem(db, { status: "confirmed", name: COAT })
  const boots = await makeTaggedItem(db, {
    status: "tagged",
    name: BOOTS,
    category: "shoes",
    subcategory: "boots",
    waterproof: true,
    insulated: false,
    warmthLevel: 2,
  })
  const pending = await makeItem(db)
  for (const item of [coat, boots, pending]) {
    for (const kind of ["original", "processed", "thumb"] as const) {
      await makeImage(db, item.id, { kind, blobPathname: `e2e/${item.id}/${kind}`, ...photoRow })
    }
    createdItemIds.push(item.id)
  }
  coatId = coat.id
  finishedRunId = await insertRelocationRun([coat, boots], true)
  // Not inserted when the server has an API key: no page may resume it.
  if (!SHELL_TAGGING) unfinishedRunId = await insertRelocationRun([coat, boots], false)
})

test.afterAll(async () => {
  try {
    if (createdShoppingIds.length > 0) await db.delete(shoppingListItems).where(inArray(shoppingListItems.id, createdShoppingIds))
    // Parts and packing rows cascade.
    if (createdAnalysisIds.length > 0) await db.delete(analyses).where(inArray(analyses.id, createdAnalysisIds))
    // Image rows cascade.
    if (createdItemIds.length > 0) await db.delete(items).where(inArray(items.id, createdItemIds))
  } finally {
    await pool.end()
  }
})

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?next=%2Fsettings")
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/settings")
}

/** Waits until the page's own content replaced every loading skeleton. */
async function waitForContent(page: Page, ready: Locator): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(ready).toBeVisible()
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
}

/** Scans the page, attaches the results, and fails on serious or critical violations. */
async function expectNoSeriousViolations(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  await testInfo.attach(`axe-${label}.json`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json",
  })
  const failing = results.violations
    .filter((violation) => FAILING_IMPACTS.has(violation.impact ?? ""))
    .map((violation) => ({
      rule: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }))
  expect(failing, `${label}: serious or critical axe violations`).toEqual([])
}

test("the login page has no serious or critical violations", async ({ page }, testInfo) => {
  await page.goto("/login")
  await waitForContent(page, page.getByLabel("Password"))
  await expectNoSeriousViolations(page, testInfo, "login")
})

test("the offline page has no serious or critical violations", async ({ page }, testInfo) => {
  await page.goto("/offline")
  await waitForContent(page, page.getByRole("button", { name: "Try again" }))
  await expectNoSeriousViolations(page, testInfo, "offline")
})

test("every signed-in page has no serious or critical violations", async ({ page }, testInfo) => {
  await signIn(page)

  const pages: ReadonlyArray<{ label: string; path: string; ready: (page: Page) => Locator }> = [
    { label: "wardrobe", path: "/wardrobe", ready: (p) => p.getByRole("list", { name: "Items" }) },
    { label: "item-detail", path: `/wardrobe/${coatId}`, ready: (p) => p.getByRole("form", { name: `Tags for ${COAT}` }) },
    { label: "stats", path: "/stats", ready: (p) => p.getByRole("region", { name: "Overview" }) },
    { label: "settings", path: "/settings", ready: (p) => p.getByRole("link", { name: "Export your data" }) },
    { label: "settings-export", path: "/settings/export", ready: (p) => p.getByRole("region", { name: "Processed photos" }) },
    { label: "settings-usage", path: "/settings/usage", ready: (p) => p.getByRole("main").getByRole("heading", { level: 2 }).first() },
    { label: "add", path: "/add", ready: (p) => p.getByRole("main").getByText("Choose photos", { exact: true }) },
    { label: "add-review", path: "/add/review", ready: (p) => p.getByRole("article", { name: BOOTS, exact: true }) },
    {
      label: "item-not-found",
      path: `/wardrobe/${randomUUID()}`,
      ready: (p) => p.getByRole("heading", { level: 1, name: "Item not found" }),
    },
    { label: "relocate", path: "/relocate", ready: (p) => p.getByRole("status").filter({ hasText: "≈" }) },
    {
      label: "relocate-print",
      path: `/relocate/${finishedRunId}/print`,
      ready: (p) => p.getByRole("button", { name: "Print" }),
    },
    // No API key on the e2e server: the first part stops the run with the
    // configuration error. With one, the page would call Claude for real.
    ...(SHELL_TAGGING
      ? []
      : [
          {
            label: "relocate-progress",
            path: `/relocate/${unfinishedRunId}`,
            ready: (p: Page) => p.getByRole("alert").filter({ hasText: "Configuration problem" }),
          },
        ]),
    {
      label: "relocate-not-found",
      path: `/relocate/${randomUUID()}`,
      ready: (p) => p.getByRole("heading", { level: 1, name: "Analysis not found" }),
    },
    { label: "shopping", path: "/shopping", ready: (p) => p.getByText(SOCKS, { exact: true }) },
    { label: "settings-climate", path: "/settings/climate", ready: (p) => p.getByRole("region", { name: "Hamburg" }) },
  ]
  if (SHELL_TAGGING) testInfo.annotations.push({ type: "skip", description: `relocate-progress: ${NEEDS_NO_API_KEY}` })
  for (const { label, path, ready } of pages) {
    await test.step(label, async () => {
      await page.goto(path)
      await waitForContent(page, ready(page))
      await expectNoSeriousViolations(page, testInfo, label)
    })
  }
})

test("each tab of a finished relocation plan has no serious or critical violations", async ({ page }, testInfo) => {
  await signIn(page)
  await page.goto(`/relocate/${finishedRunId}`)
  await waitForContent(page, page.getByRole("tab", { name: "Items 2" }))
  for (const tab of ["Items", "Gaps", "Layering", "Packing", "Warnings"]) {
    await test.step(tab, async () => {
      const trigger = page.getByRole("tab", { name: new RegExp(`^${tab} `) })
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-selected", "true")
      await expectNoSeriousViolations(page, testInfo, `relocate-result-${tab.toLowerCase()}`)
    })
  }
})

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("the wardrobe has no serious or critical violations", async ({ page }, testInfo) => {
    await signIn(page)
    await page.goto("/wardrobe")
    await waitForContent(page, page.getByRole("list", { name: "Items" }))
    await expectNoSeriousViolations(page, testInfo, "wardrobe-390")
  })

  test("a relocation plan has no serious or critical violations", async ({ page }, testInfo) => {
    await signIn(page)
    await page.goto(`/relocate/${finishedRunId}`)
    await waitForContent(page, page.getByRole("tab", { name: "Items 2" }))
    await expectNoSeriousViolations(page, testInfo, "relocate-result-390")
  })
})
