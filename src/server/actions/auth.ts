"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import type { Route } from "next";
import { z } from "zod";

import { passwordEnv, sessionEnv } from "@/env";
import { clientKeyHash, getClientIp } from "@/lib/auth/client-key";
import { nextFromLoginReferer, safeRedirect } from "@/lib/auth/safe-redirect";
import { clearSessionCookie, setSessionCookie } from "@/lib/auth/session";
import { signSessionToken } from "@/lib/auth/token";
import { getDb } from "@/lib/db";
import { toErrorPayload } from "@/lib/result";
import { attemptLogin } from "@/server/services/login";

// Login and logout are the two actions that run without a session: one
// creates it, the other only clears the caller's own cookie. Every other
// action goes through authedAction (./_wrap.ts).

/** State for useActionState(login, {}): `error` is shown under the password field. */
export type LoginState = { error?: string };

const loginSchema = z.object({
  password: z.string().min(1).max(1024),
  next: z.string().max(4096).optional(),
});

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const requestHeaders = await headers();
  const parsed = loginSchema.safeParse({
    password: field(formData, "password"),
    // The hidden `next` field renders only on the client, so a form posted
    // before hydration or without JavaScript lacks it (D-054).
    next: field(formData, "next") ?? nextFromLoginReferer(requestHeaders.get("referer")),
  });
  if (!parsed.success) return { error: "Enter your password." };

  let destination: Route;
  try {
    const { SESSION_SECRET } = sessionEnv();
    const { passwordHash } = passwordEnv();
    const now = new Date();
    const result = await attemptLogin({
      db: getDb(),
      password: parsed.data.password,
      keyHash: clientKeyHash(getClientIp(requestHeaders), SESSION_SECRET),
      now,
      passwordHash,
    });
    // The service's messages are written for this form: "Wrong password" or
    // "Too many attempts — try again in N min".
    if (!result.ok) return { error: result.error.message };

    await setSessionCookie(await signSessionToken(SESSION_SECRET, now));
    destination = safeRedirect(parsed.data.next);
  } catch (error) {
    unstable_rethrow(error);
    // Logged in full here because toErrorPayload replaces CONFIG and
    // unexpected errors with a generic message for this public form (D-053).
    console.error("[action login] failed:", error);
    return { error: toErrorPayload(error).message };
  }
  // redirect() throws, so it stays outside the try block.
  redirect(destination);
}

export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}
