// Retry policy for Claude calls (D-019). Pure: callStructured() is the only
// retry loop (the SDK runs with maxRetries 0), and this module decides, for
// each failed attempt, whether to retry, how long to wait and which AppError
// ends the call.

import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";

import { AppError, type ErrorCode } from "@/lib/result";

/** Attempts per call, the first one included. */
export const MAX_ATTEMPTS = 3;

/** Full-jitter backoff: base 1 s, doubling, capped at 8 s. */
export const BACKOFF = { baseMs: 1_000, capMs: 8_000 } as const;

/** Header access shared by the Fetch Headers class and test doubles. */
export type HeadersLike = { get(name: string): string | null };

/**
 * A reply that arrived but cannot be used. callStructured throws it into
 * classifyError like any other failure.
 */
export type ReplyFailureKind = "invalid_output" | "max_tokens" | "refusal" | "unexpected_stop";

export class ReplyError extends Error {
  readonly kind: ReplyFailureKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: ReplyFailureKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ReplyError";
    this.kind = kind;
    if (details !== undefined) this.details = details;
  }
}

export type ErrorClassification = {
  retryable: boolean;
  /** Short label stored in ai_calls.error_code, e.g. http_529, connection, invalid_output. */
  label: string;
  /** The AppError code used when this failure ends the call. */
  code: ErrorCode;
  /** User-facing message used when this failure ends the call. */
  message: string;
  status: number | null;
  /** Response headers, read for retry-after. */
  headers: HeadersLike | null;
  details?: Record<string, unknown>;
};

const RETRYABLE_STATUSES = new Set([408, 409, 429]);
const RETRYABLE_STREAM_TYPES = new Set(["overloaded_error", "api_error", "rate_limit_error", "timeout_error"]);
const CONFIG_TYPES = new Set(["authentication_error", "permission_error", "not_found_error"]);

function statusMessage(status: number, type: string | null): string {
  const what = type ? `HTTP ${status} ${type}` : `HTTP ${status}`;
  if (status === 429) return `Claude's rate limit was reached (${what}). Try again shortly.`;
  if (status === 529 || type === "overloaded_error") return `Claude is overloaded right now (${what}). Try again shortly.`;
  if (status >= 500) return `Claude had a server error (${what}). Try again shortly.`;
  if (status === 408) return `Claude timed out (${what}). Try again.`;
  if (status === 402) return `Anthropic refused the request for billing reasons (${what}). Check the account's credit.`;
  if (status === 413) return `The request was too large for Claude (${what}).`;
  return `Claude rejected the request (${what}).`;
}

function classifyApiError(error: APIError): ErrorClassification {
  const status = typeof error.status === "number" ? error.status : null;
  const headers = error.headers ?? null;
  const type = error.type ?? null;

  if (status === null) {
    // An SSE `event: error` after a 200 (for example overloaded_error mid-stream).
    // The SDK does not retry these; we do, unless the type says the request is wrong.
    const label = `stream_${type ?? "error"}`;
    if (type === null || RETRYABLE_STREAM_TYPES.has(type)) {
      return {
        retryable: true,
        label,
        code: type === "timeout_error" ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
        message: `Claude's reply broke off (${type ?? "stream error"}). Try again shortly.`,
        status,
        headers,
      };
    }
    return {
      retryable: false,
      label,
      code: CONFIG_TYPES.has(type) ? "CONFIG" : "AI_UNAVAILABLE",
      message: `Claude rejected the request (${type}).`,
      status,
      headers,
    };
  }

  const label = `http_${status}`;
  const shouldRetry = headers?.get("x-should-retry");
  let retryable = RETRYABLE_STATUSES.has(status) || status >= 500;
  // The API's own hint wins over the status, as in the SDK.
  if (shouldRetry === "true") retryable = true;
  if (shouldRetry === "false") retryable = false;

  if (status === 401 || status === 403 || status === 404) {
    return {
      retryable: false,
      label,
      code: "CONFIG",
      message:
        status === 404
          ? `Anthropic did not find the model or endpoint (${label}). Check the configured model ids.`
          : `Anthropic rejected the API key (${label}). Check ANTHROPIC_API_KEY.`,
      status,
      headers,
    };
  }
  return {
    retryable,
    label,
    code: status === 408 ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
    message: statusMessage(status, type),
    status,
    headers,
  };
}

const REPLY_FAILURES: Record<ReplyFailureKind, { retryable: boolean; code: ErrorCode }> = {
  // A malformed reply is usually a one-off; another sample is likely fine.
  invalid_output: { retryable: true, code: "AI_INVALID_OUTPUT" },
  // Retried once with a doubled cap (planNextAttempt enforces "once").
  max_tokens: { retryable: true, code: "AI_INVALID_OUTPUT" },
  // Refusals are final: no fallback model and no retry (D-022).
  refusal: { retryable: false, code: "AI_REFUSAL" },
  unexpected_stop: { retryable: false, code: "AI_UNAVAILABLE" },
};

/** Decides whether a failed attempt may be retried and which error ends the call if not. */
export function classifyError(error: unknown): ErrorClassification {
  if (error instanceof ReplyError) {
    const { retryable, code } = REPLY_FAILURES[error.kind];
    return {
      retryable,
      label: error.kind,
      code,
      message: error.message,
      status: null,
      headers: null,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof AppError) {
    return {
      retryable: false,
      label: error.code.toLowerCase(),
      code: error.code,
      message: error.message,
      status: null,
      headers: null,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  // Subclasses first: all of these extend APIError with an undefined status.
  if (error instanceof APIUserAbortError) {
    return {
      retryable: false,
      label: "aborted",
      code: "AI_TIMEOUT",
      message: "The request to Claude was cancelled before it finished.",
      status: null,
      headers: null,
    };
  }
  if (error instanceof APIConnectionTimeoutError) {
    return {
      retryable: true,
      label: "timeout",
      code: "AI_TIMEOUT",
      message: "Claude did not answer in time. Try again.",
      status: null,
      headers: null,
    };
  }
  if (error instanceof APIConnectionError) {
    return {
      retryable: true,
      label: "connection",
      code: "AI_UNAVAILABLE",
      message: "Could not reach Claude. Check the connection and try again.",
      status: null,
      headers: null,
    };
  }
  if (error instanceof APIError) return classifyApiError(error);
  // Anything else is a bug on our side; repeating it would not help.
  return {
    retryable: false,
    label: "unknown",
    code: "INTERNAL",
    message: "The request to Claude failed unexpectedly.",
    status: null,
    headers: null,
  };
}

/** The request id of a failed API call, for the ai_calls row. */
export function requestIdOf(error: unknown): string | null {
  return error instanceof APIError ? (error.requestID ?? null) : null;
}

/**
 * The server's requested wait in ms: `retry-after-ms`, then `retry-after` as
 * seconds or an HTTP date. Null when absent, invalid or not in the future.
 */
export function parseRetryAfter(headers: HeadersLike | null | undefined, now: number): number | null {
  if (!headers) return null;
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "") {
    const value = Number(ms);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const after = headers.get("retry-after");
  if (after === null || after.trim() === "") return null;
  const seconds = Number(after);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : null;
  const date = Date.parse(after);
  if (Number.isNaN(date)) return null;
  const wait = date - now;
  return wait > 0 ? wait : null;
}

/** Full jitter: a random wait in [0, min(cap, base x 2^(attempt - 1))). */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF.capMs, BACKOFF.baseMs * 2 ** Math.max(0, attempt - 1));
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.floor(r * ceiling);
}

export type PlanInput = {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  classification: ErrorClassification;
  now: number;
  /** Epoch ms by which the whole call must be finished. */
  deadlineAt: number;
  random: () => number;
  /** An attempt shorter than this is not worth starting. */
  minAttemptMs: number;
  /** max_tokens retries already made in this call. */
  maxTokensRetries: number;
  currentMaxTokens: number;
  maxTokensCeiling: number;
  /** The failure itself, kept as the AppError's cause for server logs. */
  cause?: unknown;
};

export type AttemptPlan =
  | { action: "retry"; delayMs: number; maxTokens: number; maxTokensRetries: number }
  | { action: "fail"; error: AppError };

/** What to do after a failed attempt: wait and retry, or end the call with an AppError. */
export function planNextAttempt(input: PlanInput): AttemptPlan {
  const { attempt, classification: c } = input;
  const fail = (code: ErrorCode, message: string, details: Record<string, unknown>): AttemptPlan => ({
    action: "fail",
    error: new AppError(code, message, details, input.cause === undefined ? undefined : { cause: input.cause }),
  });
  const details = { ...c.details, attempts: attempt, ...(c.status === null ? {} : { status: c.status }) };

  if (!c.retryable) return fail(c.code, c.message, details);

  const isMaxTokens = c.label === "max_tokens";
  if (isMaxTokens && (input.maxTokensRetries >= 1 || input.currentMaxTokens >= input.maxTokensCeiling)) {
    return fail(c.code, c.message, details);
  }
  if (attempt >= MAX_ATTEMPTS) {
    return fail(c.code, `${c.message} (gave up after ${attempt} attempts)`, details);
  }

  // A bad reply is retried at once; transport and server errors wait.
  const immediate = isMaxTokens || c.label === "invalid_output";
  const requested = immediate ? null : parseRetryAfter(c.headers, input.now);
  const delayMs = immediate ? 0 : (requested ?? backoffMs(attempt, input.random));

  if (input.now + delayMs + input.minAttemptMs > input.deadlineAt) {
    // Waiting would run past the route's deadline: fail now and say when to retry.
    const retryAfterSeconds = Math.max(1, Math.ceil(delayMs / 1000));
    return requested === null
      ? fail("AI_TIMEOUT", "Claude did not answer in time. Try again.", { ...details, retryAfterSeconds })
      : fail("AI_UNAVAILABLE", `Claude is busy. Try again in about ${retryAfterSeconds} s.`, {
          ...details,
          retryAfterSeconds,
        });
  }

  return {
    action: "retry",
    delayMs,
    maxTokens: isMaxTokens ? Math.min(input.currentMaxTokens * 2, input.maxTokensCeiling) : input.currentMaxTokens,
    maxTokensRetries: input.maxTokensRetries + (isMaxTokens ? 1 : 0),
  };
}
