import { randomUUID } from "node:crypto"

import { expect, test, type Page } from "@playwright/test"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { relations } from "@/lib/db/relations"
import { aiCalls, itemImages, items } from "@/lib/db/schema"

import { makeImage, makeItem, makeTaggedItem } from "../test/factories"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"
import { NEEDS_NO_BLOB_TOKEN, SHELL_HAS_BLOB_TOKEN } from "./live-env"

// The item detail page against the production build, without an Anthropic
// key or a Blob token: items are inserted straight into wardrobe_e2e, and
// their photos point at a static file the app serves itself. Without a Blob
// token, Delete must refuse with a configuration error before anything is
// deleted. Every row this spec creates is deleted again in afterAll.

const CONFIRMED_NAME = "E2E detail coat"
const RENAMED = "E2E detail overcoat"

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdItemIds: string[] = []
let confirmedId = ""
let pendingId = ""

async function signIn(page: Page, path: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(path)}`)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === path)
}

async function itemRow(id: string) {
  const [row] = await db.select().from(items).where(eq(items.id, id))
  return row
}

/** The page must never scroll sideways at phone width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

test.beforeAll(async ({ baseURL }) => {
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  const photoRow = { blobUrl: photo, contentType: "image/png", width: 192, height: 192, bytes: 4_000 }

  const confirmed = await makeTaggedItem(db, { status: "confirmed", name: CONFIRMED_NAME, aiModel: "claude-haiku-5-5" })
  const pending = await makeItem(db)
  for (const kind of ["original", "processed", "thumb"] as const) {
    await makeImage(db, confirmed.id, { kind, blobPathname: `e2e/${confirmed.id}/${kind}`, ...photoRow })
  }
  for (const kind of ["processed", "thumb"] as const) {
    await makeImage(db, pending.id, { kind, blobPathname: `e2e/${pending.id}/${kind}`, ...photoRow })
  }
  createdItemIds.push(confirmed.id, pending.id)
  confirmedId = confirmed.id
  pendingId = pending.id
})

test.afterAll(async () => {
  try {
    if (createdItemIds.length > 0) {
      await db.delete(aiCalls).where(inArray(aiCalls.itemId, createdItemIds))
      await db.delete(items).where(inArray(items.id, createdItemIds))
    }
  } finally {
    await pool.end()
  }
})

test("shows the item with its photo, toggles, tags and details", async ({ page }) => {
  const path = `/wardrobe/${confirmedId}`
  await signIn(page, path)

  await expect(page.getByRole("heading", { level: 1, name: CONFIRMED_NAME })).toBeVisible()
  const photo = page.getByRole("img", { name: `Photo of ${CONFIRMED_NAME}` })
  await expect(photo).toBeVisible()
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByRole("link", { name: "Open original (opens in a new tab)" })).toHaveAttribute(
    "target",
    "_blank"
  )
  await expect(page.getByRole("group", { name: "Plan for the move" })).toBeVisible()
  await expect(page.getByRole("group", { name: "Where it is now" })).toBeVisible()
  // A confirmed item has nothing left to confirm.
  const form = page.getByRole("form", { name: `Tags for ${CONFIRMED_NAME}` })
  await expect(form.getByRole("button", { name: "Save" })).toBeVisible()
  await expect(form.getByRole("button", { name: /Confirm/ })).toHaveCount(0)
  await expect(page.getByText("claude-haiku-5-5")).toBeVisible()
})

test("a decision and a location change are saved at once and survive a reload", async ({ page }) => {
  await signIn(page, `/wardrobe/${confirmedId}`)

  const plan = page.getByRole("group", { name: "Plan for the move" })
  await plan.getByRole("button", { name: "Donate" }).click()
  await expect(plan.getByRole("button", { name: "Donate" })).toHaveAttribute("aria-pressed", "true")
  await expect.poll(async () => (await itemRow(confirmedId))?.decision).toBe("donate")

  const place = page.getByRole("group", { name: "Where it is now" })
  await place.getByRole("button", { name: "Hamburg" }).click()
  await expect(place.getByRole("button", { name: "Hamburg" })).toHaveAttribute("aria-pressed", "true")
  await expect.poll(async () => (await itemRow(confirmedId))?.location).toBe("hamburg")

  await page.reload()
  await expect(
    page.getByRole("group", { name: "Plan for the move" }).getByRole("button", { name: "Donate" })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.getByRole("group", { name: "Where it is now" }).getByRole("button", { name: "Hamburg" })
  ).toHaveAttribute("aria-pressed", "true")
  // Neither is a tag, so neither counts as an edited tag.
  expect((await itemRow(confirmedId))?.userEditedFields).toEqual([])
})

test("an edited name is saved and survives a reload", async ({ page }) => {
  await signIn(page, `/wardrobe/${confirmedId}`)

  const form = page.getByRole("form", { name: `Tags for ${CONFIRMED_NAME}` })
  // exact: "New colour name" also contains "name".
  await form.getByLabel("Name", { exact: true }).fill(RENAMED)
  await form.getByRole("button", { name: "Save" }).click()
  // The saved name renames the form too.
  await expect(page.getByRole("form", { name: `Tags for ${RENAMED}` }).getByRole("status")).toHaveText("Saved.")

  await expect.poll(async () => (await itemRow(confirmedId))?.name).toBe(RENAMED)
  expect((await itemRow(confirmedId))?.userEditedFields).toContain("name")
  await page.reload()
  await expect(page.getByRole("heading", { level: 1, name: RENAMED })).toBeVisible()
  // The plan saved by the previous test is still there: Save sends only the changed fields.
  expect((await itemRow(confirmedId))?.decision).toBe("donate")
})

test("Archive hides the item and Unarchive brings it back as confirmed", async ({ page }) => {
  await signIn(page, `/wardrobe/${confirmedId}`)

  await page.getByRole("button", { name: "Archive", exact: true }).click()
  await expect(page.getByRole("button", { name: "Unarchive" })).toBeVisible()
  await expect(page.getByText("Archived items cannot be edited.", { exact: false })).toBeVisible()
  await expect.poll(async () => (await itemRow(confirmedId))?.status).toBe("archived")

  await page.getByRole("button", { name: "Unarchive" }).click()
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible()
  await expect.poll(async () => (await itemRow(confirmedId))?.status).toBe("confirmed")
  await expect(page.getByRole("form", { name: `Tags for ${RENAMED}` })).toBeVisible()
})

test("Delete without a Blob token shows a configuration error and keeps the item", async ({ page }) => {
  test.skip(SHELL_HAS_BLOB_TOKEN, NEEDS_NO_BLOB_TOKEN)
  await signIn(page, `/wardrobe/${confirmedId}`)

  await page.getByRole("button", { name: "Delete item" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText("including from photo storage")
  await expect(dialog).toContainText("This cannot be undone.")
  await dialog.getByRole("button", { name: "Delete", exact: true }).click()

  const alert = dialog.getByRole("alert")
  await expect(alert).toContainText("Not deleted")
  await expect(alert).toContainText("The server is misconfigured")
  await expect(page).toHaveURL((url) => url.pathname === `/wardrobe/${confirmedId}`)
  expect(await itemRow(confirmedId)).toBeDefined()
  const images = await db.select().from(itemImages).where(eq(itemImages.itemId, confirmedId))
  expect(images).toHaveLength(3)

  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toHaveCount(0)
})

test("a pending item offers Tag now and Fill in by hand", async ({ page }) => {
  await signIn(page, `/wardrobe/${pendingId}`)

  await expect(page.getByRole("heading", { level: 1, name: "Untagged item" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Tag now" })).toBeVisible()
  await page.getByRole("button", { name: "Fill in by hand" }).click()
  await expect(page.getByRole("form", { name: "Tags for Untagged item" })).toBeVisible()
  await page.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByRole("button", { name: "Fill in by hand" })).toBeFocused()
})

test("an invalid id and a missing id show the not-found page", async ({ page }) => {
  await signIn(page, `/wardrobe/${confirmedId}`)

  for (const path of ["/wardrobe/not-an-item", `/wardrobe/${randomUUID()}`]) {
    await page.goto(path)
    await expect(page.getByRole("heading", { level: 1, name: "Item not found" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Go to the wardrobe" })).toBeVisible()
  }
})

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("the detail page fits without sideways scrolling", async ({ page }) => {
    await signIn(page, `/wardrobe/${confirmedId}`)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    await expect(page.getByRole("button", { name: "Delete item" })).toBeVisible()
    await expectNoHorizontalScroll(page)
  })
})
