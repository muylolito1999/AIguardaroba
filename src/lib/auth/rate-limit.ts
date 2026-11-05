import "server-only";

import { and, desc, eq, gt, lt, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { loginAttempts } from "@/lib/db/schema";

// Login rate limiting stored in Postgres, because in-memory counters do not
// survive serverless instances (D-014). Every function takes `now` instead of
// using SQL now(), so tests drive a fake clock.
//
// Per key (sha256 of ip|SESSION_SECRET, see client-key.ts): 5 failures within
// 15 minutes lock that key until the oldest of them is 15 minutes old.
// Per prefix (an IPv6 client's /48; for IPv4 the prefix is the key itself):
// 25 failures within 15 minutes lock every key in it the same way (D-243).
// Successes never erase failures. There is deliberately no global lock: any
// anonymous visitor could trip it and lock the owner out. A burst of failures
// across all keys only logs a warning; `pnpm auth:unlock` clears everything.

export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_WINDOW = 5;
export const MAX_FAILURES_PER_PREFIX = 25;
export const GLOBAL_ALERT_WINDOW_MS = 60 * 60 * 1000;
export const GLOBAL_ALERT_THRESHOLD = 200;
export const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

// First half of the two-key advisory lock, so these locks cannot collide with
// any other advisory lock the app might take later. Arbitrary but fixed.
const ADVISORY_LOCK_NAMESPACE = 0x10617;

export type LoginGate = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function before(now: Date, ms: number): Date {
  return new Date(now.getTime() - ms);
}

async function warnOnFailureSpike(db: Db, now: Date): Promise<void> {
  const failures = await db.$count(
    loginAttempts,
    and(eq(loginAttempts.success, false), gt(loginAttempts.attemptedAt, before(now, GLOBAL_ALERT_WINDOW_MS))),
  );
  if (failures > GLOBAL_ALERT_THRESHOLD) {
    // Alert only: locking globally would hand anonymous visitors a way to lock
    // the owner out. Key hashes are not logged; they identify clients.
    console.warn(
      `[auth] ${failures} failed logins across all clients in the last hour (alert threshold ${GLOBAL_ALERT_THRESHOLD}). ` +
        "Per-client limits still apply; run `pnpm auth:unlock` if the owner is locked out.",
    );
  }
}

/**
 * When `max` failures in the window lock `column = value`, the gate for it;
 * otherwise null. It unlocks when the max-th most recent failure leaves the window.
 */
async function lockFor(
  db: Db,
  column: typeof loginAttempts.keyHash | typeof loginAttempts.prefixHash,
  value: string,
  max: number,
  now: Date,
): Promise<LoginGate | null> {
  const recentFailures = await db
    .select({ attemptedAt: loginAttempts.attemptedAt })
    .from(loginAttempts)
    .where(and(eq(column, value), eq(loginAttempts.success, false), gt(loginAttempts.attemptedAt, before(now, FAILURE_WINDOW_MS))))
    .orderBy(desc(loginAttempts.attemptedAt))
    .limit(max);

  const oldestCounted = recentFailures[max - 1];
  if (oldestCounted === undefined) return null;
  const unlocksAt = oldestCounted.attemptedAt.getTime() + FAILURE_WINDOW_MS;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((unlocksAt - now.getTime()) / 1000)) };
}

/**
 * Whether `keyHash` may try a password now; when locked, how long until it may.
 * `prefixHash` (client-key.ts clientPrefixHash) defaults to the key, which is
 * what it is for IPv4. The per-key gate runs first, so a locked key costs one
 * indexed query; the table-wide spike count runs only for allowed attempts (D-243).
 */
export async function checkLoginAllowed(db: Db, keyHash: string, now: Date, prefixHash: string = keyHash): Promise<LoginGate> {
  const keyLock = await lockFor(db, loginAttempts.keyHash, keyHash, MAX_FAILURES_PER_WINDOW, now);
  if (keyLock !== null) return keyLock;
  if (prefixHash !== keyHash) {
    const prefixLock = await lockFor(db, loginAttempts.prefixHash, prefixHash, MAX_FAILURES_PER_PREFIX, now);
    if (prefixLock !== null) return prefixLock;
  }
  await warnOnFailureSpike(db, now);
  return { allowed: true };
}

/** Stores one attempt and returns its id. The key and prefix hashes are stored, never the IP. */
export async function recordLoginAttempt(
  db: Db,
  keyHash: string,
  success: boolean,
  now: Date,
  prefixHash: string = keyHash,
): Promise<string> {
  const [row] = await db
    .insert(loginAttempts)
    .values({ keyHash, prefixHash, success, attemptedAt: now })
    .returning({ id: loginAttempts.id });
  if (row === undefined) throw new Error("recordLoginAttempt: insert returned no row");
  return row.id;
}

export type LoginReservation = { allowed: true; attemptId: string } | { allowed: false; retryAfterSeconds: number };

/**
 * Checks the limits and, when allowed, records the attempt as a failure in one
 * step that is serialized per prefix (a transaction-scoped advisory lock; for
 * IPv4 the prefix is the key). Without this, parallel requests could all pass
 * the check during the slow bcrypt compare and get far more guesses than the
 * limits allow. The caller marks the attempt as a success afterwards if the
 * password was right.
 */
export async function reserveLoginAttempt(
  db: Db,
  keyHash: string,
  now: Date,
  prefixHash: string = keyHash,
): Promise<LoginReservation> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, hashtext(${prefixHash}))`);
    const gate = await checkLoginAllowed(tx, keyHash, now, prefixHash);
    if (!gate.allowed) return gate;
    const attemptId = await recordLoginAttempt(tx, keyHash, false, now, prefixHash);
    return { allowed: true, attemptId };
  });
}

/** Turns a reserved attempt into a success, so it no longer counts towards a lock. */
export async function markLoginAttemptSucceeded(db: Db, attemptId: string): Promise<void> {
  await db.update(loginAttempts).set({ success: true }).where(eq(loginAttempts.id, attemptId));
}

/** Deletes attempts older than 24 hours and returns how many were removed. */
export async function pruneLoginAttempts(db: Db, now: Date): Promise<number> {
  const removed = await db
    .delete(loginAttempts)
    .where(lt(loginAttempts.attemptedAt, before(now, ATTEMPT_RETENTION_MS)))
    .returning({ id: loginAttempts.id });
  return removed.length;
}

/** Deletes every attempt, unlocking all clients (`pnpm auth:unlock`). Returns how many were removed. */
export async function clearLoginAttempts(db: Db): Promise<number> {
  const removed = await db.delete(loginAttempts).returning({ id: loginAttempts.id });
  return removed.length;
}
