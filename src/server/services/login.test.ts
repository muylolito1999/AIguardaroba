import { hashSync } from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { clientKeyHash } from "@/lib/auth/client-key";
import { verifyPassword } from "@/lib/auth/password";
import { recordLoginAttempt } from "@/lib/auth/rate-limit";
import { loginAttempts } from "@/lib/db/schema";

import { makeTestDb, type TestDb } from "../../../test/db";
import { attemptLogin } from "./login";

const PASSWORD = "correct horse battery staple";
// Cost 4 keeps the suite fast; production hashes use cost 12.
const PASSWORD_HASH = hashSync(PASSWORD, 4);
const KEY = clientKeyHash("203.0.113.7", "test-session-secret-0123456789abcdef");
const T0 = new Date("2026-11-02T08:00:00Z");
const MINUTE = 60_000;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
});

afterAll(async () => {
  await testDb.close();
});

function login(password: string, now: Date, verify = vi.fn(verifyPassword)) {
  return { verify, result: attemptLogin({ db: testDb.db, password, keyHash: KEY, now, passwordHash: PASSWORD_HASH, verify }) };
}

async function attempts() {
  return testDb.db
    .select({ success: loginAttempts.success, keyHash: loginAttempts.keyHash })
    .from(loginAttempts)
    .orderBy(loginAttempts.attemptedAt);
}

describe("attemptLogin", () => {
  it("returns ok for the correct password and records a success", async () => {
    const { result, verify } = login(PASSWORD, T0);
    expect(await result).toEqual({ ok: true, data: undefined });
    expect(verify).toHaveBeenCalledOnce();
    expect(await attempts()).toEqual([{ success: true, keyHash: KEY }]);
  });

  it("returns UNAUTHENTICATED 'Wrong password' and records a failure", async () => {
    const { result } = login("wrong password!", T0);
    expect(await result).toEqual({ ok: false, error: { code: "UNAUTHENTICATED", message: "Wrong password" } });
    expect(await attempts()).toEqual([{ success: false, keyHash: KEY }]);
  });

  it("records every verified attempt", async () => {
    await login("wrong-1-xxxxx", T0).result;
    await login(PASSWORD, new Date(T0.getTime() + MINUTE)).result;
    await login("wrong-2-xxxxx", new Date(T0.getTime() + 2 * MINUTE)).result;
    expect((await attempts()).map((row) => row.success)).toEqual([false, true, false]);
  });

  it("returns RATE_LIMITED before calling bcrypt once the key is locked", async () => {
    for (let i = 0; i < 5; i += 1) await login(`wrong-${i}-xxxxx`, new Date(T0.getTime() + i * MINUTE)).result;

    const { result, verify } = login(PASSWORD, new Date(T0.getTime() + 6 * MINUTE));
    expect(await result).toEqual({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many attempts — try again in 9 min",
        details: { retryAfterSeconds: 9 * 60 },
      },
    });
    expect(verify).not.toHaveBeenCalled();
    // The refused attempt is not recorded, so it does not extend the lock.
    expect(await attempts()).toHaveLength(5);
  });

  it("lets the correct password in once the lock has passed", async () => {
    for (let i = 0; i < 5; i += 1) await login(`wrong-${i}-xxxxx`, T0).result;
    expect(await login(PASSWORD, new Date(T0.getTime() + 15 * MINUTE)).result).toEqual({ ok: true, data: undefined });
  });

  it("prunes attempts older than 24 hours on each call", async () => {
    await recordLoginAttempt(testDb.db, "old-key", false, new Date(T0.getTime() - 25 * 60 * MINUTE));
    await login(PASSWORD, T0).result;
    expect(await attempts()).toEqual([{ success: true, keyHash: KEY }]);
  });

  it("rounds the wait up to whole minutes", async () => {
    for (let i = 0; i < 5; i += 1) await login(`wrong-${i}-xxxxx`, T0).result;
    const outcome = await login(PASSWORD, new Date(T0.getTime() + 14 * MINUTE + 59_000)).result;
    expect(outcome.ok ? null : outcome.error.message).toBe("Too many attempts — try again in 1 min");
  });
});
