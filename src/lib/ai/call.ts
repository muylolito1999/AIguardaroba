import "server-only";

import { AnthropicError, APIError } from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  OutputConfig,
  TextBlock,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";
import type { z } from "zod";

import type { AnthropicLike, AnthropicRequestOptions, MessageStreamLike } from "@/lib/ai/client";
import { toJsonSchemaFormat } from "@/lib/ai/json-schema";
import { dbCallLogger, usageColumns, type AiCallLogger, type AiCallRecord } from "@/lib/ai/log";
import type { PricedModelId } from "@/lib/ai/models";
import {
  classifyError,
  MAX_ATTEMPTS,
  planNextAttempt,
  ReplyError,
  requestIdOf,
  StreamInterruptedError,
  type ErrorClassification,
} from "@/lib/ai/retry";
import type { Db } from "@/lib/db/client";
import type { AiCallStatus, AiPurpose } from "@/lib/db/enums";
import { AppError } from "@/lib/result";

// callStructured(): the one way the app calls Claude (D-018 to D-022).
// - Structured output through our own JSON Schema (enums kept), checked again
//   with the strict zod schema after JSON.parse.
// - The static system prompt is one cached text block; the user content
//   (image first) follows. No temperature, top_p, top_k or prefill.
// - The only retry loop: at most 3 attempts, deadline-aware, and every attempt
//   is written to ai_calls with its usage and cost, failures included.
// - Errors leave as AppError only.

export type Effort = NonNullable<OutputConfig["effort"]>;
export type CacheTtl = "5m" | "1h";

/** An attempt needs at least this long before the deadline to be worth sending. */
export const DEFAULT_MIN_ATTEMPT_MS = 2_000;

/** Everything that shapes the request body; batches build their requests from the same type. */
export type StructuredRequest = {
  model: PricedModelId;
  /** Static text only: anything variable here defeats the prompt cache. */
  system: string;
  /** TTL of the cache breakpoint on the system prompt (default 5m; batches use 1h). */
  cacheTtl?: CacheTtl;
  /** The user turn: put images before the instruction text. */
  content: ContentBlockParam[];
  /** The wire schema sent as output_config.format. */
  wire: z.ZodType;
  effort: Effort;
  maxTokens: number;
};

/**
 * The Messages request body. Exported so the batch path sends exactly the
 * parameters of its synchronous dry run (D-024).
 */
export function buildMessageParams(request: StructuredRequest): MessageCreateParamsNonStreaming {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [
      {
        type: "text",
        text: request.system,
        cache_control: request.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: request.content }],
    output_config: { format: toJsonSchemaFormat(request.wire), effort: request.effort },
  };
}

// ---------------------------------------------------------------------------
// Reading a reply
// ---------------------------------------------------------------------------

export type StructuredReply<T> =
  | { kind: "ok"; data: T }
  | { kind: "invalid_output"; detail: string }
  | { kind: "max_tokens" }
  | { kind: "refusal"; category: string | null; explanation: string | null }
  | { kind: "unexpected_stop"; stopReason: string | null };

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/**
 * Interprets a reply by its stop_reason. Thinking blocks are skipped by type
 * and the first text block is parsed and validated with the strict schema.
 * Shared with batch result processing.
 */
export function readStructuredReply<T>(
  message: Pick<Message, "content" | "stop_reason" | "stop_details">,
  strict: z.ZodType<T>,
): StructuredReply<T> {
  switch (message.stop_reason) {
    case "refusal":
      return {
        kind: "refusal",
        category: message.stop_details?.category ?? null,
        explanation: message.stop_details?.explanation ?? null,
      };
    case "max_tokens":
      return { kind: "max_tokens" };
    case "end_turn":
      break;
    default:
      return { kind: "unexpected_stop", stopReason: message.stop_reason };
  }

  const text = message.content.find((block): block is TextBlock => block.type === "text");
  if (text === undefined) return { kind: "invalid_output", detail: "The reply has no text block." };
  let json: unknown;
  try {
    json = JSON.parse(text.text);
  } catch {
    return { kind: "invalid_output", detail: "The reply is not valid JSON." };
  }
  const parsed = strict.safeParse(json);
  if (!parsed.success) return { kind: "invalid_output", detail: describeIssues(parsed.error) };
  return { kind: "ok", data: parsed.data };
}

/** The ai_calls status of a reply. */
export function replyCallStatus(reply: StructuredReply<unknown>): AiCallStatus {
  switch (reply.kind) {
    case "ok":
      return "success";
    case "invalid_output":
      return "invalid_output";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "unexpected_stop":
      return "error";
  }
}

/** The failure a non-ok reply stands for; classifyError() turns it into a retry decision or an AppError. */
export function replyFailure(reply: Exclude<StructuredReply<unknown>, { kind: "ok" }>): ReplyError {
  switch (reply.kind) {
    case "invalid_output":
      return new ReplyError("invalid_output", "Claude's reply did not match the expected format.");
    case "max_tokens":
      return new ReplyError("max_tokens", "Claude's reply was cut off by the output limit.");
    case "refusal":
      return new ReplyError(
        "refusal",
        `Claude declined this request${reply.category ? ` (${reply.category})` : ""}.`,
        { category: reply.category, explanation: reply.explanation },
      );
    case "unexpected_stop":
      return new ReplyError("unexpected_stop", `Claude stopped unexpectedly (${reply.stopReason ?? "no stop reason"}).`, {
        stopReason: reply.stopReason,
      });
  }
}

function replyDetail(reply: StructuredReply<unknown>): string | null {
  switch (reply.kind) {
    case "invalid_output":
      return reply.detail;
    case "refusal":
      return [reply.category, reply.explanation].filter(Boolean).join(": ") || "refusal";
    case "unexpected_stop":
      return `stop_reason ${reply.stopReason ?? "null"}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** Where attempts are recorded: a database (ai_calls) or, for the smoke script without one, a custom logger. */
type CallSink = { db: Db; logCall?: never } | { logCall: AiCallLogger; db?: never };

export type CallStructuredDeps = CallSink & {
  anthropic: AnthropicLike;
  /** Epoch ms; defaults to Date.now. */
  now?: () => number;
  /** In [0, 1); defaults to Math.random (backoff jitter). */
  random?: () => number;
  /** Waits between attempts; tests pass one that records and resolves at once. */
  sleep?: (ms: number) => Promise<void>;
};

export type CallStructuredOptions<T> = StructuredRequest & {
  deps: CallStructuredDeps;
  purpose: AiPurpose;
  /** Applied after JSON.parse; enforces what the wire schema cannot. */
  strict: z.ZodType<T>;
  /** The max_tokens retry doubles the cap up to this (default 2 x maxTokens). */
  maxTokensCeiling?: number;
  /** messages.stream + finalMessage instead of messages.create (long outputs). */
  stream?: boolean;
  /** Epoch ms by which the call must be done; route handlers pass start + maxDuration minus a margin. */
  deadlineAt: number;
  /** Upper bound for a single attempt (default: the time left until the deadline). */
  requestTimeoutMs?: number;
  minAttemptMs?: number;
  /** Cancels the call, e.g. the route's request.signal. */
  signal?: AbortSignal;
  links?: { itemId?: string | null; analysisId?: string | null };
  /**
   * Called with each paid attempt's cost once its ai_calls row is written,
   * failed replies included, so a caller can keep a running total even when
   * the call gives up and throws. A streamed reply that broke off reports the
   * usage message_start announced (D-163); other transport errors have no
   * usage and no call. Awaited before the next attempt, so a caller can store
   * the cost as it goes (D-168).
   */
  onAttemptCost?: (usd: number) => void | Promise<void>;
};

export type CallStructuredResult<T> = {
  data: T;
  /** Every attempt of this call, failed ones included. */
  costUsd: number;
  attempts: number;
  requestId: string | null;
  model: PricedModelId;
  /** Usage of the successful attempt. */
  usage: Usage;
  latencyMs: number;
};

type AttemptOutcome =
  | { ok: true; message: Message; requestId: string | null; latencyMs: number }
  | {
      ok: false;
      error: unknown;
      latencyMs: number;
      deadlineHit: boolean;
      cancelled: boolean;
      /** What the stream had reported when a reply broke off; null otherwise. */
      usage: Usage | null;
    };

async function sendAttempt(
  anthropic: AnthropicLike,
  params: MessageCreateParamsNonStreaming,
  settings: { stream: boolean; remainingMs: number; requestTimeoutMs?: number; signal?: AbortSignal; now: () => number },
): Promise<AttemptOutcome> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), settings.remainingMs);
  const signal = settings.signal ? AbortSignal.any([settings.signal, deadline.signal]) : deadline.signal;
  // The SDK's per-request timeout also lifts its non-streaming size guard.
  const requestOptions: AnthropicRequestOptions = {
    signal,
    timeout: Math.max(1, Math.min(settings.requestTimeoutMs ?? settings.remainingMs, settings.remainingMs)),
  };
  const started = settings.now();
  let stream: MessageStreamLike | undefined;
  // The SDK clears its snapshot when a body ends before message_stop, so the
  // usage is kept from the events as they arrive. The listener stays trivial:
  // MessageStream wraps an error thrown by a listener like a broken stream.
  let reported: Usage | null = null;
  try {
    if (settings.stream) {
      stream = anthropic.messages.stream(params, requestOptions);
      stream.on("streamEvent", (_event, snapshot) => {
        reported = snapshot.usage;
      });
      const message = await stream.finalMessage();
      return { ok: true, message, requestId: stream.request_id ?? null, latencyMs: settings.now() - started };
    }
    const message = await anthropic.messages.create(params, requestOptions);
    return { ok: true, message, requestId: message._request_id ?? null, latencyMs: settings.now() - started };
  } catch (error) {
    // MessageStream raises a socket closed mid-body, or a body that ends
    // before message_stop, as a plain AnthropicError. Every APIError (HTTP
    // errors, SSE error events, aborts) keeps its own classification (D-163).
    const interrupted = stream !== undefined && error instanceof AnthropicError && !(error instanceof APIError);
    return {
      ok: false,
      error: interrupted
        ? new StreamInterruptedError(error.message, { cause: error, requestId: stream?.request_id ?? null })
        : error,
      latencyMs: settings.now() - started,
      deadlineHit: deadline.signal.aborted,
      cancelled: settings.signal?.aborted === true,
      usage: interrupted ? reported : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function abortClassification(cancelled: boolean): ErrorClassification {
  return cancelled
    ? {
        retryable: false,
        label: "cancelled",
        code: "AI_TIMEOUT",
        message: "The request to Claude was cancelled.",
        status: null,
        headers: null,
      }
    : {
        retryable: false,
        label: "deadline",
        code: "AI_TIMEOUT",
        message: "Claude did not answer in time. Try again.",
        status: null,
        headers: null,
      };
}

function resolveLogger(deps: CallStructuredDeps): AiCallLogger {
  const logger = deps.logCall ?? (deps.db ? dbCallLogger(deps.db) : undefined);
  if (!logger) throw new AppError("INTERNAL", "callStructured needs a database or a call logger.");
  // Recording spend is not optional: a failed insert ends the call.
  return async (row) => {
    try {
      await logger(row);
    } catch (error) {
      throw new AppError("INTERNAL", "The AI call could not be recorded.", undefined, { cause: error });
    }
  };
}

function validateOptions(options: CallStructuredOptions<unknown>, ceiling: number): void {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
    throw new AppError("INTERNAL", "maxTokens must be a positive integer.");
  }
  if (!Number.isInteger(ceiling) || ceiling < options.maxTokens) {
    throw new AppError("INTERNAL", "maxTokensCeiling must be an integer of at least maxTokens.");
  }
  if (!Number.isFinite(options.deadlineAt)) throw new AppError("INTERNAL", "deadlineAt must be a finite epoch time.");
}

/**
 * Calls Claude for one structured reply, retrying per retry.ts, and returns the
 * strict-validated data with the summed cost of all attempts. Throws AppError:
 * AI_REFUSAL, AI_INVALID_OUTPUT, AI_UNAVAILABLE, AI_TIMEOUT, CONFIG (rejected
 * key or unknown model) or INTERNAL. An AppError raised inside an attempt
 * (such as CONFIG from env) is rethrown unchanged.
 */
export async function callStructured<T>(options: CallStructuredOptions<T>): Promise<CallStructuredResult<T>> {
  const { deps } = options;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = resolveLogger(deps);
  const ceiling = options.maxTokensCeiling ?? options.maxTokens * 2;
  const minAttemptMs = options.minAttemptMs ?? DEFAULT_MIN_ATTEMPT_MS;
  validateOptions(options, ceiling);

  let maxTokens = options.maxTokens;
  let maxTokensRetries = 0;
  let totalCostUsd = 0;
  // The longest attempt so far that had a reply under way. A retry after a
  // short failure (a stream that broke off early) may still need as long as
  // an earlier full reply took (D-177).
  let longestReplyMs = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw new AppError("AI_TIMEOUT", "The request to Claude was cancelled.");
    const remainingMs = options.deadlineAt - now();
    if (remainingMs < minAttemptMs) {
      throw new AppError("AI_TIMEOUT", "Claude did not answer in time. Try again.", { attempts: attempt - 1 });
    }

    let params: MessageCreateParamsNonStreaming;
    try {
      params = buildMessageParams({ ...options, maxTokens });
    } catch (error) {
      throw new AppError("INTERNAL", "The request to Claude could not be built.", undefined, { cause: error });
    }

    const outcome = await sendAttempt(deps.anthropic, params, {
      stream: options.stream === true,
      remainingMs,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      now,
    });

    const latencyMs = Math.max(0, Math.round(outcome.latencyMs));
    const row: Pick<AiCallRecord, "model" | "purpose" | "attempt" | "itemId" | "analysisId" | "latencyMs"> = {
      model: options.model,
      purpose: options.purpose,
      attempt,
      itemId: options.links?.itemId ?? null,
      analysisId: options.links?.analysisId ?? null,
      latencyMs,
    };

    let classification: ErrorClassification;
    let cause: unknown;
    if (outcome.ok) {
      const { message, requestId } = outcome;
      const usage = usageColumns(options.model, message.usage);
      totalCostUsd += usage.costUsd;
      const reply = readStructuredReply(message, options.strict);
      await log({
        ...row,
        ...usage,
        status: replyCallStatus(reply),
        stopReason: message.stop_reason,
        requestId,
        errorCode: reply.kind === "ok" ? null : reply.kind,
        errorMessage: replyDetail(reply),
      });
      await options.onAttemptCost?.(usage.costUsd);
      if (reply.kind === "ok") {
        return {
          data: reply.data,
          costUsd: totalCostUsd,
          attempts: attempt,
          requestId,
          model: options.model,
          usage: message.usage,
          latencyMs,
        };
      }
      cause = replyFailure(reply);
      classification = classifyError(cause);
    } else {
      cause = outcome.error;
      classification =
        outcome.deadlineHit || outcome.cancelled ? abortClassification(outcome.cancelled) : classifyError(outcome.error);
      // A reply that broke off is billed for at least what the stream had
      // reported: the input, cache tokens and the output count so far, which
      // message_start gives as a placeholder (a lower bound, D-163).
      const usage = outcome.usage === null ? null : usageColumns(options.model, outcome.usage);
      if (usage !== null) totalCostUsd += usage.costUsd;
      await log({
        ...row,
        ...usage,
        status: "error",
        requestId: requestIdOf(outcome.error),
        errorCode: classification.label,
        errorMessage: outcome.error instanceof Error ? outcome.error.message : classification.message,
      });
      if (usage !== null) await options.onAttemptCost?.(usage.costUsd);
      if (outcome.error instanceof AppError) throw outcome.error;
    }
    // Transport and HTTP errors are not replies: their latency says nothing
    // about how long the next reply takes, so it is not counted. A reply
    // earlier in the call still sets the time their retry needs (D-185).
    if (classification.replyStarted === true) longestReplyMs = Math.max(longestReplyMs, latencyMs);

    const plan = planNextAttempt({
      attempt,
      classification,
      now: now(),
      deadlineAt: options.deadlineAt,
      random,
      minAttemptMs,
      maxTokensRetries,
      currentMaxTokens: maxTokens,
      maxTokensCeiling: ceiling,
      cause,
      longestReplyMs,
    });
    if (plan.action === "fail") throw plan.error;
    if (plan.delayMs > 0) await sleep(plan.delayMs);
    maxTokens = plan.maxTokens;
    maxTokensRetries = plan.maxTokensRetries;
  }
  // planNextAttempt fails the call on the last attempt; this guards the loop bound.
  throw new AppError("INTERNAL", "The request to Claude ran out of attempts.");
}
