import { getAnthropic } from "@/lib/ai/client";
import { getDb } from "@/lib/db";
import { runBatchPoll } from "@/server/services/batches";

import { cronResult, cronRoute } from "../_lib/cron-route";

// The daily Vercel cron (vercel.json, 04:00 UTC; Hobby allows one run a day
// per job) that applies finished tagging batches (D-024). The secret check is
// shared with the other cron routes (_lib/cron-route.ts). Runs may be missed
// or duplicated, which the batch processing tolerates.
export const maxDuration = 300;
/** Per Batches API request; well inside maxDuration even with a few open batches. */
const CRON_REQUEST_TIMEOUT_MS = 60_000;

export const GET = cronRoute("api GET /api/cron/poll-batches", async () => {
  const summary = await runBatchPoll({
    db: getDb(),
    anthropic: getAnthropic,
    requestTimeoutMs: CRON_REQUEST_TIMEOUT_MS,
  });
  // Some batches failed (each was logged): the first error's status, with the
  // counts of the batches that were applied.
  return cronResult(summary, summary.errors[0]);
});
