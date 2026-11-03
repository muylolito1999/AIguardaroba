import { APIUserAbortError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  backoffMs,
  classifyError,
  MAX_ATTEMPTS,
  parseRetryAfter,
  planNextAttempt,
  ReplyError,
  requestIdOf,
  StreamInterruptedError,
  type ErrorClassification,
  type PlanInput,
} from "@/lib/ai/retry";
import { AppError } from "@/lib/result";
import { apiError, connectionError, midStreamError, timeoutError } from "../../../test/fakes/anthropic";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("parseRetryAfter", () => {
  it("prefers retry-after-ms", () => {
    expect(parseRetryAfter(headers({ "retry-after-ms": "1500", "retry-after": "30" }), NOW)).toBe(1500);
  });

  it("reads retry-after as seconds", () => {
    expect(parseRetryAfter(headers({ "retry-after": "3" }), NOW)).toBe(3000);
    expect(parseRetryAfter(headers({ "retry-after": "0.5" }), NOW)).toBe(500);
  });

  it("reads retry-after as an HTTP date relative to now", () => {
    const date = new Date(NOW + 20_000).toUTCString();
    expect(parseRetryAfter(headers({ "retry-after": date }), NOW)).toBe(20_000);
  });

  it("falls back to retry-after when retry-after-ms is invalid", () => {
    expect(parseRetryAfter(headers({ "retry-after-ms": "soon", "retry-after": "2" }), NOW)).toBe(2000);
  });

  it.each([
    ["no headers", null],
    ["no retry header", headers({ "x-other": "1" })],
    ["zero seconds", headers({ "retry-after": "0" })],
    ["negative ms", headers({ "retry-after-ms": "-5" })],
    ["a past date", headers({ "retry-after": new Date(NOW - 1000).toUTCString() })],
    ["garbage", headers({ "retry-after": "later" })],
  ])("returns null for %s", (_label, value) => {
    expect(parseRetryAfter(value, NOW)).toBeNull();
  });
});

describe("backoffMs", () => {
  it("uses full jitter under a ceiling that doubles from 1 s and caps at 8 s", () => {
    expect(backoffMs(1, () => 0)).toBe(0);
    expect(backoffMs(1, () => 0.5)).toBe(500);
    expect(backoffMs(2, () => 0.5)).toBe(1000);
    expect(backoffMs(3, () => 0.999)).toBe(3996);
    expect(backoffMs(4, () => 0.999)).toBe(7992);
    expect(backoffMs(10, () => 0.999)).toBe(7992);
  });

  it("stays within [0, ceiling) for any random value", () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const ceiling = Math.min(8000, 1000 * 2 ** (attempt - 1));
      for (const r of [0, 0.1, 0.5, 0.9999]) {
        const delay = backoffMs(attempt, () => r);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(ceiling);
      }
    }
  });
});

describe("classifyError", () => {
  it.each([
    [429, "AI_UNAVAILABLE"],
    [529, "AI_UNAVAILABLE"],
    [500, "AI_UNAVAILABLE"],
    [503, "AI_UNAVAILABLE"],
    [409, "AI_UNAVAILABLE"],
    [408, "AI_TIMEOUT"],
  ] as const)("retries HTTP %i", (status, code) => {
    const c = classifyError(apiError(status));
    expect(c).toMatchObject({ retryable: true, label: `http_${status}`, code, status });
  });

  it.each([
    [400, "AI_UNAVAILABLE"],
    [413, "AI_UNAVAILABLE"],
    [422, "AI_UNAVAILABLE"],
    [402, "AI_UNAVAILABLE"],
    [401, "CONFIG"],
    [403, "CONFIG"],
    [404, "CONFIG"],
  ] as const)("does not retry HTTP %i", (status, code) => {
    expect(classifyError(apiError(status, { type: "invalid_request_error" }))).toMatchObject({
      retryable: false,
      code,
      status,
    });
  });

  it("honours x-should-retry in both directions", () => {
    expect(classifyError(apiError(529, { headers: { "x-should-retry": "false" } })).retryable).toBe(false);
    expect(classifyError(apiError(400, { headers: { "x-should-retry": "true" } })).retryable).toBe(true);
  });

  it("names overload and rate limits in the final message", () => {
    expect(classifyError(apiError(529)).message).toMatch(/overloaded/);
    expect(classifyError(apiError(429)).message).toMatch(/rate limit/);
  });

  it("retries connection errors and request timeouts", () => {
    expect(classifyError(connectionError())).toMatchObject({ retryable: true, label: "connection", code: "AI_UNAVAILABLE" });
    expect(classifyError(timeoutError())).toMatchObject({ retryable: true, label: "timeout", code: "AI_TIMEOUT" });
  });

  it("retries a mid-stream overloaded error (status undefined)", () => {
    expect(classifyError(midStreamError("overloaded_error"))).toMatchObject({
      retryable: true,
      label: "stream_overloaded_error",
      code: "AI_UNAVAILABLE",
      status: null,
    });
    expect(classifyError(midStreamError("api_error")).retryable).toBe(true);
  });

  it("does not retry a mid-stream error that says the request is wrong", () => {
    expect(classifyError(midStreamError("invalid_request_error"))).toMatchObject({ retryable: false });
    expect(classifyError(midStreamError("authentication_error"))).toMatchObject({ retryable: false, code: "CONFIG" });
  });

  it("does not retry an abort", () => {
    expect(classifyError(new APIUserAbortError())).toMatchObject({ retryable: false, code: "AI_TIMEOUT" });
  });

  it("retries invalid output and max_tokens, but not refusals or other stops", () => {
    expect(classifyError(new ReplyError("invalid_output", "bad"))).toMatchObject({
      retryable: true,
      code: "AI_INVALID_OUTPUT",
    });
    expect(classifyError(new ReplyError("max_tokens", "cut"))).toMatchObject({
      retryable: true,
      code: "AI_INVALID_OUTPUT",
    });
    expect(
      classifyError(new ReplyError("refusal", "no", { category: "general_harms", explanation: null })),
    ).toMatchObject({ retryable: false, code: "AI_REFUSAL", details: { category: "general_harms" } });
    expect(classifyError(new ReplyError("unexpected_stop", "odd"))).toMatchObject({
      retryable: false,
      code: "AI_UNAVAILABLE",
    });
  });

  it("does not retry AppErrors such as CONFIG and keeps their code", () => {
    const config = new AppError("CONFIG", "Invalid server configuration (ai): ANTHROPIC_API_KEY is not set.");
    expect(classifyError(config)).toMatchObject({ retryable: false, code: "CONFIG", label: "config" });
  });

  it("does not retry unknown errors", () => {
    expect(classifyError(new TypeError("boom"))).toMatchObject({ retryable: false, code: "INTERNAL" });
    expect(classifyError("a string")).toMatchObject({ retryable: false, code: "INTERNAL" });
  });

  it("reads the request id of API errors and broken streams only", () => {
    expect(requestIdOf(apiError(529))).toBe("req_fake_529");
    expect(requestIdOf(new StreamInterruptedError("terminated", { cause: null, requestId: "req_9" }))).toBe("req_9");
    expect(requestIdOf(new Error("x"))).toBeNull();
  });

  it("retries a streamed reply that broke off (D-163)", () => {
    expect(classifyError(new StreamInterruptedError("terminated", { cause: null, requestId: null }))).toMatchObject({
      retryable: true,
      label: "stream_interrupted",
      code: "AI_UNAVAILABLE",
    });
  });
});

function plan(classification: ErrorClassification, overrides: Partial<PlanInput> = {}) {
  return planNextAttempt({
    attempt: 1,
    classification,
    now: NOW,
    deadlineAt: NOW + 50_000,
    random: () => 0.5,
    minAttemptMs: 2_000,
    maxTokensRetries: 0,
    currentMaxTokens: 4096,
    maxTokensCeiling: 8192,
    ...overrides,
  });
}

describe("planNextAttempt", () => {
  it("retries a 529 after a jittered backoff", () => {
    expect(plan(classifyError(apiError(529)))).toEqual({
      action: "retry",
      delayMs: 500,
      maxTokens: 4096,
      maxTokensRetries: 0,
    });
  });

  it("waits as long as retry-after asks when that fits the deadline", () => {
    const result = plan(classifyError(apiError(429, { headers: { "retry-after": "5" } })));
    expect(result).toMatchObject({ action: "retry", delayMs: 5000 });
  });

  it("fails fast with AI_UNAVAILABLE and retryAfterSeconds when retry-after passes the deadline", () => {
    const result = plan(classifyError(apiError(429, { headers: { "retry-after": "60" } })), {
      deadlineAt: NOW + 30_000,
    });
    expect(result.action).toBe("fail");
    if (result.action !== "fail") return;
    expect(result.error.code).toBe("AI_UNAVAILABLE");
    expect(result.error.details).toMatchObject({ retryAfterSeconds: 60 });
  });

  it("fails fast with AI_TIMEOUT when even the backoff leaves too little time", () => {
    const result = plan(classifyError(apiError(529)), { deadlineAt: NOW + 2_200, random: () => 0.9 });
    expect(result.action).toBe("fail");
    if (result.action !== "fail") return;
    expect(result.error.code).toBe("AI_TIMEOUT");
    expect(result.error.details).toMatchObject({ retryAfterSeconds: 1 });
  });

  it("retries invalid output at once", () => {
    expect(plan(classifyError(new ReplyError("invalid_output", "bad")))).toMatchObject({
      action: "retry",
      delayMs: 0,
    });
  });

  it("retries max_tokens once with the cap doubled, then gives up", () => {
    const maxTokens = classifyError(new ReplyError("max_tokens", "cut"));
    expect(plan(maxTokens)).toEqual({ action: "retry", delayMs: 0, maxTokens: 8192, maxTokensRetries: 1 });

    const second = plan(maxTokens, { attempt: 2, maxTokensRetries: 1, currentMaxTokens: 8192 });
    expect(second.action).toBe("fail");
    if (second.action === "fail") expect(second.error.code).toBe("AI_INVALID_OUTPUT");
  });

  it("caps the doubled max_tokens at the ceiling and does not retry when already there", () => {
    const maxTokens = classifyError(new ReplyError("max_tokens", "cut"));
    expect(plan(maxTokens, { currentMaxTokens: 6000 })).toMatchObject({ action: "retry", maxTokens: 8192 });
    expect(plan(maxTokens, { currentMaxTokens: 8192 }).action).toBe("fail");
  });

  it("never allows more than 3 attempts", () => {
    expect(MAX_ATTEMPTS).toBe(3);
    const overloaded = classifyError(apiError(529));
    expect(plan(overloaded, { attempt: 2 }).action).toBe("retry");
    const last = plan(overloaded, { attempt: MAX_ATTEMPTS });
    expect(last.action).toBe("fail");
    if (last.action !== "fail") return;
    expect(last.error.code).toBe("AI_UNAVAILABLE");
    expect(last.error.message).toMatch(/gave up after 3 attempts/);
    expect(last.error.details).toMatchObject({ attempts: 3, status: 529 });
  });

  it("fails at once on a fatal error and keeps the cause", () => {
    const cause = apiError(400, { type: "invalid_request_error" });
    const result = plan(classifyError(cause), { cause });
    expect(result.action).toBe("fail");
    if (result.action !== "fail") return;
    expect(result.error.code).toBe("AI_UNAVAILABLE");
    expect(result.error.cause).toBe(cause);
  });
});

describe("planNextAttempt: time for the next attempt (D-164)", () => {
  const invalid = classifyError(new ReplyError("invalid_output", "Claude's reply did not match the expected format."));
  const broken = classifyError(new StreamInterruptedError("terminated", { cause: null, requestId: null }));

  it("fails an invalid reply with its own error when the last attempt took longer than the time left", () => {
    // A 170 s synthesis attempt with 98 s of the part's 270 s left.
    const result = plan(invalid, { deadlineAt: NOW + 98_000, longestReplyMs: 170_000 });
    expect(result.action).toBe("fail");
    if (result.action !== "fail") return;
    expect(result.error.code).toBe("AI_INVALID_OUTPUT");
    expect(result.error.details).toMatchObject({ attempts: 1, reason: "no_time_for_retry" });
  });

  it("retries an invalid reply when another attempt of the same length fits", () => {
    expect(plan(invalid, { deadlineAt: NOW + 200_000, longestReplyMs: 170_000 }).action).toBe("retry");
  });

  it("applies to a stream that broke off late, counting the backoff", () => {
    expect(plan(broken, { deadlineAt: NOW + 60_000, longestReplyMs: 200_000 })).toMatchObject({ action: "fail" });
    expect(plan(broken, { deadlineAt: NOW + 60_000, longestReplyMs: 59_600 })).toMatchObject({ action: "fail" });
    expect(plan(broken, { deadlineAt: NOW + 60_000, longestReplyMs: 5_000 })).toMatchObject({ action: "retry", delayMs: 500 });
  });

  it("applies to an SSE error event that broke a reply off late, as to a dropped connection (D-177)", () => {
    // An overloaded_error event 200 s into a part's stream, with 60 s of its 270 s left.
    const overloaded = classifyError(midStreamError("overloaded_error"));
    const result = plan(overloaded, { deadlineAt: NOW + 60_000, longestReplyMs: 200_000 });
    expect(result.action).toBe("fail");
    if (result.action !== "fail") return;
    // The overload stays visible, not a "did not answer in time" after a paid attempt.
    expect(result.error.code).toBe("AI_UNAVAILABLE");
    expect(result.error.message).toBe("Claude's reply broke off (overloaded_error). Try again shortly.");
    expect(result.error.details).toEqual({ attempts: 1, reason: "no_time_for_retry" });
    expect(plan(overloaded, { deadlineAt: NOW + 60_000, longestReplyMs: 5_000 })).toMatchObject({ action: "retry" });
  });

  it("leaves transport errors before any reply to the minimum-attempt check: their latency says nothing about the next one", () => {
    expect(plan(classifyError(apiError(529)), { deadlineAt: NOW + 10_000, longestReplyMs: 0 }).action).toBe("retry");
    expect(plan(classifyError(apiError(529)), { deadlineAt: NOW + 10_000 }).action).toBe("retry");
  });

  it("does not retry a transport error after a reply of the call that the time left could not hold again (D-185)", () => {
    // A reply in this call took 40 s; 10 s are left when a 529 comes.
    const overloaded = plan(classifyError(apiError(529)), { deadlineAt: NOW + 10_000, longestReplyMs: 40_000 });
    expect(overloaded.action).toBe("fail");
    if (overloaded.action !== "fail") return;
    // The overload stays visible, not a "did not answer in time" after a paid attempt.
    expect(overloaded.error.code).toBe("AI_UNAVAILABLE");
    expect(overloaded.error.message).toBe("Claude is overloaded right now (HTTP 529 overloaded_error). Try again shortly.");
    expect(overloaded.error.details).toEqual({ attempts: 1, status: 529, reason: "no_time_for_retry" });

    const unreachable = plan(classifyError(connectionError()), { deadlineAt: NOW + 10_000, longestReplyMs: 40_000 });
    expect(unreachable).toMatchObject({ action: "fail" });
    if (unreachable.action !== "fail") return;
    expect(unreachable.error.message).toBe("Could not reach Claude. Check the connection and try again.");
    expect(unreachable.error.details).toMatchObject({ reason: "no_time_for_retry" });

    // A wait that runs past the deadline still says how long to wait.
    const busy = plan(classifyError(apiError(529, { headers: { "retry-after": "200" } })), {
      deadlineAt: NOW + 140_000,
      longestReplyMs: 130_000,
    });
    expect(busy.action).toBe("fail");
    if (busy.action !== "fail") return;
    expect(busy.error.message).toBe("Claude is busy. Try again in about 200 s.");
    expect(busy.error.details).toMatchObject({ retryAfterSeconds: 200 });

    expect(plan(classifyError(apiError(529)), { deadlineAt: NOW + 50_000, longestReplyMs: 40_000 }).action).toBe("retry");
  });

  it("keeps the max_tokens retry's own rule (D-062)", () => {
    const cut = classifyError(new ReplyError("max_tokens", "cut"));
    expect(plan(cut, { deadlineAt: NOW + 10_000, longestReplyMs: 40_000 })).toMatchObject({ action: "retry", maxTokens: 8192 });
  });
});
