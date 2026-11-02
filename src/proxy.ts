import { NextResponse, type NextRequest } from "next/server";

import { sessionEnv } from "@/env";
import { safeRedirect } from "@/lib/auth/safe-redirect";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/token";
import { err } from "@/lib/result";

// Optimistic auth gate (D-010, D-013). It only checks that the session cookie
// holds a valid token; it is not the security boundary. Every action, route
// and server read calls the DAL (src/lib/auth/dal.ts) itself, because requests
// carrying a Next-Action header are let through here and that header can be
// forged.
//
// Public paths are decided by config.matcher alone. It is D-013's matcher with
// three changes:
// - /login is matched, so a visitor who is already signed in is sent on to the
//   app instead of seeing the form. decideAuth always lets a signed-out visitor
//   through to /login, so it stays public and the static page needs no session
//   read of its own.
// - robots.txt is excluded, so crawlers get the file (or a 404) rather than a
//   redirect to /login.
// - vendor/bg-removal/ is excluded: it holds only the open-source runtime of
//   background removal (D-081), static files that need no session check.

export type AuthInput = {
  pathname: string;
  /** The query string including "?", or "". */
  search: string;
  hasValidToken: boolean;
  /** A POST carrying a Next-Action header (a Server Action call). */
  isAction: boolean;
};

export type AuthDecision =
  | { type: "next" }
  /** A same-origin path with query. */
  | { type: "redirect"; location: string }
  | { type: "unauthorized" };

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** The pure gate decision for one request that reached the proxy. */
export function decideAuth({ pathname, search, hasValidToken, isAction }: AuthInput): AuthDecision {
  // API clients get a status they can act on, never an HTML redirect. A
  // Next-Action header means nothing here, so it buys no pass.
  if (isApiPath(pathname)) return hasValidToken ? { type: "next" } : { type: "unauthorized" };

  // Server Actions answer for themselves (requireSession); redirecting their
  // POST would also break the action protocol.
  if (isAction) return { type: "next" };

  if (pathname === "/login") {
    if (!hasValidToken) return { type: "next" };
    return { type: "redirect", location: safeRedirect(new URLSearchParams(search).get("next")) };
  }

  if (hasValidToken) return { type: "next" };
  return { type: "redirect", location: `/login?${new URLSearchParams({ next: `${pathname}${search}` })}` };
}

let reportedMissingSecret = false;

function sessionSecret(): string | null {
  try {
    return sessionEnv().SESSION_SECRET;
  } catch (error) {
    // Fail closed: without the secret no token can be trusted. Logged once per
    // instance because the proxy runs on every request.
    if (!reportedMissingSecret) {
      reportedMissingSecret = true;
      console.error("[proxy] SESSION_SECRET is unusable; every request is treated as signed out.", error);
    }
    return null;
  }
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token === undefined || token === "") return false;
  const secret = sessionSecret();
  return secret !== null && (await verifySessionToken(token, secret)) !== null;
}

export async function proxy(request: NextRequest): Promise<Response> {
  const { pathname, search } = request.nextUrl;
  const decision = decideAuth({
    pathname,
    search,
    hasValidToken: await hasValidSession(request),
    isAction: request.method === "POST" && request.headers.has("next-action"),
  });

  switch (decision.type) {
    case "next":
      return NextResponse.next();
    case "unauthorized":
      return NextResponse.json(err("UNAUTHENTICATED", "Sign in to continue."), {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
    case "redirect": {
      // 303 turns a redirected form POST into a GET of the login page.
      const status = request.method === "GET" || request.method === "HEAD" ? 307 : 303;
      return NextResponse.redirect(new URL(decision.location, request.url), status);
    }
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|icons/|manifest\\.webmanifest$|sw\\.js$|robots\\.txt$|offline$|vendor/bg-removal/|api/blob/upload$|api/cron/).*)",
  ],
};
