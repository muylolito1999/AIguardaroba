import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { aiBatches, itemImages, items, type Item } from "@/lib/db/schema";
import type { ItemPatchInput } from "@/lib/items/contracts";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
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
    expect(
      await actions.tagItemByHand({ id: first.id, patch: HAND_TAGS, confirm: false, uncheckedDefaults: [] }),
    ).toMatchObject({
      ok: true,
      data: { id: first.id, status: "tagged", name: "Grey wool scarf", aiModel: null },
    });
    expect(
      await actions.tagItemByHand({ id: second.id, patch: HAND_TAGS, confirm: true, uncheckedDefaults: [] }),
    ).toMatchObject({
      ok: true,
      data: { id: second.id, status: "confirmed" },
    });
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("stores the defaults left alone without marking them as the owner's", async () => {
    const item = await makeItem(testDb.db);
    const result = await actions.tagItemByHand({
      id: item.id,
      patch: HAND_TAGS,
      confirm: false,
      uncheckedDefaults: ["warmth_level", "waterproof", "insulated"],
    });
    expect(result).toMatchObject({ ok: true, data: { warmthLevel: 3, waterproof: false, insulated: false } });
    expect((await row(item.id)).userEditedFields).toEqual([
      "name",
      "category",
      "colors",
      "color_hex",
      "windproof",
      "seasons",
      "formality",
      "condition",
    ]);
  });

  it("validates the hand-tagging input before calling the service", async () => {
    const item = await makeItem(testDb.db);
    const malformed: unknown[] = [
      { id: "nope", patch: HAND_TAGS, confirm: false, uncheckedDefaults: [] },
      { id: item.id, patch: HAND_TAGS, uncheckedDefaults: [] },
      { id: item.id, patch: HAND_TAGS, confirm: false },
      { id: item.id, patch: HAND_TAGS, confirm: false, uncheckedDefaults: ["name"] },
      { id: item.id, patch: HAND_TAGS, confirm: false, uncheckedDefaults: ["warmth_level", "warmth_level"] },
      { id: item.id, patch: { ...HAND_TAGS, status: "tagged" }, confirm: false, uncheckedDefaults: [] },
      { id: item.id, patch: { ...HAND_TAGS, warmth_level: 9 }, confirm: false, uncheckedDefaults: [] },
    ];
    for (const input of malformed) {
      // Deliberately malformed: the client could send anything.
      expect(await actions.tagItemByHand(input as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect((await actions.tagItemByHand({ id: item.id, patch: {}, confirm: true, uncheckedDefaults: [] })).ok).toBe(false);
    expect((await row(item.id)).status).toBe("pending_tagging");
  });

  it("refuses a default left alone that the patch does not hold", async () => {
    const item = await makeItem(testDb.db);
    // windproof is true in HAND_TAGS, not the form's false.
    expect(
      await actions.tagItemByHand({ id: item.id, patch: HAND_TAGS, confirm: true, uncheckedDefaults: ["windproof"] }),
    ).toEqual({
      ok: false,
      error: {
        code: "VALIDATION",
        message: "The form's default values did not match. Reload the page and try again.",
        details: { uncheckedDefaults: ["windproof"] },
      },
    });
    expect((await row(item.id)).status).toBe("pending_tagging");
  });

  it("returns hand-tagging refusals as Err results with their details", async () => {
    const item = await makeItem(testDb.db);
    const noSeason: ItemPatchInput = { ...HAND_TAGS };
    delete noSeason.seasons;
    expect(
      await actions.tagItemByHand({ id: item.id, patch: noSeason, confirm: true, uncheckedDefaults: [] }),
    ).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "Fill in seasons first.", details: { itemId: item.id, missing: ["seasons"] } },
    });
    const tagged = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    expect(
      await actions.tagItemByHand({ id: tagged.id, patch: HAND_TAGS, confirm: false, uncheckedDefaults: [] }),
    ).toMatchObject({
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
    expect(
      await actions.tagItemByHand({ id: pending.id, patch: HAND_TAGS, confirm: true, uncheckedDefaults: [] }),
    ).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
  });
});

// The detail page's actions. Their services have their own tests; here the
// wiring, the strict input schemas and, for delete, the missing Blob token
// (blank in every test run) are checked.
describe("item detail actions", () => {
  it("sets the decision and the location without marking a tag as edited", async () => {
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS, status: "confirmed" });

    expect(await actions.setItemDecision({ id: item.id, decision: "donate" })).toMatchObject({
      ok: true,
      data: { id: item.id, decision: "donate", location: "bologna", status: "confirmed", userEditedFields: [] },
    });
    expect(await actions.setItemLocation({ id: item.id, location: "in_transit" })).toMatchObject({
      ok: true,
      data: { id: item.id, decision: "donate", location: "in_transit" },
    });
    expect(await row(item.id)).toMatchObject({ decision: "donate", location: "in_transit", userEditedFields: [] });
  });

  it("validates the toggle and lifecycle input strictly", async () => {
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    // Deliberately malformed: the client could send anything.
    const malformed: Array<() => Promise<unknown>> = [
      () => actions.setItemDecision({ id: "nope", decision: "bring" }),
      () => actions.setItemDecision({ id: item.id, decision: "keep" } as never),
      () => actions.setItemDecision({ id: item.id, decision: "bring", location: "hamburg" } as never),
      () => actions.setItemDecision({ id: item.id } as never),
      () => actions.setItemLocation({ id: item.id, location: "berlin" } as never),
      () => actions.setItemLocation({ id: item.id, location: "hamburg", decision: "bring" } as never),
      () => actions.archiveItem({ id: "nope" }),
      () => actions.archiveItem({ id: item.id, status: "archived" } as never),
      () => actions.unarchiveItem({} as never),
      () => actions.deleteItem({ id: "nope" }),
      () => actions.deleteItem({ id: item.id, force: true } as never),
    ];
    for (const call of malformed) {
      expect(await call()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect(await row(item.id)).toMatchObject({ status: "tagged", decision: "undecided", location: "bologna" });
  });

  it("answers NOT_FOUND for an item that no longer exists", async () => {
    expect(await actions.setItemDecision({ id: randomUUID(), decision: "bring" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await actions.archiveItem({ id: randomUUID() })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("archives and unarchives, returning the detail", async () => {
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS, status: "confirmed", wearCount: 2 });
    expect(await actions.archiveItem({ id: item.id })).toMatchObject({
      ok: true,
      data: { id: item.id, status: "archived", wearCount: 2, original: null },
    });
    expect(await actions.unarchiveItem({ id: item.id })).toMatchObject({
      ok: true,
      data: { id: item.id, status: "confirmed" },
    });
  });

  it("refuses to delete without a Blob token and deletes nothing", async () => {
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    await makeImage(testDb.db, item.id, { kind: "original" });
    // The wrapper logs the CONFIG detail on the server (D-053).
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await actions.deleteItem({ id: item.id })).toEqual({
      ok: false,
      error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE },
    });

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    expect((await row(item.id)).id).toBe(item.id);
    expect(await testDb.db.select().from(itemImages).where(eq(itemImages.itemId, item.id))).toHaveLength(1);
  });

  it("refuses a signed-out caller before touching the item", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Signed out."));
    const item = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    for (const result of [
      await actions.setItemDecision({ id: item.id, decision: "sell" }),
      await actions.setItemLocation({ id: item.id, location: "hamburg" }),
      await actions.archiveItem({ id: item.id }),
      await actions.unarchiveItem({ id: item.id }),
      await actions.deleteItem({ id: item.id }),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    }
    expect(await row(item.id)).toMatchObject({ status: "tagged", decision: "undecided", location: "bologna" });
  });
});
