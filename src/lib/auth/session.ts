import "server-only";

import { cookies } from "next/headers";

import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./token";

// The session cookie. Writing it only works in Server Actions and Route
// Handlers; reading it makes the caller dynamic, so pages read it inside a
// <Suspense> child (through the DAL), never in the static shell.

const COOKIE_OPTIONS = {
  httpOnly: true,
  // Browsers treat http://localhost as a secure context, so local production
  // builds and Playwright still receive the cookie.
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_TTL_SECONDS });
}

export async function clearSessionCookie(): Promise<void> {
  // Same attributes as when set, with maxAge 0, so the browser replaces and
  // drops exactly that cookie.
  (await cookies()).set(SESSION_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
}

export async function readSessionCookie(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}
