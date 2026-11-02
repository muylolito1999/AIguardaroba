import { expect, test, type Page } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// token.ts stays free of `server-only` (which throws outside Next), so the
// specs share the real cookie name.
import { SESSION_COOKIE } from "@/lib/auth/token";
import { relations } from "@/lib/db/relations";

import { makeTaggedItem } from "../test/factories";
import { E2E_DATABASE_URL, E2E_PASSWORD } from "./constants";

// Single-user auth against the production build (playwright.config.ts). Each
// test gets a fresh browser context, so every signed-in test signs in itself.

// Files browsers and the service worker fetch without cookies (D-013).
const PUBLIC_PATHS = ["/manifest.webmanifest", "/sw.js", "/offline", "/icons/icon-192.png", "/icon.svg"];
const REDIRECT_STATUSES = [302, 303, 307, 308];
// Rendered by the (app) layout on every signed-in page.
const APP_CHROME_MARKER = "Skip to content";
const CANARY_ITEM_NAME = "Forged action canary coat";
// Shaped like a Next.js action id; no real action has it.
const FORGED_ACTION_ID = "00".repeat(21);

function isLoginRedirectFor(target: string): (url: URL) => boolean {
  return (url) => url.pathname === "/login" && url.searchParams.get("next") === target;
}

function isPath(pathname: string): (url: URL) => boolean {
  return (url) => url.pathname === pathname;
}

async function signIn(page: Page, password: string = E2E_PASSWORD): Promise<void> {
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function sessionCookie(page: Page) {
  const cookies = await page.context().cookies();
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE);
}

test("a signed-out page request redirects to /login with next", async ({ request, page }) => {
  const response = await request.get("/wardrobe", { maxRedirects: 0 });
  expect(REDIRECT_STATUSES).toContain(response.status());
  const location = new URL(response.headers()["location"] ?? "", response.url());
  expect(`${location.pathname}${location.search}`).toBe("/login?next=%2Fwardrobe");

  await page.goto("/wardrobe");
  await expect(page).toHaveURL((url) => url.pathname === "/login" && url.search === "?next=%2Fwardrobe");
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("PWA files and the offline page load without a session", async ({ request }) => {
  for (const path of PUBLIC_PATHS) {
    // No redirects followed: a bounce to /login would also end in a 200.
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
  }
});

test("an API request without a session gets a 401 JSON error", async ({ request }) => {
  const response = await request.get("/api/anything", { maxRedirects: 0 });
  expect(response.status()).toBe(401);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
});

test("a wrong password shows an error and stays on /login", async ({ page }) => {
  await page.goto("/login");
  await signIn(page, "not-the-e2e-password");

  // Scoped to main: Next's route announcer is also an alert.
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText(/\S/);
  await expect(page).toHaveURL(isPath("/login"));
  expect(await sessionCookie(page)).toBeUndefined();
});

test("the right password signs in with an httpOnly, Secure, SameSite=Lax cookie", async ({ page }) => {
  await page.goto("/login");
  await signIn(page);
  await expect(page).toHaveURL(isPath("/wardrobe"));

  expect(await sessionCookie(page)).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });
});

test("signing in returns to the page named in next", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(isLoginRedirectFor("/settings"));
  // The hidden field renders after hydration; waiting for it makes this the
  // JavaScript path (the no-JavaScript test below covers the Referer path).
  await expect(page.locator('input[type="hidden"][name="next"]')).toHaveValue("/settings");
  await signIn(page);
  await expect(page).toHaveURL(isPath("/settings"));
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test("logging out from Settings ends the session", async ({ page }) => {
  await page.goto("/login");
  await signIn(page);
  await expect(page).toHaveURL(isPath("/wardrobe"));

  await page.goto("/settings");
  // Scoped to main: the desktop sidebar has a second Log out button.
  await page.getByRole("main").getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(isPath("/login"));
  expect(await sessionCookie(page)).toBeUndefined();

  await page.goto("/wardrobe");
  await expect(page).toHaveURL(isLoginRedirectFor("/wardrobe"));
});

// D-054: the form posts natively before hydration or without JavaScript. The
// error must come back as a full page, and `next` (whose hidden field renders
// only on the client) is recovered from the Referer.
test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("a wrong password shows the error", async ({ page }) => {
    await page.goto("/login");
    await signIn(page, "not-the-e2e-password");

    await expect(page.getByRole("main").getByRole("alert")).toHaveText(/\S/);
    await expect(page).toHaveURL(isPath("/login"));
    expect(await sessionCookie(page)).toBeUndefined();
  });

  test("signing in works and returns to the page named in next", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(isLoginRedirectFor("/settings"));
    await signIn(page);
    await expect(page).toHaveURL(isPath("/settings"));
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    expect(await sessionCookie(page)).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
  });
});

test("a cookieless POST with a forged Next-Action header returns no app data", async ({ request }) => {
  // A confirmed item that any page rendering the wardrobe would show.
  const pool = new Pool({ connectionString: E2E_DATABASE_URL, max: 1 });
  try {
    await makeTaggedItem(drizzle({ client: pool, relations }), { name: CANARY_ITEM_NAME, status: "confirmed" });
  } finally {
    await pool.end();
  }

  // Proxy lets Next-Action requests through, so the DAL checks must hold (D-013).
  const response = await request.post("/wardrobe", {
    headers: {
      "Next-Action": FORGED_ACTION_ID,
      "Content-Type": "text/plain;charset=UTF-8",
      Accept: "text/x-component",
    },
    data: "[]",
    maxRedirects: 0,
  });
  const status = response.status();
  const body = await response.text();

  expect(body, `status ${status} leaked item data`).not.toContain(CANARY_ITEM_NAME);
  const servedAppShell = status === 200 && body.includes(APP_CHROME_MARKER);
  expect(servedAppShell, "a 200 response carried the signed-in app shell").toBe(false);
});

test("visiting /login while signed in goes to /wardrobe", async ({ page }) => {
  await page.goto("/login");
  await signIn(page);
  await expect(page).toHaveURL(isPath("/wardrobe"));

  const response = await page.request.get("/login", { maxRedirects: 0 });
  expect(REDIRECT_STATUSES).toContain(response.status());
  expect(new URL(response.headers()["location"] ?? "", response.url()).pathname).toBe("/wardrobe");

  await page.goto("/login");
  await expect(page).toHaveURL(isPath("/wardrobe"));
});

// "/.//evil.com" passes a raw "starts with //" check but normalizes to the
// protocol-relative "//evil.com"; both the proxy and the login action must
// keep the visitor on this origin.
test("a next that normalizes to another host is ignored", async ({ page, baseURL }) => {
  const offSite = `/login?${new URLSearchParams({ next: "/.//evil.com" })}`;
  await page.goto(offSite);
  await signIn(page);
  await expect(page).toHaveURL((url) => url.origin === new URL(baseURL ?? "").origin && url.pathname === "/wardrobe");

  const response = await page.request.get(offSite, { maxRedirects: 0 });
  expect(REDIRECT_STATUSES).toContain(response.status());
  const location = new URL(response.headers()["location"] ?? "", response.url());
  expect(location.origin).toBe(new URL(baseURL ?? "").origin);
  expect(location.pathname).toBe("/wardrobe");
});
