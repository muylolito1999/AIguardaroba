import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resultSchema, TagDataSchema } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../../../../test/db";
import { makeImage, makeTaggedItem } from "../../../../../../test/factories";
import { COAT_TAGS } from "../../../../../../test/fixtures/item-tags";

// Wiring only: tagItem has its own tests. No API key exists here, so the
// Anthropic getter throws CONFIG, which only a real tagging call would reach.

const ORIGIN = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
  getAnthropic: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));
vi.mock("@/lib/ai/client", () => ({ getAnthropic: mocks.getAnthropic }));

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
  mocks.getAnthropic.mockReset();
  mocks.getAnthropic.mockImplementation(() => {
    throw new AppError("CONFIG", "ANTHROPIC_API_KEY is required.");
  });
});

afterAll(async () => {
  await testDb.close();
});

function call(id: string, body: unknown) {
  const request = new Request(`${ORIGIN}/api/items/${id}/tag`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
  return route.POST(request, { params: Promise.resolve({ id }) });
}

describe("POST /api/items/[id]/tag", () => {
  it("allows a minute, of which tagging uses at most 50 s", () => {
    expect(route.maxDuration).toBe(60);
  });

  it("answers a tagged item from the cache with a Result the client schema accepts", async () => {
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    await makeImage(testDb.db, item.id);

    const response = await call(item.id, {});

    expect(response.status).toBe(200);
    const parsed = resultSchema(TagDataSchema).parse(await response.json());
    expect(parsed).toMatchObject({ ok: true, data: { cached: true, item: { id: item.id, status: "tagged" } } });
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("refuses a malformed id with VALIDATION", async () => {
    const response = await call("not-a-uuid", {});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("refuses a body with unknown keys", async () => {
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    const response = await call(item.id, { force: true, model: "claude-opus-5-5" });
    expect(response.status).toBe(400);
  });

  it("answers 404 for an unknown item", async () => {
    const response = await call("6f1c8e2a-3b4d-4c5e-8f90-a1b2c3d4e5f6", { force: false });
    expect(response.status).toBe(404);
  });

  it("passes the card's batch id on, so a stale 'Tag now instead' gets the applied tags for free", async () => {
    // Tagged and in no batch: the batch the card still shows was applied meanwhile.
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    await makeImage(testDb.db, item.id);

    const response = await call(item.id, { force: true, batchId: randomUUID() });

    expect(response.status).toBe(200);
    const parsed = resultSchema(TagDataSchema).parse(await response.json());
    expect(parsed).toMatchObject({ ok: true, data: { cached: true, item: { id: item.id } } });
    // Without the batch id, force would have reached the Anthropic getter.
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("forces a re-tag when no batch id is sent", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    await makeImage(testDb.db, item.id);

    const response = await call(item.id, { force: true });

    // The getter throws CONFIG here (no API key), which proves a call was attempted.
    expect(response.status).toBe(500);
    expect(mocks.getAnthropic).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("refuses a batch id that is not a uuid with VALIDATION", async () => {
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    const response = await call(item.id, { force: true, batchId: "batch-1" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", details: { issues: [expect.objectContaining({ path: "batchId" })] } },
    });
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });
});
