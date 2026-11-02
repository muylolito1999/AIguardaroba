// Shared by server and client code, so this module must stay free of
// `server-only`, env access and Node APIs.

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "VALIDATION",
  "NOT_FOUND",
  "DUPLICATE",
  "CONFLICT",
  "RATE_LIMITED",
  "BUDGET_EXCEEDED",
  "AI_REFUSAL",
  "AI_INVALID_OUTPUT",
  "AI_UNAVAILABLE",
  "AI_TIMEOUT",
  "UPSTREAM",
  "CONFIG",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type AppErrorPayload = {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: AppErrorPayload };
export type Result<T> = Ok<T> | Err;

/**
 * An error whose message is safe to show the user. Anything thrown that is
 * not an AppError is treated as an internal failure and its message is hidden.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function err(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Err {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

export const INTERNAL_ERROR_MESSAGE = "Something went wrong. Please try again.";
export const CONFIG_ERROR_MESSAGE = "The server is misconfigured. Check the server logs.";

/**
 * Converts anything thrown into a payload that is safe to send to the client.
 * AppError messages pass through, except CONFIG: those name environment
 * variables and what is wrong with them, which public routes such as login must
 * not reveal. Other errors can carry SQL, stack or upstream text, so they
 * collapse to a generic INTERNAL message. Callers log the original error on the
 * server before converting it, because CONFIG and INTERNAL lose their detail here.
 */
export function toErrorPayload(error: unknown): AppErrorPayload {
  if (error instanceof AppError) {
    if (error.code === "CONFIG") return { code: "CONFIG", message: CONFIG_ERROR_MESSAGE };
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  return { code: "INTERNAL", message: INTERNAL_ERROR_MESSAGE };
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  VALIDATION: 400,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  // 402 signals a spending limit rather than a transient overload the client should retry.
  BUDGET_EXCEEDED: 402,
  AI_REFUSAL: 422,
  AI_INVALID_OUTPUT: 502,
  AI_UNAVAILABLE: 503,
  AI_TIMEOUT: 504,
  UPSTREAM: 502,
  CONFIG: 500,
  INTERNAL: 500,
};

const TOAST_TITLES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: "Signed out",
  VALIDATION: "Check your input",
  NOT_FOUND: "Not found",
  DUPLICATE: "Already exists",
  CONFLICT: "Changed elsewhere",
  RATE_LIMITED: "Too many attempts",
  BUDGET_EXCEEDED: "AI budget reached",
  AI_REFUSAL: "Claude declined",
  AI_INVALID_OUTPUT: "Unexpected AI response",
  AI_UNAVAILABLE: "AI unavailable",
  AI_TIMEOUT: "AI timed out",
  UPSTREAM: "Service unavailable",
  CONFIG: "Configuration problem",
  INTERNAL: "Something went wrong",
};

/** Options for `toast.add(...)` from `@/components/ui/toast`, kept import-free so servers can share this module. */
export function errorToast(error: AppErrorPayload): {
  title: string;
  description: string;
  type: "error";
} {
  return { title: TOAST_TITLES[error.code], description: error.message, type: "error" };
}
