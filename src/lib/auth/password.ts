import "server-only";

import { compare, hash } from "bcryptjs";

import { decodePasswordHash } from "@/env";
import { AppError } from "@/lib/result";

// Password hashing for the single owner account. APP_PASSWORD_HASH holds the
// base64 of a bcrypt hash because @next/env expands `$` in .env files (D-015).

export const MIN_PASSWORD_CHARS = 10;
// bcrypt only reads the first 72 bytes; longer passwords would be silently
// truncated, so they are refused instead.
export const MAX_PASSWORD_BYTES = 72;
export const BCRYPT_COST = 12;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Throws AppError('VALIDATION') unless the password has at least 10 characters and at most 72 UTF-8 bytes. */
export function assertPasswordAcceptable(password: string): void {
  // Counted in code points, so an emoji is one character, not two UTF-16 units.
  if ([...password].length < MIN_PASSWORD_CHARS) {
    throw new AppError("VALIDATION", `The password must have at least ${MIN_PASSWORD_CHARS} characters.`);
  }
  if (utf8Bytes(password) > MAX_PASSWORD_BYTES) {
    throw new AppError(
      "VALIDATION",
      `The password must be at most ${MAX_PASSWORD_BYTES} bytes in UTF-8 (accented letters and emoji take 2 to 4 bytes each).`,
    );
  }
}

/** Hashes `password` with bcrypt and returns the base64 value for APP_PASSWORD_HASH. */
export async function hashForEnv(password: string, cost: number = BCRYPT_COST): Promise<string> {
  assertPasswordAcceptable(password);
  const bcryptHash = await hash(password, cost);
  return Buffer.from(bcryptHash, "utf8").toString("base64");
}

/** The bcrypt hash inside an APP_PASSWORD_HASH value, or null when the value is not base64 of one. */
export function decodeStoredHash(base64: string): string | null {
  return decodePasswordHash(base64);
}

/** True when `password` matches the bcrypt hash. */
export async function verifyPassword(password: string, bcryptHash: string): Promise<boolean> {
  // A stored password is never longer than 72 bytes, so a longer input cannot
  // be correct; refusing it also stops a match on the truncated prefix.
  if (password.length === 0 || utf8Bytes(password) > MAX_PASSWORD_BYTES) return false;
  return compare(password, bcryptHash);
}
