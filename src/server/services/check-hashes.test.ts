import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeItem } from "../../../test/factories";
import { checkHashes } from "./check-hashes";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterAll(async () => {
  await testDb.close();
});

describe("checkHashes", () => {
  it("maps each known source hash to its item and leaves unknown ones out", async () => {
    const a = await makeItem(testDb.db, { sourceHash: HASH_A });
    const b = await makeItem(testDb.db, { sourceHash: HASH_B, status: "archived" });
    await makeItem(testDb.db, { sourceHash: null });

    expect(await checkHashes(testDb.db, [HASH_A, HASH_B, HASH_C, HASH_A])).toEqual({
      known: { [HASH_A]: a.id, [HASH_B]: b.id },
    });
  });

  it("answers an empty map when nothing matches", async () => {
    expect(await checkHashes(testDb.db, [HASH_C])).toEqual({ known: {} });
    expect(await checkHashes(testDb.db, [])).toEqual({ known: {} });
  });

  it("checks the session before reading", async () => {
    await makeItem(testDb.db, { sourceHash: HASH_A });
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in"));
    await expect(checkHashes(testDb.db, [HASH_A])).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
