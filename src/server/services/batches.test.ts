import { randomUUID } from "node:crypto";

import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { APIConnectionError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { buildMessageParams } from "@/lib/ai/call";
import type { AnthropicLike } from "@/lib/ai/client";
import {
  computeCostUsd,
  estimateTaggingBatchRunUsd,
  estimateTaggingCostUsd,
  estimateTaggingDryRunUsd,
} from "@/lib/ai/cost";
import { aiBatches, aiCalls, items, type AiBatch, type Item, type NewItem } from "@/lib/db/schema";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import {
  apiError,
  canceledResult,
  createFakeAnthropic,
  erroredResult,
  expiredResult,
  fakeMessage,
  succeededResult,
  type FakeAnthropic,
} from "../../../test/fakes/anthropic";
import { COAT_TAGS, JACKET_TAGS } from "../../../test/fixtures/item-tags";
import {
  BATCH_CLAIM_PREFIX,
  BATCH_CLAIM_STALE_MS,
  BATCH_CREATE_ATTEMPT_TIMEOUT_MS,
  isClaim,
  pollTaggingBatches,
  runBatchPoll,
  START_DEADLINE_MS,
  startTaggingBatch,
  type BatchPollDeps,
} from "./batches";
import { archiveItem, unarchiveItem } from "./item-lifecycle";
import { taggingRequest, type TagItemDeps } from "./tag-item";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const MODEL = "claude-haiku-5-5";
/** The default monthly budget (MONTHLY_AI_BUDGET_USD is blank in tests), in micro-dollars. */
const BUDGET_MICROS = 20_000_000;

let testDb: TestDb;
let fake: FakeAnthropic;
let anthropic: ReturnType<typeof vi.fn<() => AnthropicLike>>;
let consoleError: MockInstance<typeof console.error>;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  fake = createFakeAnthropic();
  anthropic = vi.fn(() => fake);
  // Failures are logged by design; tests assert the log where it matters.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

afterAll(async () => {
  await testDb.close();
});

function micros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/**
 * A clock that stands still until the test moves it, so deadlines can be
 * crossed at a chosen moment (for example while the dry run waits for Claude).
 */
function steppedClock(): { now: () => number; set: (offsetMs: number) => void } {
  const base = Date.now();
  let offset = 0;
  return {
    now: () => base + offset,
    set: (offsetMs) => {
      offset = offsetMs;
    },
  };
}

/** Runs `afterReply` once the fake has answered the next messages.create call (the dry run). */
function afterDryRunReply(afterReply: () => void): void {
  const create = fake.messages.create;
  fake.messages.create = async (params, options) => {
    const reply = await create(params, options);
    afterReply();
    return reply;
  };
}

function tagDeps(): TagItemDeps {
  return {
    db: testDb.db,
    anthropic,
    // Batches and their dry run send URLs; nothing is fetched.
    fetch: vi.fn<typeof fetch>(async () => {
      throw new Error("unexpected fetch");
    }),
    sleep: async () => {},
    random: () => 0.5,
  };
}

function pollDeps(): BatchPollDeps {
  return { db: testDb.db, anthropic };
}

function photoUrl(itemId: string): string {
  return `https://fakestore.public.blob.vercel-storage.com/items/${itemId}/processed-abc123.webp`;
}

async function pendingItems(count: number, overrides: Partial<NewItem> = {}): Promise<Item[]> {
  const created: Item[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = await makeItem(testDb.db, overrides);
    await makeImage(testDb.db, item.id, { kind: "processed", contentType: "image/webp", blobUrl: photoUrl(item.id) });
    created.push(item);
  }
  return created;
}

async function itemRow(id: string): Promise<Item | undefined> {
  const [found] = await testDb.db.select().from(items).where(eq(items.id, id));
  return found;
}

async function batchRows(): Promise<AiBatch[]> {
  return testDb.db.select().from(aiBatches).orderBy(asc(aiBatches.createdAt));
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

/** The request params with the image URL swapped, for comparing batch requests with the dry run. */
function withImageUrl(params: MessageCreateParamsNonStreaming, url: string): MessageCreateParamsNonStreaming {
  const copy = structuredClone(params);
  const [message] = copy.messages;
  const content = message?.content;
  if (!Array.isArray(content)) throw new Error("expected block content");
  const [image] = content;
  if (image?.type !== "image" || image.source.type !== "url") throw new Error("expected a URL image first");
  image.source.url = url;
  return copy;
}

let seededBatches = 0;
/** A batch as startTaggingBatch leaves it: created at the fake API, recorded, items linked. */
async function seedBatch(batchItems: readonly Item[], model = MODEL): Promise<{ row: AiBatch; anthropicId: string }> {
  seededBatches += 1;
  const created = await fake.messages.batches.create({
    requests: batchItems.map((item) => ({
      custom_id: item.id,
      params: buildMessageParams(taggingRequest(MODEL, { type: "url", url: photoUrl(item.id) }, "1h")),
    })),
  });
  const [row] = await testDb.db
    .insert(aiBatches)
    .values({
      anthropicBatchId: created.id,
      purpose: "tagging",
      model,
      itemIds: batchItems.map((item) => item.id),
      requestCount: batchItems.length,
      estimatedCostUsd: 0.01,
      // Explicit and increasing, so polls visit batches in a known order.
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, seededBatches)),
    })
    .returning();
  if (row === undefined) throw new Error("no batch row");
  for (const item of batchItems) {
    await testDb.db.update(items).set({ taggingBatchId: row.id }).where(eq(items.id, item.id));
  }
  return { row, anthropicId: created.id };
}

/** A claim as a start leaves it between claiming the items and recording the batch id. */
async function seedClaim(batchItems: readonly Item[], createdAt: Date): Promise<AiBatch> {
  const [row] = await testDb.db
    .insert(aiBatches)
    .values({
      anthropicBatchId: BATCH_CLAIM_PREFIX + randomUUID(),
      purpose: "tagging",
      model: MODEL,
      itemIds: batchItems.map((item) => item.id),
      requestCount: batchItems.length,
      estimatedCostUsd: 0.01,
      createdAt,
    })
    .returning();
  if (row === undefined) throw new Error("no claim row");
  for (const item of batchItems) {
    await testDb.db.update(items).set({ taggingBatchId: row.id }).where(eq(items.id, item.id));
  }
  return row;
}

async function linkedItemIds(batchRowId: string): Promise<string[]> {
  const rows = await testDb.db.select({ id: items.id }).from(items).where(eq(items.taggingBatchId, batchRowId));
  return rows.map((row) => row.id).sort();
}

async function linkedCount(): Promise<number> {
  const rows = await testDb.db.select({ batch: items.taggingBatchId }).from(items);
  return rows.filter((row) => row.batch !== null).length;
}

function createCalls() {
  return fake.batchCalls.filter((call) => call.method === "create");
}

const NOTHING_POLLED = { batches: 0, processed: 0, tagged: 0, failed: 0, pending: 0, errors: [] };

describe("startTaggingBatch", () => {
  it("refuses 20 items or fewer", async () => {
    const twenty = await pendingItems(20);
    const error = await appError(startTaggingBatch(tagDeps(), twenty.map((item) => item.id)));
    expect(error.code).toBe("VALIDATION");
    expect(fake.requests).toEqual([]);
    expect(fake.batchCalls).toEqual([]);
  });

  it("refuses items that are no longer waiting for tags", async () => {
    const waiting = await pendingItems(21);
    const tagged = await makeTaggedItem(testDb.db, { aiRaw: COAT_TAGS });
    const ids = [...waiting.map((item) => item.id), tagged.id];

    const error = await appError(startTaggingBatch(tagDeps(), ids));

    expect(error.code).toBe("CONFLICT");
    expect(error.details).toEqual({ itemIds: [tagged.id] });
    expect(fake.requests).toEqual([]);
  });

  it("blocks over budget before the dry run", async () => {
    const waiting = await pendingItems(21);
    await testDb.db.insert(aiCalls).values({ model: MODEL, purpose: "tagging", status: "success", costUsd: 20 });

    const error = await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(anthropic).not.toHaveBeenCalled();
    expect(fake.batchCalls).toEqual([]);
  });

  it("checks the budget against the dry run plus the batch, not the batch alone", async () => {
    const waiting = await pendingItems(21);
    const { batchUsd, totalUsd } = estimateTaggingBatchRunUsd({ count: 21, model: MODEL });
    // 10 micro-dollars short of the whole run, while the batch alone would still fit.
    const spentMicros = BUDGET_MICROS - micros(totalUsd) + 10;
    expect(BUDGET_MICROS - spentMicros).toBeGreaterThan(micros(batchUsd));
    await testDb.db
      .insert(aiCalls)
      .values({ model: MODEL, purpose: "tagging", status: "success", costUsd: spentMicros / 1_000_000 });

    const error = await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(error.details?.estimateUsd).toBeCloseTo(totalUsd, 6);
    expect(anthropic).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
    expect(fake.batchCalls).toEqual([]);
    expect(await batchRows()).toEqual([]);
    expect(await linkedCount()).toBe(0);
  });

  it("creates no batch when the dry run fails, and leaves no claim or linked item behind", async () => {
    const waiting = await pendingItems(21);
    const [first] = waiting;
    fake.enqueue(apiError(400, { type: "invalid_request_error", message: "image url could not be fetched" }));

    const error = await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.message).toMatch(/^No batch was created/);
    expect(error.details).toMatchObject({ dryRunItemId: first?.id });
    expect(error.details).not.toHaveProperty("taggedItemId");
    expect(fake.batchCalls).toEqual([]);
    expect(await batchRows()).toEqual([]);
    expect(await itemRow(first?.id ?? "")).toMatchObject({ status: "pending_tagging", taggingError: expect.any(String) });
    for (const item of waiting.slice(1)) {
      expect(await itemRow(item.id)).toMatchObject({ taggingBatchId: null, taggingError: null });
    }
  });

  it("does not pick an item whose earlier dry run failed as the dry run again", async () => {
    const waiting = await pendingItems(22);
    const [failedBefore, clean] = waiting;
    if (!failedBefore || !clean) throw new Error("items missing");
    await testDb.db
      .update(items)
      .set({ taggingError: "Claude declined to tag this photo." })
      .where(eq(items.id, failedBefore.id));
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));

    const data = await startTaggingBatch(tagDeps(), waiting.map((item) => item.id));

    expect(data.dryRunItemId).toBe(clean.id);
    expect(fake.requests[0]?.params.messages[0]?.content).toEqual([
      { type: "image", source: { type: "url", url: photoUrl(clean.id) } },
      expect.objectContaining({ type: "text" }),
    ]);
    const [create] = createCalls();
    if (create?.method !== "create") throw new Error("expected a batch create call");
    // The others keep the client's order; the item that failed before goes into the batch.
    expect(create.params.requests.map((request) => request.custom_id)).toEqual(
      waiting.filter((item) => item.id !== clean.id).map((item) => item.id),
    );
    // Joining the batch clears its old failure.
    expect(await itemRow(failedBefore.id)).toMatchObject({ taggingBatchId: data.batchId, taggingError: null });
  });

  it("falls back to the first item when every item failed before", async () => {
    const waiting = await pendingItems(21);
    await testDb.db.update(items).set({ taggingError: "Claude did not answer in time." });
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));

    const data = await startTaggingBatch(tagDeps(), waiting.map((item) => item.id));

    expect(data.dryRunItemId).toBe(waiting[0]?.id);
  });

  it("lets only one of two overlapping starts for the same items pay", async () => {
    const waiting = await pendingItems(22);
    const ids = waiting.map((item) => item.id);
    // One reply: a second dry run would fail loudly on the empty script.
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));

    const outcomes = await Promise.allSettled([startTaggingBatch(tagDeps(), ids), startTaggingBatch(tagDeps(), ids)]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [refusal] = rejected;
    expect(refusal?.reason).toBeInstanceOf(AppError);
    expect(refusal?.reason).toMatchObject({ code: "CONFLICT" });
    expect(createCalls()).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);

    const rows = await batchRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.anthropicBatchId).toBe("msgbatch_fake_1");
    expect(fulfilled[0]?.value).toMatchObject({ batchId: row?.id, dryRunItemId: ids[0] });
    expect(await linkedItemIds(row?.id ?? "")).toEqual(ids.slice(1).sort());
  });

  it("refuses a start that checked the items before another start claimed them", async () => {
    const waiting = await pendingItems(22);
    const ids = waiting.map((item) => item.id);
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    // Holds the second start at its budget check, which comes right after its
    // unlocked candidate check, until the first start has finished.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedGate = (): void => {};
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let sessionChecks = 0;
    requireSession.mockImplementation(async () => {
      sessionChecks += 1;
      if (sessionChecks === 2) {
        reachedGate();
        await gate;
      }
      return { sub: "owner", iat: 0, exp: 0 };
    });

    const late = appError(startTaggingBatch(tagDeps(), ids));
    await atGate;
    const first = await startTaggingBatch(tagDeps(), ids);
    release();
    const error = await late;

    // Refused by the check under row locks inside the claim.
    expect(error.code).toBe("CONFLICT");
    // Every item: the batched ones are linked, the dry-run item is tagged.
    expect(error.details?.itemIds).toEqual(ids);
    expect(createCalls()).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
    expect((await batchRows()).map((row) => row.id)).toEqual([first.batchId]);
    expect(await linkedItemIds(first.batchId)).toEqual(ids.slice(1).sort());
  });

  it("refuses to start when another start claimed the items first", async () => {
    const waiting = await pendingItems(22);
    const claim = await seedClaim(waiting.slice(1), new Date());

    const error = await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    expect(error.code).toBe("CONFLICT");
    expect(error.details?.itemIds).toHaveLength(21);
    expect(fake.requests).toEqual([]);
    expect(fake.batchCalls).toEqual([]);
    expect((await batchRows()).map((row) => row.id)).toEqual([claim.id]);
  });

  it("tags the first item with the batch parameters, then batches the rest with the same request shape", async () => {
    const waiting = await pendingItems(22);
    const ids = waiting.map((item) => item.id);
    const [firstId, ...restIds] = ids;
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));

    const data = await startTaggingBatch(tagDeps(), ids);

    const [row] = await batchRows();
    const batchEstimate = estimateTaggingCostUsd({ count: 21, model: MODEL, batch: true });
    expect(data).toEqual({
      batchId: row?.id,
      count: 22,
      // The dry run writes the 1-hour cache, priced like the page's quote.
      estimateUsd: estimateTaggingDryRunUsd(MODEL) + batchEstimate,
      dryRunItemId: firstId,
    });

    // The dry run: the batch's exact shape, sent synchronously.
    const [dryRun] = fake.requests;
    expect(dryRun?.params.system).toEqual([
      expect.objectContaining({ cache_control: { type: "ephemeral", ttl: "1h" } }),
    ]);
    expect(dryRun?.params.messages[0]?.content).toEqual([
      { type: "image", source: { type: "url", url: photoUrl(firstId ?? "") } },
      expect.objectContaining({ type: "text" }),
    ]);

    const [create] = fake.batchCalls;
    if (create?.method !== "create" || dryRun === undefined) throw new Error("expected a batch create call");
    expect(create.params.requests.map((request) => request.custom_id)).toEqual(restIds);
    for (const request of create.params.requests) {
      expect(request.params).toEqual(withImageUrl(dryRun.params, photoUrl(request.custom_id)));
    }
    // Bounded per attempt, not the SDK's 10-minute default.
    expect(create.options).toEqual({ timeout: BATCH_CREATE_ATTEMPT_TIMEOUT_MS, hasSignal: false });

    expect(row).toMatchObject({
      anthropicBatchId: "msgbatch_fake_1",
      purpose: "tagging",
      model: MODEL,
      status: "in_progress",
      itemIds: restIds,
      requestCount: 21,
    });
    expect(row?.estimatedCostUsd).toBeCloseTo(batchEstimate, 6);
    expect(await itemRow(firstId ?? "")).toMatchObject({ status: "tagged", name: JACKET_TAGS.name, taggingBatchId: null });
    for (const id of restIds) {
      expect(await itemRow(id)).toMatchObject({ status: "pending_tagging", taggingBatchId: row?.id });
    }
  });

  it("holds the claim while the dry run runs and records the batch id afterwards", async () => {
    const waiting = await pendingItems(21);
    const seen: Array<{ rows: AiBatch[]; linked: number }> = [];
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    const create = fake.messages.create;
    fake.messages.create = async (params, options) => {
      seen.push({ rows: await batchRows(), linked: await linkedCount() });
      return create(params, options);
    };

    const data = await startTaggingBatch(tagDeps(), waiting.map((item) => item.id));

    const [during] = seen;
    expect(during?.rows).toHaveLength(1);
    expect(during?.rows[0]?.id).toBe(data.batchId);
    expect(during?.rows[0] && isClaim(during.rows[0])).toBe(true);
    // The dry-run item is not linked; the other 20 are.
    expect(during?.linked).toBe(20);
    const [after] = await batchRows();
    expect(after).toMatchObject({ id: data.batchId, anthropicBatchId: "msgbatch_fake_1" });
    expect(after && isClaim(after)).toBe(false);
  });

  it("clears an old tagging error only once the batch exists", async () => {
    const waiting = await pendingItems(21);
    const old = waiting[5];
    if (!old) throw new Error("item missing");
    await testDb.db.update(items).set({ taggingError: "The batch expired before this item was tagged." }).where(eq(items.id, old.id));
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    fake.failNextBatchCall("create", apiError(400, { type: "invalid_request_error" }));

    await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    expect(await itemRow(old.id)).toMatchObject({
      taggingBatchId: null,
      taggingError: "The batch expired before this item was tagged.",
    });
  });

  it("reports a failed batch creation after a successful dry run and names the tagged item", async () => {
    const waiting = await pendingItems(21);
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    for (let attempt = 0; attempt < 3; attempt += 1) fake.failNextBatchCall("create", apiError(529));

    const error = await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.message).toMatch(/^The first item was tagged, but the batch could not be created/);
    expect(error.details).toMatchObject({ taggedItemId: waiting[0]?.id });
    expect(fake.batchCalls.filter((call) => call.method === "create")).toHaveLength(3);
    expect(await batchRows()).toEqual([]);
    expect(await linkedCount()).toBe(0);
    // Overloads created nothing, so there is no possibly lost batch to report.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("releases the claim when the API rejects the batch, so the items can be tagged again", async () => {
    const waiting = await pendingItems(21);
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    fake.failNextBatchCall("create", apiError(400, { type: "invalid_request_error", message: "too many requests" }));

    const error = await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.details).toMatchObject({ taggedItemId: waiting[0]?.id });
    expect(createCalls()).toHaveLength(1);
    expect(await batchRows()).toEqual([]);
    expect(await linkedCount()).toBe(0);
    for (const item of waiting.slice(1)) {
      expect(await itemRow(item.id)).toMatchObject({ status: "pending_tagging", taggingBatchId: null });
    }
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("ends a stalled batches.create with AI_TIMEOUT, names the tagged item and releases the claim", async () => {
    const waiting = await pendingItems(21);
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    fake.failNextBatchCall("create", new APIConnectionTimeoutError());

    const error = await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    const [create] = createCalls();
    expect(createCalls()).toHaveLength(1);
    expect(typeof create?.options.timeout).toBe("number");
    expect(create?.options.timeout).toBeLessThanOrEqual(60_000);
    expect(error.code).toBe("AI_TIMEOUT");
    expect(error.details?.taggedItemId).toBe(waiting[0]?.id);
    expect(await batchRows()).toEqual([]);
    expect(await linkedCount()).toBe(0);
    // The request may have created a batch whose id never arrived.
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/may exist at Anthropic/), expect.anything());
  });

  it("gives the create attempt only the time left before the start deadline", async () => {
    const waiting = await pendingItems(21);
    const clock = steppedClock();
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    afterDryRunReply(() => clock.set(START_DEADLINE_MS - 20_000));

    await startTaggingBatch({ ...tagDeps(), now: clock.now }, waiting.map((item) => item.id));

    expect(createCalls()[0]?.options.timeout).toBe(20_000);
  });

  it("does not start batches.create when the dry run used up the start's time", async () => {
    const waiting = await pendingItems(21);
    const clock = steppedClock();
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    afterDryRunReply(() => clock.set(START_DEADLINE_MS + 1));

    const error = await appError(startTaggingBatch({ ...tagDeps(), now: clock.now }, waiting.map((item) => item.id)));

    expect(error.code).toBe("AI_TIMEOUT");
    expect(error.message).toMatch(/not enough time left to create the batch/);
    expect(error.details?.taggedItemId).toBe(waiting[0]?.id);
    expect(createCalls()).toEqual([]);
    expect(await batchRows()).toEqual([]);
    expect(await linkedCount()).toBe(0);
    expect(await itemRow(waiting[0]?.id ?? "")).toMatchObject({ status: "tagged" });
  });

  it("does not wait for a retry that would end past the start deadline", async () => {
    const waiting = await pendingItems(21);
    const clock = steppedClock();
    const sleeps: number[] = [];
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    afterDryRunReply(() => clock.set(START_DEADLINE_MS - 30_000));
    // 30 s fits the 60 s retry window, but not before the start deadline with room for another attempt.
    fake.failNextBatchCall("create", apiError(429, { headers: { "retry-after": "30" } }));

    const error = await appError(
      startTaggingBatch(
        {
          ...tagDeps(),
          now: clock.now,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
        waiting.map((item) => item.id),
      ),
    );

    expect(error.details?.taggedItemId).toBe(waiting[0]?.id);
    expect(error.code).not.toBe("AI_TIMEOUT");
    expect(sleeps).toEqual([]);
    expect(createCalls()).toHaveLength(1);
  });

  it("retries batch creation after a rate limit or an overload, which create no batch", async () => {
    const waiting = await pendingItems(21);
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    fake.failNextBatchCall("create", apiError(429, { headers: { "retry-after": "2" } }));
    fake.failNextBatchCall("create", apiError(529));
    const sleeps: number[] = [];

    const data = await startTaggingBatch(
      {
        ...tagDeps(),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      waiting.map((item) => item.id),
    );

    expect(fake.batchCalls.filter((call) => call.method === "create")).toHaveLength(3);
    // The server's retry-after first, then the jittered backoff.
    expect(sleeps).toEqual([2_000, 1_000]);
    expect((await batchRows())[0]?.id).toBe(data.batchId);
  });

  it.each([
    ["a connection error", new APIConnectionError({ message: "socket hang up" })],
    ["a server error the API says not to retry", apiError(500, { headers: { "x-should-retry": "false" } })],
    ["a 500 without a retry hint", apiError(500)],
  ])("does not retry batch creation after %s, which may have created a batch", async (_label, failure) => {
    const waiting = await pendingItems(21);
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    fake.failNextBatchCall("create", failure);

    const error = await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    expect(error.details).toMatchObject({ taggedItemId: waiting[0]?.id });
    expect(fake.batchCalls.filter((call) => call.method === "create")).toHaveLength(1);
    expect(await batchRows()).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/may exist at Anthropic/), failure);
  });

  it("stops retrying batch creation when the server asks for a wait past the deadline", async () => {
    const waiting = await pendingItems(21);
    fake.enqueue(fakeMessage({ json: JACKET_TAGS }));
    fake.failNextBatchCall("create", apiError(429, { headers: { "retry-after": "120" } }));

    const error = await appError(startTaggingBatch(tagDeps(), waiting.map((item) => item.id)));

    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(fake.batchCalls.filter((call) => call.method === "create")).toHaveLength(1);
  });
});

describe("runBatchPoll", () => {
  it("needs no client when no batch is open", async () => {
    expect(await runBatchPoll(pollDeps())).toEqual(NOTHING_POLLED);
    expect(anthropic).not.toHaveBeenCalled();
  });

  it("skips a fresh claim without calling the API", async () => {
    const claimed = await pendingItems(2);
    const claim = await seedClaim(claimed, new Date());

    expect(await runBatchPoll(pollDeps())).toEqual(NOTHING_POLLED);

    expect(anthropic).not.toHaveBeenCalled();
    expect((await batchRows()).map((row) => row.id)).toEqual([claim.id]);
    expect(await linkedItemIds(claim.id)).toEqual(claimed.map((item) => item.id).sort());
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("deletes a claim its start left behind, which frees its items, and logs it", async () => {
    const claimed = await pendingItems(2);
    const stale = await seedClaim(claimed, new Date(Date.now() - BATCH_CLAIM_STALE_MS - 60_000));

    expect(await runBatchPoll(pollDeps())).toEqual(NOTHING_POLLED);

    expect(anthropic).not.toHaveBeenCalled();
    expect(await batchRows()).toEqual([]);
    for (const item of claimed) {
      expect(await itemRow(item.id)).toMatchObject({ status: "pending_tagging", taggingBatchId: null });
    }
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`deleted claim ${stale.id}`));
  });

  it("polls real batches next to claims and passes claims to no API call", async () => {
    const [done, fresh, stale] = await pendingItems(3);
    if (!done || !fresh || !stale) throw new Error("items missing");
    const { anthropicId } = await seedBatch([done]);
    const freshClaim = await seedClaim([fresh], new Date());
    await seedClaim([stale], new Date(Date.now() - BATCH_CLAIM_STALE_MS - 1_000));
    fake.endBatch(anthropicId, [succeededResult(done.id, fakeMessage({ json: COAT_TAGS }))]);

    expect(await runBatchPoll(pollDeps())).toEqual({ ...NOTHING_POLLED, batches: 1, processed: 1, tagged: 1 });

    const polled = fake.batchCalls.filter((call) => call.method !== "create");
    expect(polled.map((call) => call.batchId)).toEqual([anthropicId, anthropicId]);
    expect((await batchRows()).filter(isClaim).map((row) => row.id)).toEqual([freshClaim.id]);
    expect(await itemRow(stale.id)).toMatchObject({ taggingBatchId: null });
    expect(await itemRow(fresh.id)).toMatchObject({ taggingBatchId: freshClaim.id });
  });

  it("leaves a running batch alone", async () => {
    const batchItems = await pendingItems(2);
    const { row } = await seedBatch(batchItems);

    expect(await runBatchPoll(pollDeps())).toMatchObject({ pending: 1, processed: 0 });

    expect(fake.batchCalls.map((call) => call.method)).toEqual(["create", "retrieve"]);
    expect((await batchRows())[0]?.status).toBe("in_progress");
    expect(await itemRow(batchItems[0]?.id ?? "")).toMatchObject({ taggingBatchId: row.id });
  });

  it("applies succeeded, errored, expired, canceled, invalid and missing results", async () => {
    const [ok, errored, expired, invalid, canceled, missing] = await pendingItems(6);
    if (!ok || !errored || !expired || !invalid || !canceled || !missing) throw new Error("items missing");
    const { row, anthropicId } = await seedBatch([ok, errored, expired, invalid, canceled, missing]);
    fake.endBatch(anthropicId, [
      expiredResult(expired.id),
      succeededResult(ok.id, fakeMessage({ json: JACKET_TAGS })),
      erroredResult(errored.id, "invalid_request_error", "Could not fetch the image."),
      succeededResult(invalid.id, fakeMessage({ text: "not json" })),
      canceledResult(canceled.id),
    ]);

    const summary = await runBatchPoll(pollDeps());

    expect(summary).toEqual({ batches: 1, processed: 6, tagged: 1, failed: 5, pending: 0, errors: [] });
    expect(await itemRow(ok.id)).toMatchObject({
      status: "tagged",
      name: JACKET_TAGS.name,
      aiRaw: JACKET_TAGS,
      taggingBatchId: null,
      taggingError: null,
    });
    const failures = {
      [errored.id]: "The batch could not tag this item (invalid_request_error). Tag it again.",
      [expired.id]: "The batch expired before this item was tagged. Tag it again.",
      [invalid.id]: "Claude's reply did not match the expected format.",
      [canceled.id]: "The batch was cancelled before this item was tagged. Tag it again.",
      [missing.id]: "The batch returned no result for this item. Tag it again.",
    };
    for (const [id, message] of Object.entries(failures)) {
      expect(await itemRow(id), id).toMatchObject({ status: "pending_tagging", taggingBatchId: null, taggingError: message });
    }

    const calls = await testDb.db.select().from(aiCalls);
    const byItem = Object.fromEntries(calls.map((call) => [call.itemId ?? "", call]));
    expect(calls).toHaveLength(3);
    expect(byItem[ok.id]).toMatchObject({ status: "success", isBatch: true, purpose: "tagging", model: MODEL });
    expect(byItem[invalid.id]).toMatchObject({ status: "invalid_output", isBatch: true });
    expect(byItem[errored.id]).toMatchObject({
      status: "error",
      isBatch: true,
      costUsd: 0,
      errorCode: "batch_invalid_request_error",
      requestId: "req_fake_batch",
    });

    const [processed] = await batchRows();
    expect(processed).toMatchObject({ id: row.id, status: "processed" });
    expect(processed?.processedAt).toBeInstanceOf(Date);
    expect(processed?.endedAt).toBeInstanceOf(Date);
    const logged = calls.reduce((sum, call) => sum + call.costUsd, 0);
    expect(processed?.costUsd).toBeCloseTo(logged, 6);
  });

  it("bills results at half the standard rate", async () => {
    const [item] = await pendingItems(1);
    if (!item) throw new Error("item missing");
    const { anthropicId } = await seedBatch([item]);
    const usage = { input_tokens: 1_500, output_tokens: 700, cache_read_input_tokens: 1_984 };
    fake.endBatch(anthropicId, [succeededResult(item.id, fakeMessage({ json: COAT_TAGS, usage }))]);

    await runBatchPoll(pollDeps());

    const [call] = await testDb.db.select().from(aiCalls);
    const standard = computeCostUsd(MODEL, usage);
    expect(call?.costUsd).toBeCloseTo(computeCostUsd(MODEL, usage, { batch: true }), 6);
    expect(call?.costUsd).toBeCloseTo(standard / 2, 6);
    expect(call).toMatchObject({ isBatch: true, cacheReadInputTokens: 1_984, inputTokens: 1_500, outputTokens: 700 });
    expect((await batchRows())[0]?.costUsd).toBeCloseTo(standard / 2, 6);
  });

  it("does nothing on a second run", async () => {
    const batchItems = await pendingItems(2);
    const { anthropicId } = await seedBatch(batchItems);
    fake.endBatch(
      anthropicId,
      batchItems.map((item) => succeededResult(item.id, fakeMessage({ json: COAT_TAGS }))),
    );
    await runBatchPoll(pollDeps());
    const callsBefore = fake.batchCalls.length;
    anthropic.mockClear();

    expect(await runBatchPoll(pollDeps())).toEqual(NOTHING_POLLED);
    expect(fake.batchCalls).toHaveLength(callsBefore);
    expect(anthropic).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(aiCalls)).toHaveLength(2);
  });

  it("applies a batch once when two polls overlap", async () => {
    const batchItems = await pendingItems(3);
    const { anthropicId } = await seedBatch(batchItems);
    fake.endBatch(
      anthropicId,
      batchItems.map((item) => succeededResult(item.id, fakeMessage({ json: COAT_TAGS }))),
    );

    const [first, second] = await Promise.all([runBatchPoll(pollDeps()), runBatchPoll(pollDeps())]);

    expect((first?.batches ?? 0) + (second?.batches ?? 0)).toBe(1);
    expect((first?.tagged ?? 0) + (second?.tagged ?? 0)).toBe(3);
    expect(await testDb.db.select().from(aiCalls)).toHaveLength(3);
  });

  it("skips items re-tagged or deleted meanwhile but records what was spent", async () => {
    const [retagged, deleted] = await pendingItems(2);
    if (!retagged || !deleted) throw new Error("items missing");
    const { anthropicId } = await seedBatch([retagged, deleted]);
    // A forced re-tag clears the batch link; a delete removes the row.
    await testDb.db.update(items).set({ taggingBatchId: null, name: "Tagged by hand" }).where(eq(items.id, retagged.id));
    await testDb.db.delete(items).where(eq(items.id, deleted.id));
    fake.endBatch(anthropicId, [
      succeededResult(retagged.id, fakeMessage({ json: JACKET_TAGS })),
      succeededResult(deleted.id, fakeMessage({ json: JACKET_TAGS })),
    ]);

    expect(await runBatchPoll(pollDeps())).toEqual({ ...NOTHING_POLLED, batches: 1 });

    expect(await itemRow(retagged.id)).toMatchObject({ name: "Tagged by hand", aiRaw: null, status: "pending_tagging" });
    const calls = await testDb.db.select().from(aiCalls);
    expect(calls.map((call) => call.itemId).sort()).toEqual([null, retagged.id].sort());
    expect(calls.every((call) => call.costUsd > 0)).toBe(true);
  });

  it("keeps fields the owner edited while the batch ran", async () => {
    const [item] = await pendingItems(1, { name: "Grandpa's jacket", userEditedFields: ["name"] });
    if (!item) throw new Error("item missing");
    const { anthropicId } = await seedBatch([item]);
    fake.endBatch(anthropicId, [succeededResult(item.id, fakeMessage({ json: JACKET_TAGS }))]);

    await runBatchPoll(pollDeps());

    expect(await itemRow(item.id)).toMatchObject({
      status: "tagged",
      name: "Grandpa's jacket",
      subcategory: "field jacket",
      userEditedFields: ["name"],
    });
  });

  it("keeps an item archived meanwhile archived, with the status it was archived from, and unarchives it as tagged", async () => {
    const [item] = await pendingItems(1);
    if (!item) throw new Error("item missing");
    const { anthropicId } = await seedBatch([item]);
    await archiveItem(testDb.db, item.id);
    fake.endBatch(anthropicId, [succeededResult(item.id, fakeMessage({ json: JACKET_TAGS }))]);

    expect(await runBatchPoll(pollDeps())).toMatchObject({ batches: 1, processed: 1, tagged: 1 });
    expect(await itemRow(item.id)).toMatchObject({
      status: "archived",
      archivedFrom: "pending_tagging",
      subcategory: "field jacket",
    });

    // The owner has not seen Claude's tags: back as tagged, so they reach the review queue.
    expect(await unarchiveItem(testDb.db, item.id)).toMatchObject({ status: "tagged" });
  });

  it("keeps polling the other batches when one fails and returns their counts with the failure", async () => {
    const [stuck, done] = await pendingItems(2);
    if (!stuck || !done) throw new Error("items missing");
    const first = await seedBatch([stuck]);
    const second = await seedBatch([done]);
    fake.endBatch(second.anthropicId, [succeededResult(done.id, fakeMessage({ json: COAT_TAGS }))]);
    fake.failNextBatchCall("retrieve", apiError(500));

    const summary = await runBatchPoll(pollDeps());

    expect(summary).toEqual({
      batches: 1,
      processed: 1,
      tagged: 1,
      failed: 0,
      pending: 0,
      errors: [{ code: "AI_UNAVAILABLE", message: expect.stringMatching(`^Batch ${first.anthropicId} could not be checked`) }],
    });
    const rows = await batchRows();
    expect(rows.map((batch) => batch.status)).toEqual(["in_progress", "processed"]);
    expect(await itemRow(done.id)).toMatchObject({ status: "tagged" });
    expect(await itemRow(stuck.id)).toMatchObject({ status: "pending_tagging", taggingBatchId: rows[0]?.id });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(`polling batch ${first.anthropicId} failed`),
      expect.any(AppError),
    );
  });

  it("throws when the client cannot be created, because no batch was tried", async () => {
    const [item] = await pendingItems(1);
    if (!item) throw new Error("item missing");
    await seedBatch([item]);
    const noKey = vi.fn<() => AnthropicLike>(() => {
      throw new AppError("CONFIG", "ANTHROPIC_API_KEY is required.");
    });

    expect((await appError(runBatchPoll({ db: testDb.db, anthropic: noKey }))).code).toBe("CONFIG");
  });

  it("passes the request timeout to every Batches API call", async () => {
    const [item] = await pendingItems(1);
    if (!item) throw new Error("item missing");
    const { anthropicId } = await seedBatch([item]);
    fake.endBatch(anthropicId, [succeededResult(item.id, fakeMessage({ json: COAT_TAGS }))]);

    await runBatchPoll({ ...pollDeps(), requestTimeoutMs: 10_000 });

    const polled = fake.batchCalls.filter((call) => call.method !== "create");
    expect(polled.map((call) => [call.method, call.options])).toEqual([
      ["retrieve", { timeout: 10_000, hasSignal: false }],
      ["results", { timeout: 10_000, hasSignal: true }],
    ]);
  });

  it("gives up on a results download that stalls past the timeout and leaves the batch open", async () => {
    const [item] = await pendingItems(1);
    if (!item) throw new Error("item missing");
    const { anthropicId } = await seedBatch([item]);
    fake.endBatch(anthropicId, [succeededResult(item.id, fakeMessage({ json: COAT_TAGS }))]);
    fake.stallNextResults();

    const summary = await runBatchPoll({ ...pollDeps(), requestTimeoutMs: 20 });

    expect(summary).toMatchObject({ batches: 0, processed: 0 });
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.code).toBe("AI_TIMEOUT");
    expect(summary.errors[0]?.message).toMatch(/did not answer within 1 s/);
    expect((await batchRows())[0]?.status).toBe("in_progress");
    expect(await itemRow(item.id)).toMatchObject({ status: "pending_tagging" });
  });

  it("refuses to apply results it cannot price, without revealing configuration details", async () => {
    const [item] = await pendingItems(1);
    if (!item) throw new Error("item missing");
    const { anthropicId } = await seedBatch([item], "claude-unpriced-1");
    fake.endBatch(anthropicId, [succeededResult(item.id, fakeMessage({ json: COAT_TAGS }))]);

    const summary = await runBatchPoll(pollDeps());

    expect(summary.errors).toEqual([{ code: "CONFIG", message: CONFIG_ERROR_MESSAGE }]);
    expect((await batchRows())[0]?.status).toBe("in_progress");
    expect(await testDb.db.select().from(aiCalls)).toEqual([]);
  });
});

describe("pollTaggingBatches", () => {
  it("checks the session before polling", async () => {
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Signed out."));
    expect((await appError(pollTaggingBatches(pollDeps()))).code).toBe("UNAUTHENTICATED");
  });

  it("runs the same poll for a signed-in owner", async () => {
    const [item] = await pendingItems(1);
    if (!item) throw new Error("item missing");
    const { anthropicId } = await seedBatch([item]);
    fake.endBatch(anthropicId, [succeededResult(item.id, fakeMessage({ json: COAT_TAGS }))]);
    expect(await pollTaggingBatches(pollDeps())).toMatchObject({ batches: 1, processed: 1, tagged: 1 });
  });
});
