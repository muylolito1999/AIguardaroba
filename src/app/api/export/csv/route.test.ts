import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CSV_BOM, CSV_EOL, ITEM_CSV_HEADERS } from "@/lib/export/csv";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../../../test/db";
import { makeTaggedItem } from "../../../../../test/factories";

// Wiring of GET /api/export/csv: session check and download headers. The
// rows themselves are covered by the CSV and export service tests.

const ORIGIN = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));

const route = await import("./route");

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

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.close();
});

function get(headers: Record<string, string> = {}) {
  return route.GET(new Request(`${ORIGIN}/api/export/csv`, { headers }), { params: Promise.resolve({}) });
}

describe("GET /api/export/csv", () => {
  it("allows a minute", () => {
    expect(route.maxDuration).toBe(60);
  });

  it("streams a dated, uncached CSV attachment with a BOM", async () => {
    const item = await makeTaggedItem(testDb.db);

    const response = await get({ "sec-fetch-site": "same-origin" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="wardrobe-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).slice(CSV_BOM.length).split(CSV_EOL);
    expect(lines[0]).toBe(ITEM_CSV_HEADERS.join(","));
    expect(lines[1]?.startsWith(`${item.id},`)).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it("answers 401 without a session", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again."));
    const response = await get();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  it("refuses a download another site started", async () => {
    const response = await get({ "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(403);
  });
});
