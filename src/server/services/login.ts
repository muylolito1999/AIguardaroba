import "server-only";

import { verifyPassword } from "@/lib/auth/password";
import { markLoginAttemptSucceeded, pruneLoginAttempts, reserveLoginAttempt } from "@/lib/auth/rate-limit";
import type { Db } from "@/lib/db/client";
import { err, ok, type Result } from "@/lib/result";

// The password check behind the login action. It runs without a session by
// design (it is how a session starts), so it is the one service that does not
// call the DAL. Dependencies are injected so PGlite tests can drive it.

export type AttemptLoginInput = {
  db: Db;
  password: string;
  /** clientKeyHash(ip, SESSION_SECRET); see client-key.ts. */
  keyHash: string;
  /** clientPrefixHash(ip, SESSION_SECRET); defaults to keyHash (an IPv4 client). */
  prefixHash?: string;
  now: Date;
  /** The decoded bcrypt hash (passwordEnv().passwordHash). */
  passwordHash: string;
  /** Defaults to bcrypt; tests pass a spy. */
  verify?: (password: string, bcryptHash: string) => Promise<boolean>;
};

export const WRONG_PASSWORD_MESSAGE = "Wrong password";

export function rateLimitedMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts — try again in ${minutes} min`;
}

/**
 * Prunes old attempts, checks the per-client limit before any bcrypt work,
 * verifies the password and records the outcome. The attempt is recorded as a
 * failure while it is reserved and marked a success only once the password
 * matched, so concurrent requests always see it.
 */
export async function attemptLogin({
  db,
  password,
  keyHash,
  prefixHash = keyHash,
  now,
  passwordHash,
  verify = verifyPassword,
}: AttemptLoginInput): Promise<Result<void>> {
  await pruneLoginAttempts(db, now);

  const reservation = await reserveLoginAttempt(db, keyHash, now, prefixHash);
  if (!reservation.allowed) {
    return err("RATE_LIMITED", rateLimitedMessage(reservation.retryAfterSeconds), {
      retryAfterSeconds: reservation.retryAfterSeconds,
    });
  }

  if (!(await verify(password, passwordHash))) return err("UNAUTHENTICATED", WRONG_PASSWORD_MESSAGE);

  await markLoginAttemptSucceeded(db, reservation.attemptId);
  return ok(undefined);
}
