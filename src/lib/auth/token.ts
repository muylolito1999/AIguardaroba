// Session token signing and verification. Kept free of `server-only` and
// `next/headers` so proxy.ts, the DAL and tests can all share it; the secret is
// always passed in by the caller, never read here.

import { jwtVerify, SignJWT } from "jose";

// The __Host- prefix makes browsers accept the cookie only when it is Secure,
// has Path=/ and no Domain (session.ts sets exactly that), so a sibling
// subdomain or a plain-HTTP response cannot plant or shadow it (cookie
// tossing). Chromium honours it on http://localhost as well, so local
// production builds and e2e runs keep working.
export const SESSION_COOKIE = "__Host-wardrobe_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const ISSUER = "wardrobe";
const AUDIENCE = "wardrobe";
const SUBJECT = "owner";

/** The verified claims of a session. There is one user, so `sub` is always "owner". */
export type SessionPayload = { sub: typeof SUBJECT; iat: number; exp: number };

function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Signs a 30-day HS256 session token for the owner, issued at `now`. */
export async function signSessionToken(secret: string, now: Date = new Date()): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(SUBJECT)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_TTL_SECONDS)
    .sign(signingKey(secret));
}

/**
 * Returns the session claims, or null for any token that is not a valid,
 * unexpired session signed with `secret`. It never throws: a bad cookie is an
 * ordinary "signed out", not an error.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<SessionPayload | null> {
  if (token === "" || secret === "") return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(secret), {
      // Pinned so a token can never pick its own algorithm (alg confusion);
      // jose rejects "none" regardless.
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: SUBJECT,
      requiredClaims: ["iat", "exp"],
      // Bounds the age by `iat` as well as `exp`, so no token outlives the
      // 30-day TTL whatever its exp says, and tokens issued in the future fail.
      maxTokenAge: SESSION_TTL_SECONDS,
      currentDate: now,
    });
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
    return { sub: SUBJECT, iat: payload.iat, exp: payload.exp };
  } catch {
    return null;
  }
}
