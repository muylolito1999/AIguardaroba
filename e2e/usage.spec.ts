import { expect, test, type Page } from "@playwright/test"
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import { formatUsd } from "@/lib/ai/cost"
import { relations } from "@/lib/db/relations"
import { aiCalls } from "@/lib/db/schema"

import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"

// /settings/usage against ai_calls rows inserted straight into wardrobe_e2e.
// Other specs may log calls of their own, so the expected figures are read
// back from the database rather than assumed; the rows this spec adds are
// deleted in afterAll.

const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 2 })
const db = drizzle({ client: pool, relations })
const createdCallIds: string[] = []

function monthWindow(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function signIn(page: Page, next: string): Promise<void> {
  await page.goto(`/login?${new URLSearchParams({ next })}`)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === next)
}

test.beforeAll(async () => {
  const now = new Date()
  const { start } = monthWindow(now)
  const lastMonth = new Date(start.getTime() - 24 * 60 * 60 * 1000)
  const rows = await db
    .insert(aiCalls)
    .values([
      {
        createdAt: now,
        model: "claude-haiku-5-5",
        purpose: "tagging",
        status: "success",
        inputTokens: 1_200,
        outputTokens: 310,
        cacheReadInputTokens: 1_450,
        costUsd: 1.2,
        latencyMs: 2_100,
      },
      {
        createdAt: now,
        model: "claude-haiku-5-5",
        purpose: "tagging",
        status: "invalid_output",
        inputTokens: 1_100,
        outputTokens: 290,
        cacheCreationInputTokens: 1_450,
        costUsd: 2.03,
        latencyMs: 1_900,
        errorCode: "AI_INVALID_OUTPUT",
      },
      {
        createdAt: lastMonth,
        model: "claude-sonnet-5-5",
        purpose: "relocation_synthesis",
        status: "success",
        costUsd: 0.5,
      },
    ])
    .returning({ id: aiCalls.id })
  createdCallIds.push(...rows.map((row) => row.id))
})

test.afterAll(async () => {
  try {
    if (createdCallIds.length > 0) await db.delete(aiCalls).where(inArray(aiCalls.id, createdCallIds))
  } finally {
    await pool.end()
  }
})

test("Settings links to the usage page", async ({ page }) => {
  await signIn(page, "/settings")
  await page.getByRole("link", { name: "AI usage", exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/settings/usage")
  await expect(page.getByRole("heading", { level: 1, name: "AI usage" })).toBeVisible()
})

test("shows this month's spend and the per-purpose breakdown", async ({ page }) => {
  await signIn(page, "/settings/usage")

  const { start, end } = monthWindow(new Date())
  const thisMonth = and(gte(aiCalls.createdAt, start), lt(aiCalls.createdAt, end))
  const [month] = await db
    .select({ cost: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`.mapWith(Number) })
    .from(aiCalls)
    .where(thisMonth)
  const [tagging] = await db
    .select({
      calls: sql<number>`count(*)`.mapWith(Number),
      cost: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`.mapWith(Number),
    })
    .from(aiCalls)
    .where(and(thisMonth, eq(aiCalls.purpose, "tagging")))

  const monthCard = page.getByRole("region", { name: "This month", exact: true })
  await expect(monthCard).toContainText(new RegExp(`${escapeRegExp(formatUsd(month?.cost ?? 0))} of \\$`))
  await expect(monthCard.getByRole("progressbar")).toBeVisible()

  const byPurpose = page.getByRole("region", { name: "By purpose" })
  const taggingRow = byPurpose.getByRole("row", { name: /^Tagging/ })
  await expect(taggingRow).toBeVisible()
  const cells = taggingRow.getByRole("cell")
  await expect(cells.first()).toHaveText(String(tagging?.calls ?? 0))
  await expect(cells.nth(5)).toHaveText(formatUsd(tagging?.cost ?? 0))
  // Last month's call counts toward the credit but not toward this month.
  await expect(byPurpose.getByRole("row", { name: /^Relocation: summary/ })).toBeVisible()

  await expect(page.getByRole("region", { name: "Recent calls" })).toContainText("Invalid output")
})

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("tables scroll inside their own box, never the page", async ({ page }) => {
    await signIn(page, "/settings/usage")
    const recent = page.getByRole("region", { name: "Recent calls" })
    await expect(recent).toBeVisible()
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(pageOverflow).toBeLessThanOrEqual(0)
    const tableOverflows = await recent.evaluate((element) => element.scrollWidth > element.clientWidth)
    expect(tableOverflows).toBe(true)
  })
})
