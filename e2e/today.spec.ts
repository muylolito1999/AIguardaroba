import { expect, test, type Page } from "@playwright/test"
import { and, count, eq, inArray, like } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { z } from "zod"

import { relations } from "@/lib/db/relations"
import { aiCalls, analyses, appSettings, climateProfiles, items, outfitItems, outfits, wearLogs } from "@/lib/db/schema"
import { OUTFIT_PROMPT_VERSION } from "@/lib/outfits/suggestion"
import { calendarDayIn } from "@/lib/wear/contracts"

import { makeImage } from "../test/factories"
import {
  makeOutfitSuggestionResult,
  makeOutfitWardrobe,
  makeWeatherSnapshot,
  type OutfitFixtureItem,
} from "../test/outfit-fixtures"
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"
import { NEEDS_NO_API_KEY, SHELL_TAGGING } from "./live-env"
import { OPEN_METEO_STUB_URL } from "./open-meteo-stub"

// /today against the production build and the local Open-Meteo stub
// (e2e/open-meteo-stub.ts; playwright.config.ts starts it and points the
// server's OPEN_METEO_BASE_URL at it), so no request leaves the machine:
// - the weather card for the home city (Bologna, as seeded) with the
//   Open-Meteo credit, and proof that the server asked the stub;
// - the navigation's marks: on a phone the Wardrobe tab marks /today as its
//   section (aria-current="true") whether Settings or the wardrobe led there,
//   and on a desktop only the open page's own row says "page";
// - without an API key, "Suggest outfits" shows the configuration error and
//   no Claude call is logged;
// - a complete suggestion for today, inserted as if Claude had answered,
//   shows three cards; Save makes an outfit and "Wore this today" logs the
//   items, with Undo, and the Undo toast leaves the last card's Save free;
// - a card whose item was moved to running gear since badges it and offers
//   neither Save nor "Wore this today" (D-250); the item is moved back after;
// - Settings, Home city moves /today to Hamburg (and back).
// A wardrobe of 17 items (the shared outfit fixtures, located in Bologna) is
// inserted straight into wardrobe_e2e; it and everything made from it are
// deleted in afterAll, and the home city is put back.

test.describe.configure({ mode: "serial" })

const PREFIX = "E2E todayspec"
const PHONE = { width: 390, height: 844 }

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })

let homeProfileId: string | null = null
let bolognaId = ""
let hamburgId = ""
let wardrobe: OutfitFixtureItem[] = []
const analysisIds: string[] = []

const StubRequestsSchema = z.array(z.object({ latitude: z.string().nullable(), timezone: z.string().nullable() }))

function todayIn(timeZone: string): string {
  return calendarDayIn(timeZone, new Date())
}

/** "Tuesday 3 November", as the page heading names the day. */
function dayHeading(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`)
  )
}

async function signIn(page: Page, next = "/today"): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === next)
}

/** The page must never scroll sideways at phone width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

async function stubRequests() {
  const response = await fetch(`${OPEN_METEO_STUB_URL}/__requests`)
  return StubRequestsSchema.parse(await response.json())
}

async function callCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(aiCalls)
  return row?.n ?? 0
}

test.beforeAll(async ({ baseURL }) => {
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1))
  homeProfileId = settings?.homeProfileId ?? null
  const profiles = await db.select().from(climateProfiles)
  bolognaId = profiles.find((profile) => profile.slug === "bologna")?.id ?? ""
  hamburgId = profiles.find((profile) => profile.slug === "hamburg")?.id ?? ""
  if (bolognaId === "" || hamburgId === "") throw new Error("The e2e database has no Bologna or Hamburg profile.")
  // The seed makes Bologna the home city; a run that stopped half way may have left Hamburg.
  await db.update(appSettings).set({ homeProfileId: bolognaId }).where(eq(appSettings.id, 1))

  const made = makeOutfitWardrobe()
  wardrobe = Object.values(made).map((item) => ({ ...item, name: `${PREFIX} ${item.name}`, location: "bologna" }))
  await db.insert(items).values(
    wardrobe.map((item, index) => ({
      id: item.id,
      imageHash: `e2etodayspec${String(index).padStart(52, "0")}`,
      status: item.status,
      location: item.location,
      decision: item.decision,
      name: item.name,
      category: item.category,
      subcategory: item.subcategory,
      colors: [...item.colors],
      materials: [...item.materials],
      warmthLevel: item.warmthLevel,
      waterproof: item.waterproof,
      windproof: item.windproof,
      insulated: item.insulated,
      breathable: item.breathable,
      seasons: [...item.seasons],
      formality: item.formality,
      condition: "good" as const,
    }))
  )
  // One thumb the app serves itself, so the card shows a real image.
  const photo = new URL("/icons/icon-192.png", baseURL ?? "http://localhost:3000").toString()
  const first = wardrobe[0]
  if (first !== undefined) {
    await makeImage(db, first.id, {
      kind: "thumb",
      blobUrl: photo,
      blobPathname: `e2e/${first.id}/thumb`,
      contentType: "image/png",
      width: 192,
      height: 192,
      bytes: 4_000,
    })
  }
})

test.afterAll(async () => {
  try {
    const ids = wardrobe.map((item) => item.id)
    if (ids.length > 0) {
      // Outfits made from these items by Save; their item rows and wear logs cascade.
      const saved = await db
        .selectDistinct({ id: outfitItems.outfitId })
        .from(outfitItems)
        .where(inArray(outfitItems.itemId, ids))
      if (saved.length > 0) await db.delete(outfits).where(inArray(outfits.id, saved.map((row) => row.id)))
    }
    if (analysisIds.length > 0) {
      await db.delete(aiCalls).where(inArray(aiCalls.analysisId, analysisIds))
      await db.delete(analyses).where(inArray(analyses.id, analysisIds))
    }
    await db.delete(items).where(like(items.name, `${PREFIX}%`))
    await db.update(appSettings).set({ homeProfileId }).where(eq(appSettings.id, 1))
  } finally {
    await pool.end()
  }
})

test("shows today's weather for the home city with the Open-Meteo credit, from the stub", async ({ page }) => {
  await page.setViewportSize(PHONE)
  await signIn(page)

  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible()
  await expect(page.getByText(`${dayHeading(todayIn("Europe/Rome"))} in Bologna, Italy`)).toBeVisible()
  const weather = page.getByRole("region", { name: "Weather in Bologna" })
  await expect(weather).toContainText("Light rain")
  await expect(weather).toContainText("Feels like")
  await expect(weather).toContainText("% chance of rain")
  const credit = weather.getByRole("link", { name: "Weather data by Open-Meteo.com" })
  await expect(credit).toHaveAttribute("href", "https://open-meteo.com/")
  await expectNoHorizontalScroll(page)

  // The server asked the stub, not the real API, for Bologna's day.
  const requests = await stubRequests()
  expect(requests.some((request) => request.timezone === "Europe/Rome" && request.latitude === "44.49")).toBe(true)
})

test("on a phone the Wardrobe tab marks /today as its section, the same from Settings and from the wardrobe", async ({
  page,
}) => {
  // D-218 and D-230: the mark depends on the page open, never on the page before
  // it, and only the link to the open page says aria-current="page".
  await page.setViewportSize(PHONE)
  const tabs = page.getByRole("navigation", { name: "Primary" })
  const wardrobeTab = tabs.getByRole("link", { name: "Wardrobe" })
  const today = page.getByRole("heading", { level: 1, name: "Today" })

  await signIn(page, "/settings")
  await expect(tabs.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page")
  await page.getByRole("navigation", { name: "Get dressed" }).getByRole("link", { name: "Today" }).click()
  await expect(today).toBeVisible()
  await expect(wardrobeTab).toHaveAttribute("aria-current", "true")
  await expect(tabs.locator("[aria-current]")).toHaveCount(1)

  await page.goto("/wardrobe")
  await expect(wardrobeTab).toHaveAttribute("aria-current", "page")
  await page.getByRole("navigation", { name: "Get dressed" }).getByRole("link", { name: "Today" }).click()
  await expect(today).toBeVisible()
  await expect(wardrobeTab).toHaveAttribute("aria-current", "true")
  await expect(tabs.locator("[aria-current]")).toHaveCount(1)
})

test("on a desktop the sidebar says page only on the open page's own row", async ({ page }) => {
  await signIn(page)
  const primary = page.getByRole("navigation", { name: "Primary" })
  const daily = page.getByRole("navigation", { name: "Get dressed" })

  await expect(daily.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page")
  await expect(primary.locator("[aria-current]")).toHaveCount(0)

  await page.goto("/outfits/new")
  await expect(daily.getByRole("link", { name: "Outfits" })).toHaveAttribute("aria-current", "true")
  await expect(daily.locator("[aria-current]")).toHaveCount(1)
  await expect(primary.locator("[aria-current]")).toHaveCount(0)

  await page.goto("/stats")
  await expect(primary.getByRole("link", { name: "Wardrobe" })).toHaveAttribute("aria-current", "true")
  await expect(primary.locator("[aria-current]")).toHaveCount(1)
  await expect(daily.locator("[aria-current]")).toHaveCount(0)
})

test("without an API key, Suggest outfits shows the configuration error and logs no Claude call", async ({ page }) => {
  // With a real key the server would make a paid call here.
  test.skip(SHELL_TAGGING, NEEDS_NO_API_KEY)
  await signIn(page)
  const before = await callCount()

  const suggest = page.getByRole("button", { name: "Suggest outfits" })
  // At least this spec's 17 items; another spec's leftovers would only add to them.
  await expect(page.locator(`#${await suggest.getAttribute("aria-describedby")}`)).toContainText(
    /\d+ items in Bologna or of unknown location/
  )
  await suggest.click()

  const alert = page.getByRole("alert").filter({ hasText: "Configuration problem" })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText("The server is misconfigured. Check the server logs.")
  expect(await callCount()).toBe(before)
  const stored = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.kind, "outfit_suggestion"))
  expect(stored).toHaveLength(0)
})

/** A complete suggestion for today in Bologna, inserted as if Claude had answered; deleted in afterAll. */
async function insertTodaySuggestion() {
  const today = todayIn("Europe/Rome")
  const result = makeOutfitSuggestionResult(
    wardrobe,
    makeWeatherSnapshot({ date: today, timezone: "Europe/Rome", fetchedAt: new Date().toISOString() })
  )
  const [row] = await db
    .insert(analyses)
    .values({
      kind: "outfit_suggestion",
      status: "complete",
      climateProfileId: bolognaId,
      dateFrom: today,
      dateTo: today,
      params: { force: false, savedOutfitIds: [null, null, null] },
      model: "claude-sonnet-5-5",
      effort: "low",
      promptVersion: OUTFIT_PROMPT_VERSION,
      result,
      costUsd: 0.04,
      completedAt: new Date(),
    })
    .returning({ id: analyses.id })
  if (row === undefined) throw new Error("no analysis")
  analysisIds.push(row.id)
  return { row, result, today }
}

test("a stored suggestion for today shows three cards; Save makes an outfit and Wore this today logs it", async ({
  page,
}) => {
  const { row, result, today } = await insertTodaySuggestion()
  const [first, second] = result.outfits
  if (first === undefined || second === undefined) throw new Error("three outfits")

  await page.setViewportSize(PHONE)
  await signIn(page)
  const list = page.getByRole("list", { name: "Suggested outfits" })
  await expect(list.getByRole("article")).toHaveCount(3)
  await expect(page.getByRole("button", { name: "Suggest again" })).toBeVisible()
  const firstCard = page.getByRole("article", { name: first.title })
  await expect(firstCard).toContainText(first.why)
  await expectNoHorizontalScroll(page)

  // Save makes an outfit of source ai, once.
  await firstCard.getByRole("button", { name: `Save ${first.title}` }).click()
  const open = firstCard.getByRole("link", { name: `Open saved outfit ${first.title}` })
  await expect(open).toBeVisible()
  const [stored] = await db.select({ params: analyses.params }).from(analyses).where(eq(analyses.id, row.id))
  const savedId = z.object({ savedOutfitIds: z.array(z.string().nullable()) }).parse(stored?.params).savedOutfitIds[0]
  expect(savedId).toEqual(expect.any(String))
  const [outfit] = await db.select().from(outfits).where(eq(outfits.id, savedId ?? ""))
  expect(outfit).toMatchObject({ name: first.title, source: "ai", aiReasoning: first.why, rainOk: first.rain_ok })
  const savedItems = await db.select().from(outfitItems).where(eq(outfitItems.outfitId, savedId ?? ""))
  expect(savedItems).toHaveLength(first.items.length)
  await expect(open).toHaveAttribute("href", `/outfits/${savedId}`)

  // The saved card survives a reload.
  await page.reload()
  await expect(page.getByRole("article", { name: first.title }).getByRole("link", { name: /Open saved outfit/ })).toBeVisible()

  // Wore this today logs the second outfit's items with today's weather; Undo takes it back.
  const secondCard = page.getByRole("article", { name: second.title })
  await secondCard.getByRole("button", { name: `Wore this today (${second.title})` }).click()
  await expect(secondCard.getByRole("button", { name: `Worn today (${second.title})` })).toBeVisible()
  const secondIds = second.items.map((entry) => entry.itemId)
  const logs = await db
    .select()
    .from(wearLogs)
    .where(and(inArray(wearLogs.itemId, secondIds), eq(wearLogs.wornOn, today)))
  expect(logs).toHaveLength(secondIds.length)
  expect(logs.every((log) => log.outfitId === null && log.weatherSnapshot !== null)).toBe(true)

  await page.getByRole("button", { name: "Undo" }).click()
  await expect(secondCard.getByRole("button", { name: `Wore this today (${second.title})` })).toBeVisible()
  await expect
    .poll(async () => (await db.select().from(wearLogs).where(inArray(wearLogs.itemId, secondIds))).length)
    .toBe(0)
})

test("the Undo toast of a wear never covers the last card's Save at desktop or phone width", async ({ page }) => {
  const { result } = await insertTodaySuggestion()
  const last = result.outfits[2]
  if (last === undefined) throw new Error("three outfits")

  await signIn(page)
  const card = page.getByRole("article", { name: last.title })
  for (const size of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, PHONE]) {
    await page.setViewportSize(size)
    await card.getByRole("button", { name: `Wore this today (${last.title})` }).click()
    await expect(card.getByRole("button", { name: `Worn today (${last.title})` })).toBeVisible()
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible()
    // The toast slides in from below; measure once it has arrived.
    await page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "Logged as worn" })
      .evaluate(async (toast) => {
        // Two frames first, so a transition that starts on the next frame is included. A transition
        // cut short rejects its promise, so this waits until none is running.
        const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await frames()
        for (let round = 0; round < 20; round += 1) {
          const running = toast.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running")
          if (running.length === 0) return
          await Promise.allSettled(running.map((animation) => animation.finished))
          await frames()
        }
      })
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    // A trial click runs the hit-target check without saving: it fails while the toast is on top.
    await card.getByRole("button", { name: `Save ${last.title}` }).click({ trial: true, timeout: 3_000 })
    await page.getByRole("button", { name: "Undo" }).click()
    await expect(card.getByRole("button", { name: `Wore this today (${last.title})` })).toBeVisible()
    // The closed toast leaves before the next size's wear, so only that wear's Undo is on screen.
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0)
  }
  const lastIds = last.items.map((entry) => entry.itemId)
  await expect.poll(async () => (await db.select().from(wearLogs).where(inArray(wearLogs.itemId, lastIds))).length).toBe(0)
})

test("a stored suggestion whose item moved to running gear badges it and offers neither Save nor Wore this today", async ({
  page,
}) => {
  const { result } = await insertTodaySuggestion()
  // An item only one card uses, so the other cards stay available (D-250).
  const uses = new Map<string, number>()
  for (const outfit of result.outfits) {
    for (const entry of outfit.items) uses.set(entry.itemId, (uses.get(entry.itemId) ?? 0) + 1)
  }
  const target = result.outfits.find((outfit) => outfit.items.some((entry) => uses.get(entry.itemId) === 1))
  const movedId = target?.items.find((entry) => uses.get(entry.itemId) === 1)?.itemId
  const movedName = wardrobe.find((item) => item.id === movedId)?.name
  if (target === undefined || movedId === undefined || movedName === undefined || movedName === null) {
    throw new Error("No item of the suggestion belongs to one card only")
  }
  const others = result.outfits.filter((outfit) => outfit !== target)

  await signIn(page)
  const card = page.getByRole("article", { name: target.title })
  const save = card.getByRole("button", { name: `Save ${target.title}` })
  const wore = card.getByRole("button", { name: `Wore this today (${target.title})` })
  // Still clothing: the card can be saved and logged.
  await expect(save).toBeEnabled()
  await expect(wore).toBeEnabled()
  await expect(card.getByText("Running gear", { exact: true })).toHaveCount(0)

  await db.update(items).set({ collection: "running" }).where(eq(items.id, movedId))
  try {
    await page.reload()
    const row = card
      .getByRole("list", { name: `Items in ${target.title}` })
      .getByRole("listitem")
      .filter({ hasText: movedName })
    await expect(row.getByText("Running gear", { exact: true })).toBeVisible()
    await expect(card).toContainText(
      "An item of this outfit was deleted, archived or moved to running gear, so it can no longer be saved or logged."
    )
    await expect(save).toBeDisabled()
    await expect(wore).toBeDisabled()
    // The other cards keep their items and both buttons.
    for (const other of others) {
      const otherCard = page.getByRole("article", { name: other.title })
      await expect(otherCard.getByText("Running gear", { exact: true })).toHaveCount(0)
      await expect(otherCard.getByRole("button", { name: `Save ${other.title}` })).toBeEnabled()
      await expect(otherCard.getByRole("button", { name: `Wore this today (${other.title})` })).toBeEnabled()
    }
  } finally {
    await db.update(items).set({ collection: "clothing" }).where(eq(items.id, movedId))
  }
})

test("Settings, Home city moves today's weather to Hamburg and back", async ({ page }) => {
  await signIn(page, "/settings")
  // By role: the Settings section is labelled "Home city" too.
  const select = page.getByRole("combobox", { name: "Home city" })
  await expect(select).toHaveValue(bolognaId)
  await select.selectOption(hamburgId)
  await expect(page.getByText("Home city: Hamburg")).toBeVisible()

  await page.goto("/today")
  await expect(page.getByText(`${dayHeading(todayIn("Europe/Berlin"))} in Hamburg, Germany`)).toBeVisible()
  await expect(page.getByRole("region", { name: "Weather in Hamburg" })).toBeVisible()
  expect((await stubRequests()).some((request) => request.timezone === "Europe/Berlin")).toBe(true)

  await page.goto("/settings")
  await page.getByRole("combobox", { name: "Home city" }).selectOption(bolognaId)
  await expect(page.getByText("Home city: Bologna")).toBeVisible()
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, 1))
  expect(settings?.homeProfileId).toBe(bolognaId)
})
