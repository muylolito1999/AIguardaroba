import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { aiBatches, items, type Item } from "@/lib/db/schema";
import type { ItemPatchInput } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeItem, makeTaggedItem } from "../../../test/factories";
import { createFakeAnthropic } from "../../../test/fakes/anthropic";
import { COAT_TAGS } from "../../../test/fixtures/item-tags";

// Wiring of the item actions: session check, input validation and Result
// shape. The services behind them have their own tests. There is no API key
// here: the Anthropic getter throws CONFIG, as in an unconfigured deployment,
// unless a test hands it the fake client.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
  getAnthropic: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));
vi.mock("@/lib/ai/client", () => ({ getAnthropic: mocks.getAnthropic }));

const actions = await import("./items");

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

async function row(id: string): Promise<Item> {
  const [found] = await testDb.db.select().from(items).where(eq(items.id, id));
  if (found === undefined) throw new Error(`item ${id} is gone`);
  return found;
}

/** Every required tag and a season, as the "Fill in by hand" form sends them. */
const HAND_TAGS = {
  name: "Grey wool scarf",
  category: "scarf",
  colors: ["grey"],
  color_hex: ["#808080"],
  warmth_level: 3,
  waterproof: false,
  windproof: true,
  insulated: false,
  seasons: ["winter"],
  formality: "casual",
  condition: "good",
} satisfies ItemPatchInput;

describe("item actions", () => {
  it("polls batches without needing an API key when none is open", async () => {
    expect(await actions.pollTaggingBatches()).toEqual({
      ok: true,
      data: { batches: 0, processed: 0, tagged: 0, failed: 0, pending: 0, errors: [] },
    });
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("polls open batches with the review page's 10 s request timeout", async () => {
    const fake = createFakeAnthropic();
    mocks.getAnthropic.mockReset();
    mocks.getAnthropic.mockReturnValue(fake);
    const created = await fake.messages.batches.create({ requests: [] });
    await testDb.db
      .insert(aiBatches)
      .values({ anthropicBatchId: created.id, purpose: "tagging", model: "claude-haiku-5-5", requestCount: 0 });

    expect(await actions.pollTaggingBatches()).toEqual({
      ok: true,
      data: { batches: 0, processed: 0, tagged: 0, failed: 0, pending: 1, errors: [] },
    });
    const retrieve = fake.batchCalls.find((call) => call.method === "retrieve");
    expect(retrieve?.options.timeout).toBe(10_000);
  });

  it("tags a pending item by hand, and confirms it when asked", async () => {
    const first = await makeItem(testDb.db);
    const second = await makeItem(testDb.db);
    expect(await actions.tagItemByHand({ id: first.id, patch: HAND_TAGS, confirm: false })).toMatchObject({
      ok: true,
      data: { id: first.id, status: "tagged", name: "Grey wool scarf", aiModel: null },
    });
    expect(await actions.tagItemByHand({ id: second.id, patch: HAND_TAGS, confirm: true })).toMatchObject({
      ok: true,
      data: { id: second.id, status: "confirmed" },
    });
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("validates the hand-tagging input before calling the service", async () => {
    const item = await makeItem(testDb.db);
    const malformed: unknown[] = [
      { id: "nope", patch: HAND_TAGS, confirm: false },
      { id: item.id, patch: HAND_TAGS },
      { id: item.id, patch: { ...HAND_TAGS, status: "tagged" }, confirm: false },
      { id: item.id, patch: { ...HAND_TAGS, warmth_level: 9 }, confirm: false },
    ];
    for (const input of malformed) {
      // Deliberately malformed: the client could send anything.
      expect(await actions.tagItemByHand(input as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect((await actions.tagItemByHand({ id: item.id, patch: {}, confirm: true })).ok).toBe(false);
    expect((await row(item.id)).status).toBe("pending_tagging");
  });

  it("returns hand-tagging refusals as Err results with their details", async () => {
    const item = await makeItem(testDb.db);
    const noSeason: ItemPatchInput = { ...HAND_TAGS };
    delete noSeason.seasons;
    expect(await actions.tagItemByHand({ id: item.id, patch: noSeason, confirm: true })).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "Fill in seasons first.", details: { itemId: item.id, missing: ["seasons"] } },
    });
    const tagged = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    expect(await actions.tagItemByHand({ id: tagged.id, patch: HAND_TAGS, confirm: false })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
  });

  it("saves an edit and returns the updated card", async () => {
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    const result = await actions.updateItemTags({ id: item.id, patch: { brand: "Hackett" } });
    expect(result).toMatchObject({ ok: true, data: { id: item.id, brand: "Hackett", userEditedFields: ["brand"] } });
  });

  it("confirms with and without a patch", async () => {
    const first = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    const second = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    expect(await actions.confirmItem({ id: first.id })).toMatchObject({ ok: true, data: { status: "confirmed" } });
    expect(await actions.confirmItem({ id: second.id, patch: { waterproof: true } })).toMatchObject({
      ok: true,
      data: { status: "confirmed", waterproof: true },
    });
  });

  it("returns service errors as Err results", async () => {
    const pending = await makeItem(testDb.db);
    expect(await actions.confirmItem({ id: pending.id })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("confirms only tagged items in bulk", async () => {
    const tagged = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    const pending = await makeItem(testDb.db);
    expect(await actions.confirmItems({ ids: [tagged.id, pending.id] })).toEqual({ ok: true, data: { confirmed: 1 } });
  });

  it("validates input before calling a service", async () => {
    expect(await actions.updateItemTags({ id: "nope", patch: {} })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    const twenty = Array.from({ length: 20 }, () => randomUUID());
    expect(await actions.startTaggingBatch({ itemIds: twenty })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Signed out."));
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    expect(await actions.confirmItems({ ids: [item.id] })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
    expect(await actions.pollTaggingBatches()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    const pending = await makeItem(testDb.db);
    expect(await actions.tagItemByHand({ id: pending.id, patch: HAND_TAGS, confirm: true })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });
});
