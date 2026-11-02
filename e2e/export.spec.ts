import { readFile } from "node:fs/promises"

import { expect, test, type Download, type Page } from "@playwright/test"
import { count, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { items } from "@/lib/db/schema"
import { CSV_EOL, ITEM_CSV_HEADERS } from "@/lib/export/csv"
import { EXPORT_FORMAT_VERSION, EXPORT_JSON_TABLES } from "@/lib/export/json-tables"

import { makeImage, makeTaggedItem } from "../test/factories"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// The export page against the production build, without a Blob token: two
// items are inserted straight into wardrobe_e2e with photos pointing at a
// static file the app serves itself. JSON and CSV come from the database
// alone; the photo ZIPs are only listed, never downloaded, because those
// photo URLs are not on a Blob host and the route would refuse them. Every
// row this spec creates is deleted again in afterAll.

const COAT_NAME = "E2E export coat"
const SCARF_NAME = "E2E export scarf, wool"

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []

async function signIn(page: Page, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === next)
}

async function downloadFrom(page: Page, linkName: string): Promise<{ download: Download; bytes: Buffer }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: linkName }).click(),
  ])
  expect(await download.failure()).toBeNull()
  return { download, bytes: await readFile(await download.path()) }
}

test.beforeAll(async ({ baseURL }) => {
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  const photoRow = { blobUrl: photo, contentType: "image/png", width: 192, height: 192, bytes: 4_000 }
  const coat = await makeTaggedItem(db, { name: COAT_NAME, createdAt: new Date(Date.UTC(2026, 0, 1, 8)) })
  const scarf = await makeTaggedItem(db, {
    name: SCARF_NAME,
    category: "scarf",
    subcategory: "scarf",
    createdAt: new Date(Date.UTC(2026, 0, 1, 9)),
  })
  for (const item of [coat, scarf]) {
    await makeImage(db, item.id, { kind: "processed", blobPathname: `e2e/${item.id}/processed`, ...photoRow })
    await makeImage(db, item.id, { kind: "thumb", blobPathname: `e2e/${item.id}/thumb`, ...photoRow })
  }
  createdItemIds.push(coat.id, scarf.id)
})

test.afterAll(async () => {
  try {
    // Images cascade with their items.
    if (createdItemIds.length > 0) await db.delete(items).where(inArray(items.id, createdItemIds))
  } finally {
    await pool.end()
  }
})

test("exports JSON and CSV and lists one photo part", async ({ page }) => {
  await signIn(page, "/settings")
  await page.getByRole("link", { name: "Export your data" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/settings/export")
  await expect(page.getByRole("heading", { level: 1, name: "Export your data" })).toBeVisible()

  // JSON: every exported table, both items with their photos, no login attempts.
  const json = await downloadFrom(page, "Download JSON")
  expect(json.download.suggestedFilename()).toMatch(/^wardrobe-\d{4}-\d{2}-\d{2}\.json$/)
  const parsed = JSON.parse(json.bytes.toString("utf8")) as Record<string, unknown> & {
    version: number
    items: Array<{ id: string; name: string | null; images: Array<{ kind: string }> }>
  }
  expect(parsed.version).toBe(EXPORT_FORMAT_VERSION)
  // Every exported table, in file order; login attempts are not among them.
  expect(Object.keys(parsed)).toEqual(["exportedAt", "version", ...EXPORT_JSON_TABLES])
  expect(Object.keys(parsed)).not.toContain("loginAttempts")
  for (const table of EXPORT_JSON_TABLES) expect(Array.isArray(parsed[table]), table).toBe(true)
  const exported = parsed.items.filter((item) => createdItemIds.includes(item.id))
  expect(exported.map((item) => item.name)).toEqual([COAT_NAME, SCARF_NAME])
  expect(exported[0]?.images.map((image) => image.kind)).toEqual(["processed", "thumb"])

  // CSV: BOM, the header, one row per item in the database (just these two after global setup).
  const csv = await downloadFrom(page, "Download CSV")
  expect(csv.download.suggestedFilename()).toMatch(/^wardrobe-\d{4}-\d{2}-\d{2}\.csv$/)
  expect([...csv.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const lines = csv.bytes.subarray(3).toString("utf8").split(CSV_EOL)
  expect(lines.pop()).toBe("")
  expect(lines[0]).toBe(ITEM_CSV_HEADERS.join(","))
  const rows = lines.slice(1)
  const [{ total } = { total: -1 }] = await db.select({ total: count() }).from(items)
  expect(rows).toHaveLength(total)
  expect(rows.filter((row) => createdItemIds.some((id) => row.startsWith(`${id},`)))).toHaveLength(2)
  expect(rows.some((row) => row.includes(`"${SCARF_NAME}"`))).toBe(true)

  // Photos: both processed photos fit in one part; neither item has a cut-out.
  const processed = page.getByRole("region", { name: "Processed photos" })
  // exact: the download link's hidden name ends in "part 1 of 1" too.
  await expect(processed.getByText("Part 1 of 1", { exact: true })).toBeVisible()
  await expect(processed.getByRole("link", { name: /^Download processed photos, part \d+ of \d+$/ })).toHaveCount(1)
  await expect(processed.getByRole("link", { name: "Download processed photos, part 1 of 1" })).toHaveAttribute(
    "href",
    "/api/export/images?kind=processed&part=1",
  )
  await expect(page.getByRole("region", { name: "Cut-outs" }).getByText("No cut-outs yet.")).toBeVisible()

  // Phone width: no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
