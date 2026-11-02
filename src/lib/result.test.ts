import { describe, expect, it } from "vitest";

import {
  AppError,
  CONFIG_ERROR_MESSAGE,
  ERROR_CODES,
  HTTP_STATUS,
  INTERNAL_ERROR_MESSAGE,
  err,
  errorToast,
  isAppError,
  ok,
  toErrorPayload,
  type Result,
} from "@/lib/result";

describe("ok / err", () => {
  it("builds the success shape", () => {
    const result: Result<{ id: string }> = ok({ id: "a" });
    expect(result).toEqual({ ok: true, data: { id: "a" } });
  });

  it("builds the failure shape without an undefined details key", () => {
    const result: Result<number> = err("NOT_FOUND", "Item not found");
    expect(result).toStrictEqual({ ok: false, error: { code: "NOT_FOUND", message: "Item not found" } });
  });

  it("includes details when given", () => {
    expect(err("VALIDATION", "Bad input", { field: "name" })).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "Bad input", details: { field: "name" } },
    });
  });

  it("narrows on the ok discriminant", () => {
    const result: Result<number> = Math.random() > 2 ? ok(1) : err("CONFLICT", "Changed");
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("CONFLICT");
  });
});

describe("AppError", () => {
  it("carries code, message, details and cause", () => {
    const cause = new Error("root");
    const error = new AppError("RATE_LIMITED", "Slow down", { retryAfterSeconds: 60 }, { cause });
    expect(error).toBeInstanceOf(Error);
    expect(isAppError(error)).toBe(true);
    expect(error.name).toBe("AppError");
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.details).toEqual({ retryAfterSeconds: 60 });
    expect(error.cause).toBe(cause);
  });
});

describe("toErrorPayload", () => {
  it("passes an AppError through", () => {
    expect(toErrorPayload(new AppError("DUPLICATE", "Already uploaded", { itemId: "x" }))).toEqual({
      code: "DUPLICATE",
      message: "Already uploaded",
      details: { itemId: "x" },
    });
    expect(toErrorPayload(new AppError("NOT_FOUND", "Gone"))).toStrictEqual({ code: "NOT_FOUND", message: "Gone" });
  });

  it("hides which configuration is wrong behind a generic CONFIG message", () => {
    const error = new AppError(
      "CONFIG",
      "Invalid server configuration (password): APP_PASSWORD_HASH looks like a raw bcrypt hash. See .env.example.",
      { group: "password", variables: ["APP_PASSWORD_HASH"] },
    );
    const payload = toErrorPayload(error);
    expect(payload).toStrictEqual({ code: "CONFIG", message: CONFIG_ERROR_MESSAGE });
    expect(JSON.stringify(payload)).not.toMatch(/APP_PASSWORD_HASH|password|bcrypt/);
  });

  it("never leaks the message of a non-AppError", () => {
    const secret = 'duplicate key value violates unique constraint "items_pkey" password=hunter2';
    const payload = toErrorPayload(new Error(secret));
    expect(payload).toStrictEqual({ code: "INTERNAL", message: INTERNAL_ERROR_MESSAGE });
    expect(JSON.stringify(payload)).not.toContain("hunter2");
  });

  it.each([["a string"], [42], [null], [undefined], [{ code: "NOT_FOUND", message: "spoofed" }]])(
    "maps a thrown %j to INTERNAL",
    (thrown) => {
      expect(toErrorPayload(thrown)).toStrictEqual({ code: "INTERNAL", message: INTERNAL_ERROR_MESSAGE });
    },
  );
});

describe("HTTP_STATUS", () => {
  it("covers every error code with a 4xx or 5xx status", () => {
    expect(Object.keys(HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(HTTP_STATUS[code]).toBeLessThan(600);
    }
    expect(HTTP_STATUS.UNAUTHENTICATED).toBe(401);
    expect(HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(HTTP_STATUS.INTERNAL).toBe(500);
  });
});

describe("errorToast", () => {
  it("builds error toast options from a payload", () => {
    expect(errorToast({ code: "BUDGET_EXCEEDED", message: "Monthly AI budget reached." })).toEqual({
      title: "AI budget reached",
      description: "Monthly AI budget reached.",
      type: "error",
    });
  });
});
