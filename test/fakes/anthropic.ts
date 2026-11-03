// A scripted stand-in for the Anthropic client (D-046: no network in tests).
// It implements AnthropicLike, so services take it where they take the real
// client. Each messages.create / messages.stream call consumes the next
// scripted step; errors are real SDK error instances, so classification in
// retry.ts sees exactly what the SDK would throw.

import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  MessageStreamEvent,
  RefusalStopDetails,
  StopReason,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  BatchCreateParams,
  MessageBatch,
  MessageBatchIndividualResponse,
} from "@anthropic-ai/sdk/resources/messages/batches";
import type { ErrorObject, ErrorType } from "@anthropic-ai/sdk/resources/shared";

import type { AnthropicLike, AnthropicRequestOptions, MessageStreamLike } from "@/lib/ai/client";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** A complete Usage; every field the SDK declares is present. */
export function fakeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 2_000,
    output_tokens: 600,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    speed: null,
    ...overrides,
  };
}

export type FakeMessageInput = {
  /** Serialised into the text block. */
  json?: unknown;
  /** Raw text block content (wins over json). */
  text?: string;
  /** Adds a thinking block before the text block. */
  thinking?: string;
  /** Leaves out the text block entirely. */
  noText?: boolean;
  stopReason?: StopReason;
  stopDetails?: Omit<RefusalStopDetails, "type">;
  usage?: Partial<Usage>;
  model?: string;
  id?: string;
};

let messageSeq = 0;

/** A complete Message as the SDK returns it. */
export function fakeMessage(input: FakeMessageInput = {}): Message {
  messageSeq += 1;
  const content: ContentBlock[] = [];
  if (input.thinking !== undefined) {
    content.push({ type: "thinking", thinking: input.thinking, signature: "fake-signature" });
  }
  if (!input.noText) {
    const text = input.text ?? JSON.stringify(input.json ?? {});
    content.push({ type: "text", text, citations: null });
  }
  return {
    id: input.id ?? `msg_fake_${messageSeq}`,
    container: null,
    content,
    diagnostics: null,
    model: input.model ?? "claude-haiku-5-5",
    role: "assistant",
    stop_details: input.stopDetails ? { type: "refusal", ...input.stopDetails } : null,
    stop_reason: input.stopReason ?? "end_turn",
    stop_sequence: null,
    type: "message",
    usage: fakeUsage(input.usage),
  };
}

/** An HTTP error exactly as the SDK builds it (BadRequestError, RateLimitError, InternalServerError...). */
export function apiError(
  status: number,
  options: { type?: string; message?: string; headers?: Record<string, string> } = {},
): APIError {
  const type = options.type ?? (status === 529 ? "overloaded_error" : status === 429 ? "rate_limit_error" : "api_error");
  return APIError.generate(
    status,
    { type: "error", error: { type, message: options.message ?? `fake ${status}` } },
    undefined,
    new Headers({ "request-id": `req_fake_${status}`, ...options.headers }),
  );
}

/** An SSE `event: error` after a 200, which the SDK raises with an undefined status. */
export function midStreamError(type: ErrorType = "overloaded_error"): APIError {
  return new APIError(
    undefined,
    { type: "error", error: { type, message: "fake mid-stream error" } },
    undefined,
    new Headers({ "request-id": "req_fake_stream" }),
    type,
  );
}

export function connectionError(): APIConnectionError {
  return new APIConnectionError({ message: "fake connection error" });
}

export function timeoutError(): APIConnectionTimeoutError {
  return new APIConnectionTimeoutError();
}

// ---------------------------------------------------------------------------
// Batch result builders
// ---------------------------------------------------------------------------

export function succeededResult(customId: string, message: Message): MessageBatchIndividualResponse {
  return { custom_id: customId, result: { type: "succeeded", message } };
}

/** An errored result; the error kind sits at result.error.error.type, as in the API. */
export function erroredResult(
  customId: string,
  type: ErrorObject["type"] = "invalid_request_error",
  message = "fake batch error",
): MessageBatchIndividualResponse {
  return {
    custom_id: customId,
    result: {
      type: "errored",
      error: { type: "error", error: { type, message } as ErrorObject, request_id: "req_fake_batch" },
    },
  };
}

export function expiredResult(customId: string): MessageBatchIndividualResponse {
  return { custom_id: customId, result: { type: "expired" } };
}

export function canceledResult(customId: string): MessageBatchIndividualResponse {
  return { custom_id: customId, result: { type: "canceled" } };
}

// ---------------------------------------------------------------------------
// The fake client
// ---------------------------------------------------------------------------

export type FakeStep =
  | { kind: "message"; message: Message; requestId?: string }
  | { kind: "error"; error: unknown }
  /** Never answers; rejects with APIUserAbortError when the request's signal aborts. */
  | { kind: "hang" }
  /**
   * A streamed reply that breaks off after message_start reported this usage:
   * the stream emits that event, then rejects with the plain AnthropicError
   * the SDK raises for a socket closed mid-body. messages.stream only.
   */
  | { kind: "broken"; usage?: Partial<Usage>; requestId?: string };

export type RecordedRequest = {
  method: "create" | "stream";
  /** A deep copy, safe to inspect after the call. */
  params: MessageCreateParamsNonStreaming;
  timeout: number | undefined;
  hasSignal: boolean;
};

/** The request options a batch call received: the SDK timeout and whether a signal was passed. */
export type RecordedBatchOptions = { timeout: number | undefined; hasSignal: boolean };

export type RecordedBatchCall =
  | { method: "create"; params: BatchCreateParams; options: RecordedBatchOptions }
  | { method: "retrieve" | "results"; batchId: string; options: RecordedBatchOptions };

type BatchMethod = "create" | "retrieve" | "results";

type StoredBatch = { batch: MessageBatch; results: MessageBatchIndividualResponse[] };

export type FakeAnthropic = AnthropicLike & {
  /** Every messages.create / messages.stream call, in order. */
  readonly requests: RecordedRequest[];
  /** Every batch call, in order. */
  readonly batchCalls: RecordedBatchCall[];
  /** Appends steps: a Message, an error to throw, or a step object. */
  enqueue(...steps: Array<Message | Error | FakeStep>): void;
  /** Steps not consumed yet; tests assert 0 to prove every scripted reply was used. */
  remaining(): number;
  /** Ends a created batch with these results (any order, as the API returns them). */
  endBatch(batchId: string, results: MessageBatchIndividualResponse[]): void;
  /** Makes the next call of a batch method throw. */
  failNextBatchCall(method: BatchMethod, error: unknown): void;
  /**
   * Makes the next results() call stream nothing until its signal aborts,
   * like a download that stalls; it then throws APIUserAbortError.
   */
  stallNextResults(): void;
};

function recordOptions(options: AnthropicRequestOptions | undefined): RecordedBatchOptions {
  return { timeout: options?.timeout, hasSignal: options?.signal !== undefined };
}

function toStep(step: Message | Error | FakeStep): FakeStep {
  if (step instanceof Error) return { kind: "error", error: step };
  if ("kind" in step) return step;
  return { kind: "message", message: step };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(new APIUserAbortError());
    signal.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
  });
}

function emptyCounts(): MessageBatch["request_counts"] {
  return { canceled: 0, errored: 0, expired: 0, processing: 0, succeeded: 0 };
}

/**
 * Builds a fake client. Pass initial steps or call enqueue later. An
 * unscripted call throws, so a test fails loudly instead of hanging.
 */
export function createFakeAnthropic(initial: Array<Message | Error | FakeStep> = []): FakeAnthropic {
  const queue: FakeStep[] = initial.map(toStep);
  const requests: RecordedRequest[] = [];
  const batchCalls: RecordedBatchCall[] = [];
  const batches = new Map<string, StoredBatch>();
  const batchFailures = new Map<BatchMethod, unknown[]>();
  let stallResults = 0;
  let batchSeq = 0;
  let requestSeq = 0;

  const next = async (
    method: "create" | "stream",
    params: MessageCreateParamsNonStreaming,
    options: AnthropicRequestOptions | undefined,
    onBroken?: (step: Extract<FakeStep, { kind: "broken" }>, requestId: string) => void,
  ): Promise<{ message: Message; requestId: string }> => {
    requests.push({
      method,
      params: structuredClone(params),
      timeout: options?.timeout,
      hasSignal: options?.signal !== undefined,
    });
    const step = queue.shift();
    if (step === undefined) throw new Error(`FakeAnthropic: no scripted reply left for messages.${method}`);
    if (options?.signal?.aborted) throw new APIUserAbortError();
    switch (step.kind) {
      case "error":
        throw step.error;
      case "hang":
        return waitForAbort(options?.signal);
      case "broken": {
        if (onBroken === undefined) throw new Error("FakeAnthropic: a broken reply needs messages.stream");
        requestSeq += 1;
        const requestId = step.requestId ?? `req_fake_${requestSeq}`;
        // Events arrive after stream() returned, once its listeners are on.
        await Promise.resolve();
        onBroken(step, requestId);
        throw new AnthropicError("terminated");
      }
      case "message":
        requestSeq += 1;
        return { message: structuredClone(step.message), requestId: step.requestId ?? `req_fake_${requestSeq}` };
    }
  };

  const takeBatchFailure = (method: BatchMethod): void => {
    const pending = batchFailures.get(method);
    if (pending && pending.length > 0) throw pending.shift();
  };

  const stored = (batchId: string): StoredBatch => {
    const entry = batches.get(batchId);
    // The real API answers an unknown id with a 404.
    if (!entry) throw apiError(404, { type: "not_found_error", message: `fake batch ${batchId} not found` });
    return entry;
  };

  return {
    requests,
    batchCalls,
    messages: {
      async create(params, options) {
        const { message, requestId } = await next("create", params, options);
        return Object.assign(message, { _request_id: requestId });
      },
      stream(params, options): MessageStreamLike {
        let requestId: string | null = null;
        const listeners: Array<(event: MessageStreamEvent, snapshot: Message) => void> = [];
        const result = next("stream", params, options, (step, id) => {
          // What message_start delivers: the message so far, with the input usage.
          requestId = id;
          const snapshot = fakeMessage({ noText: true, usage: { output_tokens: 1, ...step.usage } });
          const event: MessageStreamEvent = { type: "message_start", message: snapshot };
          for (const listener of listeners) listener(event, snapshot);
        }).then(({ message, requestId: id }) => {
          requestId = id;
          return message;
        });
        // Rejections surface through finalMessage(), as with the SDK's MessageStream.
        result.catch(() => undefined);
        return {
          finalMessage: () => result,
          get request_id() {
            return requestId;
          },
          on(_event, listener) {
            listeners.push(listener);
            return this;
          },
        };
      },
      batches: {
        async create(params, options) {
          batchCalls.push({ method: "create", params: structuredClone(params), options: recordOptions(options) });
          takeBatchFailure("create");
          batchSeq += 1;
          const id = `msgbatch_fake_${batchSeq}`;
          const batch: MessageBatch = {
            id,
            archived_at: null,
            cancel_initiated_at: null,
            created_at: new Date(0).toISOString(),
            ended_at: null,
            expires_at: new Date(24 * 3_600_000).toISOString(),
            processing_status: "in_progress",
            request_counts: { ...emptyCounts(), processing: params.requests.length },
            results_url: null,
            type: "message_batch",
          };
          batches.set(id, { batch, results: [] });
          return structuredClone(batch);
        },
        async retrieve(batchId, _params, options) {
          batchCalls.push({ method: "retrieve", batchId, options: recordOptions(options) });
          takeBatchFailure("retrieve");
          return structuredClone(stored(batchId).batch);
        },
        async results(batchId, _params, options) {
          batchCalls.push({ method: "results", batchId, options: recordOptions(options) });
          takeBatchFailure("results");
          const entry = stored(batchId);
          if (entry.batch.processing_status !== "ended") {
            throw apiError(400, { type: "invalid_request_error", message: "fake batch has not ended" });
          }
          const results = structuredClone(entry.results);
          if (stallResults > 0) {
            stallResults -= 1;
            const signal = options?.signal;
            return (async function* () {
              await waitForAbort(signal);
              yield* results;
            })();
          }
          return (async function* () {
            yield* results;
          })();
        },
      },
    },
    enqueue(...steps) {
      queue.push(...steps.map(toStep));
    },
    remaining() {
      return queue.length;
    },
    endBatch(batchId, results) {
      const entry = stored(batchId);
      const counts = emptyCounts();
      for (const result of results) counts[result.result.type] += 1;
      entry.batch = {
        ...entry.batch,
        processing_status: "ended",
        ended_at: new Date(3_600_000).toISOString(),
        request_counts: counts,
        results_url: `https://api.anthropic.com/v1/messages/batches/${batchId}/results`,
      };
      entry.results = structuredClone(results);
    },
    failNextBatchCall(method, error) {
      const pending = batchFailures.get(method) ?? [];
      pending.push(error);
      batchFailures.set(method, pending);
    },
    stallNextResults() {
      stallResults += 1;
    },
  };
}
