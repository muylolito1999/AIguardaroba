import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test"

import type { ItemCardDto } from "@/lib/items/contracts"

import { cardFor } from "../src/components/add/test-fixtures"
import { E2E_PASSWORD } from "./constants"
import { makeJpegFixture, type PhotoFixture } from "./fixtures/images"

// The add page's tagging controls in a visible browser. The e2e server has no
// Blob token and no API key (playwright.config.ts), so nothing would ever
// reach "Ready". Here the browser's requests are answered instead: the
// client-token route, the Blob store's PUT, register and tag. Everything else
// (the page, the session, the hash check, the budget read) is the real
// production build. Screenshots go to each test's output folder.

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

type TagAnswer = (itemId: string) => { status: number; body: unknown }

const tagged: TagAnswer = (itemId) => ({
  status: 200,
  body: {
    ok: true,
    data: {
      cached: false,
      item: cardFor(itemId, {
        status: "tagged",
        name: "Navy wool coat",
        category: "outerwear",
        colors: ["navy"],
        colorHex: ["#1f2a44"],
        warmthLevel: 4,
        seasons: ["winter"],
        formality: "smart_casual",
        condition: "good",
        aiModel: "claude-haiku-5-5",
      }),
    },
  },
})

const unavailable: TagAnswer = () => ({
  status: 503,
  body: { ok: false, error: { code: "AI_UNAVAILABLE", message: "Claude is overloaded right now. Try again shortly." } },
})

const budgetReached: TagAnswer = () => ({
  status: 402,
  body: {
    ok: false,
    error: { code: "BUDGET_EXCEEDED", message: "Monthly AI budget reached: $0.00 left until 1 December 2026." },
  },
})

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

type Fakes = {
  /** Replaces how tag calls are answered from now on. */
  answerTags(answer: TagAnswer): void
  /** Holds every register call until release() is called. */
  holdRegister(): { release(): void }
}

/** Answers the Blob token route, the store's PUT, register and tag in the browser. */
async function fakeStorageAndClaude(page: Page, baseURL: string): Promise<Fakes> {
  const thumb = { url: new URL("/icons/icon-192.png", baseURL).toString(), width: 192, height: 192 }
  let answerTag: TagAnswer = tagged
  let registerGate: Promise<void> | null = null

  await page.route("**/api/blob/upload", (route) =>
    json(route, 200, { type: "blob.generate-client-token", clientToken: "vercel_blob_client_fakestore_e30" }),
  )
  await page.route("https://vercel.com/api/blob/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "PUT, OPTIONS",
          "access-control-allow-headers": "*",
        },
      })
      return
    }
    const pathname = new URL(route.request().url()).searchParams.get("pathname") ?? "items/x/original.jpg"
    const url = `https://fakestore.public.blob.vercel-storage.com/${pathname}`
    await json(route, 200, {
      url,
      downloadUrl: `${url}?download=1`,
      pathname,
      contentType: "image/jpeg",
      contentDisposition: "inline",
      etag: '"fake"',
    })
  })
  await page.route("**/api/items/register", async (route) => {
    if (registerGate !== null) await registerGate
    const { itemId } = route.request().postDataJSON() as { itemId: string }
    const item: ItemCardDto = cardFor(itemId, { images: { thumb, processed: thumb, nobg: null } })
    await json(route, 200, { ok: true, data: { duplicate: false, item } })
  })
  await page.route("**/api/items/*/tag", async (route) => {
    const itemId = new URL(route.request().url()).pathname.split("/")[3] ?? ""
    const { status, body } = answerTag(itemId)
    await json(route, status, body)
  })

  return {
    answerTags(answer) {
      answerTag = answer
    },
    holdRegister() {
      let release = () => {}
      registerGate = new Promise<void>((resolve) => {
        release = () => {
          registerGate = null
          resolve()
        }
      })
      return { release: () => release() }
    },
  }
}

async function signInToAdd(page: Page): Promise<void> {
  await page.goto("/add")
  await expect(page).toHaveURL((url) => url.pathname === "/login")
  await expect(page.locator('input[type="hidden"][name="next"]')).toHaveValue("/add")
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === "/add")
}

async function photos(count: number, prefix: string): Promise<PhotoFixture[]> {
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      makeJpegFixture(`${prefix}-${index + 1}.jpg`, { r: (index * 11) % 256, g: 90 + index, b: 200 - index }),
    ),
  )
}

async function choose(page: Page, fixtures: PhotoFixture[]): Promise<void> {
  await page.getByLabel("Choose photos").setInputFiles(
    fixtures.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })),
  )
}

/** Picks a file that is not a photo, which the page skips with a warning toast. */
async function chooseNotAPhoto(page: Page): Promise<void> {
  await page.getByLabel("Choose photos").setInputFiles([
    { name: "e2e-notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a photo") },
  ])
}

function queueStatus(page: Page) {
  return page.getByRole("status").filter({ hasText: /of \d+ photos? uploaded/ })
}

function tagBar(page: Page) {
  return page.getByRole("region", { name: "Tagging" })
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: false })
  await testInfo.attach(name, { path, contentType: "image/png" })
}

type Box = { x: number; y: number; width: number; height: number }

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

test.describe("the add page's tagging controls, with storage and Claude faked in the browser", () => {
  let fakes: Fakes

  test.beforeEach(async ({ page, baseURL }) => {
    fakes = await fakeStorageAndClaude(page, baseURL ?? "http://localhost:3000")
    await signInToAdd(page)
  })

  test("two ready photos get a quote, the remaining budget and Start tagging", async ({ page }, testInfo) => {
    await choose(page, await photos(2, "e2e-tag-two"))
    await expect(queueStatus(page)).toHaveText("2 of 2 photos uploaded.")

    const bar = tagBar(page)
    await expect(bar).toContainText(/Tag 2 items ≈ (< )?\$\d+\.\d\d \(Haiku 5\.5\)/)
    await expect(bar).toContainText(/\$\d+\.\d\d left this month/)
    await expect(bar.getByRole("button", { name: /Tag as a batch/ })).toHaveCount(0)
    for (const [label, size] of [
      ["two-ready-desktop", DESKTOP],
      ["two-ready-phone", PHONE],
    ] as const) {
      await page.setViewportSize(size)
      await expect(bar.getByRole("button", { name: "Start tagging" })).toBeInViewport()
      await shoot(page, testInfo, label)
    }

    await bar.getByRole("button", { name: "Start tagging" }).click()
    await expect(bar).toContainText("All 2 items tagged")
    await expect(page.getByRole("main").getByText("Tagged", { exact: true })).toHaveCount(2)
  })

  test("21 ready photos add the batch offer, and error toasts stay above the bar", async ({ page }, testInfo) => {
    await choose(page, await photos(21, "e2e-tag-batch"))
    await expect(queueStatus(page)).toHaveText("21 of 21 photos uploaded.", { timeout: 30_000 })

    const bar = tagBar(page)
    const batch = bar.getByRole("button", { name: /^Tag as a batch \(≈ (< )?\$\d+\.\d\d\)$/ })
    await expect(batch).toBeVisible()
    for (const [label, size] of [
      ["batch-offer-desktop", DESKTOP],
      ["batch-offer-phone", PHONE],
    ] as const) {
      await page.setViewportSize(size)
      // Scrolled to the top, the list runs past the fold and the bar sticks to the bottom.
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect(batch).toBeInViewport()
      await shoot(page, testInfo, label)
    }

    fakes.answerTags(unavailable)
    await bar.getByRole("button", { name: "Start tagging" }).click()
    const toastMessage = page.locator('[data-slot="toast"]').filter({ hasText: "Claude is overloaded" })
    await expect(toastMessage).toBeVisible()
    for (const [label, size] of [
      ["toast-above-bar-phone", PHONE],
      ["toast-above-bar-desktop", DESKTOP],
    ] as const) {
      await page.setViewportSize(size)
      await page.evaluate(() => window.scrollTo(0, 0))
      // The toasts follow the bar's measured position; give the layout a frame to settle.
      await expect
        .poll(async () => {
          const [toastBox, barBox] = await Promise.all([toastMessage.boundingBox(), bar.boundingBox()])
          return toastBox !== null && barBox !== null && !overlaps(toastBox, barBox)
        })
        .toBe(true)
      await shoot(page, testInfo, label)
    }
  })

  test("with a short list the bar is not stuck, and toasts still stay off it", async ({ page }, testInfo) => {
    await choose(page, await photos(2, "e2e-tag-short"))
    await expect(queueStatus(page)).toHaveText("2 of 2 photos uploaded.")
    const bar = tagBar(page)
    const toastMessage = page.locator('[data-slot="toast"]').filter({ hasText: "Skipped 1 file" })

    for (const [label, size, stickyOffset] of [
      ["short-list-toast-phone", PHONE, 72],
      ["short-list-toast-desktop", DESKTOP, 24],
    ] as const) {
      await page.setViewportSize(size)
      await page.evaluate(() => window.scrollTo(0, 0))
      // The page is shorter than the window, so the bar sits in the flow, above its sticky place.
      const barBox = await bar.boundingBox()
      expect(barBox).not.toBeNull()
      expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThan(size.height - stickyOffset - 1)

      await chooseNotAPhoto(page)
      await expect(toastMessage).toBeVisible()
      await expect
        .poll(async () => {
          const [toastBox, box] = await Promise.all([toastMessage.boundingBox(), bar.boundingBox()])
          return toastBox !== null && box !== null && !overlaps(toastBox, box)
        })
        .toBe(true)
      await expect(bar.getByRole("button", { name: "Start tagging" })).toBeInViewport()
      await shoot(page, testInfo, label)
      // Base UI hides a toast's close button from assistive tech until the toasts are focused or hovered.
      await toastMessage.getByRole("button", { name: "Close toast", includeHidden: true }).click()
      await expect(toastMessage).toBeHidden()
    }
  })

  test("a budget refusal stops tagging and shows the budget alert", async ({ page }, testInfo) => {
    fakes.answerTags(budgetReached)
    await choose(page, await photos(2, "e2e-tag-budget"))
    await expect(queueStatus(page)).toHaveText("2 of 2 photos uploaded.")

    await tagBar(page).getByRole("button", { name: "Start tagging" }).click()

    const alert = page.getByRole("alert").filter({ hasText: "AI budget reached" })
    await expect(alert).toContainText("Monthly AI budget reached")
    await expect(tagBar(page).getByRole("button", { name: "Start tagging" })).toBeDisabled()
    await page.setViewportSize(PHONE)
    await shoot(page, testInfo, "budget-reached-phone")
  })

  test("leaving while an upload is still running asks first", async ({ page }, testInfo) => {
    await page.setViewportSize(PHONE)
    const [first, second] = await photos(2, "e2e-tag-leave")
    if (first === undefined || second === undefined) throw new Error("fixtures missing")
    await choose(page, [first])
    await expect(queueStatus(page)).toHaveText("1 of 1 photo uploaded.")

    const held = fakes.holdRegister()
    await choose(page, [second])
    await expect(queueStatus(page)).toContainText("1 in progress")

    await tagBar(page).getByRole("link", { name: "Review 1 item" }).click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog).toContainText("Leave this page?")
    await expect(dialog).toContainText("1 photo is still being uploaded.")
    await shoot(page, testInfo, "leave-dialog-phone")
    await dialog.getByRole("button", { name: "Stay here" }).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL((url) => url.pathname === "/add")

    held.release()
    await expect(queueStatus(page)).toHaveText("2 of 2 photos uploaded.")
    // Nothing is running any more, so the link simply navigates.
    await tagBar(page).getByRole("link", { name: "Review 2 items" }).click()
    await expect(page).toHaveURL((url) => url.pathname === "/add/review")
  })

  test("coming back after leaving starts with an empty list, and leaving again does not ask", async ({
    page,
  }, testInfo) => {
    await choose(page, await photos(2, "e2e-tag-return"))
    await expect(queueStatus(page)).toHaveText("2 of 2 photos uploaded.")

    await tagBar(page).getByRole("link", { name: "Review 2 items" }).click()
    await expect(page).toHaveURL((url) => url.pathname === "/add/review")
    await expect(page.getByRole("heading", { level: 1, name: "Review items" })).toBeVisible()

    // Next keeps /add in a hidden <Activity> and shows that same page again.
    const primary = page.getByRole("navigation", { name: "Primary" })
    await primary.getByRole("link", { name: "Add", exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === "/add")
    await expect(page.getByRole("heading", { level: 1, name: "Add items" })).toBeVisible()
    await expect(page.getByRole("main").getByRole("listitem")).toHaveCount(0)
    await expect(tagBar(page)).toHaveCount(0)
    await expect(queueStatus(page)).toHaveCount(0)
    await shoot(page, testInfo, "returned-empty-desktop")

    await primary.getByRole("link", { name: "Wardrobe", exact: true }).click()
    await expect(page).toHaveURL((url) => url.pathname === "/wardrobe")
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
  })
})
