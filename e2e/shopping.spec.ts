import { expect, test, type Locator, type Page } from "@playwright/test"
import { inArray, like } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { items, shoppingListItems } from "@/lib/db/schema"

import { makeImage, makeTaggedItem } from "../test/factories"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// /shopping against the production build: an entry added by hand, its status
// saved at once and kept after a reload, an owned item linked through the
// search picker, and the entry deleted again. The owned item is inserted
// straight into wardrobe_e2e with a photo the app serves itself. Every row
// this spec makes (found by its item and the "E2E shopspec" prefix) is
// deleted in afterAll.

const PREFIX = "E2E shopspec"
const ENTRY = `${PREFIX} insulated rain boots`
const OWNED = "E2E shopspec merino base layer"
const PHONE = { width: 390, height: 844 }

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?next=%2Fshopping")
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/shopping")
}

/** The page must never scroll sideways at phone width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

function entry(page: Page): Locator {
  return page.getByRole("listitem", { name: ENTRY, exact: true })
}

test.beforeAll(async ({ baseURL }) => {
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  const owned = await makeTaggedItem(db, {
    status: "confirmed",
    name: OWNED,
    category: "base_layer",
    subcategory: "thermal top",
    materials: ["merino wool"],
  })
  await makeImage(db, owned.id, {
    kind: "thumb",
    blobUrl: photo,
    blobPathname: `e2e/${owned.id}/thumb`,
    contentType: "image/png",
    width: 192,
    height: 192,
    bytes: 4_000,
  })
  createdItemIds.push(owned.id)
})

test.afterAll(async () => {
  try {
    await db.delete(shoppingListItems).where(like(shoppingListItems.itemType, `${PREFIX}%`))
    // Image rows cascade; a link from a leftover entry is set to null.
    if (createdItemIds.length > 0) await db.delete(items).where(inArray(items.id, createdItemIds))
  } finally {
    await pool.end()
  }
})

test("an entry added by hand keeps its status, links an owned item and can be deleted", async ({ page }) => {
  await page.setViewportSize(PHONE)
  await signIn(page)
  await expect(page.getByRole("heading", { level: 1, name: "Shopping" })).toBeVisible()

  // Add by hand.
  await page.getByRole("button", { name: "Add item" }).click()
  await expect(page.getByLabel("What to buy", { exact: true })).toBeFocused()
  await page.getByLabel("What to buy", { exact: true }).fill(ENTRY)
  await page.getByLabel("Category", { exact: true }).selectOption("shoes")
  await page.getByLabel("Priority", { exact: true }).selectOption({ label: "Must have" })
  await page.getByLabel("Quantity", { exact: true }).fill("2")
  await page.getByLabel("Lowest price (€)", { exact: true }).fill("80")
  await page.getByLabel("Highest price (€)", { exact: true }).fill("120")
  await page.getByLabel("When to buy", { exact: true }).selectOption("after_move")
  await page.getByLabel("Specs", { exact: true }).fill("insulated\ngrippy sole")
  await page.getByRole("button", { name: "Add to list" }).click()

  await expect(entry(page)).toBeVisible()
  await expect(entry(page)).toContainText("€80–€120 each")
  await expect(entry(page)).toContainText("Buy after the move")
  await expect(entry(page).getByRole("list", { name: `Specs for ${ENTRY}` })).toContainText("grippy sole")
  await expectNoHorizontalScroll(page)

  // The status is saved at once and survives a reload.
  const status = entry(page).getByRole("group", { name: `Status of ${ENTRY}` })
  await status.getByRole("button", { name: "Bought" }).click()
  await expect(status.getByRole("button", { name: "Bought" })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByText(`Saving the status of ${ENTRY}…`)).toHaveCount(0)
  await page.reload()
  await expect(
    entry(page).getByRole("group", { name: `Status of ${ENTRY}` }).getByRole("button", { name: "Bought" })
  ).toHaveAttribute("aria-pressed", "true")

  // Link an owned item through the search picker.
  await entry(page).getByRole("button", { name: "Link to an item I own" }).click()
  // By name: the "Linked" toast is a dialog too.
  const dialog = page.getByRole("dialog", { name: `Link ${ENTRY} to an item you own` })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Search your items", { exact: true }).fill("shopspec merino")
  const result = dialog.getByRole("list", { name: "Your items" }).getByRole("button", { name: new RegExp(OWNED) })
  await expect(result).toHaveCount(1)
  await expect(result.locator("img")).toHaveAttribute("src", /icon-192\.png$/)
  await result.click()
  await expect(dialog).toBeHidden()
  await expect(entry(page).getByRole("link", { name: OWNED })).toBeVisible()
  await page.reload()
  await expect(entry(page).getByRole("link", { name: OWNED })).toBeVisible()
  await expectNoHorizontalScroll(page)

  // Delete, after confirming.
  await entry(page).getByRole("button", { name: `Delete ${ENTRY}` }).click()
  const confirm = page.getByRole("alertdialog")
  await expect(confirm).toContainText(`Delete ${ENTRY}?`)
  await confirm.getByRole("button", { name: "Delete" }).click()
  await expect(entry(page)).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: "Shopping" })).toBeVisible()
  await expect(entry(page)).toHaveCount(0)
})
