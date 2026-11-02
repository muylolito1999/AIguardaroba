// Validates the `?next=` target used after login. Pure and dependency-free so
// proxy.ts, the login action and tests share one implementation.

import type { Route } from "next";

export const DEFAULT_AFTER_LOGIN = "/wardrobe";

const MAX_LENGTH = 2048;
// Browsers strip tabs and newlines anywhere in a URL and treat "\" like "/",
// so "/\t/evil.com" or "/\\evil.com" would become the protocol-relative
// "//evil.com". Any control character or backslash is therefore rejected
// outright rather than cleaned.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\]/;
// Only a base for parsing and the origin comparison; nothing is fetched.
const PARSE_BASE = "https://wardrobe.invalid";

function isLoginOrApi(pathname: string): boolean {
  // Landing back on /login after signing in would loop, and /api paths return
  // JSON or files rather than pages.
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/api" ||
    pathname.startsWith("/api/")
  );
}

/**
 * Returns `next` when it is a same-origin, path-absolute app URL, otherwise
 * `/wardrobe`. Accepts only values that start with a single "/" (not "//"),
 * contain no scheme, backslash or control character, do not normalize to a
 * "//" path, and do not point at /login or /api.
 */
export function safeRedirect(next: unknown): Route {
  const fallback = DEFAULT_AFTER_LOGIN as Route;
  if (typeof next !== "string" || next.length === 0 || next.length > MAX_LENGTH) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || UNSAFE_CHARACTERS.test(next)) return fallback;

  let url: URL;
  try {
    url = new URL(next, PARSE_BASE);
  } catch {
    return fallback;
  }
  // Belt and braces: whatever the string looked like, it must resolve to our
  // own origin. The normalized form (dot segments resolved, characters
  // percent-encoded) is what gets returned, so it is checked again: dot
  // segments can collapse into a protocol-relative path after the raw check
  // above ("/.//evil.com", "/a/..//evil.com" and "/%2e//evil.com" all
  // normalize to "//evil.com"), which a browser or new URL(location, base)
  // would resolve off-site.
  if (url.origin !== PARSE_BASE || url.pathname.startsWith("//")) return fallback;
  if (isLoginOrApi(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}` as Route;
}

/**
 * The raw `next` parameter of a Referer that is the login page, otherwise
 * undefined. A login form posted before hydration (or without JavaScript) has
 * no `next` field, because that field only renders on the client; the browser
 * posts the form to the page's own URL, so its Referer still carries `?next=`.
 * The value is untrusted like the form field and must go through safeRedirect.
 */
export function nextFromLoginReferer(referer: string | null | undefined): string | undefined {
  if (!referer || referer.length > MAX_LENGTH * 2) return undefined;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return undefined;
  }
  if (url.pathname !== "/login") return undefined;
  return url.searchParams.get("next") ?? undefined;
}
