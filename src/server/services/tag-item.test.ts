import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnthropicLike } from "@/lib/ai/client";
import { estimateTaggingCostUsd, estimateTaggingDryRunUsd } from "@/lib/ai/cost";
import { toJsonSchemaFormat } from "@/lib/ai/json-schema";
import { buildTaggingContent, TAG_PROMPT_VERSION, TAGGING_SYSTEM_PROMPT } from "@/lib/ai/tagging/prompt";
import { ItemTagsWireSchema } from "@/lib/ai/tagging/schema";
import { aiBatches, aiCalls, items, type Item, type NewItem } from "@/lib/db/schema";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import { apiError, createFakeAnthropic, fakeMessage, type FakeAnthropic } from "../../../test/fakes/anthropic";
import { COAT_TAGS, JACKET_TAGS } from "../../../test/fixtures/item-tags";
import { MAX_TAGGING_ERROR_LENGTH, tagItem, taggingErrorMessage, type TagItemDeps } from "./tag-item";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

/** Stands in for the processed WebP; the service only base64-encodes it. */
const PHOTO = Buffer.from("RIFF0000WEBPVP8 fake processed photo bytes");
/** The default monthly budget (MONTHLY_AI_BUDGET_USD is blank in tests), in micro-dollars. */
const BUDGET_MICROS = 20_000_000;

function micros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

let testDb: TestDb;
let fake: FakeAnthropic;
let anthropic: ReturnType<typeof vi.fn<() => AnthropicLike>>;
let fetchPhoto: ReturnType<typeof vi.fn<typeof fetch>>;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  fake = createFakeAnthropic();
  anthropic = vi.fn(() => fake);
  fetchPhoto = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(PHOTO), { status: 200 }));
});

afterAll(async () => {
  await testDb.close();
});

function deps(overrides: Partial<TagItemDeps> = {}): TagItemDeps {
  return {
    db: testDb.db,
    anthropic,
    fetch: fetchPhoto,
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  };
}

function photoUrl(itemId: string): string {
  return `https://fakestore.public.blob.vercel-storage.com/items/${itemId}/processed-abc123.webp`;
}

async function withPhoto(item: Item): Promise<Item> {
  await makeImage(testDb.db, item.id, { kind: "processed", contentType: "image/webp", blobUrl: photoUrl(item.id) });
  return item;
}

/** Columns of an item that tagging with COAT_TAGS produced. */
const COAT_COLUMNS = {
  name: COAT_TAGS.name,
  category: COAT_TAGS.category,
  subcategory: COAT_TAGS.subcategory,
  colors: COAT_TAGS.colors,
  colorHex: COAT_TAGS.color_hex,
  materialGuess: COAT_TAGS.material_guess,
  materials: COAT_TAGS.materials,
  warmthLevel: COAT_TAGS.warmth_level,
  waterproof: COAT_TAGS.waterproof,
  windproof: COAT_TAGS.windproof,
  insulated: COAT_TAGS.insulated,
  breathable: COAT_TAGS.breathable,
  seasons: COAT_TAGS.seasons,
  formality: COAT_TAGS.formality,
  pattern: COAT_TAGS.pattern,
  fit: COAT_TAGS.fit,
  condition: COAT_TAGS.condition,
  brand: COAT_TAGS.brand_guess,
  description: COAT_TAGS.description,
  aiRaw: COAT_TAGS,
  aiConfidence: COAT_TAGS.confidence,
  aiModel: "claude-haiku-5-5",
  aiPromptVersion: TAG_PROMPT_VERSION,
} satisfies Partial<NewItem>;

function pendingItem(overrides: Partial<NewItem> = {}): Promise<Item> {
  return makeItem(testDb.db, overrides).then(withPhoto);
}

function taggedCoat(overrides: Partial<NewItem> = {}): Promise<Item> {
  return makeTaggedItem(testDb.db, { ...COAT_COLUMNS, ...overrides }).then(withPhoto);
}

async function row(id: string): Promise<Item> {
  const [found] = await testDb.db.select().from(items).where(eq(items.id, id));
  if (found === undefined) throw new Error(`item ${id} is gone`);
  return found;
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected an AppError");
}

describe("tagItem: the tag cache", () => {
  it("returns an item that has tags without calling Claude or needing an API key", async () => {
    const item = await taggedCoat();
    const noKey = vi.fn<() => AnthropicLike>(() => {
      throw new AppError("CONFIG", "ANTHROPIC_API_KEY is not set.");
    });

    const result = await tagItem(deps({ anthropic: noKey }), item.id);

    expect(result.cached).toBe(true);
    expect(result.item).toMatchObject({ id: item.id, status: "tagged", name: COAT_TAGS.name });
    expect(noKey).not.toHaveBeenCalled();
    expect(fetchPhoto).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(aiCalls)).toEqual([]);
  });

  it("returns an item tagged by hand without calling Claude", async () => {
    // Tagged by hand: complete tags, but no tagging output.
    const item = await makeTaggedItem(testDb.db, { aiRaw: null }).then(withPhoto);
    const noKey = vi.fn<() => AnthropicLike>(() => {
      throw new AppError("CONFIG", "ANTHROPIC_API_KEY is not set.");
    });

    const result = await tagItem(deps({ anthropic: noKey }), item.id);

    expect(result.cached).toBe(true);
    expect(result.item).toMatchObject({ id: item.id, status: "tagged", aiModel: null });
    expect(noKey).not.toHaveBeenCalled();
    expect(fetchPhoto).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(aiCalls)).toEqual([]);
  });
});

describe("tagItem: a card's stale batch", () => {
  async function batchRow(): Promise<string> {
    const [batch] = await testDb.db
      .insert(aiBatches)
      .values({ anthropicBatchId: `msgbatch_${randomUUID()}`, purpose: "tagging", model: "claude-haiku-5-5", requestCount: 1 })
      .returning();
    if (batch === undefined) throw new Error("no batch row");
    return batch.id;
  }

  it("answers 'Tag now instead' on an item the batch already tagged with its tags, for free", async () => {
    // The batch applied its result after the card was rendered: tagged, link cleared.
    const item = await taggedCoat();
    const staleBatchId = await batchRow();

    const result = await tagItem(deps(), item.id, { force: true, batchId: staleBatchId });

    expect(result.cached).toBe(true);
    expect(result.item).toMatchObject({ id: item.id, status: "tagged", name: COAT_TAGS.name });
    expect(anthropic).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
    expect(await testDb.db.select().from(aiCalls)).toEqual([]);
  });

  it("also answers an item tagged by hand meanwhile with its tags", async () => {
    const item = await makeTaggedItem(testDb.db, { aiRaw: null }).then(withPhoto);
    const result = await tagItem(deps(), item.id, { force: true, batchId: randomUUID() });
    expect(result.cached).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it("tags an item still waiting in that batch when forced", async () => {
    const item = await pendingItem();
    const batchId = await batchRow();
    await testDb.db.update(items).set({ taggingBatchId: batchId }).where(eq(items.id, item.id));
    fake.enqueue(fakeMessage({ json: COAT_TAGS }));

    const result = await tagItem(deps(), item.id, { force: true, batchId });

    expect(result.cached).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(await row(item.id)).toMatchObject({ status: "tagged", aiRaw: COAT_TAGS, taggingBatchId: null });
  });

  it("re-tags a tagged item that is still linked to that batch when forced", async () => {
    const batchId = await batchRow();
    const item = await taggedCoat({ taggingBatchId: batchId });
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));

    const result = await tagItem(deps(), item.id, { force: true, batchId });

    expect(result.cached).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(await row(item.id)).toMatchObject({ aiRaw: JACKET_TAGS, taggingBatchId: null });
  });

  it("tags an item the batch could not tag, although the card's batch is stale", async () => {
    // The batch failed for it: unlinked, still pending, with the stored reason.
    const item = await pendingItem({ taggingError: "The batch expired before this item was tagged. Tag it again." });
    fake.enqueue(fakeMessage({ json: COAT_TAGS }));

    const result = await tagItem(deps(), item.id, { force: true, batchId: randomUUID() });

    expect(result.cached).toBe(false);
    expect(await row(item.id)).toMatchObject({ status: "tagged", taggingError: null });
  });
});

describe("tagItem: a first tagging", () => {
  it("tags a pending item and records the call", async () => {
    const item = await pendingItem();
    fake.enqueue(fakeMessage({ json: JACKET_TAGS, thinking: "Looks like waxed cotton." }));

    const result = await tagItem(deps(), item.id);

    expect(result.cached).toBe(false);
    expect(result.item).toMatchObject({
      id: item.id,
      status: "tagged",
      name: JACKET_TAGS.name,
      brand: "Barbour",
      multipleItemsDetected: true,
      aiModel: "claude-haiku-5-5",
      taggingError: null,
      userEditedFields: [],
    });
    const saved = await row(item.id);
    expect(saved).toMatchObject({
      aiRaw: JACKET_TAGS,
      aiPromptVersion: TAG_PROMPT_VERSION,
      aiConfidence: JACKET_TAGS.confidence,
      colorHex: JACKET_TAGS.color_hex,
      warmthLevel: 3,
    });
    const calls = await testDb.db.select().from(aiCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "tagging", status: "success", itemId: item.id, isBatch: false });
    expect(fake.remaining()).toBe(0);
  });

  it("sends the photo as base64 with the cached system prompt and the tagging parameters", async () => {
    const item = await pendingItem();
    fake.enqueue(fakeMessage({ json: COAT_TAGS }));

    await tagItem(deps(), item.id);

    expect(fetchPhoto).toHaveBeenCalledTimes(1);
    expect(fetchPhoto.mock.calls[0]?.[0]).toBe(photoUrl(item.id));
    expect(fetchPhoto.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    const [request] = fake.requests;
    expect(request?.method).toBe("create");
    expect(request?.params).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 4096,
      system: [{ type: "text", text: TAGGING_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: buildTaggingContent({ type: "base64", mediaType: "image/webp", data: PHOTO.toString("base64") }),
        },
      ],
      output_config: { format: toJsonSchemaFormat(ItemTagsWireSchema), effort: "low" },
    });
  });

  it("keeps fields the owner filled in while the item waited", async () => {
    const item = await pendingItem({ name: "Grandpa's jacket", userEditedFields: ["name"] });
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    await tagItem(deps(), item.id);
    expect(await row(item.id)).toMatchObject({ name: "Grandpa's jacket", subcategory: "field jacket", status: "tagged" });
  });
});

describe("tagItem: Re-tag", () => {
  it("calls Claude again and keeps the values of user-edited fields", async () => {
    const item = await taggedCoat({
      name: "Dad's coat",
      warmthLevel: 5,
      colors: ["black"],
      colorHex: ["#000000"],
      userEditedFields: ["name", "colors", "color_hex", "warmth_level"],
    });
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));

    const result = await tagItem(deps(), item.id, { force: true });

    expect(result.cached).toBe(false);
    const saved = await row(item.id);
    expect(saved).toMatchObject({
      name: "Dad's coat",
      warmthLevel: 5,
      colors: ["black"],
      colorHex: ["#000000"],
      subcategory: "field jacket",
      condition: "worn",
      brand: "Barbour",
      aiRaw: JACKET_TAGS,
      status: "tagged",
      userEditedFields: ["name", "colors", "color_hex", "warmth_level"],
    });
  });

  it("leaves a confirmed item confirmed", async () => {
    const item = await taggedCoat({ status: "confirmed" });
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    expect((await tagItem(deps(), item.id, { force: true })).item.status).toBe("confirmed");
    expect((await row(item.id)).subcategory).toBe("field jacket");
  });

  it("keeps the earlier tags and status when it fails", async () => {
    const item = await taggedCoat({ status: "confirmed" });
    fake.enqueue(apiError(400, { type: "invalid_request_error" }));

    const error = await appError(tagItem(deps(), item.id, { force: true }));

    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(await row(item.id)).toMatchObject({
      status: "confirmed",
      name: COAT_TAGS.name,
      aiRaw: COAT_TAGS,
      taggingError: error.message,
    });
  });
});

describe("tagItem: failures", () => {
  it("keeps the item pending and stores the reason when Claude refuses", async () => {
    const item = await pendingItem();
    fake.enqueue(fakeMessage({ stopReason: "refusal", stopDetails: { category: null, explanation: null }, noText: true }));

    const error = await appError(tagItem(deps(), item.id));

    expect(error.code).toBe("AI_REFUSAL");
    const saved = await row(item.id);
    expect(saved).toMatchObject({ status: "pending_tagging", taggingError: error.message, aiRaw: null, name: null });
    const [call] = await testDb.db.select().from(aiCalls);
    expect(call).toMatchObject({ status: "refusal", itemId: item.id });
  });

  it("prices the batch-shaped dry run with the 1-hour cache write, above a standard call", async () => {
    const item = await pendingItem();
    const standardMicros = micros(estimateTaggingCostUsd({ count: 1, model: "claude-haiku-5-5" }));
    const dryRunMicros = micros(estimateTaggingDryRunUsd("claude-haiku-5-5"));
    expect(dryRunMicros).toBeGreaterThan(standardMicros + 1);
    // Room for a standard call, not for the dry run.
    const remainingMicros = standardMicros + Math.floor((dryRunMicros - standardMicros) / 2);
    await testDb.db.insert(aiCalls).values({
      model: "claude-haiku-5-5",
      purpose: "tagging",
      status: "success",
      costUsd: (BUDGET_MICROS - remainingMicros) / 1_000_000,
    });

    const error = await appError(tagItem(deps(), item.id, { batchShape: true }));

    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(error.details?.estimateUsd).toBeCloseTo(estimateTaggingDryRunUsd("claude-haiku-5-5"), 6);
    expect(anthropic).not.toHaveBeenCalled();
    expect((await row(item.id)).taggingError).toBeNull();

    fake.enqueue(fakeMessage({ json: COAT_TAGS }));
    const result = await tagItem(deps(), item.id);
    expect(result.cached).toBe(false);
    expect(fake.requests).toHaveLength(1);
  });

  it("blocks over budget before reading the photo or creating a client", async () => {
    const item = await pendingItem();
    // The default monthly budget is $20 (MONTHLY_AI_BUDGET_USD is blank in tests).
    await testDb.db.insert(aiCalls).values({ model: "claude-haiku-5-5", purpose: "tagging", status: "success", costUsd: 20 });

    const error = await appError(tagItem(deps(), item.id));

    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(anthropic).not.toHaveBeenCalled();
    expect(fetchPhoto).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
    // Nothing was attempted, so there is no tagging failure to show.
    expect((await row(item.id)).taggingError).toBeNull();
  });

  it("stores an unreadable photo as the reason without calling Claude", async () => {
    const item = await pendingItem();
    fetchPhoto.mockResolvedValueOnce(new Response("gone", { status: 404 }));

    const error = await appError(tagItem(deps(), item.id));

    expect(error.code).toBe("UPSTREAM");
    expect(fake.requests).toEqual([]);
    expect((await row(item.id)).taggingError).toBe(error.message);
  });

  it("stores a generic reason for a configuration error and rethrows it", async () => {
    const item = await pendingItem();
    const config = new AppError("CONFIG", "Invalid server configuration (ai): ANTHROPIC_API_KEY is required.");
    const error = await appError(
      tagItem(
        deps({
          anthropic: () => {
            throw config;
          },
        }),
        item.id,
      ),
    );
    expect(error).toBe(config);
    expect((await row(item.id)).taggingError).toBe(CONFIG_ERROR_MESSAGE);
  });

  it("refuses an item that waits in a batch unless forced", async () => {
    const item = await pendingItem();
    const [batch] = await testDb.db
      .insert(aiBatches)
      .values({ anthropicBatchId: "msgbatch_test", purpose: "tagging", model: "claude-haiku-5-5", requestCount: 1 })
      .returning();
    await testDb.db.update(items).set({ taggingBatchId: batch?.id }).where(eq(items.id, item.id));

    expect((await appError(tagItem(deps(), item.id))).code).toBe("CONFLICT");
    expect(fake.requests).toEqual([]);

    fake.enqueue(fakeMessage({ json: COAT_TAGS }));
    await tagItem(deps(), item.id, { force: true });
    // Tagged now, so the batch's later result for it will be skipped.
    expect(await row(item.id)).toMatchObject({ status: "tagged", taggingBatchId: null });
  });

  it("answers NOT_FOUND for unknown and malformed ids", async () => {
    expect((await appError(tagItem(deps(), randomUUID()))).code).toBe("NOT_FOUND");
    expect((await appError(tagItem(deps(), "42"))).code).toBe("NOT_FOUND");
  });

  it("checks the session first", async () => {
    const item = await pendingItem();
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Signed out."));
    expect((await appError(tagItem(deps(), item.id))).code).toBe("UNAUTHENTICATED");
    expect(fetchPhoto).not.toHaveBeenCalled();
  });
});

describe("taggingErrorMessage", () => {
  it("keeps AppError messages, shortened, and hides configuration and unexpected errors", () => {
    expect(taggingErrorMessage(new AppError("AI_TIMEOUT", "Claude did not answer in time."))).toBe(
      "Claude did not answer in time.",
    );
    expect(taggingErrorMessage(new AppError("AI_UNAVAILABLE", "x".repeat(500)))).toHaveLength(MAX_TAGGING_ERROR_LENGTH);
    expect(taggingErrorMessage(new AppError("CONFIG", "ANTHROPIC_API_KEY"))).toBe(CONFIG_ERROR_MESSAGE);
    expect(taggingErrorMessage(new Error("SQL details"))).not.toContain("SQL");
  });
});
