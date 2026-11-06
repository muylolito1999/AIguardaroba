import Anthropic from "@anthropic-ai/sdk";
import { asc } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AnthropicLike } from "@/lib/ai/client";
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
  connectionError,
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

  it("reports each paid attempt's cost as it is logged, also when the call gives up", async () => {
    fake.enqueue(
      apiError(529),
      fakeMessage({ text: "nope", usage: { input_tokens: 1000, output_tokens: 100 } }),
      fakeMessage({ text: "nope", usage: { input_tokens: 2000, output_tokens: 100 } }),
    );
    const reported: number[] = [];

    const error = await appError(callStructured(tagOptions({ onAttemptCost: (usd) => void reported.push(usd) })));

    expect(error.code).toBe("AI_INVALID_OUTPUT");
    const logged = await rows();
    expect(logged.map((row) => row.status)).toEqual(["error", "invalid_output", "invalid_output"]);
    // The transport error had no usage, so nothing to report for it.
    expect(reported).toEqual(logged.slice(1).map((row) => row.costUsd));
    expect(reported.every((usd) => usd > 0)).toBe(true);
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

// The real SDK client reading a streamed reply from a scripted body (no
// network): what MessageStream raises when the socket closes mid-body or the
// body ends before message_stop is a plain AnthropicError, not an APIError.
type StreamBody = "drop" | "truncate" | "complete" | "hang" | "overloaded";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamedReply(kind: StreamBody, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  const reply = JSON.stringify(VALID_TAGS);
  const start =
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_stream",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        container: null,
        usage: { input_tokens: 6_000, output_tokens: 1, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 0 },
      },
    }) +
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } }) +
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(0, 20) } });
  const end =
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(20) } }) +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
      usage: { output_tokens: 700 },
    }) +
    sse("message_stop", { type: "message_stop" });
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(start));
    },
    // Called once the first events were read: an error raised in start() would
    // drop them unread.
    pull(controller) {
      if (kind === "drop") {
        // What undici raises when the other side closes the socket mid-body.
        controller.error(Object.assign(new TypeError("terminated"), { cause: new Error("other side closed") }));
      } else if (kind === "truncate") {
        controller.close();
      } else if (kind === "complete") {
        controller.enqueue(encoder.encode(end));
        controller.close();
      } else if (kind === "overloaded") {
        // An SSE error event after the 200: the SDK raises an APIError with no status.
        controller.enqueue(
          encoder.encode(sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })),
        );
        controller.close();
      } else {
        return new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              controller.error(new DOMException("aborted", "AbortError"));
              resolve();
            },
            { once: true },
          );
        });
      }
      return undefined;
    },
  });
}

/** `clock`, when given, moves on by each reply's latency, so a reply can take minutes of the injected clock. */
function sdkStreaming(
  bodies: StreamBody[],
  clock?: { now: number; latencyMs: number[] },
): { client: AnthropicLike; requests: () => number } {
  let count = 0;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const kind = bodies[count] ?? "complete";
    if (clock !== undefined) clock.now += clock.latencyMs[count] ?? 0;
    count += 1;
    return new Response(streamedReply(kind, init?.signal), {
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": `req_${count}` },
    });
  };
  const client = new Anthropic({ apiKey: "test-key-not-real", maxRetries: 0, fetch: fetchImpl });
  return { client, requests: () => count };
}

describe("callStructured: a streamed reply that breaks off (D-163)", () => {
  it("retries a stream cut off mid-body and records the usage message_start reported", async () => {
    const sdk = sdkStreaming(["drop", "complete"]);
    const reported: number[] = [];

    const result = await callStructured(
      tagOptions({ deps: { ...deps(), anthropic: sdk.client }, stream: true, onAttemptCost: (usd) => void reported.push(usd) }),
    );

    expect(result.attempts).toBe(2);
    expect(sdk.requests()).toBe(2);
    const logged = await rows();
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      status: "error",
      errorCode: "stream_interrupted",
      requestId: "req_1",
      inputTokens: 6_000,
      cacheCreationInputTokens: 2_000,
    });
    expect(logged[0]?.costUsd).toBeGreaterThan(0);
    expect(logged[1]).toMatchObject({ status: "success", requestId: "req_2" });
    // The column keeps 6 decimals.
    expect(reported).toHaveLength(2);
    reported.forEach((usd, index) => expect(usd).toBeCloseTo(logged[index]?.costUsd ?? Number.NaN, 6));
    expect(result.costUsd).toBeCloseTo(reported.reduce((sum, usd) => sum + usd, 0), 12);
    // Transport errors wait before the retry, as an SSE error event does.
    expect(sleeps).toHaveLength(1);
  });

  it("retries a stream whose body ends before message_stop", async () => {
    const sdk = sdkStreaming(["truncate", "complete"]);
    const result = await callStructured(tagOptions({ deps: { ...deps(), anthropic: sdk.client }, stream: true }));
    expect(result.attempts).toBe(2);
    expect((await rows())[0]).toMatchObject({ status: "error", errorCode: "stream_interrupted", inputTokens: 6_000 });
  });

  it("gives up after 3 broken streams with AI_UNAVAILABLE, not INTERNAL", async () => {
    const sdk = sdkStreaming(["drop", "truncate", "drop", "complete"]);
    const error = await appError(callStructured(tagOptions({ deps: { ...deps(), anthropic: sdk.client }, stream: true })));
    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.message).toBe("Claude's reply broke off. Try again shortly. (gave up after 3 attempts)");
    expect(sdk.requests()).toBe(3);
    expect((await rows()).map((row) => row.errorCode)).toEqual(["stream_interrupted", "stream_interrupted", "stream_interrupted"]);
  });

  it("still ends a stream the deadline aborts as a deadline timeout, without a retry", async () => {
    const sdk = sdkStreaming(["hang", "complete"]);
    const error = await appError(
      callStructured(
        tagOptions({ deps: { ...deps(), anthropic: sdk.client }, stream: true, deadlineAt: Date.now() + 300, minAttemptMs: 50 }),
      ),
    );
    expect(error.code).toBe("AI_TIMEOUT");
    expect(sdk.requests()).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "error", errorCode: "deadline", inputTokens: 0, costUsd: 0 });
  });

  it("does not retry an error that is not the stream's, such as a TypeError from create()", async () => {
    fake.enqueue(new TypeError("a bug on our side"), fakeMessage({ json: VALID_TAGS }));
    const error = await appError(callStructured(tagOptions()));
    expect(error.code).toBe("INTERNAL");
    expect(fake.remaining()).toBe(1);
  });
});

describe("callStructured: a retry that cannot finish before the deadline (D-164)", () => {
  // A client whose every reply takes `ms` of the injected clock.
  function slowClient(ms: number, clock: { now: number }): AnthropicLike {
    return {
      messages: {
        ...fake.messages,
        create: async (params, options) => {
          clock.now += ms;
          return fake.messages.create(params, options);
        },
      },
    };
  }

  it("does not send another invalid-output attempt when the last one took longer than the time left", async () => {
    const clock = { now: 1_000_000 };
    fake.enqueue(fakeMessage({ text: "nope" }), fakeMessage({ json: VALID_TAGS }));

    const error = await appError(
      callStructured(
        tagOptions({
          deps: { ...deps(), anthropic: slowClient(30_000, clock), now: () => clock.now },
          deadlineAt: clock.now + 50_000,
        }),
      ),
    );

    // The real cause, not a "Try again" timeout after a paid attempt the deadline cut off.
    expect(error.code).toBe("AI_INVALID_OUTPUT");
    expect(error.details).toMatchObject({ attempts: 1, reason: "no_time_for_retry" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.remaining()).toBe(1);
  });

  it("does not send another attempt after an SSE error event late in a reply, as after a dropped connection (D-177)", async () => {
    // An overloaded_error event 200 s into the reply, with 70 s of 270 s left.
    const clock = { now: 1_000_000, latencyMs: [200_000] };
    const sdk = sdkStreaming(["overloaded", "complete"], clock);

    const error = await appError(
      callStructured(
        tagOptions({
          deps: { ...deps(), anthropic: sdk.client, now: () => clock.now },
          stream: true,
          deadlineAt: clock.now + 270_000,
        }),
      ),
    );

    // The overload, not "Claude did not answer in time" after a paid attempt the deadline cut off.
    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.message).toBe("Claude's reply broke off (overloaded_error). Try again shortly.");
    expect(error.details).toMatchObject({ attempts: 1, reason: "no_time_for_retry" });
    expect(sdk.requests()).toBe(1);
    expect((await rows()).map((row) => row.errorCode)).toEqual(["stream_overloaded_error"]);
  });

  it("measures the time a retry needs by the longest reply of the call, not only the attempt that failed (D-177)", async () => {
    // A 130 s invalid reply, then a stream that broke off after 20 s: a third
    // attempt may take 130 s again, with 119 s of 270 s left after the backoff.
    const clock = { now: 1_000_000 };
    const latencies = [130_000, 20_000];
    const slowStreams: AnthropicLike = {
      messages: {
        ...fake.messages,
        stream: (params, options) => {
          clock.now += latencies.shift() ?? 0;
          return fake.messages.stream(params, options);
        },
      },
    };
    fake.enqueue(fakeMessage({ text: "nope" }), { kind: "broken", usage: { input_tokens: 6_000 } }, fakeMessage({ json: VALID_TAGS }));

    const error = await appError(
      callStructured(
        tagOptions({
          deps: { ...deps(), anthropic: slowStreams, now: () => clock.now },
          stream: true,
          deadlineAt: clock.now + 270_000,
        }),
      ),
    );

    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.message).toBe("Claude's reply broke off. Try again shortly.");
    expect(error.details).toMatchObject({ attempts: 2, reason: "no_time_for_retry" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.remaining()).toBe(1);
  });

  // A client whose replies take the next of `latencies` of the injected clock, streamed or not.
  function timedClient(latencies: number[], clock: { now: number }): AnthropicLike {
    return {
      messages: {
        ...fake.messages,
        create: async (params, options) => {
          clock.now += latencies.shift() ?? 0;
          return fake.messages.create(params, options);
        },
        stream: (params, options) => {
          clock.now += latencies.shift() ?? 0;
          return fake.messages.stream(params, options);
        },
      },
    };
  }

  it("does not send another attempt after an HTTP error when the time left cannot hold the call's longest reply (D-185)", async () => {
    // A part's 130 s invalid reply, then a 529 after 1 s asking for 15 s: a
    // third attempt would start at +146 s with 124 s left for a 130 s reply.
    const clock = { now: 1_000_000 };
    fake.enqueue(
      fakeMessage({ text: "nope" }),
      apiError(529, { headers: { "retry-after": "15" } }),
      fakeMessage({ json: VALID_TAGS }),
    );

    const error = await appError(
      callStructured(
        tagOptions({
          deps: { ...deps(), anthropic: timedClient([130_000, 1_000], clock), now: () => clock.now },
          stream: true,
          deadlineAt: clock.now + 270_000,
        }),
      ),
    );

    // The overload, not "Claude did not answer in time" after a paid attempt the deadline cut off.
    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.message).toBe("Claude is overloaded right now (HTTP 529 overloaded_error). Try again shortly.");
    expect(error.details).toMatchObject({ attempts: 2, status: 529, reason: "no_time_for_retry" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.remaining()).toBe(1);
    expect((await rows()).map((row) => row.errorCode)).toEqual(["invalid_output", "http_529"]);
  });

  it("does the same after a connection error that follows a long reply (D-185)", async () => {
    const clock = { now: 1_000_000 };
    fake.enqueue(fakeMessage({ text: "nope" }), connectionError(), fakeMessage({ json: VALID_TAGS }));

    const error = await appError(
      callStructured(
        tagOptions({
          deps: { ...deps(), anthropic: timedClient([133_000, 5_000], clock), now: () => clock.now },
          stream: true,
          deadlineAt: clock.now + 270_000,
        }),
      ),
    );

    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.message).toBe("Could not reach Claude. Check the connection and try again.");
    expect(error.details).toMatchObject({ attempts: 2, reason: "no_time_for_retry" });
    expect(fake.requests).toHaveLength(2);
  });

  it("applies the longest reply to tagging's 50 s too: invalid after 24 s, then after 5 s, ends after two attempts (D-177, D-185)", async () => {
    // Not streamed, with TAG_DEADLINE_MS (tag-item.ts) of 50 s: 29 s are gone, and 21 s cannot hold another 24 s reply.
    const clock = { now: 1_000_000 };
    fake.enqueue(fakeMessage({ text: "nope" }), fakeMessage({ text: "still nope" }), fakeMessage({ json: VALID_TAGS }));

    const error = await appError(
      callStructured(
        tagOptions({
          deps: { ...deps(), anthropic: timedClient([24_000, 5_000], clock), now: () => clock.now },
          deadlineAt: clock.now + 50_000,
        }),
      ),
    );

    expect(error.code).toBe("AI_INVALID_OUTPUT");
    expect(error.details).toMatchObject({ attempts: 2, reason: "no_time_for_retry" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.every((request) => request.method === "create")).toBe(true);
    expect(fake.remaining()).toBe(1);
  });

  it("counts a tagging reply cut off by max_tokens as the longest reply too (D-177, D-185)", async () => {
    const clock = { now: 1_000_000 };
    fake.enqueue(
      fakeMessage({ text: '{"name": "Navy', stopReason: "max_tokens" }),
      fakeMessage({ text: "nope" }),
      fakeMessage({ json: VALID_TAGS }),
    );

    const error = await appError(
      callStructured(
        tagOptions({
          deps: { ...deps(), anthropic: timedClient([25_000, 5_000], clock), now: () => clock.now },
          deadlineAt: clock.now + 50_000,
        }),
      ),
    );

    expect(error.code).toBe("AI_INVALID_OUTPUT");
    expect(error.details).toMatchObject({ attempts: 2, reason: "no_time_for_retry" });
    expect(fake.requests).toHaveLength(2);
    // The max_tokens retry itself went out, with the doubled cap (D-062).
    expect(fake.requests[1]?.params.max_tokens).toBe(8192);
    expect(fake.remaining()).toBe(1);
  });

  it("still retries an invalid reply when another attempt fits", async () => {
    const clock = { now: 1_000_000 };
    fake.enqueue(fakeMessage({ text: "nope" }), fakeMessage({ json: VALID_TAGS }));
    const result = await callStructured(
      tagOptions({
        deps: { ...deps(), anthropic: slowClient(10_000, clock), now: () => clock.now },
        deadlineAt: clock.now + 50_000,
      }),
    );
    expect(result.attempts).toBe(2);
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

describe("callStructured: a strict schema that throws", () => {
  // A strict schema may run app code in a transform (the outfit suggestion's
  // selection does); zod lets an exception thrown there escape safeParse.
  function throwingSchema(error: Error) {
    return ItemTagsSchema.transform((): ItemTags => {
      throw error;
    });
  }

  it("logs and charges the paid attempt, then ends with INTERNAL without a retry", async () => {
    const usage = { input_tokens: 1_800, output_tokens: 650 };
    fake.enqueue(fakeMessage({ json: VALID_TAGS, usage }), fakeMessage({ json: VALID_TAGS }));
    const reported: number[] = [];
    const crash = new RangeError("Invalid day: never");

    const error = await appError(
      callStructured(tagOptions({ strict: throwingSchema(crash), onAttemptCost: (usd) => void reported.push(usd) })),
    );

    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("Claude's reply could not be checked.");
    expect(error.details).toEqual({ attempts: 1 });
    expect(error.cause).toBe(crash);
    // A deterministic crash would crash again: one request, no retry.
    expect(fake.requests).toHaveLength(1);
    expect(fake.remaining()).toBe(1);
    expect(sleeps).toEqual([]);
    const expected = computeCostUsd("claude-haiku-5-5", usage);
    const logged = await rows();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      status: "error",
      stopReason: "end_turn",
      requestId: "req_fake_1",
      errorCode: "check_failed",
      errorMessage: "Invalid day: never",
      inputTokens: 1_800,
      outputTokens: 650,
    });
    expect(logged[0]?.costUsd).toBeCloseTo(expected, 6);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeCloseTo(expected, 12);
  });

  it("rethrows an AppError from the transform unchanged, after logging and charging the attempt", async () => {
    fake.enqueue(fakeMessage({ json: VALID_TAGS }), fakeMessage({ json: VALID_TAGS }));
    const reported: number[] = [];
    const thrown = new AppError("VALIDATION", "Choose Bologna or Hamburg as the home city in Settings.");

    await expect(
      callStructured(tagOptions({ strict: throwingSchema(thrown), onAttemptCost: (usd) => void reported.push(usd) })),
    ).rejects.toBe(thrown);

    expect(fake.requests).toHaveLength(1);
    const logged = await rows();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ status: "error", errorCode: "check_failed", errorMessage: thrown.message });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeCloseTo(logged[0]?.costUsd ?? Number.NaN, 6);
    expect(reported[0]).toBeGreaterThan(0);
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
