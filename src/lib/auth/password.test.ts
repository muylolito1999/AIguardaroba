import { getRounds } from "bcryptjs";
import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/result";

import {
  assertPasswordAcceptable,
  BCRYPT_COST,
  decodeStoredHash,
  hashForEnv,
  MAX_PASSWORD_BYTES,
  verifyPassword,
} from "./password";

// Cost 4 keeps the suite fast; the hash format is the same as at cost 12.
const FAST_COST = 4;
const PASSWORD = "correct horse battery staple";

function validationError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected AppError");
}

describe("hashForEnv / decodeStoredHash / verifyPassword", () => {
  it("round-trips: the base64 env value decodes to a bcrypt hash that verifies", async () => {
    const encoded = await hashForEnv(PASSWORD, FAST_COST);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(encoded).not.toContain("$");

    const bcryptHash = decodeStoredHash(encoded);
    expect(bcryptHash).toMatch(/^\$2[aby]\$04\$/);
    expect(await verifyPassword(PASSWORD, bcryptHash ?? "")).toBe(true);
  });

  it("uses cost 12 by default", async () => {
    expect(BCRYPT_COST).toBe(12);
    const bcryptHash = decodeStoredHash(await hashForEnv("a-strong-default-cost-pw"));
    expect(getRounds(bcryptHash ?? "")).toBe(12);
  }, 20_000);

  it("returns false for a wrong password", async () => {
    const bcryptHash = decodeStoredHash(await hashForEnv(PASSWORD, FAST_COST)) ?? "";
    expect(await verifyPassword("correct horse battery stapler", bcryptHash)).toBe(false);
    expect(await verifyPassword("", bcryptHash)).toBe(false);
  });

  it("rejects malformed stored values", () => {
    expect(decodeStoredHash("not base64!")).toBeNull();
    expect(decodeStoredHash(Buffer.from("plain text").toString("base64"))).toBeNull();
    expect(decodeStoredHash("$2b$12$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01")).toBeNull();
  });

  it("refuses a longer input that shares the stored password's first 72 bytes", async () => {
    const stored = "p".repeat(MAX_PASSWORD_BYTES);
    const bcryptHash = decodeStoredHash(await hashForEnv(stored, FAST_COST)) ?? "";
    expect(await verifyPassword(stored, bcryptHash)).toBe(true);
    expect(await verifyPassword(`${stored}extra`, bcryptHash)).toBe(false);
  });

  it("verifies a multibyte password", async () => {
    const password = "Grüße-aus-Bologna-🧥";
    const bcryptHash = decodeStoredHash(await hashForEnv(password, FAST_COST)) ?? "";
    expect(await verifyPassword(password, bcryptHash)).toBe(true);
    expect(await verifyPassword("Grusse-aus-Bologna-🧥", bcryptHash)).toBe(false);
  });
});

describe("assertPasswordAcceptable", () => {
  it("accepts exactly 10 characters and exactly 72 bytes", () => {
    expect(() => assertPasswordAcceptable("a".repeat(10))).not.toThrow();
    expect(() => assertPasswordAcceptable("a".repeat(72))).not.toThrow();
  });

  it("rejects 9 characters and 73 bytes with VALIDATION", () => {
    expect(validationError(() => assertPasswordAcceptable("a".repeat(9))).code).toBe("VALIDATION");
    expect(validationError(() => assertPasswordAcceptable("a".repeat(73))).code).toBe("VALIDATION");
  });

  it("counts characters as code points and the limit in UTF-8 bytes", () => {
    // 10 emoji: 10 characters (20 UTF-16 units), 40 bytes.
    expect(() => assertPasswordAcceptable("🧥".repeat(10))).not.toThrow();
    // 9 emoji: 18 UTF-16 units but only 9 characters.
    expect(validationError(() => assertPasswordAcceptable("🧥".repeat(9))).code).toBe("VALIDATION");
    // 18 emoji = 72 bytes passes; 19 = 76 bytes fails though only 19 characters.
    expect(() => assertPasswordAcceptable("🧥".repeat(18))).not.toThrow();
    expect(validationError(() => assertPasswordAcceptable("🧥".repeat(19))).message).toMatch(/72 bytes/);
    // "é" is 2 bytes: 36 of them fit, 37 do not.
    expect(() => assertPasswordAcceptable("é".repeat(36))).not.toThrow();
    expect(validationError(() => assertPasswordAcceptable("é".repeat(37))).code).toBe("VALIDATION");
  });

  it("never includes the password in the error", () => {
    const secretish = "short-pw";
    expect(validationError(() => assertPasswordAcceptable(secretish)).message).not.toContain(secretish);
  });

  it("is enforced by hashForEnv too", async () => {
    await expect(hashForEnv("too-short", FAST_COST)).rejects.toBeInstanceOf(AppError);
    await expect(hashForEnv("x".repeat(73), FAST_COST)).rejects.toBeInstanceOf(AppError);
  });
});
