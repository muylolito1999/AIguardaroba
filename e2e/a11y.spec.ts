import { randomUUID } from "node:crypto"

import { AxeBuilder } from "@axe-core/playwright"
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test"
import { inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { items } from "@/lib/db/schema"

import { makeImage, makeItem, makeTaggedItem } from "../test/factories"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// An axe scan (WCAG 2.0 and 2.1, levels A and AA) of every page built so far,
// against the production build: /login and /offline signed out, every
// signed-in page, an item page's not-found state, and /wardrobe at 390 px. A
// serious or critical violation fails the test; the full results are attached
// to the report either way. A few items are inserted straight into
// wardrobe_e2e so the wardrobe, detail, stats, export and review pages show
// real content, with photos pointing at a static file the app serves itself.
// Every row is deleted again in afterAll.

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]
const FAILING_IMPACTS = new Set(["serious", "critical"])

const COAT = "E2E a11y wool coat"
const BOOTS = "E2E a11y rain boots"

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []
let coatId = ""

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
})

test.afterAll(async () => {
  try {
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
  ]
  for (const { label, path, ready } of pages) {
    await test.step(label, async () => {
      await page.goto(path)
      await waitForContent(page, ready(page))
      await expectNoSeriousViolations(page, testInfo, label)
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
})
