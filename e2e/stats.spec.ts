import { expect, test, type Locator, type Page } from "@playwright/test"
import { and, eq, inArray, notInArray, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import type { ItemStatus } from "@/lib/db/enums"
import { relations } from "@/lib/db/relations"
import { items, type NewItem } from "@/lib/db/schema"

import { makeItem, makeTaggedItem } from "../test/factories"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// /stats against items inserted straight into wardrobe_e2e. The seed meets
// three of the six winter rules (shell, scarf, beanie) and nearly meets the
// other three: boots that are not insulated, gloves that are not windproof
// plus windproof gloves marked Donate, and one merino base layer of the two
// needed. A pending and an archived item check the scoping. A piece of
// running gear (a thermal base layer, insulated) has its own tile, stays out
// of the Items tile and every breakdown, and still counts for the winter
// checklist, where it is the second base layer (D-249). Totals are read back
// from the database, since another spec may have left pending or archived
// rows; every row this spec adds is deleted in afterAll.

const SHELL = "E2E stats rain shell"
const SCARF = "E2E stats wool scarf"
const BEANIE = "E2E stats beanie"
const BOOTS = "E2E stats rubber boots"
const KNITTED_GLOVES = "E2E stats knitted gloves"
const DONATED_GLOVES = "E2E stats donated shell gloves"
const MERINO = "E2E stats merino top"
const ARCHIVED_GLOVES = "E2E stats archived gloves"
const RUNNING_BASE = "E2E stats running thermal top"

const NO_FLAGS = { waterproof: false, windproof: false, insulated: false } satisfies Partial<NewItem>

// Tagged or confirmed: the base of every tag-based number on the page.
// The factory's defaults are a wool coat (windproof, insulated, wool), so
// every seed sets its category, warmth, flags and materials itself.
const TAGGED_SEED: ReadonlyArray<Partial<NewItem> & { name: string }> = [
  {
    name: SHELL,
    status: "confirmed",
    category: "outerwear",
    subcategory: "rain jacket",
    materials: ["polyester"],
    warmthLevel: 3,
    ...NO_FLAGS,
    waterproof: true,
    windproof: true,
    decision: "bring",
  },
  {
    name: SCARF,
    status: "tagged",
    category: "scarf",
    subcategory: "scarf",
    materials: ["wool"],
    warmthLevel: 3,
    ...NO_FLAGS,
  },
  {
    name: BEANIE,
    status: "confirmed",
    category: "hat_beanie",
    subcategory: "beanie",
    materials: ["acrylic"],
    warmthLevel: 4,
    ...NO_FLAGS,
    insulated: true,
  },
  {
    name: BOOTS,
    status: "confirmed",
    category: "shoes",
    subcategory: "rain boots",
    materials: ["rubber"],
    warmthLevel: 2,
    ...NO_FLAGS,
    waterproof: true,
  },
  {
    name: KNITTED_GLOVES,
    status: "tagged",
    category: "gloves",
    subcategory: "knitted gloves",
    materials: ["acrylic"],
    warmthLevel: 3,
    ...NO_FLAGS,
  },
  {
    name: DONATED_GLOVES,
    status: "confirmed",
    category: "gloves",
    subcategory: "shell gloves",
    materials: ["polyester"],
    warmthLevel: 3,
    ...NO_FLAGS,
    windproof: true,
    decision: "donate",
  },
  {
    name: MERINO,
    status: "confirmed",
    category: "base_layer",
    subcategory: "long-sleeve top",
    materials: ["merino"],
    warmthLevel: 2,
    ...NO_FLAGS,
  },
]

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []
const idByName = new Map<string, string>()

function idOf(name: string): string {
  const id = idByName.get(name)
  if (id === undefined) throw new Error(`${name} was not seeded`)
  return id
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`/login?${new URLSearchParams({ next: "/stats" })}`)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/stats")
}

/** The count printed in a bar table's row, found by its row header. */
function countCell(page: Page, table: string, rowHeader: string): Locator {
  return page
    .getByRole("table", { name: table })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: rowHeader, exact: true }) })
    .getByRole("cell")
}

/** One checklist entry, by its heading ("Scarf Ready", "Scarf Missing"). */
function readinessRow(page: Page, heading: string): Locator {
  return page
    .getByRole("region", { name: "Winter-ready checklist" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 3, name: heading, exact: true }) })
}

/** An overview tile's number, by its term. */
function tileValue(page: Page, term: string): Locator {
  return page
    .getByRole("region", { name: "Overview" })
    .locator("div")
    .filter({ has: page.locator("dt", { hasText: new RegExp(`^${term}$`) }) })
    .locator("dd")
}

/** The page must never scroll sideways at phone width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test.beforeAll(async () => {
  for (const seed of TAGGED_SEED) {
    const row = await makeTaggedItem(db, seed)
    createdItemIds.push(row.id)
    idByName.set(seed.name, row.id)
  }
  const pending = await makeItem(db)
  // Windproof gloves that would meet a rule if they were not archived.
  const archived = await makeTaggedItem(db, {
    name: ARCHIVED_GLOVES,
    status: "archived",
    category: "gloves",
    warmthLevel: 3,
    ...NO_FLAGS,
    windproof: true,
  })
  // Running gear: insulated and a base layer, so a breakdown that counted it
  // would show it, while the checklist does count it (D-249).
  const running = await makeTaggedItem(db, {
    name: RUNNING_BASE,
    status: "confirmed",
    collection: "running",
    category: "base_layer",
    subcategory: "thermal running top",
    materials: ["polyester"],
    warmthLevel: 2,
    ...NO_FLAGS,
    insulated: true,
  })
  createdItemIds.push(pending.id, archived.id, running.id)
  idByName.set(ARCHIVED_GLOVES, archived.id)
  idByName.set(RUNNING_BASE, running.id)

  // The category, weather and checklist expectations below assume these are
  // the only tagged or confirmed items. Every other spec deletes its rows, and
  // global-setup empties the database before each run.
  const foreign = await db
    .select({ id: items.id, name: items.name })
    .from(items)
    .where(and(inArray(items.status, ["tagged", "confirmed"]), notInArray(items.id, createdItemIds)))
  expect(foreign, "another spec left tagged or confirmed items behind").toEqual([])
})

test.afterAll(async () => {
  try {
    if (createdItemIds.length > 0) await db.delete(items).where(inArray(items.id, createdItemIds))
  } finally {
    await pool.end()
  }
})

test("shows the counts and which winter rules are met, with evidence links", async ({ page }) => {
  const statusRows = await db
    .select({ status: items.status, collection: items.collection, count: sql<number>`count(*)`.mapWith(Number) })
    .from(items)
    .groupBy(items.status, items.collection)
  // The status tiles count clothes only; Archived counts every collection (D-249).
  const byStatus = (status: ItemStatus) =>
    statusRows.find((row) => row.status === status && row.collection === "clothing")?.count ?? 0
  const archived = statusRows.filter((row) => row.status === "archived").reduce((sum, row) => sum + row.count, 0)
  const running = statusRows
    .filter((row) => row.status !== "archived" && row.collection !== "clothing")
    .reduce((sum, row) => sum + row.count, 0)
  expect(running).toBeGreaterThanOrEqual(1)
  const pending = byStatus("pending_tagging")

  await signIn(page)
  await expect(page.getByRole("heading", { level: 1, name: "Stats" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Wardrobe" }).first()).toHaveAttribute("href", "/wardrobe")

  // Overview, from the database; archived items and running gear count only in their own tiles.
  await expect(tileValue(page, "Items")).toHaveText(String(byStatus("confirmed") + byStatus("tagged") + pending))
  await expect(tileValue(page, "Confirmed")).toHaveText(String(byStatus("confirmed")))
  await expect(tileValue(page, "Tagged, not confirmed")).toHaveText(String(byStatus("tagged")))
  await expect(tileValue(page, "Waiting for tags")).toHaveText(String(pending))
  await expect(tileValue(page, "Archived")).toHaveText(String(archived))
  await expect(tileValue(page, "Running gear")).toHaveText(String(running))
  const overview = page.getByRole("region", { name: "Overview" })
  await expect(overview.getByText(`${pending} ${pending === 1 ? "item is" : "items are"} waiting for tags`)).toBeVisible()
  await expect(overview.getByRole("link", { name: "Review untagged items" })).toHaveAttribute("href", "/add/review")

  // Tag-based numbers: the seven tagged or confirmed clothes only, not the
  // running base layer (insulated too).
  await expect(countCell(page, "By category", "Gloves")).toHaveText("2")
  await expect(countCell(page, "By category", "Outerwear")).toHaveText("1")
  await expect(countCell(page, "By category", "Base layer")).toHaveText("1")
  await expect(countCell(page, "By category", "Dress")).toHaveText("0")
  await expect(countCell(page, "Weather protection", "Waterproof")).toHaveText("2")
  await expect(countCell(page, "Weather protection", "Windproof")).toHaveText("2")
  await expect(countCell(page, "Weather protection", "Insulated")).toHaveText("1")
  await expect(page.getByRole("table", { name: "Warmth" }).getByRole("rowheader")).toHaveCount(5)

  // Four rules met, each linking the items that meet it.
  const checklist = page.getByRole("region", { name: "Winter-ready checklist" })
  await expect(checklist.getByText("4 of 6 ready")).toBeVisible()
  for (const [heading, name] of [
    ["Waterproof shell Ready", SHELL],
    ["Scarf Ready", SCARF],
    ["Warm beanie Ready", BEANIE],
  ] as const) {
    const row = readinessRow(page, heading)
    await expect(row).toBeVisible()
    await expect(row.getByRole("link", { name, exact: true })).toHaveAttribute("href", `/wardrobe/${idOf(name)}`)
    await expect(row.getByText("Needed:")).toHaveCount(0)
  }

  // The checklist counts running gear: the running thermal top is the second base layer (D-249).
  const baseLayers = readinessRow(page, "Merino or thermal base layers Ready")
  await expect(baseLayers).toBeVisible()
  await expect(baseLayers.getByText("Needed:")).toHaveCount(0)
  for (const name of [MERINO, RUNNING_BASE]) {
    await expect(baseLayers.getByRole("link", { name, exact: true })).toHaveAttribute("href", `/wardrobe/${idOf(name)}`)
  }

  // Two missing, each saying what is needed.
  await expect(readinessRow(page, "Insulated waterproof footwear Missing")).toContainText(
    "Needed: Shoes or boots that are both insulated and waterproof."
  )
  await expect(readinessRow(page, "Windproof gloves Missing")).toContainText("Needed: A pair of windproof gloves.")

  // Near misses, the donated gloves and the archived gloves are never evidence.
  for (const name of [BOOTS, KNITTED_GLOVES, DONATED_GLOVES, ARCHIVED_GLOVES]) {
    await expect(checklist.getByRole("link", { name, exact: true })).toHaveCount(0)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalScroll(page)
  await page.screenshot({ path: test.info().outputPath("stats-390.png"), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 900 })

  // An evidence link opens the item's detail page.
  await readinessRow(page, "Waterproof shell Ready").getByRole("link", { name: SHELL, exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === `/wardrobe/${idOf(SHELL)}`)
  await expect(page.getByRole("heading", { name: SHELL })).toBeVisible()

  // Marked Donate there, the shell stops counting once the owner goes back:
  // Next shows the stats page as it was, and it reads itself again (D-107).
  const plan = page.getByRole("group", { name: "Plan for the move" })
  await plan.getByRole("button", { name: "Donate" }).click()
  await expect(plan.getByRole("button", { name: "Donate" })).toHaveAttribute("aria-pressed", "true")
  await expect
    .poll(async () => (await db.select({ decision: items.decision }).from(items).where(eq(items.id, idOf(SHELL))))[0]?.decision)
    .toBe("donate")
  await page.goBack()
  await expect(page).toHaveURL((url) => url.pathname === "/stats")
  await expect(readinessRow(page, "Waterproof shell Missing")).toBeVisible()
  await expect(checklist.getByText("3 of 6 ready")).toBeVisible()
  await expect(checklist.getByRole("link", { name: SHELL, exact: true })).toHaveCount(0)
})
