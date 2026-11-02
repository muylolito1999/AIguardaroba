import "server-only";

import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";

import { requireSession, type Session } from "@/lib/auth/dal";
import {
  AppError,
  CONFIG_ERROR_MESSAGE,
  HTTP_STATUS,
  toErrorPayload,
  type AppErrorPayload,
  type Err,
  type Result,
} from "@/lib/result";

// Shared request plumbing for Route Handlers (authedRoute) and Server Actions
// (authedAction in src/server/actions/_wrap.ts): one place that checks the
// session, validates input and turns failures into safe payloads. Unexpected
// errors and CONFIG errors are logged with full detail before toErrorPayload
// hides them from the client (D-053).

export type RouteParams = Record<string, string | string[] | undefined>;

export type AuthedRouteContext<P extends RouteParams = RouteParams> = {
  request: Request;
  /** The route's dynamic params, as Next passes them (a promise). */
  params: Promise<P>;
  session: Session;
};

export type RouteHandler<P extends RouteParams = RouteParams> = (
  request: Request,
  context: { params: Promise<P> },
) => Promise<Response>;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True when an AppError is an expected outcome that needs no server log. */
function isExpected(error: unknown): boolean {
  return error instanceof AppError && error.code !== "CONFIG" && error.code !== "INTERNAL";
}

/**
 * Logs anything that is not an expected AppError, then converts it to an Err
 * safe for the client. Call it at the top level of a catch block after
 * unstable_rethrow, so redirect() and notFound() still reach Next.
 */
export function errFromThrown(error: unknown, where: string): Err {
  if (!isExpected(error)) console.error(`[${where}] failed:`, error);
  return { ok: false, error: toErrorPayload(error) };
}

/**
 * Passes a handler's own Err through, except CONFIG, whose message may name
 * environment variables: that one is logged and replaced, like a thrown one.
 */
export function publicErr(result: Err, where: string): Err {
  if (result.error.code !== "CONFIG") return result;
  console.error(`[${where}] returned a configuration error:`, result.error);
  return { ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } };
}

/** A VALIDATION Err listing each failing field and zod's message for it (never the input values). */
export function validationErr(error: z.ZodError): Err {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: "Some fields are missing or invalid.",
      details: {
        issues: error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
      },
    },
  };
}

/** Plain-object view of form fields; repeated keys become arrays. */
export function formDataToObject(formData: FormData): Record<string, FormDataEntryValue | FormDataEntryValue[]> {
  const result: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
  for (const key of new Set(formData.keys())) {
    const values = formData.getAll(key);
    result[key] = values.length === 1 ? (values[0] as FormDataEntryValue) : values;
  }
  return result;
}

function searchParamsToObject(params: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    result[key] = values.length === 1 ? (values[0] as string) : values;
  }
  return result;
}

function requestHost(request: Request): string {
  // Same order Next uses for its own Server Action origin check.
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("host") || new URL(request.url).host;
}

/**
 * CSRF guard for cookie-authenticated mutations: the browser-set Origin must
 * name this host. A missing or opaque ("null") Origin is refused, because
 * every browser sends Origin on POST, PUT, PATCH and DELETE.
 */
export function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "null") return false;
  try {
    return new URL(origin).host === requestHost(request);
  } catch {
    return false;
  }
}

function errorResponse(payload: AppErrorPayload): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  const retryAfter = payload.details?.retryAfterSeconds;
  if (payload.code === "RATE_LIMITED" && typeof retryAfter === "number") {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfter))));
  }
  return Response.json({ ok: false, error: payload }, { status: HTTP_STATUS[payload.code], headers });
}

async function readInput(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { ok: true, value: searchParamsToObject(new URL(request.url).searchParams) };
  }
  const text = await request.text();
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Wraps a Route Handler: Origin check on mutating methods (403), session check
 * (401), input validation (400) from the JSON body, or from the query string
 * for GET and HEAD, then the handler. A returned Result becomes
 * `{ ok, data | error }` JSON with the matching HTTP status; a returned
 * Response (a stream or a file) is sent as is. Pass `null` as the schema to
 * leave the body unread for the handler.
 *
 * Type route params by annotating the handler's context, for example
 * `async (input, { params }: AuthedRouteContext<{ id: string }>) => …`.
 */
export function authedRoute<S extends z.ZodType, T, P extends RouteParams = RouteParams>(
  schema: S | null,
  handler: (input: z.output<S>, context: AuthedRouteContext<P>) => Promise<Result<T> | Response>,
): RouteHandler<P> {
  return async (request, { params }) => {
    const where = `api ${request.method} ${new URL(request.url).pathname}`;
    try {
      if (MUTATING_METHODS.has(request.method) && !hasSameOrigin(request)) return crossOriginRefused();

      const session = await requireSession();

      let input: unknown = undefined;
      if (schema !== null) {
        const raw = await readInput(request);
        if (!raw.ok) return errorResponse({ code: "VALIDATION", message: "The request body must be JSON." });
        const parsed = schema.safeParse(raw.value);
        if (!parsed.success) return errorResponse(validationErr(parsed.error).error);
        input = parsed.data;
      }

      const result = await handler(input as z.output<S>, { request, params, session });
      if (result instanceof Response) return result;
      if (!result.ok) return errorResponse(publicErr(result, where).error);
      return Response.json({ ok: true, data: result.data }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      unstable_rethrow(error);
      return errorResponse(errFromThrown(error, where).error);
    }
  };
}

export const CROSS_ORIGIN_MESSAGE = "Cross-origin requests are not allowed.";

function crossOriginRefused(): Response {
  // There is no FORBIDDEN error code: a cross-origin request's cookies are not
  // accepted as authentication, so the body says UNAUTHENTICATED while the
  // status is 403, telling the client that signing in again will not help.
  return Response.json(
    { ok: false, error: { code: "UNAUTHENTICATED", message: CROSS_ORIGIN_MESSAGE } },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
