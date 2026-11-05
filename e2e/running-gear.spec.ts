import { expect, test, type Locator, type Page } from "@playwright/test"
import { eq, inArray, like } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { items, outfitItems, outfits, wearLogs, type NewItem } from "@/lib/db/schema"

import { makeImage, makeTaggedItem } from "../test/factories"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// Running gear against the production build (D-248 to D-252): the Clothes |
// Running switch on /wardrobe and the views it keeps to, the "Running gear"
// switch on an item page, outfits leaving running gear out (pickers, a saved
// outfit holding a moved piece, its wear refused), and "+1 worn today" still
// counting running gear. Three clothing items (a top, a bottom and shoes), two
// pieces of running gear (a top and shoes) and one saved outfit of the three
// clothing items are inserted straight into wardrobe_e2e, all named with the
// made-up word "Runspec", so searching for it scopes every list to them.
// Photos point at a static icon the app serves itself. Every row this spec
// creates is deleted again in afterAll (stats.spec fails on tagged leftovers).

test.describe.configure({ mode: "serial" })

const TOKEN = "Runspec"
const SCOPED = `/wardrobe?q=${TOKEN}`
const OUTFIT_NAME = `${TOKEN} commute`
const NOT_CLOTHING = "This item is running gear, which outfits leave out."
const WEAR_REFUSED = "Running gear cannot be logged as part of an outfit. Swap it out first."

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []
const ids = { top: "", bottom: "", shoes: "", runTop: "", runShoes: "" }
let outfitId = ""

type Key = keyof typeof ids

const ITEMS: Record<Key, Partial<NewItem> & { name: string }> = {
  top: { name: `${TOKEN} grey sweater`, category: "top", subcategory: "sweater", warmthLevel: 3, waterproof: false },
  bottom: { name: `${TOKEN} dark jeans`, category: "bottom", subcategory: "jeans", warmthLevel: 2, waterproof: false },
  shoes: { name: `${TOKEN} brown boots`, category: "shoes", subcategory: "boots", warmthLevel: 3, waterproof: false },
  runTop: {
    name: `${TOKEN} neon running shirt`,
    category: "top",
    subcategory: "running shirt",
    warmthLevel: 1,
    waterproof: false,
    collection: "running",
  },
  runShoes: {
    name: `${TOKEN} trail running shoes`,
    category: "shoes",
    subcategory: "trail shoes",
    warmthLevel: 2,
    waterproof: true,
    collection: "running",
  },
}

const CLOTHING: readonly Key[] = ["top", "bottom", "shoes"]
const RUNNING: readonly Key[] = ["runTop", "runShoes"]

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

/** Waits for the URL to carry exactly these parameters, in this order. */
async function expectQuery(page: Page, query: string): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === "/wardrobe" && url.search === query)
}

function resultCount(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: /^\d[\d,]* items?$/ })
}

function cards(page: Page): Locator {
  return page.getByRole("list", { name: "Items" }).getByRole("link")
}

function viewSwitch(page: Page): Locator {
  return page.getByRole("group", { name: "Show" })
}

/** The grid lists exactly these of the spec's items, in any order. */
async function expectCards(page: Page, keys: readonly Key[]): Promise<void> {
  await expect(resultCount(page)).toHaveText(`${keys.length} ${keys.length === 1 ? "item" : "items"}`)
  await expect(cards(page)).toHaveCount(keys.length)
  for (const key of keys) await expect(cards(page).filter({ hasText: ITEMS[key].name })).toHaveCount(1)
}

/** The item page's "Worn" value in its details list. */
function wornValue(page: Page): Locator {
  return page.locator("dt", { hasText: /^Worn$/ }).locator("xpath=following-sibling::dd[1]")
}

/** The item page header's badges (not the switch's label, which says "Running gear" too). */
function headerBadge(page: Page, text: string): Locator {
  return page
    .locator("header")
    .filter({ has: page.getByRole("heading", { level: 1 }) })
    .getByText(text, { exact: true })
}

async function collectionOf(id: string): Promise<string | undefined> {
  const [row] = await db.select({ collection: items.collection }).from(items).where(eq(items.id, id))
  return row?.collection
}

async function wearCount(id: string): Promise<number | undefined> {
  const [row] = await db.select({ wearCount: items.wearCount }).from(items).where(eq(items.id, id))
  return row?.wearCount
}

test.beforeAll(async ({ baseURL }) => {
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  const photoRow = { blobUrl: photo, contentType: "image/png", width: 192, height: 192, bytes: 4_000 }
  let minutesAgo = 10
  for (const key of Object.keys(ITEMS) as Key[]) {
    const item = await makeTaggedItem(db, {
      status: "confirmed",
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
      ...ITEMS[key],
    })
    minutesAgo -= 1
    await makeImage(db, item.id, { kind: "thumb", blobPathname: `e2e/${item.id}/thumb`, ...photoRow })
    await makeImage(db, item.id, { kind: "processed", blobPathname: `e2e/${item.id}/processed`, ...photoRow })
    ids[key] = item.id
    createdItemIds.push(item.id)
  }
  const [outfit] = await db.insert(outfits).values({ name: OUTFIT_NAME }).returning({ id: outfits.id })
  if (outfit === undefined) throw new Error("The outfit was not inserted")
  outfitId = outfit.id
  await db.insert(outfitItems).values([
    { outfitId, itemId: ids.top, slot: "top" },
    { outfitId, itemId: ids.bottom, slot: "bottom" },
    { outfitId, itemId: ids.shoes, slot: "shoes" },
  ])
})

test.afterAll(async () => {
  try {
    // outfit_items cascade with the outfits; wear logs and images with the items.
    await db.delete(outfits).where(like(outfits.name, `${TOKEN}%`))
    if (createdItemIds.length > 0) {
      await db.delete(wearLogs).where(inArray(wearLogs.itemId, createdItemIds))
      await db.delete(items).where(inArray(items.id, createdItemIds))
    }
    await db.delete(items).where(like(items.name, `${TOKEN}%`))
  } finally {
    await pool.end()
  }
})

test("the Clothes and Running views each list one collection, and the view stays through chips, search, reset and Back", async ({
  page,
}) => {
  await signIn(page, "/wardrobe")
  await page.goto(SCOPED)

  // Clothes is the default view and leaves running gear out.
  const show = viewSwitch(page)
  await expect(show.getByRole("button", { name: "Clothes" })).toHaveAttribute("aria-pressed", "true")
  await expect(show.getByRole("button", { name: "Running" })).toHaveAttribute("aria-pressed", "false")
  await expectCards(page, CLOTHING)

  // Running: the first parameter, and only running gear.
  await show.getByRole("button", { name: "Running" }).click()
  await expectQuery(page, `?collection=running&q=${TOKEN}`)
  await expect(show.getByRole("button", { name: "Running" })).toHaveAttribute("aria-pressed", "true")
  await expect(show.getByRole("button", { name: "Clothes" })).toHaveAttribute("aria-pressed", "false")
  await expectCards(page, RUNNING)

  // The chips count this view's items, and a chip keeps to it.
  const chips = page.getByRole("group", { name: "Category" })
  await expect(chips.getByRole("button", { name: "All, 2 items" })).toHaveAttribute("aria-pressed", "true")
  await chips.getByRole("button", { name: "Shoes, 1 item" }).click()
  await expectQuery(page, `?collection=running&q=${TOKEN}&category=shoes`)
  await expectCards(page, ["runShoes"])
  await chips.getByRole("button", { name: "All, 2 items" }).click()
  await expectQuery(page, `?collection=running&q=${TOKEN}`)
  await expectCards(page, RUNNING)

  // Search within the view.
  const search = page.getByRole("searchbox", { name: "Search your wardrobe" })
  await search.fill(`${TOKEN} neon`)
  await expectQuery(page, `?collection=running&q=${TOKEN}+neon`)
  await expectCards(page, ["runTop"])
  await search.fill(TOKEN)
  await expectQuery(page, `?collection=running&q=${TOKEN}`)
  await expectCards(page, RUNNING)

  // A panel filter, then Reset filters: the view stays Running.
  await page.getByRole("button", { name: /^Filters/ }).click()
  const panel = page.getByRole("dialog", { name: "Filters" })
  await expect(panel).toBeVisible()
  await panel.getByRole("group", { name: "Waterproof" }).getByRole("button", { name: "Yes" }).click()
  await expectQuery(page, `?collection=running&q=${TOKEN}&waterproof=true`)
  // The drawer is modal, so its own count stands in for the hidden grid.
  await expect(panel.getByRole("button", { name: "Show 1 item" })).toBeVisible()
  await panel.getByRole("button", { name: "Reset filters" }).click()
  await expectQuery(page, `?collection=running&q=${TOKEN}`)
  await panel.getByRole("button", { name: "Show 2 items" }).click()
  await expect(panel).toBeHidden()
  await expectCards(page, RUNNING)
  await expect(show.getByRole("button", { name: "Running" })).toHaveAttribute("aria-pressed", "true")

  // An item of the view, then "Back to wardrobe": the Running view again.
  await cards(page).filter({ hasText: ITEMS.runTop.name }).click()
  await expect(page).toHaveURL((url) => url.pathname === `/wardrobe/${ids.runTop}`)
  await expect(page.getByRole("heading", { level: 1, name: ITEMS.runTop.name })).toBeVisible()
  await expect(headerBadge(page, "Running gear")).toBeVisible()
  await page.getByRole("link", { name: "Back to wardrobe" }).click()
  await expectQuery(page, `?collection=running&q=${TOKEN}`)
  await expect(viewSwitch(page).getByRole("button", { name: "Running" })).toHaveAttribute("aria-pressed", "true")
  await expectCards(page, RUNNING)

  // Clothes again drops the parameter.
  await viewSwitch(page).getByRole("button", { name: "Clothes" }).click()
  await expectQuery(page, `?q=${TOKEN}`)
  await expectCards(page, CLOTHING)
})

test("the item page's Running gear switch moves the boots, saved at once and shown after a reload", async ({ page }) => {
  await signIn(page, `/wardrobe/${ids.shoes}`)
  await expect(page.getByRole("heading", { level: 1, name: ITEMS.shoes.name })).toBeVisible()
  const toggle = page.getByRole("switch", { name: "Running gear" })
  await expect(toggle).toHaveAttribute("aria-checked", "false")
  await expect(headerBadge(page, "Running gear")).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  await expect.poll(() => collectionOf(ids.shoes)).toBe("running")

  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: ITEMS.shoes.name })).toBeVisible()
  await expect(page.getByRole("switch", { name: "Running gear" })).toHaveAttribute("aria-checked", "true")
  await expect(headerBadge(page, "Running gear")).toBeVisible()

  // The Clothes view no longer lists the boots; the Running view does.
  await page.goto(SCOPED)
  await expectCards(page, ["top", "bottom"])
  await page.goto(`/wardrobe?collection=running&q=${TOKEN}`)
  await expectCards(page, ["shoes", ...RUNNING])
})

test("the outfit builder's pickers never offer running gear", async ({ page }) => {
  await signIn(page, "/outfits/new")
  await expect(page.getByRole("heading", { level: 1, name: "New outfit" })).toBeVisible()
  const dialog = page.getByRole("dialog")

  // The top slot offers the clothing top, not the running shirt.
  await page.getByRole("button", { name: "Choose top or dress" }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Search").fill(TOKEN)
  await expect(dialog.getByRole("button", { name: new RegExp(ITEMS.top.name) })).toBeVisible()
  await expect(dialog.getByRole("button", { name: new RegExp(ITEMS.runTop.name) })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()

  // Both pairs of shoes are running gear now: the shoes slot offers neither.
  await page.getByRole("button", { name: "Choose shoes" }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Search").fill(TOKEN)
  await expect(dialog.getByRole("status")).toHaveText(/^(No items match “Runspec”\.|You have no items for this slot yet\.)$/)
  await expect(dialog.getByRole("button", { name: new RegExp(TOKEN) })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})

test("a saved outfit holding the moved boots flags them, and neither Save nor a wear goes through", async ({ page }) => {
  await signIn(page, `/outfits/${outfitId}`)
  await expect(page.getByRole("heading", { level: 1, name: OUTFIT_NAME })).toBeVisible()
  const shoesSlot = page.getByRole("group", { name: "Shoes" })
  await expect(shoesSlot).toContainText(ITEMS.shoes.name)
  await expect(shoesSlot.getByText("Running gear", { exact: true })).toBeVisible()
  await expect(page.getByRole("group", { name: "Top or dress" }).getByText("Running gear", { exact: true })).toHaveCount(0)

  // Save names the problem at the shoes slot and changes nothing.
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(shoesSlot).toContainText(NOT_CLOTHING)
  const stored = await db.select({ itemId: outfitItems.itemId }).from(outfitItems).where(eq(outfitItems.outfitId, outfitId))
  expect(stored.map((row) => row.itemId).sort()).toEqual([ids.top, ids.bottom, ids.shoes].sort())

  // "Wore this today" is refused, and no wear is written for any of its items.
  await page.getByRole("button", { name: "Wore this today" }).click()
  await expect(page.locator('[data-slot="toast"]').filter({ hasText: WEAR_REFUSED })).toBeVisible()
  await expect(page.locator('[data-slot="toast"]').filter({ hasText: "Logged as worn" })).toHaveCount(0)
  const logs = await db.select({ id: wearLogs.id }).from(wearLogs).where(inArray(wearLogs.itemId, createdItemIds))
  expect(logs).toHaveLength(0)
  const outfitLogs = await db.select({ id: wearLogs.id }).from(wearLogs).where(eq(wearLogs.outfitId, outfitId))
  expect(outfitLogs).toHaveLength(0)
  expect(await wearCount(ids.top)).toBe(0)
  expect(await wearCount(ids.shoes)).toBe(0)
})

test("+1 worn today counts a piece of running gear, and Undo takes it back", async ({ page }) => {
  await signIn(page, `/wardrobe/${ids.runShoes}`)
  await expect(page.getByRole("heading", { level: 1, name: ITEMS.runShoes.name })).toBeVisible()
  await expect(wornValue(page)).toHaveText("Never")

  await page.getByRole("button", { name: "+1 worn today" }).click()
  await expect(wornValue(page)).toHaveText("Once")
  await expect.poll(() => wearCount(ids.runShoes)).toBe(1)

  await page.getByRole("button", { name: "Undo" }).click()
  await expect(wornValue(page)).toHaveText("Never")
  await expect.poll(() => wearCount(ids.runShoes)).toBe(0)
  const logs = await db.select({ id: wearLogs.id }).from(wearLogs).where(eq(wearLogs.itemId, ids.runShoes))
  expect(logs).toHaveLength(0)
})

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("the Running view fits: the switch is fully shown and nothing scrolls sideways", async ({ page }) => {
    await signIn(page, "/wardrobe")
    await page.goto("/wardrobe?collection=running")
    await expect(page.getByRole("list", { name: "Items" })).toBeVisible()
    const show = viewSwitch(page)
    await expect(show).toBeInViewport({ ratio: 1 })
    for (const name of ["Clothes", "Running"]) {
      await expect(show.getByRole("button", { name })).toBeInViewport({ ratio: 1 })
    }
    await expect(show.getByRole("button", { name: "Running" })).toHaveAttribute("aria-pressed", "true")
    await expectNoHorizontalScroll(page)
    await page.screenshot({ path: test.info().outputPath("running-390.png"), fullPage: true })
  })
})
