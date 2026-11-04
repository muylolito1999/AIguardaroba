import { getDb } from "@/lib/db";
import { getBlobStorage } from "@/lib/images/blob";
import { runBlobCleanup } from "@/server/services/blob-cleanup";

import { cronResult, cronRoute } from "../_lib/cron-route";

// The daily Vercel cron (vercel.json, 05:00 UTC) that deletes the Blob files
// of deleted items still listed in blob_cleanup (D-234, D-235): the ones a
// delete could not remove because Blob failed or the function stopped after
// the commit. A run that is missed or repeated does no harm, since deleting a
// file the store no longer has counts as done.
export const maxDuration = 300;
/**
 * Items per run, one Blob call each. A call normally takes well under a
 * second, so this fits maxDuration; whatever is left waits for the next run
 * or the next delete.
 */
const CRON_MAX_ITEMS = 100;
/**
 * The run's Blob calls end this long before maxDuration (D-237), which leaves
 * time to store a failure, count the queue and answer before the platform
 * stops the function.
 */
const CRON_MARGIN_MS = 30_000;

export const GET = cronRoute("api GET /api/cron/blob-cleanup", async () => {
  const deadlineAt = Date.now() + maxDuration * 1000 - CRON_MARGIN_MS;
  // A missing BLOB_READ_WRITE_TOKEN throws CONFIG here, before the queue is read or changed.
  const storage = getBlobStorage();
  const summary = await runBlobCleanup({ db: getDb(), storage }, { maxItems: CRON_MAX_ITEMS, deadlineAt });
  return cronResult(summary, summary.error);
});
