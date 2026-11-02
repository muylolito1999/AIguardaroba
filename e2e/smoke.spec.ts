import { expect, test, type Page } from "@playwright/test"
import { del } from "@vercel/blob"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { CATEGORY_LABELS } from "@/components/items/tag-options"
import { relations } from "@/lib/db/relations"
import { aiCalls, itemImages, items } from "@/lib/db/schema"

import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"
import { makeJpegFixture, type PhotoFixture } from "./fixtures/images"
import { E2E_TAG_REQUESTED, SHELL_HAS_BLOB_TOKEN, SHELL_TAGGING } from "./live-env"

// The whole path once, against a real Blob store (D-113): sign in, upload two
// photos, wait for registration, review and confirm them, find them in the
// wardrobe, filter by category, open one and change its plan. Tagging is by
// hand unless E2E_TAG=1, which uses Tag now and calls Claude for real.
//
// It needs BLOB_READ_WRITE_TOKEN in the shell that starts Playwright (never
// read from .env.local); playwright.config.ts then passes it to the server.
// Run it on its own, since other specs assume the server has no token:
//   BLOB_READ_WRITE_TOKEN=… pnpm test:e2e e2e/smoke.spec.ts
// Everything it stores is removed in afterAll: every blob it uploaded or the
// server wrote for its items (del() with the same token), then the rows.

test.skip(!SHELL_HAS_BLOB_TOKEN, "needs BLOB_READ_WRITE_TOKEN in the shell")
test.skip(E2E_TAG_REQUESTED && !SHELL_TAGGING, "E2E_TAG=1 needs ANTHROPIC_API_KEY in the shell")

const HAND_TAGS = [
  { name: "E2E smoke wool coat", category: "outerwear", colour: "navy" },
  { name: "E2E smoke scarf", category: "scarf", colour: "olive" },
] as const

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
let fixtures: PhotoFixture[] = []
/** Blob URLs the browser uploaded, read from the Blob API's answers. */
const uploadedUrls = new Set<string>()

/** The items this run created, found by the photos' source hashes. */
async function createdItemIds(): Promise<string[]> {
  if (fixtures.length === 0) return []
  const rows = await db
    .select({ id: items.id })
    .from(items)
    .where(inArray(items.sourceHash, fixtures.map((fixture) => fixture.sourceHash)))
  return rows.map((row) => row.id)
}

test.beforeAll(async () => {
  // Colours from the clock, so a store left with blobs from a crashed run
  // never meets the same source hash again.
  const shade = Date.now() % 200
  fixtures = [
    await makeJpegFixture("e2e-smoke-coat.jpg", { r: 20 + shade, g: 40, b: 90 }),
    await makeJpegFixture("e2e-smoke-scarf.jpg", { r: 90, g: 110, b: 20 + shade }),
  ]
})

test.afterAll(async () => {
  try {
    const ids = await createdItemIds()
    const stored =
      ids.length === 0
        ? []
        : await db.select({ url: itemImages.blobUrl }).from(itemImages).where(inArray(itemImages.itemId, ids))
    const urls = [...new Set([...uploadedUrls, ...stored.map((row) => row.url)])]
    const token = process.env.BLOB_READ_WRITE_TOKEN
    // Explicit token, as on the server; its value is never printed.
    if (urls.length > 0 && token !== undefined && token !== "") await del(urls, { token })
    if (ids.length > 0) {
      await db.delete(aiCalls).where(inArray(aiCalls.itemId, ids))
      // Image rows cascade.
      await db.delete(items).where(inArray(items.id, ids))
    }
  } finally {
    await pool.end()
  }
})

async function signIn(page: Page, path: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(path)}`)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === path)
}

/** A review card found by its item id (the heading's id). */
function cardFor(page: Page, itemId: string) {
  return page.locator("article", { has: page.locator(`[id="review-item-${itemId}"]`) })
}

async function fillInByHand(page: Page, itemId: string, tags: (typeof HAND_TAGS)[number]): Promise<void> {
  const card = cardFor(page, itemId)
  await card.getByRole("button", { name: "Fill in by hand" }).click()
  // exact: "New colour name" also contains "name".
  await card.getByLabel("Name", { exact: true }).fill(tags.name)
  await card.getByLabel("Category").click()
  await page.getByRole("option", { name: CATEGORY_LABELS[tags.category], exact: true }).click()
  await card.getByLabel("New colour name").fill(tags.colour)
  await card.getByRole("button", { name: "Add colour" }).click()
  await card.getByRole("button", { name: "Winter" }).click()
  await card.getByLabel("Formality").click()
  await page.getByRole("option", { name: "Casual", exact: true }).click()
  await card.getByLabel("Condition").click()
  await page.getByRole("option", { name: "Good", exact: true }).click()
  await card.getByRole("button", { name: "Save and confirm" }).click()
  await expect(card).toHaveCount(0)
}

async function tagWithClaude(page: Page, itemId: string): Promise<void> {
  const card = cardFor(page, itemId)
  await card.getByRole("button", { name: "Tag now" }).click()
  // The form replaces the tagging controls once Claude's tags are stored.
  await expect(card.getByRole("form")).toBeVisible({ timeout: 90_000 })
  await card.getByRole("button", { name: "Confirm", exact: true }).click()
  await expect(card).toHaveCount(0)
}

test("upload, review, browse, filter and change an item's plan", async ({ page }) => {
  test.setTimeout(300_000)
  page.on("response", async (response) => {
    // The browser's put() answers with the stored blob's URL; recorded even if
    // registration later fails, so afterAll can delete it.
    if (!response.url().startsWith("https://vercel.com/api/blob") || response.request().method() !== "PUT") return
    try {
      const body: unknown = await response.json()
      if (typeof body === "object" && body !== null && "url" in body && typeof body.url === "string") {
        uploadedUrls.add(body.url)
      }
    } catch {
      // Not JSON (a failed upload): nothing was stored.
    }
  })

  // Upload and registration.
  await signIn(page, "/add")
  await page.getByLabel("Choose photos").setInputFiles(
    fixtures.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })),
  )
  await expect(page.getByRole("status").filter({ hasText: /of \d+ photos? uploaded/ })).toHaveText(
    "2 of 2 photos uploaded.",
    { timeout: 120_000 },
  )
  const ids = await createdItemIds()
  expect(ids).toHaveLength(2)
  const images = await db.select({ kind: itemImages.kind }).from(itemImages).where(inArray(itemImages.itemId, ids))
  expect(images.map((image) => image.kind).sort()).toEqual(["original", "original", "processed", "processed", "thumb", "thumb"])

  // Review and confirm.
  await page.getByRole("link", { name: "Review 2 items" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/add/review")
  for (const [index, id] of ids.entries()) {
    const tags = HAND_TAGS[index] ?? HAND_TAGS[0]
    if (SHELL_TAGGING) await tagWithClaude(page, id)
    else await fillInByHand(page, id, tags)
  }
  await expect
    .poll(async () => (await db.select({ status: items.status }).from(items).where(inArray(items.id, ids))).map((row) => row.status))
    .toEqual(["confirmed", "confirmed"])
  const confirmed = await db
    .select({ id: items.id, name: items.name, category: items.category })
    .from(items)
    .where(inArray(items.id, ids))

  // Both cards in the wardrobe.
  await page.getByRole("link", { name: "Wardrobe" }).first().click()
  await expect(page).toHaveURL((url) => url.pathname === "/wardrobe")
  const grid = page.getByRole("list", { name: "Items" })
  for (const item of confirmed) {
    await expect(grid.locator(`a[href="/wardrobe/${item.id}"]`)).toBeVisible()
  }

  // Filter by the first item's category.
  const first = confirmed[0]
  if (first === undefined || first.category === null) throw new Error("the confirmed item has no category")
  const chips = page.getByRole("group", { name: "Category" })
  await chips.getByRole("button", { name: new RegExp(`^${CATEGORY_LABELS[first.category]}, \\d+ items?$`) }).click()
  await expect(page).toHaveURL((url) => url.searchParams.getAll("category").join() === first.category)
  const card = grid.locator(`a[href="/wardrobe/${first.id}"]`)
  await expect(card).toBeVisible()

  // Open it and change its plan.
  await card.click()
  await expect(page).toHaveURL((url) => url.pathname === `/wardrobe/${first.id}`)
  if (first.name !== null) await expect(page.getByRole("heading", { level: 1, name: first.name })).toBeVisible()
  const plan = page.getByRole("group", { name: "Plan for the move" })
  await plan.getByRole("button", { name: "Donate" }).click()
  await expect(plan.getByRole("button", { name: "Donate" })).toHaveAttribute("aria-pressed", "true")
  await expect
    .poll(async () => (await db.select({ decision: items.decision }).from(items).where(eq(items.id, first.id)))[0]?.decision)
    .toBe("donate")
})
