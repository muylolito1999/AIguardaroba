import { expect, test, type Page } from "@playwright/test"
import { and, eq, gte, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { z } from "zod"

import { relations } from "@/lib/db/relations"
import {
  aiCalls,
  analyses,
  analysisParts,
  items,
  packingChecklistItems,
  shoppingListItems,
  type NewItem,
  type NewPackingChecklistItem,
} from "@/lib/db/schema"

import { makeImage, makeItem, makeTaggedItem } from "../test/factories"
import { makeRelocationResult } from "../test/relocation-fixtures"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"
import { NEEDS_NO_API_KEY, SHELL_TAGGING } from "./live-env"

// /relocate against the production build, without an Anthropic key. Twelve
// confirmed items, one waiting for tags, one archived and one confirmed piece
// of running gear (never analysed, D-249) are inserted straight into
// wardrobe_e2e. Run starts a real analysis, whose first part stops with
// the configuration error (no key); the spec then completes that analysis in
// the database with a fixture result and packing rows, exactly as if Claude
// had answered, so its cache key is the one the server computed for the
// form's default inputs. Every analysis this spec starts (parts and packing
// rows cascade), its shopping rows and its items are deleted in afterAll.

// With a real key the server would call Claude for every run started here.
test.skip(SHELL_TAGGING, NEEDS_NO_API_KEY)
test.describe.configure({ mode: "serial" })

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const startedAt = new Date()
const createdItemIds: string[] = []
const nameById = new Map<string, string>()

let analysisId = ""
let runningId = ""
/** Snapshot item ids in alias order (i1, i2, …), from the analysis the form started. */
let snapshotIds: string[] = []

const UUID_PATH = /^\/relocate\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const EXTRA = "E2E phone charger"

type Seed = Partial<NewItem> & { name: string }

const CONFIRMED: Seed[] = [
  { name: "Relospec navy parka", category: "outerwear", subcategory: "parka", warmthLevel: 5 },
  { name: "Relospec rain shell", category: "outerwear", subcategory: "rain jacket", warmthLevel: 2, waterproof: true },
  { name: "Relospec wool coat", category: "outerwear", subcategory: "coat", warmthLevel: 4 },
  { name: "Relospec merino sweater", category: "top", subcategory: "sweater", warmthLevel: 3, windproof: false, insulated: false },
  { name: "Relospec oxford shirt", category: "top", subcategory: "shirt", warmthLevel: 2, windproof: false, insulated: false },
  { name: "Relospec linen shirt", category: "top", subcategory: "shirt", warmthLevel: 1, windproof: false, insulated: false, seasons: ["summer"] },
  { name: "Relospec dark jeans", category: "bottom", subcategory: "jeans", warmthLevel: 2, windproof: false, insulated: false },
  { name: "Relospec chinos", category: "bottom", subcategory: "chinos", warmthLevel: 2, windproof: false, insulated: false },
  { name: "Relospec chelsea boots", category: "shoes", subcategory: "boots", warmthLevel: 3, insulated: false },
  { name: "Relospec canvas sneakers", category: "shoes", subcategory: "sneakers", warmthLevel: 1, windproof: false, insulated: false },
  { name: "Relospec cashmere scarf", category: "scarf", subcategory: "scarf", warmthLevel: 3, windproof: false, insulated: false },
  { name: "Relospec leather gloves", category: "gloves", subcategory: "gloves", warmthLevel: 3 },
]

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?next=%2Frelocate")
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/relocate")
}

/** The page must never scroll sideways at phone width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

function estimate(page: Page) {
  return page.getByRole("status").filter({ hasText: "≈" })
}

function configurationAlert(page: Page) {
  return page.getByRole("alert").filter({ hasText: "Configuration problem" })
}

async function decisionOf(id: string): Promise<string | undefined> {
  const [row] = await db.select({ decision: items.decision }).from(items).where(eq(items.id, id))
  return row?.decision
}

function nameOf(id: string | undefined): string {
  const name = id === undefined ? undefined : nameById.get(id)
  if (name === undefined) throw new Error(`No seeded item ${id}`)
  return name
}

const SnapshotSchema = z.object({ lines: z.array(z.object({ itemId: z.string() })) })

/**
 * Completes the run in the database as Claude would have: the fixture result
 * for the snapshot's items (AI decisions bring, bring, leave, donate, sell,
 * repeating; two gaps; every item packed once), its parts complete, and the
 * packing rows finalize would write.
 */
async function completeWithFixtureResult(id: string): Promise<string[]> {
  const [row] = await db.select({ inputSnapshot: analyses.inputSnapshot }).from(analyses).where(eq(analyses.id, id))
  const itemIds = SnapshotSchema.parse(row?.inputSnapshot).lines.map((line) => line.itemId)
  const result = makeRelocationResult(itemIds)
  const now = new Date()
  await db.update(analyses).set({ status: "complete", result, costUsd: 0.31, completedAt: now }).where(eq(analyses.id, id))
  await db
    .update(analysisParts)
    .set({ status: "complete", costUsd: 0.1, attempts: 1, error: null, completedAt: now })
    .where(eq(analysisParts.analysisId, id))
  let sortOrder = 0
  const packing: NewPackingChecklistItem[] = result.packing_checklist.flatMap((group) => [
    ...group.item_ids.map((itemId) => ({
      analysisId: id,
      itemId,
      label: nameOf(itemId),
      group: group.group,
      sortOrder: (sortOrder += 1),
    })),
    ...group.extras.map((label) => ({ analysisId: id, itemId: null, label, group: group.group, sortOrder: (sortOrder += 1) })),
  ])
  await db.insert(packingChecklistItems).values(packing)
  return itemIds
}

test.beforeAll(async ({ baseURL }) => {
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  let minutes = CONFIRMED.length + 2
  for (const seed of CONFIRMED) {
    const item = await makeTaggedItem(db, { status: "confirmed", createdAt: new Date(Date.now() - minutes * 60_000), ...seed })
    minutes -= 1
    await makeImage(db, item.id, {
      kind: "thumb",
      blobUrl: photo,
      blobPathname: `e2e/${item.id}/thumb`,
      contentType: "image/png",
      width: 192,
      height: 192,
      bytes: 4_000,
    })
    createdItemIds.push(item.id)
    nameById.set(item.id, seed.name)
  }
  const pending = await makeItem(db, { notes: "relospec photo waiting for tags" })
  const archived = await makeTaggedItem(db, { name: "Relospec archived coat", status: "archived", archivedFrom: "confirmed" })
  // Confirmed, so only its collection keeps it out of the run.
  const running = await makeTaggedItem(db, {
    name: "Relospec running jacket",
    status: "confirmed",
    collection: "running",
    category: "outerwear",
    subcategory: "running jacket",
    warmthLevel: 2,
  })
  runningId = running.id
  createdItemIds.push(pending.id, archived.id, running.id)
})

test.afterAll(async () => {
  try {
    const runs = await db
      .select({ id: analyses.id })
      .from(analyses)
      .where(and(eq(analyses.kind, "relocation"), gte(analyses.createdAt, startedAt)))
    const runIds = runs.map((run) => run.id)
    if (runIds.length > 0) {
      // Shopping rows only lose their analysis link when it goes, so they go first.
      await db.delete(shoppingListItems).where(inArray(shoppingListItems.analysisId, runIds))
      await db.delete(aiCalls).where(inArray(aiCalls.analysisId, runIds))
      // Parts and packing rows cascade.
      await db.delete(analyses).where(inArray(analyses.id, runIds))
    }
    // Image rows cascade.
    if (createdItemIds.length > 0) await db.delete(items).where(inArray(items.id, createdItemIds))
  } finally {
    await pool.end()
  }
})

test("the form estimates the confirmed clothes and says what is left out, running gear included", async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole("heading", { level: 1, name: "Relocate" })).toBeVisible()
  await expect(page.getByLabel("Climate profile")).toHaveValue(/.+/)
  await expect(page.getByLabel("Climate profile").locator("option:checked")).toHaveText("Hamburg, Germany")
  await expect(page.getByRole("switch", { name: "Confirmed items only" })).toHaveAttribute("aria-checked", "true")

  await expect(estimate(page)).toContainText("with Sonnet 5.5 · 2 parts · 12 items")
  await expect(estimate(page)).toContainText("1 waiting for tags, 1 archived and 1 running gear item are left out.")
  await expect(page.getByRole("button", { name: "Run analysis" })).toBeEnabled()
})

test("Run starts the analysis, and without an API key it stops with a configuration error", async ({ page }) => {
  await signIn(page)
  await expect(estimate(page)).toContainText("12 items")
  await page.getByRole("button", { name: "Run analysis" }).click()

  await expect(page).toHaveURL((url) => UUID_PATH.test(url.pathname))
  analysisId = UUID_PATH.exec(new URL(page.url()).pathname)?.[1] ?? ""
  await expect(page.getByRole("heading", { level: 1, name: "Relocation analysis" })).toBeVisible()
  await expect(configurationAlert(page)).toBeVisible()
  await expect(configurationAlert(page)).toContainText("AI settings")
  await expect(page.getByRole("list", { name: "Parts" }).getByRole("listitem")).toHaveCount(2)

  snapshotIds = await completeWithFixtureResult(analysisId)
  expect(snapshotIds).toHaveLength(12)
  expect(snapshotIds).not.toContain(runningId)
})

test("an unchanged wardrobe offers the earlier result instead of a new run", async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole("heading", { name: /^Unchanged since / })).toBeVisible()
  await expect(page.getByRole("button", { name: "Run analysis" })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Earlier analyses" }).getByRole("link")).toHaveCount(1)

  await page.getByRole("link", { name: "View result" }).click()
  await expect(page).toHaveURL(`/relocate/${analysisId}`)
  await expect(page.getByRole("heading", { level: 1, name: "Hamburg plan" })).toBeVisible()
  await expect(page.getByRole("tab", { name: "Items 12" })).toBeVisible()
})

test("an override is saved to the item and survives a reload", async ({ page }) => {
  const first = snapshotIds[0] ?? ""
  await signIn(page)
  await page.goto(`/relocate/${analysisId}`)

  const group = page.getByRole("group", { name: `Your decision for ${nameOf(first)}` })
  await group.getByRole("button", { name: "Leave" }).click()
  await expect(group.getByRole("button", { name: "Leave" })).toHaveAttribute("aria-pressed", "true")
  await expect.poll(() => decisionOf(first)).toBe("leave")

  await page.reload()
  const reloaded = page.getByRole("group", { name: `Your decision for ${nameOf(first)}` })
  await expect(reloaded.getByRole("button", { name: "Leave" })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("listitem").filter({ has: reloaded }).getByText("Yours: Leave")).toBeVisible()
})

test("Apply AI decisions fills in the undecided clothes, keeps the override and skips an item moved to running gear", async ({ page }) => {
  // i4, the AI's Donate, moves to running gear before the page renders, so
  // the button counts only the clothes Apply writes to, as the server does
  // (D-249): 10 of the 11 undecided items.
  const moved = snapshotIds[3] ?? ""
  const decisions = () => Promise.all(snapshotIds.map((id) => decisionOf(id)))
  await db.update(items).set({ collection: "running" }).where(eq(items.id, moved))
  try {
    await signIn(page)
    await page.goto(`/relocate/${analysisId}`)

    await page.getByRole("button", { name: "Apply AI decisions to 10 undecided items", exact: true }).click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toContainText("Items you already decided keep your decision.")
    await dialog.getByRole("button", { name: "Apply" }).click()
    await expect(page.getByText("Applied 10 AI decisions")).toBeVisible()
    // Only the running item is undecided now, and Apply would write nothing to it.
    await expect(page.getByRole("button", { name: "No undecided items left" })).toBeDisabled()
    // i1 keeps the owner's Leave; i4 keeps no decision.
    await expect
      .poll(decisions)
      .toEqual(["leave", "bring", "leave", "undecided", "sell", "bring", "bring", "leave", "donate", "sell", "bring", "bring"])
  } finally {
    // Back among the clothes, even when a check above failed: the later tests
    // need the unchanged wardrobe and its 12 items.
    await db.update(items).set({ collection: "clothing" }).where(eq(items.id, moved))
  }

  // Back among the clothes it is offered again and takes the run's decision.
  await page.reload()
  await page.getByRole("button", { name: "Apply AI decisions to 1 undecided item", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Apply" }).click()
  await expect(page.getByText("Applied 1 AI decision", { exact: true })).toBeVisible()
  await expect
    .poll(decisions)
    .toEqual(["leave", "bring", "leave", "donate", "sell", "bring", "bring", "leave", "donate", "sell", "bring", "bring"])
  await expect(page.getByRole("button", { name: "No undecided items left" })).toBeDisabled()
})

test("gaps go to the shopping list once", async ({ page }) => {
  await signIn(page)
  await page.goto(`/relocate/${analysisId}`)
  await page.getByRole("tab", { name: "Gaps 2" }).click()

  await expect(page.getByRole("checkbox", { name: "Waterproof breathable shell jacket" })).toBeChecked()
  await expect(page.getByRole("checkbox", { name: "Insulated waterproof boots" })).toBeChecked()
  await page.getByRole("button", { name: "Add 2 to shopping list" }).click()
  await expect(page.getByText("Added 2 items to your shopping list")).toBeVisible()
  await expect(page.getByText("On your shopping list", { exact: true })).toHaveCount(2)
  await expect(page.getByRole("button", { name: "All gaps are on your shopping list" })).toHaveAttribute("aria-disabled", "true")

  const countRows = async () =>
    (await db.select({ id: shoppingListItems.id }).from(shoppingListItems).where(eq(shoppingListItems.analysisId, analysisId)))
      .length
  await expect.poll(countRows).toBe(2)

  await page.getByRole("link", { name: "Open shopping list" }).click()
  await expect(page).toHaveURL("/shopping")
  await expect(page.getByText("Waterproof breathable shell jacket").first()).toBeVisible()
  await expect(page.getByText("Insulated waterproof boots").first()).toBeVisible()

  // Back on the result, both are locked as already added; nothing is added twice.
  await page.goto(`/relocate/${analysisId}`)
  await page.getByRole("tab", { name: "Gaps 2" }).click()
  await expect(page.getByText("On your shopping list", { exact: true })).toHaveCount(2)
  await expect(page.getByRole("button", { name: "All gaps are on your shopping list" })).toHaveAttribute("aria-disabled", "true")
  expect(await countRows()).toBe(2)
})

test("a packing box and an added extra survive a reload, and the checklist prints", async ({ page }) => {
  // makeRelocationResult packs i1, i5 and i9 in the suitcase and i2, i6 and i10
  // in the carry-on. By now i1 is the owner's Leave (the override test) and i5
  // the AI's Sell (applied), so they are no longer coming (D-181); i2 is bring.
  const packedName = nameOf(snapshotIds[1])
  await signIn(page)
  await page.goto(`/relocate/${analysisId}`)
  await page.getByRole("tab", { name: /^Packing/ }).click()

  await expect(page.getByRole("region", { name: /^Suitcase/ })).toContainText("Yours: Leave · not coming")
  const carryOnRows = page.getByRole("region", { name: /^Carry-on/ })
  await carryOnRows.getByRole("checkbox", { name: packedName }).click()
  await expect(carryOnRows.getByRole("checkbox", { name: packedName })).toBeChecked()
  await expect
    .poll(async () => {
      const rows = await db
        .select({ packed: packingChecklistItems.packed })
        .from(packingChecklistItems)
        .where(and(eq(packingChecklistItems.analysisId, analysisId), eq(packingChecklistItems.itemId, snapshotIds[1] ?? "")))
      return rows[0]?.packed
    })
    .toBe(true)

  const carryOn = page.getByRole("region", { name: /^Carry-on/ })
  await carryOn.getByLabel("Add to Carry-on").fill(EXTRA)
  await carryOn.getByRole("button", { name: "Add to Carry-on" }).click()
  await expect(carryOn.getByRole("checkbox", { name: EXTRA })).toBeVisible()

  await page.reload()
  await page.getByRole("tab", { name: /^Packing/ }).click()
  await expect(page.getByRole("region", { name: /^Carry-on/ }).getByRole("checkbox", { name: packedName })).toBeChecked()
  await expect(page.getByRole("region", { name: /^Carry-on/ }).getByRole("checkbox", { name: EXTRA })).not.toBeChecked()

  await page.getByRole("link", { name: "Print checklist" }).click()
  await expect(page).toHaveURL(`/relocate/${analysisId}/print`)
  await expect(page.getByRole("heading", { level: 1, name: "Packing checklist" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Carry-on" })).toContainText(EXTRA)
  await expect(page.getByRole("region", { name: "Carry-on" })).toContainText(packedName)
  // Items no longer coming are printed apart, not in their group (D-181).
  const notBringing = page.getByRole("region", { name: "Not bringing" })
  await expect(notBringing).toContainText(`${nameOf(snapshotIds[0])} (Yours: Leave · not coming)`)
  await expect(notBringing).toContainText(`${nameOf(snapshotIds[4])} (Yours: Sell · not coming)`)
  await expect(page.getByRole("region", { name: "Suitcase" })).not.toContainText(nameOf(snapshotIds[4]))
  await expect(page.getByRole("link", { name: "Back to the plan" })).toBeVisible()
})

test("Re-run anyway starts a new run, which stops with the configuration error without a key", async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole("heading", { name: /^Unchanged since / })).toBeVisible()
  await page.getByRole("button", { name: "Re-run anyway" }).click()

  await expect(page).toHaveURL((url) => UUID_PATH.test(url.pathname) && !url.pathname.endsWith(analysisId))
  await expect(configurationAlert(page)).toBeVisible()

  await page.goto("/relocate")
  const earlier = page.getByRole("region", { name: "Earlier analyses" })
  await expect(earlier.getByRole("link")).toHaveCount(2)
  await expect(earlier.getByText("Not finished")).toHaveCount(1)
})

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("the form and the result fit without sideways scrolling", async ({ page }) => {
    await signIn(page)
    await expect(estimate(page)).toContainText("12 items")
    await expectNoHorizontalScroll(page)

    await page.goto(`/relocate/${analysisId}`)
    await expect(page.getByRole("heading", { level: 1, name: "Hamburg plan" })).toBeVisible()
    // Below lg, one column at a time behind a segmented control.
    await expect(page.getByRole("group", { name: "Show decisions" })).toBeVisible()
    await expectNoHorizontalScroll(page)
    // The tabs wrap onto two rows here: every trigger stays inside the tab
    // list and on top at its centre, not drawn over the content below.
    const layout = await page.getByRole("tablist").evaluate((list) => {
      // Mid-screen, clear of the fixed tab bar, so elementFromPoint can see it.
      list.scrollIntoView({ block: "center", behavior: "instant" })
      const box = list.getBoundingClientRect()
      return [...list.querySelectorAll("[role='tab']")].map((tab) => {
        const rect = tab.getBoundingClientRect()
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
          name: tab.textContent?.trim(),
          inside: rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1,
          onTop: top !== null && tab.contains(top),
          height: Math.round(rect.height),
        }
      })
    })
    for (const tab of layout) expect(tab, JSON.stringify(tab)).toMatchObject({ inside: true, onTop: true })
    expect(Math.max(...layout.map((tab) => tab.height))).toBeLessThanOrEqual(48)
    for (const tab of [/^Gaps/, /^Packing/, /^Warnings/]) {
      await page.getByRole("tab", { name: tab }).click()
      await expectNoHorizontalScroll(page)
    }
  })
})
