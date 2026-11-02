import { createHash } from "node:crypto";

import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { relations } from "@/lib/db/relations";
import { loginAttempts } from "@/lib/db/schema";

import { makeTestDb, type TestDb } from "../../../test/db";
import { clientKeyHash, getClientIp, rateLimitAddress } from "./client-key";
import {
  ATTEMPT_RETENTION_MS,
  checkLoginAllowed,
  clearLoginAttempts,
  FAILURE_WINDOW_MS,
  GLOBAL_ALERT_THRESHOLD,
  markLoginAttemptSucceeded,
  pruneLoginAttempts,
  recordLoginAttempt,
  reserveLoginAttempt,
} from "./rate-limit";

const SECRET = "test-session-secret-0123456789abcdef";
const OWNER_IP = "203.0.113.7";
const OWNER = clientKeyHash(OWNER_IP, SECRET);
const ATTACKER = clientKeyHash("198.51.100.66", SECRET);
const T0 = new Date("2026-11-02T08:00:00Z");
const MINUTE = 60_000;

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.close();
});

async function fail(keyHash: string, times: number, when: Date | ((i: number) => Date)): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await recordLoginAttempt(testDb.db, keyHash, false, typeof when === "function" ? when(i) : when);
  }
}

describe("checkLoginAllowed", () => {
  it("allows a fresh key", async () => {
    expect(await checkLoginAllowed(testDb.db, OWNER, T0)).toEqual({ allowed: true });
  });

  it("allows 4 failures and locks on the 5th within 15 minutes", async () => {
    await fail(OWNER, 4, (i) => at(i * MINUTE));
    expect(await checkLoginAllowed(testDb.db, OWNER, at(5 * MINUTE))).toEqual({ allowed: true });

    await recordLoginAttempt(testDb.db, OWNER, false, at(5 * MINUTE));
    const gate = await checkLoginAllowed(testDb.db, OWNER, at(6 * MINUTE));
    // The oldest of the 5 (t=0) leaves the window at t=15 min: 9 minutes from t=6.
    expect(gate).toEqual({ allowed: false, retryAfterSeconds: 9 * 60 });
  });

  it("unlocks once the 5th most recent failure is 15 minutes old", async () => {
    await fail(OWNER, 5, T0);
    expect((await checkLoginAllowed(testDb.db, OWNER, at(FAILURE_WINDOW_MS - 1000))).allowed).toBe(false);
    expect(await checkLoginAllowed(testDb.db, OWNER, at(FAILURE_WINDOW_MS))).toEqual({ allowed: true });
    expect(await checkLoginAllowed(testDb.db, OWNER, at(FAILURE_WINDOW_MS + 1000))).toEqual({ allowed: true });
  });

  it("reports at least one second to wait", async () => {
    await fail(OWNER, 5, T0);
    expect(await checkLoginAllowed(testDb.db, OWNER, at(FAILURE_WINDOW_MS - 10))).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("does not let a success erase earlier failures", async () => {
    await fail(OWNER, 4, (i) => at(i * MINUTE));
    await recordLoginAttempt(testDb.db, OWNER, true, at(4 * MINUTE));
    expect((await checkLoginAllowed(testDb.db, OWNER, at(5 * MINUTE))).allowed).toBe(true);

    await recordLoginAttempt(testDb.db, OWNER, false, at(5 * MINUTE));
    expect((await checkLoginAllowed(testDb.db, OWNER, at(6 * MINUTE))).allowed).toBe(false);
  });

  it("does not count successes as failures", async () => {
    for (let i = 0; i < 10; i += 1) await recordLoginAttempt(testDb.db, OWNER, true, at(i * MINUTE));
    expect(await checkLoginAllowed(testDb.db, OWNER, at(10 * MINUTE))).toEqual({ allowed: true });
  });

  it("has no global lock: 300 failures from other keys leave a fresh key allowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = Array.from({ length: 300 }, (_, i) => ({
      keyHash: clientKeyHash(`198.51.100.${i % 250}`, SECRET) + (i >= 250 ? "-b" : ""),
      success: false,
      attemptedAt: at(-(i % 50) * 1000),
    }));
    await testDb.db.insert(loginAttempts).values(rows);

    expect(await checkLoginAllowed(testDb.db, OWNER, T0)).toEqual({ allowed: true });
    // The spike above the alert threshold is logged once for the call, without key hashes.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("300 failed logins");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(rows[0]?.keyHash ?? "missing");
  });

  it("stays quiet at or below the alert threshold", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await testDb.db.insert(loginAttempts).values(
      Array.from({ length: GLOBAL_ALERT_THRESHOLD }, (_, i) => ({
        keyHash: `key-${i}`,
        success: false,
        attemptedAt: at(-i * 1000),
      })),
    );
    await checkLoginAllowed(testDb.db, OWNER, T0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("only counts failures from the last hour towards the alert", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await testDb.db.insert(loginAttempts).values(
      Array.from({ length: GLOBAL_ALERT_THRESHOLD + 50 }, (_, i) => ({
        keyHash: `key-${i}`,
        success: false,
        attemptedAt: at(-61 * MINUTE),
      })),
    );
    await checkLoginAllowed(testDb.db, OWNER, T0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps keys independent", async () => {
    await fail(ATTACKER, 5, T0);
    expect((await checkLoginAllowed(testDb.db, ATTACKER, at(MINUTE))).allowed).toBe(false);
    expect(await checkLoginAllowed(testDb.db, OWNER, at(MINUTE))).toEqual({ allowed: true });
  });
});

describe("reserveLoginAttempt", () => {
  it("records the attempt as a failure until it is marked a success", async () => {
    const reservation = await reserveLoginAttempt(testDb.db, OWNER, T0);
    if (!reservation.allowed) throw new Error("expected the reservation to be allowed");

    let rows = await testDb.db.select().from(loginAttempts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: reservation.attemptId, keyHash: OWNER, success: false });
    expect(rows[0]?.attemptedAt.toISOString()).toBe(T0.toISOString());

    await markLoginAttemptSucceeded(testDb.db, reservation.attemptId);
    rows = await testDb.db.select().from(loginAttempts);
    expect(rows[0]?.success).toBe(true);
  });

  it("refuses without recording anything once the key is locked", async () => {
    await fail(OWNER, 5, T0);
    expect(await reserveLoginAttempt(testDb.db, OWNER, at(MINUTE))).toEqual({
      allowed: false,
      retryAfterSeconds: 14 * 60,
    });
    expect(await testDb.db.$count(loginAttempts)).toBe(5);
  });

  // PGlite runs transactions one at a time, so this cannot show that parallel
  // requests on separate connections are serialized; rate-limit.pg.test.ts
  // checks that against real Postgres. It does pin the reservation logic.
  it("lets 5 of 12 attempts started together through for one key", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => reserveLoginAttempt(testDb.db, ATTACKER, T0)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(await testDb.db.$count(loginAttempts)).toBe(5);
  });

  it("takes the per-key advisory lock before counting, inside the transaction", async () => {
    const statements: string[] = [];
    const logged = drizzle({
      client: testDb.client,
      relations,
      logger: { logQuery: (query) => statements.push(query.toLowerCase()) },
    });
    // The PGlite driver opens the transaction through the client, so BEGIN is
    // not logged; the spy shows the statements run in one.
    const transaction = vi.spyOn(logged, "transaction");
    await reserveLoginAttempt(logged, OWNER, T0);

    expect(transaction).toHaveBeenCalledTimes(1);
    const count = statements.findIndex((query) => query.startsWith("select") && query.includes('from "login_attempts"'));
    const insert = statements.findIndex((query) => query.startsWith('insert into "login_attempts"'));
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(count).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(count);
  });
});

describe("pruneLoginAttempts and clearLoginAttempts", () => {
  it("deletes only attempts older than 24 hours", async () => {
    await recordLoginAttempt(testDb.db, OWNER, false, at(-ATTEMPT_RETENTION_MS - 1000));
    await recordLoginAttempt(testDb.db, OWNER, true, at(-ATTEMPT_RETENTION_MS - 60 * MINUTE));
    await recordLoginAttempt(testDb.db, OWNER, false, at(-ATTEMPT_RETENTION_MS + 1000));
    await recordLoginAttempt(testDb.db, ATTACKER, false, T0);

    expect(await pruneLoginAttempts(testDb.db, T0)).toBe(2);
    const left = await testDb.db.select({ attemptedAt: loginAttempts.attemptedAt }).from(loginAttempts);
    expect(left.map((row) => row.attemptedAt.getTime()).sort()).toEqual(
      [at(-ATTEMPT_RETENTION_MS + 1000).getTime(), T0.getTime()].sort(),
    );
    expect(await pruneLoginAttempts(testDb.db, T0)).toBe(0);
  });

  it("clears every attempt and unlocks the key", async () => {
    await fail(OWNER, 5, T0);
    await fail(ATTACKER, 3, T0);
    expect(await clearLoginAttempts(testDb.db)).toBe(8);
    expect(await checkLoginAllowed(testDb.db, OWNER, at(MINUTE))).toEqual({ allowed: true });
  });
});

describe("client keys", () => {
  it("are the hex sha256 of ip|secret", () => {
    expect(OWNER).toBe(createHash("sha256").update(`${OWNER_IP}|${SECRET}`).digest("hex"));
  });

  it("come from the first x-forwarded-for entry, then x-real-ip, then 'unknown'", () => {
    expect(getClientIp(new Headers({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" }))).toBe("203.0.113.7");
    expect(getClientIp(new Headers({ "x-real-ip": "198.51.100.1" }))).toBe("198.51.100.1");
    expect(getClientIp(new Headers({ "x-forwarded-for": " , ", "x-real-ip": "198.51.100.1" }))).toBe("198.51.100.1");
    expect(getClientIp(new Headers())).toBe("unknown");
  });

  it("group an IPv6 client by its /64 network", () => {
    const sameNetwork = [
      "2001:db8:1234:5678::1",
      "2001:db8:1234:5678:ffff:ffff:ffff:ffff",
      "2001:0DB8:1234:5678:0:0:0:abcd",
      "2001:db8:1234:5678:a:b:c:d%eth0",
    ];
    for (const ip of sameNetwork) {
      expect(rateLimitAddress(ip), ip).toBe("2001:db8:1234:5678::/64");
      expect(clientKeyHash(ip, SECRET), ip).toBe(clientKeyHash(sameNetwork[0] ?? "", SECRET));
    }
    expect(clientKeyHash("2001:db8:1234:5679::1", SECRET)).not.toBe(clientKeyHash("2001:db8:1234:5678::1", SECRET));
    expect(rateLimitAddress("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitAddress("fe80::1")).toBe("fe80:0:0:0::/64");
  });

  it("treat an IPv4-mapped IPv6 address as the plain IPv4 address", () => {
    expect(rateLimitAddress("::ffff:203.0.113.7")).toBe(OWNER_IP);
    expect(rateLimitAddress("::FFFF:cb00:7107")).toBe(OWNER_IP);
    expect(rateLimitAddress("0:0:0:0:0:ffff:203.0.113.7")).toBe(OWNER_IP);
    expect(clientKeyHash("::ffff:203.0.113.7", SECRET)).toBe(OWNER);
    // Different IPv4 addresses stay separate clients.
    expect(clientKeyHash("::ffff:203.0.113.8", SECRET)).not.toBe(OWNER);
  });

  it("keep IPv4 and non-addresses as they are", () => {
    expect(rateLimitAddress(" 203.0.113.7 ")).toBe(OWNER_IP);
    expect(rateLimitAddress("unknown")).toBe("unknown");
    expect(rateLimitAddress("not-an-ip")).toBe("not-an-ip");
  });
});

describe("privacy", () => {
  it("stores a salted hash, never the raw IP", async () => {
    await recordLoginAttempt(testDb.db, OWNER, false, T0);
    await reserveLoginAttempt(testDb.db, OWNER, T0);

    const rows = await testDb.db.select().from(loginAttempts);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(OWNER_IP);
    }
    // The raw table holds no IP in any column either.
    const raw = await testDb.client.query("select * from login_attempts");
    expect(JSON.stringify(raw.rows)).not.toContain(OWNER_IP);
    // The key depends on the secret, so it cannot be rebuilt from the IP alone.
    expect(clientKeyHash(OWNER_IP, "a-different-secret-0123456789abcd")).not.toBe(OWNER);
  });
});
