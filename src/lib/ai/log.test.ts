import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aiCalls, items } from "@/lib/db/schema";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeItem } from "../../../test/factories";
import { logAiCall, type AiCallRecord } from "./log";

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

function call(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  return { model: "claude-haiku-5-5", purpose: "tagging", status: "success", costUsd: 0.004, ...overrides };
}

describe("logAiCall", () => {
  it("records the call linked to its item", async () => {
    const item = await makeItem(testDb.db);
    await logAiCall(testDb.db, call({ itemId: item.id }));
    expect(await testDb.db.select().from(aiCalls)).toMatchObject([{ itemId: item.id, costUsd: 0.004 }]);
  });

  it("still records the spend when the item was deleted during the call", async () => {
    const item = await makeItem(testDb.db);
    await testDb.db.delete(items).where(eq(items.id, item.id));
    await logAiCall(testDb.db, call({ itemId: item.id }));
    expect(await testDb.db.select().from(aiCalls)).toMatchObject([{ itemId: null, costUsd: 0.004 }]);
  });

  it("lets every other insert failure through", async () => {
    // Not a valid status: the enum rejects it, and nothing is written.
    await expect(logAiCall(testDb.db, call({ status: "bogus" as AiCallRecord["status"] }))).rejects.toThrow();
    expect(await testDb.db.select().from(aiCalls)).toHaveLength(0);
  });
});
