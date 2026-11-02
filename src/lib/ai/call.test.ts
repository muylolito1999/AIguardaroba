import { asc } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { computeCostUsd } from "@/lib/ai/cost";
import { toJsonSchemaFormat } from "@/lib/ai/json-schema";
import type { AiCallRecord } from "@/lib/ai/log";
import { buildTaggingContent, TAGGING_PARAMS, TAGGING_SYSTEM_PROMPT } from "@/lib/ai/tagging/prompt";
import { ItemTagsSchema, ItemTagsWireSchema, type ItemTags, type ItemTagsWire } from "@/lib/ai/tagging/schema";
import { aiCalls } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeItem } from "../../../test/factories";
import {
  apiError,
  createFakeAnthropic,
  fakeMessage,
  midStreamError,
  type FakeAnthropic,
} from "../../../test/fakes/anthropic";
import {
  buildMessageParams,
  callStructured,
  readStructuredReply,
  type CallStructuredDeps,
  type CallStructuredOptions,
} from "./call";

const VALID_TAGS: ItemTagsWire = {
  name: "Navy waxed cotton field jacket",
  category: "outerwear",
  subcategory: "field jacket",
  colors: ["navy", "brown"],
  color_hex: ["#1f2a44", "#6b4423"],
  material_guess: "waxed cotton",
  materials: ["waxed cotton", "corduroy"],
  warmth_level: 3,
  waterproof: false,
  windproof: true,
  insulated: false,
  breathable: true,
  seasons: ["spring", "autumn"],
  formality: "casual",
  pattern: "solid",
  fit: "regular",
  condition: "good",
  brand_guess: null,
  description: "Navy water-resistant waxed cotton field jacket with a corduroy collar.",
  confidence: {
    category: 0.95,
    colors: 0.9,
    materials: 0.7,
    warmth_level: 0.6,
    waterproof: 0.8,
    windproof: 0.7,
    insulated: 0.65,
    formality: 0.85,
    condition: 0.6,
    brand: 0.9,
  },
  multiple_items_detected: false,
};

let testDb: TestDb;
let fake: FakeAnthropic;
let sleeps: number[];

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  fake = createFakeAnthropic();
  sleeps = [];
});

afterAll(async () => {
  await testDb.close();
});

function deps(): CallStructuredDeps {
  return {
    anthropic: fake,
    db: testDb.db,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

function tagOptions(overrides: Partial<CallStructuredOptions<ItemTags>> = {}): CallStructuredOptions<ItemTags> {
  return {
    deps: deps(),
    purpose: "tagging",
    model: "claude-haiku-5-5",
    system: TAGGING_SYSTEM_PROMPT,
    content: buildTaggingContent({ type: "base64", mediaType: "image/webp", data: "UklGRg==" }),
    wire: ItemTagsWireSchema,
    strict: ItemTagsSchema,
    effort: TAGGING_PARAMS.effort,
    maxTokens: TAGGING_PARAMS.maxTokens,
    maxTokensCeiling: TAGGING_PARAMS.maxTokensCeiling,
    deadlineAt: Date.now() + 50_000,
    ...overrides,
  };
}

async function rows() {
  return testDb.db.select().from(aiCalls).orderBy(asc(aiCalls.attempt));
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

describe("callStructured: success", () => {
  it("skips a thinking block and returns the strict-validated tags", async () => {
    fake.enqueue(fakeMessage({ thinking: "The jacket looks waxed.", json: VALID_TAGS }));

    const result = await callStructured(tagOptions());

    expect(result.data).toEqual(VALID_TAGS);
    expect(result.attempts).toBe(1);
    expect(result.model).toBe("claude-haiku-5-5");
    expect(result.requestId).toBe("req_fake_1");
    const [row] = await rows();
    expect(row).toMatchObject({ status: "success", stopReason: "end_turn", attempt: 1, requestId: "req_fake_1" });
    expect(fake.remaining()).toBe(0);
  });

  it("sends a cached static system block, the strict JSON Schema, effort and no sampling parameters", async () => {
    fake.enqueue(fakeMessage({ json: VALID_TAGS }));
    await callStructured(tagOptions());

    const [request] = fake.requests;
    expect(request?.method).toBe("create");
    const params = request?.params;
    expect(params).toBeDefined();
    if (!params) return;
    expect(params.system).toEqual([
      { type: "text", text: TAGGING_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
    expect(params.output_config).toEqual({ format: toJsonSchemaFormat(ItemTagsWireSchema), effort: "low" });
    expect(params.max_tokens).toBe(4096);
    for (const key of ["temperature", "top_p", "top_k", "thinking", "stop_sequences", "tools"]) {
      expect(params).not.toHaveProperty(key);
    }
    // One user turn, image first, and no assistant prefill.
    expect(params.messages).toHaveLength(1);
    const [message] = params.messages;
    expect(message?.role).toBe("user");
    const content = Array.isArray(message?.content) ? message.content : [];
    expect(content.map((block) => block.type)).toEqual(["image", "text"]);
    expect(request?.hasSignal).toBe(true);
    expect(request?.timeout).toBeGreaterThan(0);
    expect(request?.timeout).toBeLessThanOrEqual(50_000);
  });

  it("uses the 1-hour TTL when asked (batch parameters)", () => {
    const params = buildMessageParams({ ...tagOptions(), cacheTtl: "1h" });
    expect(params.system).toEqual([
      { type: "text", text: TAGGING_SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  it("records usage, cache tokens, thinking and cost from the reply", async () => {
    const usage = {
      input_tokens: 1_800,
      output_tokens: 650,
      cache_read_input_tokens: 1_984,
      cache_creation_input_tokens: 120,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 100 },
      output_tokens_details: { thinking_tokens: 200 },
    };
    fake.enqueue(fakeMessage({ json: VALID_TAGS, usage }));

    const result = await callStructured(tagOptions());

    const expected = computeCostUsd("claude-haiku-5-5", usage);
    expect(result.costUsd).toBeCloseTo(expected, 12);
    const [row] = await rows();
    expect(row).toMatchObject({
      inputTokens: 1_800,
      outputTokens: 650,
      cacheReadInputTokens: 1_984,
      cacheCreationInputTokens: 120,
      cacheWrite1hTokens: 100,
      thinkingTokens: 200,
      pricingTier: "standard",
      isBatch: false,
    });
    expect(row?.costUsd).toBeCloseTo(expected, 6);
  });

  it("streams with messages.stream + finalMessage when asked", async () => {
    fake.enqueue({ kind: "message", message: fakeMessage({ json: VALID_TAGS }), requestId: "req_stream" });
    const result = await callStructured(tagOptions({ stream: true }));
    expect(fake.requests[0]?.method).toBe("stream");
    expect(result.requestId).toBe("req_stream");
  });

  it("links the rows to an item", async () => {
    const item = await makeItem(testDb.db);
    fake.enqueue(fakeMessage({ json: VALID_TAGS }));
    await callStructured(tagOptions({ links: { itemId: item.id } }));
    expect((await rows())[0]?.itemId).toBe(item.id);
  });

  it("writes to a custom logger instead of ai_calls when given one", async () => {
    const logged: AiCallRecord[] = [];
    fake.enqueue(fakeMessage({ json: VALID_TAGS }));
    await callStructured(
      tagOptions({
        deps: { anthropic: fake, logCall: async (row) => void logged.push(row), sleep: async () => undefined },
        purpose: "smoke_test",
      }),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ purpose: "smoke_test", status: "success" });
    expect(await rows()).toHaveLength(0);
  });
});

describe("callStructured: retries", () => {
  it("retries invalid JSON at once and succeeds on the second attempt, logging both", async () => {
    fake.enqueue(fakeMessage({ text: "{not json", usage: { input_tokens: 1000, output_tokens: 100 } }));
    fake.enqueue(fakeMessage({ json: VALID_TAGS, usage: { input_tokens: 1000, output_tokens: 200 } }));

    const result = await callStructured(tagOptions());

    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([]);
    const logged = await rows();
    expect(logged.map((row) => row.status)).toEqual(["invalid_output", "success"]);
    expect(logged[0]).toMatchObject({ errorCode: "invalid_output", errorMessage: "The reply is not valid JSON." });
    // The failed attempt was billed too.
    expect(result.costUsd).toBeCloseTo((1000 * 0.1 + 100 * 0.5 + 1000 * 0.1 + 200 * 0.5) / 1_000_000, 12);
  });

  it("treats a reply that fails the strict schema as invalid output", async () => {
    const tooLong = { ...VALID_TAGS, description: "x".repeat(201) };
    fake.enqueue(fakeMessage({ json: tooLong }), fakeMessage({ json: VALID_TAGS }));

    await callStructured(tagOptions());

    const [first] = await rows();
    expect(first?.status).toBe("invalid_output");
    expect(first?.errorMessage).toMatch(/^description:/);
  });

  it("treats a reply without a text block as invalid output", async () => {
    fake.enqueue(fakeMessage({ thinking: "...", noText: true }), fakeMessage({ json: VALID_TAGS }));
    await callStructured(tagOptions());
    expect((await rows())[0]?.errorMessage).toBe("The reply has no text block.");
  });

  it("gives up with AI_INVALID_OUTPUT after 3 invalid replies", async () => {
    fake.enqueue(fakeMessage({ text: "nope" }), fakeMessage({ text: "nope" }), fakeMessage({ text: "nope" }));
    const error = await appError(callStructured(tagOptions()));
    expect(error.code).toBe("AI_INVALID_OUTPUT");
    expect(await rows()).toHaveLength(3);
  });

  it("retries max_tokens once with the cap doubled", async () => {
    fake.enqueue(fakeMessage({ stopReason: "max_tokens", text: '{"name":' }), fakeMessage({ json: VALID_TAGS }));

    await callStructured(tagOptions());

    expect(fake.requests.map((request) => request.params.max_tokens)).toEqual([4096, 8192]);
    expect((await rows()).map((row) => row.status)).toEqual(["max_tokens", "success"]);
  });

  it("stops after a second max_tokens with AI_INVALID_OUTPUT", async () => {
    fake.enqueue(
      fakeMessage({ stopReason: "max_tokens", text: "{" }),
      fakeMessage({ stopReason: "max_tokens", text: "{" }),
      fakeMessage({ json: VALID_TAGS }),
    );
    const error = await appError(callStructured(tagOptions()));
    expect(error.code).toBe("AI_INVALID_OUTPUT");
    expect(await rows()).toHaveLength(2);
    expect(fake.remaining()).toBe(1);
  });

  it("gives up with AI_UNAVAILABLE after 3 overloaded (529) attempts, logging each", async () => {
    fake.enqueue(apiError(529), apiError(529), apiError(529));

    const error = await appError(callStructured(tagOptions()));

    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.details).toMatchObject({ attempts: 3, status: 529 });
    const logged = await rows();
    expect(logged).toHaveLength(3);
    for (const row of logged) {
      expect(row).toMatchObject({ status: "error", errorCode: "http_529", requestId: "req_fake_529", costUsd: 0 });
    }
    // Full jitter with random 0.5: half of 1 s, then half of 2 s.
    expect(sleeps).toEqual([500, 1000]);
  });

  it("retries a mid-stream overloaded error", async () => {
    fake.enqueue(midStreamError("overloaded_error"), fakeMessage({ json: VALID_TAGS }));
    const result = await callStructured(tagOptions({ stream: true }));
    expect(result.attempts).toBe(2);
    expect((await rows())[0]?.errorCode).toBe("stream_overloaded_error");
  });

  it("honours retry-after when it fits the deadline", async () => {
    fake.enqueue(apiError(429, { headers: { "retry-after": "3" } }), fakeMessage({ json: VALID_TAGS }));
    await callStructured(tagOptions());
    expect(sleeps).toEqual([3000]);
  });

  it("fails fast when retry-after would pass the deadline", async () => {
    fake.enqueue(apiError(429, { headers: { "retry-after": "60" } }), fakeMessage({ json: VALID_TAGS }));

    const error = await appError(callStructured(tagOptions({ deadlineAt: Date.now() + 20_000 })));

    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.details).toMatchObject({ retryAfterSeconds: 60 });
    expect(sleeps).toEqual([]);
    expect(await rows()).toHaveLength(1);
    expect(fake.remaining()).toBe(1);
  });
});

describe("callStructured: final failures", () => {
  it("raises AI_REFUSAL without retrying and keeps the stop details", async () => {
    fake.enqueue(
      fakeMessage({
        stopReason: "refusal",
        noText: true,
        stopDetails: { category: "general_harms", explanation: "Declined." },
      }),
      fakeMessage({ json: VALID_TAGS }),
    );

    const error = await appError(callStructured(tagOptions()));

    expect(error.code).toBe("AI_REFUSAL");
    expect(error.details).toMatchObject({ category: "general_harms", explanation: "Declined." });
    const logged = await rows();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ status: "refusal", stopReason: "refusal", errorMessage: "general_harms: Declined." });
    expect(fake.remaining()).toBe(1);
  });

  it("raises AI_UNAVAILABLE for an unexpected stop reason", async () => {
    fake.enqueue(fakeMessage({ stopReason: "pause_turn", json: VALID_TAGS }));
    const error = await appError(callStructured(tagOptions()));
    expect(error.code).toBe("AI_UNAVAILABLE");
    expect((await rows())[0]).toMatchObject({ status: "error", stopReason: "pause_turn" });
  });

  it("does not retry a 400", async () => {
    fake.enqueue(apiError(400, { type: "invalid_request_error", message: "Schema is too complex for compilation." }));
    const error = await appError(callStructured(tagOptions()));
    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.cause).toBeInstanceOf(Error);
    expect((await rows())[0]?.errorMessage).toMatch(/too complex/);
  });

  it("maps a rejected API key to CONFIG", async () => {
    fake.enqueue(apiError(401, { type: "authentication_error" }));
    expect((await appError(callStructured(tagOptions()))).code).toBe("CONFIG");
  });

  it("rethrows an AppError from inside the attempt unchanged", async () => {
    const config = new AppError("CONFIG", "Invalid server configuration (ai): ANTHROPIC_API_KEY is not set.");
    fake.enqueue(config);
    await expect(callStructured(tagOptions())).rejects.toBe(config);
    expect(await rows()).toHaveLength(1);
  });

  it("aborts a hanging request at the deadline with AI_TIMEOUT", async () => {
    fake.enqueue({ kind: "hang" });
    const error = await appError(callStructured(tagOptions({ deadlineAt: Date.now() + 200, minAttemptMs: 50 })));
    expect(error.code).toBe("AI_TIMEOUT");
    expect((await rows())[0]).toMatchObject({ status: "error", errorCode: "deadline" });
  });

  it("sends nothing when the deadline leaves too little time", async () => {
    const error = await appError(callStructured(tagOptions({ deadlineAt: Date.now() + 1_000 })));
    expect(error.code).toBe("AI_TIMEOUT");
    expect(fake.requests).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("sends nothing when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await appError(callStructured(tagOptions({ signal: controller.signal })));
    expect(error.code).toBe("AI_TIMEOUT");
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects invalid token settings before calling", async () => {
    await expect(callStructured(tagOptions({ maxTokens: 0 }))).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(callStructured(tagOptions({ maxTokensCeiling: 100 }))).rejects.toMatchObject({ code: "INTERNAL" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("readStructuredReply", () => {
  it("reads replies for batch processing", () => {
    expect(readStructuredReply(fakeMessage({ json: VALID_TAGS }), ItemTagsSchema)).toEqual({
      kind: "ok",
      data: VALID_TAGS,
    });
    expect(readStructuredReply(fakeMessage({ stopReason: "max_tokens" }), ItemTagsSchema)).toEqual({
      kind: "max_tokens",
    });
    expect(
      readStructuredReply(fakeMessage({ json: { ...VALID_TAGS, color_hex: ["#FFF"] } }), ItemTagsSchema).kind,
    ).toBe("invalid_output");
  });
});
