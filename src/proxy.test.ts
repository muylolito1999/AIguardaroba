import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import nextConfig from "../next.config";
import { SESSION_COOKIE, signSessionToken } from "./lib/auth/token";
import { config, decideAuth, proxy, type AuthDecision, type AuthInput } from "./proxy";

const SECRET = "test-session-secret-0123456789abcdef";
const ORIGIN = "http://localhost:3000";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, init);
}

async function sessionCookie(now = new Date()): Promise<string> {
  return `${SESSION_COOKIE}=${await signSessionToken(SECRET, now)}`;
}

describe("decideAuth", () => {
  const base: AuthInput = { pathname: "/wardrobe", search: "", hasValidToken: false, isAction: false };
  const next: AuthDecision = { type: "next" };

  it.each<[string, Partial<AuthInput>, AuthDecision]>([
    ["page, token", { hasValidToken: true }, next],
    ["page, no token", {}, { type: "redirect", location: "/login?next=%2Fwardrobe" }],
    [
      "page with query, no token",
      { pathname: "/wardrobe", search: "?category=top&sort=new" },
      { type: "redirect", location: "/login?next=%2Fwardrobe%3Fcategory%3Dtop%26sort%3Dnew" },
    ],
    ["nested page, no token", { pathname: "/relocate/abc/print" }, { type: "redirect", location: "/login?next=%2Frelocate%2Fabc%2Fprint" }],
    ["action, token", { isAction: true, hasValidToken: true }, next],
    ["action, no token", { isAction: true }, next],
    ["api, token", { pathname: "/api/items/register", hasValidToken: true }, next],
    ["api, no token", { pathname: "/api/items/register" }, { type: "unauthorized" }],
    ["api root, no token", { pathname: "/api" }, { type: "unauthorized" }],
    ["api with a forged Next-Action header, no token", { pathname: "/api/export", isAction: true }, { type: "unauthorized" }],
    ["login, no token", { pathname: "/login" }, next],
    ["login with next, no token", { pathname: "/login", search: "?next=%2Frelocate" }, next],
    ["login, token", { pathname: "/login", hasValidToken: true }, { type: "redirect", location: "/wardrobe" }],
    ["login with next, token", { pathname: "/login", search: "?next=%2Frelocate%3Fstep%3D2", hasValidToken: true }, { type: "redirect", location: "/relocate?step=2" }],
    ["login with an unsafe next, token", { pathname: "/login", search: "?next=%2F%2Fevil.com", hasValidToken: true }, { type: "redirect", location: "/wardrobe" }],
    // Normalizes to "//evil.com", which new URL(location, request.url) would resolve off-site.
    ["login with a dot-segment next, token", { pathname: "/login", search: "?next=%2F.%2F%2Fevil.com", hasValidToken: true }, { type: "redirect", location: "/wardrobe" }],
    ["login with an encoded dot-segment next, token", { pathname: "/login", search: "?next=/%252e//evil.com", hasValidToken: true }, { type: "redirect", location: "/wardrobe" }],
    ["login form action, token", { pathname: "/login", isAction: true, hasValidToken: true }, next],
    ["a path merely starting with /api, no token", { pathname: "/apiary" }, { type: "redirect", location: "/login?next=%2Fapiary" }],
  ])("%s", (_label, overrides, expected) => {
    expect(decideAuth({ ...base, ...overrides })).toEqual(expected);
  });
});

describe("proxy()", () => {
  it("redirects a page request without a cookie to /login with next (307)", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const response = await proxy(request("/wardrobe?category=top"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?next=%2Fwardrobe%3Fcategory%3Dtop`);
  });

  it("answers an API request without a cookie with 401 JSON", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const response = await proxy(request("/api/x", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
  });

  it("passes a request with a valid session cookie", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const response = await proxy(request("/wardrobe", { headers: { cookie: await sessionCookie() } }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();

    const api = await proxy(request("/api/x", { headers: { cookie: await sessionCookie() } }));
    expect(api.headers.get("x-middleware-next")).toBe("1");
  });

  it("treats an expired or forged cookie as signed out", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const expired = await sessionCookie(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    expect((await proxy(request("/wardrobe", { headers: { cookie: expired } }))).status).toBe(307);

    const forged = `${SESSION_COOKIE}=${await signSessionToken("an-attacker-secret-0123456789abcdef")}`;
    expect((await proxy(request("/wardrobe", { headers: { cookie: forged } }))).status).toBe(307);
  });

  it("lets a Next-Action POST through without a cookie (the action checks the session)", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const response = await proxy(request("/wardrobe", { method: "POST", headers: { "next-action": "abc123" } }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not treat a GET with a Next-Action header as an action", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const response = await proxy(request("/wardrobe", { headers: { "next-action": "abc123" } }));
    expect(response.status).toBe(307);
  });

  it("redirects other signed-out POSTs to /login with 303", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const response = await proxy(request("/settings", { method: "POST" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?next=%2Fsettings`);
  });

  it("serves /login to signed-out visitors and sends signed-in ones on", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    expect((await proxy(request("/login?next=%2Frelocate"))).headers.get("x-middleware-next")).toBe("1");

    const cookie = await sessionCookie();
    const response = await proxy(request("/login?next=%2Frelocate", { headers: { cookie } }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/relocate`);
    expect((await proxy(request("/login", { headers: { cookie } }))).headers.get("location")).toBe(`${ORIGIN}/wardrobe`);
  });

  it("never redirects a signed-in visitor off-site through next", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const cookie = await sessionCookie();
    for (const next of ["/.//evil.com", "/a/..//evil.com", "/%2e//evil.com", "//evil.com", "https://evil.com"]) {
      const response = await proxy(request(`/login?${new URLSearchParams({ next })}`, { headers: { cookie } }));
      expect(response.headers.get("location"), next).toBe(`${ORIGIN}/wardrobe`);
    }
  });

  it("fails closed and logs once when SESSION_SECRET is missing", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    // A fresh module instance, so the once-only log flag starts unset.
    vi.resetModules();
    const fresh = await import("./proxy");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const cookie = await sessionCookie();
    const first = await fresh.proxy(request("/wardrobe", { headers: { cookie } }));
    const second = await fresh.proxy(request("/api/x", { headers: { cookie } }));

    expect(first.status).toBe(307);
    expect(second.status).toBe(401);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("SESSION_SECRET");
  });
});

describe("config.matcher", () => {
  // Next 16.4.3 ships this helper as unstable_doesMiddlewareMatch; the proxy
  // docs call it unstable_doesProxyMatch, a name the package does not export yet.
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, nextConfig, url });

  it.each([
    "/_next/static/chunks/main.js",
    "/_next/static/css/app.css",
    "/_next/image?url=%2Ficons%2Ficon-192.png&w=64&q=75",
    "/favicon.ico",
    "/icon.svg",
    "/apple-icon.png",
    "/icons/icon-192.png",
    "/icons/icon-maskable-512.png",
    "/manifest.webmanifest",
    "/sw.js",
    "/robots.txt",
    "/offline",
    "/vendor/bg-removal/imgly-1.7.0-ort-1.21.0/resources.json",
    "/vendor/bg-removal/imgly-1.7.0-ort-1.21.0/ort-wasm-simd-threaded.mjs",
    "/api/blob/upload",
    "/api/cron/poll-batches",
    "/api/cron/blob-cleanup",
  ])("leaves public %s alone", (url) => {
    expect(matches(url)).toBe(false);
  });

  it.each([
    "/",
    "/wardrobe",
    "/wardrobe?category=top",
    "/wardrobe/123e4567-e89b-12d3-a456-426614174000",
    "/add",
    "/add/review",
    "/relocate/abc/print",
    "/settings/usage",
    "/login",
    "/login?next=%2Fwardrobe",
    "/api/items/register",
    "/api/items/abc/tag",
    "/api/export/json",
    // Near misses of public names stay protected.
    "/offline-notes",
    "/sw.js.map",
    "/icons-custom",
    "/api/cron",
    "/api/blob/upload/extra",
    "/vendor",
    "/vendor/other",
  ])("runs on %s", (url) => {
    expect(matches(url)).toBe(true);
  });
});
