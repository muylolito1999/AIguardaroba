import { expect, test, type Locator, type Page } from "@playwright/test"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { climateProfiles, type ClimateProfile } from "@/lib/db/schema"

import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// /settings/climate against the production build and the seeded profiles:
// filling in every Bologna month clears its placeholder mark, and the default
// moves to Bologna and back to Hamburg. The Bologna row (and which profile is
// the default) is read before the tests and written back exactly in afterAll,
// so later specs see the seed's placeholder again.

const PHONE = { width: 390, height: 844 }

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

// Plausible values for the test only (max, min, mean °C, rain mm, rain days, sun h); afterAll restores the seed.
const VALUES: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [6.5, -0.5, 3, 45, 6, 85],
  [9, 0.5, 4.7, 50, 6, 110],
  [14, 4, 9, 60, 7, 150],
  [18, 8, 13, 70, 8, 180],
  [23, 12, 17.5, 65, 8, 230],
  [28, 16, 22, 50, 6, 270],
  [31, 18, 24.5, 35, 4, 310],
  [30, 18, 24, 50, 5, 280],
  [25, 14, 19.5, 65, 6, 200],
  [19, 10, 14.5, 85, 8, 140],
  [12, 5, 8.5, 80, 8, 80],
  [7, 0.5, 3.8, 55, 6, 70],
]
const FIELDS = ["max °C", "min °C", "mean °C", "rain mm", "rain days", "sun hours"]

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
let savedBologna: ClimateProfile | undefined
let savedDefaultIds: string[] = []

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?next=%2Fsettings%2Fclimate")
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/settings/climate")
}

function card(page: Page, city: string): Locator {
  return page.getByRole("region", { name: city, exact: true })
}

/** True when the first card is shown above the second. */
async function isAbove(first: Locator, second: Locator): Promise<boolean> {
  const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()])
  if (a === null || b === null) throw new Error("a card is not visible")
  return a.y < b.y
}

/** The page must never scroll sideways at phone width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test.beforeAll(async () => {
  const [bologna] = await db.select().from(climateProfiles).where(eq(climateProfiles.slug, "bologna"))
  if (bologna === undefined) throw new Error("The e2e database has no Bologna profile; the global setup seeds it.")
  savedBologna = bologna
  const defaults = await db.select({ id: climateProfiles.id }).from(climateProfiles).where(eq(climateProfiles.isDefault, true))
  savedDefaultIds = defaults.map((row) => row.id)
})

test.afterAll(async () => {
  try {
    if (savedBologna !== undefined) {
      const { id, ...fields } = savedBologna
      await db.transaction(async (tx) => {
        // The partial unique index allows one default: clear every flag before restoring.
        await tx.update(climateProfiles).set({ isDefault: false }).where(eq(climateProfiles.isDefault, true))
        // Every column as it was, updated_at included (an explicit value wins over $onUpdate).
        await tx.update(climateProfiles).set(fields).where(eq(climateProfiles.id, id))
        if (savedDefaultIds.length > 0) {
          await tx.update(climateProfiles).set({ isDefault: true }).where(inArray(climateProfiles.id, savedDefaultIds))
        }
      })
    }
  } finally {
    await pool.end()
  }
})

test("Settings links to the climate profiles", async ({ page }) => {
  await signIn(page)
  await page.goto("/settings")
  await page.getByRole("link", { name: "Climate profiles" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/settings/climate")
  await expect(page.getByRole("heading", { level: 1, name: "Climate profiles" })).toBeVisible()
  await expect(card(page, "Hamburg")).toContainText("Running pnpm db:seed restores these reference values")
})

test("filling in every Bologna month clears its placeholder mark", async ({ page }) => {
  await page.setViewportSize(PHONE)
  await signIn(page)
  const bologna = card(page, "Bologna")
  await expect(bologna.getByText("Placeholder", { exact: true })).toBeVisible()
  const save = bologna.getByRole("button", { name: "Save" })
  await expect(save).toBeDisabled()

  for (const [index, month] of MONTHS.entries()) {
    const row = VALUES[index]
    if (row === undefined) throw new Error(`no values for ${month}`)
    for (const [position, field] of FIELDS.entries()) {
      await bologna.getByLabel(`${month} ${field}`, { exact: true }).fill(String(row[position]))
    }
  }
  await expectNoHorizontalScroll(page)
  // The table is wider than a phone and scrolls inside its own container instead.
  const table = bologna.locator("table")
  const scrolls = await table.evaluate((element) => {
    const container = element.parentElement
    return container !== null && container.scrollWidth > container.clientWidth
  })
  expect(scrolls).toBe(true)

  await expect(save).toBeEnabled()
  await save.click()
  await expect(bologna.getByText("Placeholder", { exact: true })).toHaveCount(0)
  await expect(save).toBeDisabled()

  await page.reload()
  const reloaded = card(page, "Bologna")
  await expect(reloaded.getByLabel("July rain days", { exact: true })).toHaveValue("4")
  await expect(reloaded.getByText("Placeholder", { exact: true })).toHaveCount(0)
  await expectNoHorizontalScroll(page)
})

test("an invalid row is explained and not saved", async ({ page }) => {
  await signIn(page)
  const hamburg = card(page, "Hamburg")
  const min = hamburg.getByLabel("March min °C", { exact: true })
  await min.fill("20")
  await min.blur()
  await expect(hamburg.getByText("Temperatures must go Min ≤ Mean ≤ Max.")).toBeVisible()
  await hamburg.getByRole("button", { name: "Save" }).click()
  await expect(hamburg.getByRole("alert")).toHaveText("One month needs fixing before this can be saved.")

  await page.reload()
  await expect(card(page, "Hamburg").getByLabel("March min °C", { exact: true })).toHaveValue("1.1")
})

test("Bologna becomes the default, then Hamburg again", async ({ page }) => {
  await signIn(page)
  const bologna = card(page, "Bologna")
  const hamburg = card(page, "Hamburg")
  await expect(hamburg.getByText("Default", { exact: true })).toBeVisible()
  await expect(bologna.getByText(/Running pnpm db:seed makes Hamburg the default again/)).toBeVisible()

  await bologna.getByRole("button", { name: "Set as default" }).click()
  await expect(bologna.getByText("Default", { exact: true })).toBeVisible()
  await expect(hamburg.getByText("Default", { exact: true })).toHaveCount(0)

  await page.reload()
  await expect(card(page, "Bologna").getByText("Default", { exact: true })).toBeVisible()
  // The default is listed first.
  expect(await isAbove(card(page, "Bologna"), card(page, "Hamburg"))).toBe(true)

  await card(page, "Hamburg").getByRole("button", { name: "Set as default" }).click()
  await expect(card(page, "Hamburg").getByText("Default", { exact: true })).toBeVisible()
  await page.reload()
  await expect(card(page, "Bologna").getByRole("button", { name: "Set as default" })).toBeVisible()
  expect(await isAbove(card(page, "Hamburg"), card(page, "Bologna"))).toBe(true)
})
