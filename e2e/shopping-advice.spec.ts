import { expect, test, type Page } from "@playwright/test"
import { like } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { shoppingListItems } from "@/lib/db/schema"

import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// "What to buy next" with FEATURE_SHOPPING_AI off, as the e2e server always
// runs (playwright.config.ts leaves the variable blank): /shopping shows the
// list but not the section, even with an open entry it could rank; the route
// answers 404 like a route that does not exist; Settings says the feature is
// off. No Claude call is possible here. The entry this spec adds (found by the
// "E2E advicespec" prefix) is deleted in afterAll.

const PREFIX = "E2E advicespec"
const ENTRY = `${PREFIX} waterproof rain shell`
const PHONE = { width: 390, height: 844 }

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })

async function signIn(page: Page, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === next)
}

test.beforeAll(async () => {
  await db.insert(shoppingListItems).values({ itemType: ENTRY, category: "outerwear", priority: 1, estPriceMinEur: 120 })
})

test.afterAll(async () => {
  try {
    await db.delete(shoppingListItems).where(like(shoppingListItems.itemType, `${PREFIX}%`))
  } finally {
    await pool.end()
  }
})

test("with the flag off, /shopping has no What to buy next and the route answers 404", async ({ page, baseURL }) => {
  await page.setViewportSize(PHONE)
  await signIn(page, "/shopping")
  // A fresh load waits for the whole streamed page, both Suspense boundaries included.
  await page.goto("/shopping", { waitUntil: "load" })
  await expect(page.getByRole("listitem", { name: ENTRY, exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "What to buy next" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /^Rank \d+ purchases?$|^Run again$/ })).toHaveCount(0)

  const origin = new URL(baseURL ?? "http://localhost:3000").origin
  for (const data of [{}, { force: true }]) {
    const response = await page.request.post("/api/shopping/advice", { data, headers: { origin } })
    expect(response.status()).toBe(404)
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Shopping advice is turned off." },
    })
  }
})

test("Settings shows Shopping advice as off and how to turn it on", async ({ page }) => {
  await page.setViewportSize(PHONE)
  await signIn(page, "/settings")
  const features = page.getByRole("region", { name: "Features" })
  await expect(features.getByText("Shopping advice", { exact: true })).toBeVisible()
  await expect(features.getByText("Off", { exact: true })).toBeVisible()
  await expect(features.getByText(/set FEATURE_SHOPPING_AI to true in the server environment/)).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
