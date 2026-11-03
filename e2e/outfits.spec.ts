import { expect, test, type Locator, type Page } from "@playwright/test"
import { eq, inArray, like } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { items, outfits, wearLogs, type NewItem } from "@/lib/db/schema"

import { makeImage, makeTaggedItem } from "../test/factories"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// Outfits and wear tracking against the production build: build and save an
// outfit with the slot pickers, see it listed, log a wear from the list and
// undo it, log one on the item page and see its count there, then delete the
// outfit and check its items stay. The items are inserted straight into
// wardrobe_e2e, all named with the made-up word "Outspec" so the pickers'
// search finds only them; photos point at a static icon the app serves
// itself. Every row this spec creates is deleted again in afterAll. Wear
// dates follow the seeded home profile (Bologna, Europe/Rome).

const TOKEN = "Outspec"
const OUTFIT_NAME = `${TOKEN} weekend`

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []
const ids = { sweater: "", jeans: "", boots: "" }

const ITEMS: Record<keyof typeof ids, Partial<NewItem> & { name: string }> = {
  sweater: { name: `${TOKEN} grey sweater`, category: "top", subcategory: "sweater", warmthLevel: 3 },
  jeans: { name: `${TOKEN} dark jeans`, category: "bottom", subcategory: "jeans", warmthLevel: 2 },
  boots: { name: `${TOKEN} brown boots`, category: "shoes", subcategory: "boots", warmthLevel: 3, waterproof: true },
}

async function signIn(page: Page, path: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(path)}`)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === path)
}

/** The page must never scroll sideways at phone width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

/** Opens a slot's picker, searches for the spec's items and picks one by name. */
async function pick(page: Page, slotButton: string, itemName: string): Promise<void> {
  await page.getByRole("button", { name: slotButton }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Search").fill(TOKEN)
  await dialog.getByRole("button", { name: new RegExp(itemName) }).click()
  await expect(dialog).toBeHidden()
}

function outfitCard(page: Page): Locator {
  return page.getByRole("article", { name: OUTFIT_NAME })
}

/** The item page's "Worn" value in its details list. */
function wornValue(page: Page): Locator {
  return page.locator("dt", { hasText: /^Worn$/ }).locator("xpath=following-sibling::dd[1]")
}

async function wearCount(id: string): Promise<number | undefined> {
  const [row] = await db.select({ wearCount: items.wearCount }).from(items).where(eq(items.id, id))
  return row?.wearCount
}

test.beforeAll(async ({ baseURL }) => {
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  const photoRow = { blobUrl: photo, contentType: "image/png", width: 192, height: 192, bytes: 4_000 }
  for (const key of Object.keys(ITEMS) as (keyof typeof ids)[]) {
    const item = await makeTaggedItem(db, { status: "confirmed", ...ITEMS[key] })
    await makeImage(db, item.id, { kind: "thumb", blobPathname: `e2e/${item.id}/thumb`, ...photoRow })
    ids[key] = item.id
    createdItemIds.push(item.id)
  }
})

test.afterAll(async () => {
  try {
    // outfit_items cascade with the outfits; wear logs and images with the items.
    await db.delete(outfits).where(like(outfits.name, `${TOKEN}%`))
    if (createdItemIds.length > 0) {
      await db.delete(wearLogs).where(inArray(wearLogs.itemId, createdItemIds))
      await db.delete(items).where(inArray(items.id, createdItemIds))
    }
  } finally {
    await pool.end()
  }
})

test.describe.configure({ mode: "serial" })

test("builds an outfit, logs and undoes wears, and deletes it while its items stay", async ({ page }) => {
  await signIn(page, "/outfits/new")
  await expect(page.getByRole("heading", { level: 1, name: "New outfit" })).toBeVisible()

  // Save first: the missing slots and the name are pointed out where they are.
  await page.getByRole("button", { name: "Save outfit" }).click()
  await expect(page.getByRole("group", { name: "Top or dress" })).toContainText("Choose a top or a dress.")
  await expect(page.getByText("Give the outfit a name.")).toBeVisible()

  await pick(page, "Choose top or dress", ITEMS.sweater.name)
  await pick(page, "Choose bottom", ITEMS.jeans.name)
  await pick(page, "Choose shoes", ITEMS.boots.name)
  await expect(page.getByRole("group", { name: "Top or dress" })).toContainText(ITEMS.sweater.name)
  await expect(page.getByRole("group", { name: "Top or dress" })).not.toContainText("Choose a top or a dress.")
  await page.getByLabel("Name").fill(OUTFIT_NAME)
  await page.getByLabel("Occasion").fill("Weekend walk")
  await page.getByLabel("Lowest °C").fill("4")
  await page.getByLabel("Highest °C").fill("12,5")
  await page.getByRole("checkbox", { name: "Fine in rain" }).click()
  await page.getByLabel("Rating").selectOption("4")
  await page.getByRole("button", { name: "Save outfit" }).click()

  // Listed.
  await expect(page).toHaveURL((url) => url.pathname === "/outfits")
  const card = outfitCard(page)
  await expect(card).toBeVisible()
  await expect(card).toContainText("Weekend walk")
  await expect(card).toContainText("4 to 12.5 °C")
  await expect(card).toContainText("Fine in rain")
  await expect(card).toContainText("Never worn")

  // A wear from the list, then its Undo from the toast.
  await card.getByRole("button", { name: "Wore this today" }).click()
  await expect(page.getByText("Logged as worn")).toBeVisible()
  await expect(card).toContainText("Worn once")
  expect(await wearCount(ids.sweater)).toBe(1)
  await page.getByRole("button", { name: "Undo" }).click()
  await expect(page.getByText("Wear undone")).toBeVisible()
  await expect(card).toContainText("Never worn")
  expect(await wearCount(ids.sweater)).toBe(0)

  // Logged again; a second press the same day counts once.
  await card.getByRole("button", { name: "Wore this today" }).click()
  await expect(card).toContainText("Worn once")
  await card.getByRole("button", { name: "Wore this today" }).click()
  // Exact: the toast's description says "is already logged" too.
  await expect(page.getByText("Already logged", { exact: true })).toBeVisible()
  expect(await wearCount(ids.sweater)).toBe(1)

  // The item page shows the count, and "+1 worn today" adds an item-only wear with Undo.
  await page.goto(`/wardrobe/${ids.sweater}`)
  await expect(page.getByRole("heading", { level: 1, name: ITEMS.sweater.name })).toBeVisible()
  await expect(wornValue(page)).toHaveText("Once")
  await page.getByRole("button", { name: "+1 worn today" }).click()
  await expect(wornValue(page)).toHaveText("2 times")
  await page.getByRole("button", { name: "Undo" }).click()
  await expect(wornValue(page)).toHaveText("Once")
  expect(await wearCount(ids.sweater)).toBe(1)

  // Delete the outfit from its page; the items and their wear counts stay.
  await page.goto("/outfits")
  await outfitCard(page).getByRole("link", { name: OUTFIT_NAME }).click()
  await expect(page.getByRole("heading", { level: 1, name: OUTFIT_NAME })).toBeVisible()
  // The outfit's own line; each chosen item shows its count as well ("Worn once · last …").
  await expect(page.getByText(/^Worn once, last on /)).toBeVisible()
  await page.getByRole("button", { name: "Delete outfit" }).click()
  const confirm = page.getByRole("alertdialog")
  await expect(confirm).toContainText(`Delete ${OUTFIT_NAME}?`)
  await confirm.getByRole("button", { name: "Delete" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/outfits")
  await expect(outfitCard(page)).toHaveCount(0)
  const left = await db.select({ id: items.id }).from(items).where(inArray(items.id, createdItemIds))
  expect(left).toHaveLength(3)
  expect(await wearCount(ids.sweater)).toBe(1)
})

test("the builder and its picker fit a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, "/outfits/new")
  await expect(page.getByRole("button", { name: "Choose top or dress" })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.getByRole("button", { name: "Choose top or dress" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Search").fill(TOKEN)
  await expect(dialog.getByRole("button", { name: new RegExp(ITEMS.sweater.name) })).toBeVisible()
  await expectNoHorizontalScroll(page)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await page.goto("/outfits")
  await expectNoHorizontalScroll(page)
})
