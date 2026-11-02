import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckHashesDataSchema, resultSchema } from "@/lib/items/contracts";

import { makeTestDb, type TestDb } from "../../../../../test/db";
import { makeItem } from "../../../../../test/factories";

// Wiring only: the service has its own tests.

const ORIGIN = "http://localhost:3000";

const mocks = vi.hoisted(() => ({ requireSession: vi.fn(), db: { current: undefined as unknown } }));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));

const { POST } = await import("./route");

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterAll(async () => {
  await testDb.close();
});

function call(body: unknown) {
  const request = new Request(`${ORIGIN}/api/items/check-hashes`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({}) });
}

describe("POST /api/items/check-hashes", () => {
  it("answers the known hashes as a Result the client schema accepts", async () => {
    const item = await makeItem(testDb.db, { sourceHash: "1".repeat(64) });

    const response = await call({ sourceHashes: ["1".repeat(64), "2".repeat(64)] });

    expect(response.status).toBe(200);
    expect(resultSchema(CheckHashesDataSchema).parse(await response.json())).toEqual({
      ok: true,
      data: { known: { ["1".repeat(64)]: item.id } },
    });
  });

  it("rejects malformed hashes and an empty list", async () => {
    expect((await call({ sourceHashes: ["XYZ"] })).status).toBe(400);
    expect((await call({ sourceHashes: [] })).status).toBe(400);
  });
});
