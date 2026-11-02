import { expect, test, type Page } from "@playwright/test"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { aiBatches, aiCalls, items } from "@/lib/db/schema"

import { makeImage, makeItem, makeTaggedItem } from "../test/factories"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"
import { NEEDS_NO_API_KEY, SHELL_TAGGING } from "./live-env"

// The review screen against the production build, without an Anthropic key
// or a Blob token: items are inserted straight into wardrobe_e2e, and their
// photos point at a static file the app serves itself. Every row this spec
// creates is deleted again in afterAll.

const TAGGED_NAME = "E2E review coat"
const RENAMED = "E2E review overcoat"
const STORED_ERROR = "E2E: Claude declined to describe this photo."
const HAND_TAGGED_NAME = "E2E hand-tagged scarf"

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []
let createdBatchId = ""
let taggedId = ""
let failedId = ""
let pendingId = ""
let manualId = ""
let batchedId = ""

/** A card found by its item id (the heading's id), which stays stable while its buttons change. */
function cardFor(page: Page, itemId: string) {
  return page.locator("article", { has: page.locator(`[id="review-item-${itemId}"]`) })
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?next=%2Fadd%2Freview")
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/add/review")
}

/** The page must never scroll sideways at phone width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test.beforeAll(async ({ baseURL }) => {
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  const photoRow = { blobUrl: photo, contentType: "image/png", width: 192, height: 192, bytes: 4_000 }

  // ai_raw holds what Claude returned; user_edited_fields is computed against it.
  const tags = {
    name: TAGGED_NAME,
    category: "outerwear",
    subcategory: "coat",
    colors: ["navy"],
    color_hex: ["#1f2a44"],
    material_guess: "wool",
    materials: ["wool"],
    warmth_level: 4,
    waterproof: false,
    windproof: true,
    insulated: true,
    breathable: null,
    seasons: ["winter", "autumn"],
    formality: "smart_casual",
    pattern: "solid",
    fit: null,
    condition: "good",
    brand_guess: null,
    description: "Knee-length navy wool coat.",
    confidence: {
      category: 0.95,
      colors: 0.9,
      materials: 0.4,
      warmth_level: 0.8,
      waterproof: 0.9,
      windproof: 0.8,
      insulated: 0.8,
      formality: 0.8,
      condition: 0.9,
      brand: 0.9,
    },
    multiple_items_detected: false,
  }
  const tagged = await makeTaggedItem(db, {
    name: TAGGED_NAME,
    materialGuess: "wool",
    pattern: "solid",
    aiRaw: tags,
    aiConfidence: tags.confidence,
    aiModel: "claude-haiku-5-5",
    aiPromptVersion: "tag-v1",
  })
  const failed = await makeItem(db, { taggingError: STORED_ERROR })
  const pending = await makeItem(db)
  // Filled in by hand: pending, in no batch, never sent to Claude.
  const manual = await makeItem(db)
  // Waiting in a batch. The batch row is already processed, so the page's
  // poll leaves it alone and never calls the Batches API.
  const [batch] = await db
    .insert(aiBatches)
    .values({
      anthropicBatchId: `msgbatch_e2e_${Date.now()}`,
      purpose: "tagging",
      model: "claude-haiku-5-5",
      status: "processed",
      requestCount: 1,
    })
    .returning({ id: aiBatches.id })
  if (batch === undefined) throw new Error("the e2e batch row was not inserted")
  createdBatchId = batch.id
  const batched = await makeItem(db, { taggingBatchId: batch.id })
  for (const item of [tagged, failed, pending, manual, batched]) {
    await makeImage(db, item.id, { kind: "processed", blobPathname: `e2e/${item.id}/processed`, ...photoRow })
    await makeImage(db, item.id, { kind: "thumb", blobPathname: `e2e/${item.id}/thumb`, ...photoRow })
  }
  createdItemIds.push(tagged.id, failed.id, pending.id, manual.id, batched.id)
  taggedId = tagged.id
  failedId = failed.id
  pendingId = pending.id
  manualId = manual.id
  batchedId = batched.id
})

test.afterAll(async () => {
  try {
    if (createdItemIds.length > 0) {
      // A failed tagging attempt may have logged a call against these items.
      await db.delete(aiCalls).where(inArray(aiCalls.itemId, createdItemIds))
      await db.delete(items).where(inArray(items.id, createdItemIds))
    }
    if (createdBatchId !== "") await db.delete(aiBatches).where(eq(aiBatches.id, createdBatchId))
  } finally {
    await pool.end()
  }
})

test("editing and confirming records the edited fields", async ({ page }) => {
  await signIn(page)
  const card = page.getByRole("article", { name: TAGGED_NAME, exact: true })
  await expect(card).toBeVisible()

  // The photo comes from the item's image row and actually loads (it may be lazy).
  const photo = card.getByRole("img", { name: TAGGED_NAME })
  await photo.scrollIntoViewIfNeeded()
  await expect(photo).toBeVisible()
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)

  // Materials had confidence 0.4: the hint is text, not only a coloured ring.
  await expect(card.getByText("Check this: Claude was 40% sure")).toBeVisible()

  // exact: "New colour name" also contains "name".
  await card.getByLabel("Name", { exact: true }).fill(RENAMED)
  await card.getByRole("button", { name: "Spring" }).click()
  await expect(card.getByRole("button", { name: "Spring" })).toHaveAttribute("aria-pressed", "true")
  await card.getByRole("button", { name: "Save and confirm" }).click()

  await expect(page.getByRole("article", { name: TAGGED_NAME, exact: true })).toHaveCount(0)
  await expect
    .poll(async () => {
      const [row] = await db.select().from(items).where(eq(items.id, taggedId))
      return row
    })
    .toMatchObject({ status: "confirmed", name: RENAMED, seasons: ["winter", "spring", "autumn"] })
  const [row] = await db.select({ edited: items.userEditedFields }).from(items).where(eq(items.id, taggedId))
  expect(row?.edited).toEqual(expect.arrayContaining(["name", "seasons"]))
  expect(row?.edited).not.toContain("materials")
})

test("a stored tagging error is shown with Retry", async ({ page }) => {
  await signIn(page)
  const card = cardFor(page, failedId)
  await expect(card).toContainText(STORED_ERROR)
  await expect(card.getByRole("button", { name: "Retry tagging" })).toBeVisible()
})

test("Tag now without an API key shows the error and leaves the item pending", async ({ page }) => {
  test.skip(SHELL_TAGGING, NEEDS_NO_API_KEY)
  await signIn(page)
  const card = cardFor(page, pendingId)
  await card.getByRole("button", { name: "Tag now" }).click()

  const alert = card.getByRole("alert")
  await expect(alert).toContainText("Tagging failed")
  await expect(alert).toHaveText(/Tagging failed\s*\S+/)
  await expect(card.getByRole("button", { name: "Retry tagging" })).toBeVisible()

  const [row] = await db.select({ status: items.status }).from(items).where(eq(items.id, pendingId))
  expect(row?.status).toBe("pending_tagging")
})

test("an item filled in by hand is confirmed without Claude", async ({ page }) => {
  await signIn(page)

  // An item waiting in a batch cannot be tagged by hand (the server would refuse).
  const batched = cardFor(page, batchedId)
  await expect(batched).toContainText("In batch")
  await expect(batched.getByRole("button", { name: "Fill in by hand" })).toHaveCount(0)

  const card = cardFor(page, manualId)
  await card.getByRole("button", { name: "Fill in by hand" }).click()
  await expect(card.getByRole("form")).toBeVisible()
  await expect(card.getByRole("button", { name: "Re-tag" })).toHaveCount(0)

  // exact: "New colour name" also contains "name".
  await card.getByLabel("Name", { exact: true }).fill(HAND_TAGGED_NAME)
  await card.getByLabel("Category").click()
  await page.getByRole("option", { name: "Scarf", exact: true }).click()
  await expect(card.getByLabel("Category")).toContainText("Scarf")
  await card.getByLabel("New colour name").fill("olive")
  await card.getByRole("button", { name: "Add colour" }).click()
  await card.getByRole("button", { name: "Winter" }).click()
  await expect(card.getByRole("button", { name: "Winter" })).toHaveAttribute("aria-pressed", "true")
  await card.getByLabel("Formality").click()
  await page.getByRole("option", { name: "Casual", exact: true }).click()
  await expect(card.getByLabel("Formality")).toContainText("Casual")
  await card.getByLabel("Condition").click()
  await page.getByRole("option", { name: "Good", exact: true }).click()
  await expect(card.getByLabel("Condition")).toContainText("Good")
  await card.getByRole("button", { name: "Save and confirm" }).click()

  await expect(cardFor(page, manualId)).toHaveCount(0)
  await expect(page.getByText(`${HAND_TAGGED_NAME} confirmed and moved to your wardrobe.`)).toBeAttached()
  await expect
    .poll(async () => {
      const [row] = await db
        .select({
          status: items.status,
          name: items.name,
          category: items.category,
          aiRaw: items.aiRaw,
          taggingError: items.taggingError,
        })
        .from(items)
        .where(eq(items.id, manualId))
      return row
    })
    .toEqual({ status: "confirmed", name: HAND_TAGGED_NAME, category: "scarf", aiRaw: null, taggingError: null })
  const [row] = await db.select({ edited: items.userEditedFields }).from(items).where(eq(items.id, manualId))
  expect(row?.edited).toEqual(
    expect.arrayContaining(["name", "category", "colors", "color_hex", "seasons", "formality", "condition"]),
  )
  // Nothing was sent to Claude for it.
  const calls = await db.select({ id: aiCalls.id }).from(aiCalls).where(eq(aiCalls.itemId, manualId))
  expect(calls).toHaveLength(0)
})

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("the review page fits without sideways scrolling", async ({ page }) => {
    await signIn(page)
    await expect(page.getByRole("heading", { level: 1, name: "Review items" })).toBeVisible()
    await expect(page.getByRole("article").first()).toBeVisible()
    await expectNoHorizontalScroll(page)
  })
})

// Last, because it leaves a tagging error on every waiting item.
test("the waiting items get one quote and are tagged together, each card showing its outcome", async ({
  page,
}, testInfo) => {
  test.skip(SHELL_TAGGING, NEEDS_NO_API_KEY)
  await signIn(page)
  const region = page.getByRole("region", { name: "Tagging" })
  await expect(region).toContainText(/Tag \d+ waiting items? ≈ (< )?\$\d+\.\d\d \(Haiku 5\.5\)/)
  await expect(region).toContainText(/\$\d+\.\d\d left this month/)
  for (const [label, size] of [
    ["review-tagging-desktop", { width: 1280, height: 800 }],
    ["review-tagging-phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size)
    await expect(region).toBeInViewport()
    const path = testInfo.outputPath(`${label}.png`)
    await page.screenshot({ path })
    await testInfo.attach(label, { path, contentType: "image/png" })
  }

  await region.getByRole("button", { name: /^Tag \d+ items?$/ }).click()

  // Without an API key every call fails; each card says so and offers Retry.
  for (const itemId of [pendingId, failedId]) {
    const card = cardFor(page, itemId)
    await expect(card.getByRole("alert")).toContainText("Tagging failed")
    await expect(card.getByRole("button", { name: "Retry tagging" })).toBeVisible()
  }
  await expect(page.locator('[data-slot="toast"]').filter({ hasText: "could not be tagged" })).toBeVisible()
  const rows = await db.select({ status: items.status }).from(items).where(inArray(items.id, [pendingId, failedId]))
  expect(rows.map((row) => row.status)).toEqual(["pending_tagging", "pending_tagging"])
})
