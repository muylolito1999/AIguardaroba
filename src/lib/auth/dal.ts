import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { sessionEnv } from "@/env";
import { AppError } from "@/lib/result";

import { readSessionCookie } from "./session";
import { verifySessionToken, type SessionPayload } from "./token";

// Data Access Layer session checks (D-013). proxy.ts is only an optimistic
// filter: it lets requests carrying a Next-Action header through, and that
// header can be forged. So every Server Action, Route Handler and server read
// or service function calls one of these itself, close to the data:
//
// - verifySession(): pages and Server Components. Redirects to /login.
// - requireSession(): actions, routes and services. Throws UNAUTHENTICATED,
//   which the authedAction/authedRoute wrappers turn into a 401-style result.
//
// Both read the cookie, so a page must call them inside a <Suspense> child,
// never in its static shell. Exceptions: the login and logout actions, which
// must work without a valid session.

export type Session = SessionPayload;

/** The current session, or null. Memoized per request, so repeated checks verify the token once. */
export const getSession = cache(async (): Promise<Session | null> => {
  const token = await readSessionCookie();
  if (token === undefined || token === "") return null;
  // A missing SESSION_SECRET throws CONFIG here instead of looking like a
  // signed-out visitor, so a misconfiguration fails loudly.
  return verifySessionToken(token, sessionEnv().SESSION_SECRET);
});

/** For pages and Server Components: the session, or a redirect to /login. */
export async function verifySession(): Promise<Session> {
  const session = await getSession();
  if (session === null) redirect("/login");
  return session;
}

/** For actions, routes and services: the session, or AppError('UNAUTHENTICATED'). */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (session === null) throw new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again.");
  return session;
}
