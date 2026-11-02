import { expect, test, type Page } from "@playwright/test"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { items, type NewItem } from "@/lib/db/schema"

import { makeImage, makeItem, makeTaggedItem } from "../test/factories"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// The /wardrobe grid against the production build. Thirty items are inserted
// straight into wardrobe_e2e, all findable by the made-up brand "Wardspec"
// (the pending one through its notes), so searching for it scopes every count
// to this spec's rows whatever other specs left behind. Photos point at a
// static icon the app serves itself. Every row is deleted again in afterAll.

const TOKEN = "wardspec"
const SCOPED = `/wardrobe?q=${TOKEN}`

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []

/** Newest first: each row is a minute older than the one before. */
let minutesAgo = 0
function created(): Date {
  minutesAgo += 1
  return new Date(Date.now() - minutesAgo * 60_000)
}

type Spec = Partial<NewItem> & { name: string }

function row(name: string, fields: Partial<NewItem>): Spec {
  return { brand: "Wardspec", ...fields, name }
}

// 29 visible by default (the archived one is hidden): outerwear 8, shoes 6,
// top 8, scarf 4, bottom 2, untagged 1. Waterproof: 3 shells and 2 boots.
const TAGGED: Spec[] = [
  row("Wardspec down parka", { category: "outerwear", subcategory: "parka", warmthLevel: 5, waterproof: false }),
  ...["A", "B", "C"].map((letter) =>
    row(`Wardspec rain shell ${letter}`, {
      category: "outerwear",
      subcategory: "rain jacket",
      warmthLevel: 2,
      waterproof: true,
      seasons: ["spring", "autumn"],
    })
  ),
  ...[1, 2, 3, 4].map((index) =>
    row(`Wardspec wool coat ${index}`, { category: "outerwear", warmthLevel: 4, waterproof: false, wearCount: index })
  ),
  ...[1, 2].map((index) =>
    row(`Wardspec rain boots ${index}`, {
      category: "shoes",
      subcategory: "boots",
      warmthLevel: 3,
      waterproof: true,
      colors: ["black"],
      colorHex: ["#111111"],
    })
  ),
  ...[1, 2, 3, 4].map((index) =>
    row(`Wardspec sneakers ${index}`, {
      category: "shoes",
      subcategory: "sneakers",
      warmthLevel: 1,
      waterproof: false,
      windproof: false,
      seasons: ["summer"],
    })
  ),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((index) =>
    row(`Wardspec tee ${index}`, {
      category: "top",
      subcategory: "t-shirt",
      warmthLevel: 1,
      waterproof: false,
      windproof: false,
      insulated: false,
      seasons: ["summer"],
      formality: "casual",
    })
  ),
  ...[1, 2, 3, 4].map((index) =>
    row(`Wardspec scarf ${index}`, { category: "scarf", subcategory: "scarf", warmthLevel: 3, waterproof: false })
  ),
  ...[1, 2].map((index) =>
    row(`Wardspec jeans ${index}`, { category: "bottom", subcategory: "jeans", warmthLevel: 2, waterproof: false })
  ),
  row("Wardspec archived coat", { category: "outerwear", status: "archived", waterproof: true }),
]

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?next=%2Fwardrobe")
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/wardrobe")
}

function resultCount(page: Page) {
  return page.getByRole("status").filter({ hasText: /^\d[\d,]* items?$/ })
}

function grid(page: Page) {
  return page.getByRole("list", { name: "Items" })
}

function cards(page: Page) {
  return grid(page).getByRole("link")
}

/** Waits for the URL to carry exactly these parameters, in this order. */
async function expectQuery(page: Page, query: string): Promise<void> {
  await expect(page).toHaveURL((url) => url.pathname === "/wardrobe" && url.search === query)
}

/** The page must never scroll sideways at phone width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test.beforeAll(async ({ baseURL }) => {
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  const photoRow = { blobUrl: photo, contentType: "image/png", width: 192, height: 192, bytes: 4_000 }

  const rows = []
  for (const spec of TAGGED) {
    rows.push(await makeTaggedItem(db, { status: "confirmed", createdAt: created(), ...spec }))
  }
  // Waiting for tags: no name, no category, found through its notes.
  rows.push(await makeItem(db, { notes: `${TOKEN} photo from the hall cupboard`, createdAt: created() }))
  for (const item of rows) {
    await makeImage(db, item.id, { kind: "thumb", blobPathname: `e2e/${item.id}/thumb`, ...photoRow })
    await makeImage(db, item.id, { kind: "processed", blobPathname: `e2e/${item.id}/processed`, ...photoRow })
    createdItemIds.push(item.id)
  }
})

test.afterAll(async () => {
  try {
    // Image rows cascade.
    if (createdItemIds.length > 0) await db.delete(items).where(inArray(items.id, createdItemIds))
  } finally {
    await pool.end()
  }
})

test("the chips count the search's items per category, and a chip filters by category", async ({ page }) => {
  await signIn(page)
  await page.goto(SCOPED)
  await expect(resultCount(page)).toHaveText("29 items")
  await expect(cards(page).first()).toBeVisible()

  const chips = page.getByRole("group", { name: "Category" })
  await expect(chips.getByRole("button", { name: "All, 29 items" })).toHaveAttribute("aria-pressed", "true")
  await expect(chips.getByRole("button", { name: "Outerwear, 8 items" })).toBeVisible()
  await expect(chips.getByRole("button", { name: "Shoes, 6 items" })).toBeVisible()
  await expect(chips.getByRole("button", { name: "Top, 8 items" })).toBeAttached()
  await expect(chips.getByRole("button", { name: "Scarf, 4 items" })).toBeAttached()
  await expect(chips.getByRole("button", { name: "Bottom, 2 items" })).toBeAttached()
  await expect(chips.getByRole("button", { name: "Untagged, 1 item" })).toBeAttached()

  await chips.getByRole("button", { name: "Shoes, 6 items" }).click()
  await expectQuery(page, `?q=${TOKEN}&category=shoes`)
  await expect(resultCount(page)).toHaveText("6 items")
  await expect(cards(page)).toHaveCount(6)
  // The counts ignore the category filter, so the other chips keep theirs.
  await expect(chips.getByRole("button", { name: "Outerwear, 8 items" })).toHaveAttribute("aria-pressed", "false")
  await expect(chips.getByRole("button", { name: "Shoes, 6 items" })).toHaveAttribute("aria-pressed", "true")

  // Untagged stands for the items still waiting for tags.
  await chips.getByRole("button", { name: "Untagged, 1 item" }).click()
  await expectQuery(page, `?q=${TOKEN}&status=pending_tagging`)
  await expect(resultCount(page)).toHaveText("1 item")
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).first()).toHaveAccessibleName("Untagged item")
  // The other badges still count what their chip would show: All and the
  // categories go back to the usual statuses.
  await expect(chips.getByRole("button", { name: "All, 29 items" })).toHaveAttribute("aria-pressed", "false")
  await expect(chips.getByRole("button", { name: "Shoes, 6 items" })).toBeAttached()
  await expect(chips.getByRole("button", { name: "Untagged, 1 item" })).toHaveAttribute("aria-pressed", "true")
})

test("search narrows the grid and its count", async ({ page }) => {
  await signIn(page)
  await page.goto(SCOPED)
  await expect(resultCount(page)).toHaveText("29 items")

  const search = page.getByRole("searchbox", { name: "Search your wardrobe" })
  await search.fill(`${TOKEN} rain`)
  await expectQuery(page, `?q=${TOKEN}+rain`)
  // Three shells and two pairs of boots.
  await expect(resultCount(page)).toHaveText("5 items")
  await expect(cards(page)).toHaveCount(5)
  await expect(search).toHaveValue(`${TOKEN} rain`)

  // Escape clears the search at once.
  await search.press("Escape")
  await expectQuery(page, "")
  await expect(search).toHaveValue("")
})

test("sorting by warmth puts the parka first", async ({ page }) => {
  await signIn(page)
  await page.goto(SCOPED)
  await expect(resultCount(page)).toHaveText("29 items")

  await page.getByRole("combobox", { name: "Sort" }).selectOption({ label: "Warmest first" })
  await expectQuery(page, `?q=${TOKEN}&sort=warmth_desc`)
  await expect(cards(page).first()).toHaveAccessibleName("Wardspec down parka Outerwear")

  await page.getByRole("combobox", { name: "Sort" }).selectOption({ label: "Most worn first" })
  await expectQuery(page, `?q=${TOKEN}&sort=wear_desc`)
  await expect(cards(page).first()).toHaveAccessibleName("Wardspec wool coat 4 Outerwear")
})

test("the filter panel filters, and Back from an item restores the filtered list", async ({ page }) => {
  await signIn(page)
  await page.goto(SCOPED)
  await expect(resultCount(page)).toHaveText("29 items")

  const filtersButton = page.getByRole("button", { name: /^Filters/ })
  await filtersButton.click()
  const panel = page.getByRole("dialog", { name: "Filters" })
  await expect(panel).toBeVisible()
  await panel.getByRole("group", { name: "Waterproof" }).getByRole("button", { name: "Yes" }).click()
  await expectQuery(page, `?q=${TOKEN}&waterproof=true`)
  await panel.getByRole("button", { name: "Show 5 items" }).click()
  await expect(panel).toBeHidden()
  // Focus goes back to the button that opened the panel.
  await expect(page.getByRole("button", { name: "Filters, 1 active" })).toBeFocused()
  await expect(resultCount(page)).toHaveText("5 items")
  const hrefs = await cards(page).evaluateAll((links) => links.map((link) => link.getAttribute("href")))
  expect(hrefs).toHaveLength(5)

  // Opening a card lands on its page.
  const first = cards(page).first()
  const href = await first.getAttribute("href")
  expect(href).toMatch(/^\/wardrobe\/[0-9a-f-]{36}$/)
  await first.click()
  await expect(page).toHaveURL((url) => url.pathname === href)

  // Back returns to the same filtered URL and the same results.
  await page.goBack()
  await expectQuery(page, `?q=${TOKEN}&waterproof=true`)
  await expect(resultCount(page)).toHaveText("5 items")
  await expect(page.getByRole("button", { name: "Filters, 1 active" })).toBeVisible()
  expect(await cards(page).evaluateAll((links) => links.map((link) => link.getAttribute("href")))).toEqual(hrefs)
})

test("going back after a change on the detail page shows the list read again", async ({ page }) => {
  await signIn(page)
  await page.goto(`${SCOPED}&waterproof=true`)
  await expect(resultCount(page)).toHaveText("5 items")
  const shell = cards(page).filter({ hasText: "Wardspec rain shell A" })
  const href = await shell.getAttribute("href")
  expect(href).toMatch(/^\/wardrobe\/[0-9a-f-]{36}$/)
  const id = (href ?? "").split("/").pop() ?? ""

  // Archive on the detail page, then the page's own back link (history back).
  await shell.click()
  await expect(page).toHaveURL((url) => url.pathname === href)
  await page.getByRole("button", { name: "Archive", exact: true }).click()
  await expect(page.getByRole("button", { name: "Unarchive" })).toBeVisible()
  await page.getByRole("link", { name: "Back to wardrobe" }).click()
  await expectQuery(page, `?q=${TOKEN}&waterproof=true`)
  // The list Next kept from before the change reads itself again (D-107).
  await expect(resultCount(page)).toHaveText("4 items")
  await expect(cards(page).filter({ hasText: "Wardspec rain shell A" })).toHaveCount(0)

  // Unarchive after Forward, then the browser's Back.
  await page.goForward()
  await expect(page).toHaveURL((url) => url.pathname === href)
  await page.getByRole("button", { name: "Unarchive" }).click()
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible()
  await page.goBack()
  await expectQuery(page, `?q=${TOKEN}&waterproof=true`)
  await expect(resultCount(page)).toHaveText("5 items")
  await expect(cards(page).filter({ hasText: "Wardspec rain shell A" })).toHaveCount(1)
  expect((await db.select({ status: items.status }).from(items).where(eq(items.id, id)))[0]?.status).toBe("confirmed")
})

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("the grid has two columns and the page never scrolls sideways", async ({ page }) => {
    await signIn(page)
    await page.goto(SCOPED)
    await expect(resultCount(page)).toHaveText("29 items")
    await expect(page.locator("[data-columns]")).toHaveAttribute("data-columns", "2")

    const boxes = await cards(page).evaluateAll((links) =>
      links.slice(0, 3).map((link) => {
        const rect = link.getBoundingClientRect()
        return { top: Math.round(rect.top), left: Math.round(rect.left) }
      })
    )
    const [one, two, three] = boxes
    expect(one?.top).toBe(two?.top)
    expect(two?.left ?? 0).toBeGreaterThan(one?.left ?? 0)
    expect(three?.top ?? 0).toBeGreaterThan(one?.top ?? 0)
    expect(three?.left).toBe(one?.left)

    await expectNoHorizontalScroll(page)
    // The chip row scrolls inside its own box.
    await page.getByRole("group", { name: "Category" }).getByRole("button", { name: /^Untagged/ }).scrollIntoViewIfNeeded()
    await expectNoHorizontalScroll(page)
  })
})
