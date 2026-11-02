import { createHash, timingSafeEqual } from "node:crypto";

import { unstable_rethrow } from "next/navigation";

import { cronEnv } from "@/env";
import { getAnthropic } from "@/lib/ai/client";
import { getDb } from "@/lib/db";
import { HTTP_STATUS, type AppErrorPayload } from "@/lib/result";
import { errFromThrown } from "@/server/http";
import { runBatchPoll } from "@/server/services/batches";

// The daily Vercel cron (vercel.json, 04:00 UTC; Hobby allows one run a day)
// that applies finished tagging batches (D-024). proxy.ts does not cover
// /api/cron/*, and there is no session: Vercel sends
// `Authorization: Bearer <CRON_SECRET>`, which is the only credential here.
// Runs may be missed or duplicated, which the batch processing tolerates.
export const maxDuration = 300;
/** Per Batches API request; well inside maxDuration even with a few open batches. */
const CRON_REQUEST_TIMEOUT_MS = 60_000;

const NO_STORE = { "Cache-Control": "no-store" };
const WHERE = "api GET /api/cron/poll-batches";

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

export async function GET(request: Request): Promise<Response> {
  // Reading the header first also makes the handler request-time under Cache
  // Components, so it is never prerendered at build.
  const header = request.headers.get("authorization");
  try {
    // A missing CRON_SECRET throws CONFIG, answered as a 500 without detail.
    const { CRON_SECRET } = cronEnv();
    if (!authorized(header, CRON_SECRET)) {
      return errorResponse({ code: "UNAUTHENTICATED", message: "Missing or wrong cron secret." });
    }
    const summary = await runBatchPoll({
      db: getDb(),
      anthropic: getAnthropic,
      requestTimeoutMs: CRON_REQUEST_TIMEOUT_MS,
    });
    const [failure] = summary.errors;
    if (failure === undefined) return Response.json({ ok: true, data: summary }, { headers: NO_STORE });
    // Some batches failed (each was logged): a non-2xx status shows the run as
    // failed in the cron log, and the counts of the batches that were applied
    // are kept next to the first error.
    return Response.json(
      { ok: false, error: failure, data: summary },
      { status: HTTP_STATUS[failure.code], headers: NO_STORE },
    );
  } catch (error) {
    unstable_rethrow(error);
    return errorResponse(errFromThrown(error, WHERE).error);
  }
}
