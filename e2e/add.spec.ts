import { expect, test, type Page } from "@playwright/test"
import { Pool } from "pg"

import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants"
import { makeJpegFixture, type PhotoFixture } from "./fixtures/images"

// The add flow against the e2e server, which has no BLOB_READ_WRITE_TOKEN and
// no ANTHROPIC_API_KEY (playwright.config.ts). The page must still render,
// prepare and check photos, and then say clearly that uploads are not
// configured, for each photo and in a toast, without creating any item.

const CONFIG_STATUS = "Failed: Uploads are not configured on the server."

async function signInTo(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page).toHaveURL((url) => url.pathname === "/login")
  // The hidden next field renders after hydration (see auth.spec.ts).
  await expect(page.locator('input[type="hidden"][name="next"]')).toHaveValue(path)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page).toHaveURL((url) => url.pathname === path)
}

async function countItems(sourceHashes: string[]): Promise<{ total: number; matching: number }> {
  const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 1 })
  try {
    const { rows } = await pool.query<{ total: number; matching: number }>(
      "select count(*)::int as total, (count(*) filter (where source_hash = any($1::text[])))::int as matching from items",
      [sourceHashes],
    )
    return rows[0] ?? { total: 0, matching: 0 }
  } finally {
    await pool.end()
  }
}

function rowFor(page: Page, fixture: PhotoFixture) {
  // Scoped to main: the sidebar and the tab bar are lists too.
  return page.getByRole("main").getByRole("listitem").filter({ has: page.getByTitle(fixture.name, { exact: true }) })
}

test("without a Blob token, picked photos are checked and then fail with a clear configuration error", async ({
  page,
}) => {
  const fixtures = [
    await makeJpegFixture("e2e-shirt-red.jpg", { r: 200, g: 40, b: 40 }),
    await makeJpegFixture("e2e-shirt-blue.jpg", { r: 40, g: 60, b: 200 }),
  ]
  const hashes = fixtures.map((fixture) => fixture.sourceHash)
  const before = await countItems(hashes)
  expect(before.matching).toBe(0)

  await signInTo(page, "/add")
  await expect(page.getByRole("heading", { level: 1, name: "Add items" })).toBeVisible()

  const camera = page.getByLabel("Take photo")
  await expect(camera).toHaveAttribute("type", "file")
  await expect(camera).toHaveAttribute("capture", "environment")
  await expect(camera).toHaveAttribute("accept", "image/*")
  await expect(camera).toHaveAttribute("multiple", "")

  // Hold the hash check so the Checking state can be asserted before it moves on.
  let releaseCheck = () => {}
  const checkHeld = new Promise<void>((resolve) => {
    releaseCheck = resolve
  })
  await page.route("**/api/items/check-hashes", async (route) => {
    await checkHeld
    await route.continue()
  })
  // The browser's put() from @vercel/blob/client uploads to the Blob API on
  // vercel.com; blob.vercel-storage.com is only the public read host. Uploads
  // are recorded and stopped, so none can reach a store during the test.
  const blobStoreRequests: string[] = []
  await page.route("https://vercel.com/api/blob/**", async (route) => {
    blobStoreRequests.push(route.request().url())
    await route.abort()
  })
  page.on("request", (request) => {
    if (new URL(request.url()).hostname.endsWith("blob.vercel-storage.com")) blobStoreRequests.push(request.url())
  })

  await page.getByLabel("Choose photos").setInputFiles(
    fixtures.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })),
  )

  for (const fixture of fixtures) {
    await expect(rowFor(page, fixture)).toContainText("Checking")
  }
  releaseCheck()

  for (const fixture of fixtures) {
    const row = rowFor(page, fixture)
    await expect(row).toContainText(CONFIG_STATUS)
    await expect(row.getByRole("button", { name: `Retry ${fixture.name}` })).toBeVisible()
  }
  const toastMessage = page.locator('[data-slot="toast"]').filter({ hasText: "Configuration problem" })
  await expect(toastMessage).toBeVisible()
  await expect(toastMessage).toContainText("Uploads are not configured on the server.")
  await expect(page.getByRole("status").filter({ hasText: "photos uploaded" })).toHaveText(
    "0 of 2 photos uploaded, 2 failed.",
  )

  // No upload went to the Blob API, nothing was read from the store, and no item was created.
  expect(blobStoreRequests).toEqual([])
  const after = await countItems(hashes)
  expect(after.matching).toBe(0)
  expect(after.total).toBe(before.total)
})
