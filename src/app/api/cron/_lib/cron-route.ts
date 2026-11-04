import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { unstable_rethrow } from "next/navigation";

import { cronEnv } from "@/env";
import { HTTP_STATUS, type AppErrorPayload } from "@/lib/result";
import { errFromThrown } from "@/server/http";

// What every Vercel cron route shares (D-069): proxy.ts does not cover
// /api/cron/*, and there is no session. Vercel sends
// `Authorization: Bearer <CRON_SECRET>`, which is the only credential here.
// The folder is private (`_lib`), so this module is never a route itself.

const NO_STORE = { "Cache-Control": "no-store" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time check; hashing first gives equal-length inputs, so the secret's length does not leak either. */
function authorized(header: string | null, secret: string): boolean {
  return header !== null && timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

function errorResponse(error: AppErrorPayload): Response {
  return Response.json({ ok: false, error }, { status: HTTP_STATUS[error.code], headers: NO_STORE });
}

/**
 * A run's answer: 200 with the summary when nothing failed. Otherwise the
 * failure's status with `{ ok: false, error, data }`, so the cron log shows
 * the run as failed and the summary of what did get done is kept (D-092).
 */
export function cronResult<T>(summary: T, failure: AppErrorPayload | null | undefined): Response {
  if (failure === null || failure === undefined) return Response.json({ ok: true, data: summary }, { headers: NO_STORE });
  return Response.json(
    { ok: false, error: failure, data: summary },
    { status: HTTP_STATUS[failure.code], headers: NO_STORE },
  );
}

/**
 * The GET handler of a cron route: checks the secret, then runs `run`. A
 * missing or wrong secret answers 401 without running it, a missing
 * CRON_SECRET a generic 500; anything `run` throws is logged and answered
 * with its status (CONFIG without detail).
 */
export function cronRoute(where: string, run: () => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    // Reading the header first also makes the handler request-time under Cache
    // Components, so it is never prerendered at build.
    const header = request.headers.get("authorization");
    try {
      // A missing CRON_SECRET throws CONFIG, answered as a 500 without detail.
      const { CRON_SECRET } = cronEnv();
      if (!authorized(header, CRON_SECRET)) {
        return errorResponse({ code: "UNAUTHENTICATED", message: "Missing or wrong cron secret." });
      }
      return await run();
    } catch (error) {
      unstable_rethrow(error);
      return errorResponse(errFromThrown(error, where).error);
    }
  };
}
