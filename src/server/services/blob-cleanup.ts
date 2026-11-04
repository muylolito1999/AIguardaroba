import "server-only";

import { count, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { IMAGE_KINDS } from "@/lib/db/enums";
import { blobCleanup, type BlobCleanup } from "@/lib/db/schema";
import { blobFailure, type BlobStorage } from "@/lib/images/blob";
import { AppError, toErrorPayload, type AppErrorPayload } from "@/lib/result";

// Deletes the Blob files that blob_cleanup lists (D-234). A file is queued in
// the same transaction that removes its last database row, so the queue is
// the durable record of what is left to delete, and this module works it off.
// Deleting is idempotent (a file the store no longer has counts as deleted),
// so two runs that pick the same row at once do no harm.

export type BlobCleanupReason = "item_deleted";

export type BlobCleanupDeps = {
  db: Db;
  /** Built by the caller (getBlobStorage()), so a missing token fails before the queue is touched. */
  storage: BlobStorage;
  /** Tests pass a fixed clock. */
  now?: () => Date;
};

export type BlobCleanupOptions = {
  /**
   * Epoch ms (the real clock, Date.now, not deps.now) by which the run ends
   * (D-237): each Blob call gets at most the time left, and no item is
   * started with less than MIN_CALL_MS left. The caller derives it from its
   * own time limit.
   */
  deadlineAt: number;
  /** At most this many items' files are tried, one Blob call per item. */
  maxItems: number;
  /** This item's files go first: the delete that just queued them. */
  firstItemId?: string;
  /** Files tried more recently than this are left for a later run; omitted, every queued file is due. */
  retryAfterMs?: number;
};

export type BlobCleanupSummary = {
  /** Files deleted in this run (or found already gone), each taken off the queue. */
  deleted: number;
  /** Files still queued when the run ended. */
  pending: number;
  /** The failure that ended the run early, safe to return; null when nothing failed. */
  error: AppErrorPayload | null;
};

/** last_error is for diagnosis in the database; a long upstream message is cut. */
const LAST_ERROR_MAX_LENGTH = 500;

/**
 * The longest one Blob call may take, however much of the run is left. A
 * delete normally answers in well under a second; this still gives the SDK
 * a few of its retries, and keeps a store outage from using up the cron's
 * whole run on one item.
 */
export const CLEANUP_CALL_TIMEOUT_MS = 30_000;

/** An item is not started with less than this left: its call would most likely only time out. */
export const MIN_CALL_MS = 1_000;

type Group = { itemId: string; rows: Array<Pick<BlobCleanup, "id" | "url">> };

/** The due rows grouped by item, in the order the groups are tried. */
async function dueGroups(db: Db, options: BlobCleanupOptions, now: Date): Promise<Group[]> {
  const { firstItemId, retryAfterMs, maxItems } = options;
  const due =
    retryAfterMs === undefined
      ? undefined
      : or(isNull(blobCleanup.lastAttemptAt), lt(blobCleanup.lastAttemptAt, new Date(now.getTime() - retryAfterMs)));
  const rows = await db
    .select({ id: blobCleanup.id, url: blobCleanup.url, itemId: blobCleanup.itemId })
    .from(blobCleanup)
    .where(due)
    .orderBy(
      // The just-deleted item first; then files never tried, then those tried
      // longest ago, so a file that keeps failing moves behind the others
      // instead of blocking them.
      ...(firstItemId === undefined ? [] : [sql`${blobCleanup.itemId} = ${firstItemId} desc`]),
      sql`${blobCleanup.lastAttemptAt} asc nulls first`,
      blobCleanup.createdAt,
      blobCleanup.id,
    )
    // An item has at most one image row per kind, so this many rows always
    // hold the first maxItems groups whole.
    .limit(maxItems * IMAGE_KINDS.length);

  const groups = new Map<string, Group>();
  for (const row of rows) {
    const group = groups.get(row.itemId) ?? { itemId: row.itemId, rows: [] };
    group.rows.push({ id: row.id, url: row.url });
    groups.set(row.itemId, group);
  }
  return [...groups.values()].slice(0, maxItems);
}

/**
 * Deletes queued Blob files, one del() per item, and removes the queue row of
 * every file that is gone. The attempt is recorded before each call, so a
 * call cut off by the function's time limit still counts and moves its files
 * behind the others. Each call gives up at options.deadlineAt at the latest
 * (D-237), so a store that does not answer still ends in a stored failure
 * instead of a killed function. The first failure is logged, stored in
 * last_error and ends the run: a store outage or a token problem would fail
 * every later call too. When the time left is too short for another item,
 * the run ends without an error and the rest stays queued.
 *
 * This is the cron entry point, so it does not check a session (the cron
 * route checks CRON_SECRET); deleteItem calls it after its own session check.
 */
export async function runBlobCleanup(deps: BlobCleanupDeps, options: BlobCleanupOptions): Promise<BlobCleanupSummary> {
  const { db, storage } = deps;
  const now = deps.now ?? (() => new Date());
  const summary: BlobCleanupSummary = { deleted: 0, pending: 0, error: null };
  // A NaN deadline would pass the time-left check and give every call a timer that fires at once.
  if (!Number.isFinite(options.deadlineAt)) throw new AppError("INTERNAL", "deadlineAt must be a finite epoch time.");

  for (const group of await dueGroups(db, options, now())) {
    const leftMs = options.deadlineAt - Date.now();
    if (leftMs < MIN_CALL_MS) break;
    const ids = group.rows.map((row) => row.id);
    const urls = group.rows.map((row) => row.url);
    await db
      .update(blobCleanup)
      .set({ attempts: sql`${blobCleanup.attempts} + 1`, lastAttemptAt: now() })
      .where(inArray(blobCleanup.id, ids));
    try {
      await storage.del(urls, { timeoutMs: Math.min(CLEANUP_CALL_TIMEOUT_MS, leftMs) });
    } catch (error) {
      console.error(
        `[blob-cleanup] deleting ${urls.length} file(s) of deleted item ${group.itemId} failed; they stay queued:`,
        urls,
        error,
      );
      const failure = blobFailure(error, "delete a deleted item's photos");
      // The safe message alone would not say what Blob answered.
      const cause = failure.cause instanceof Error ? ` (${failure.cause.message})` : "";
      const lastError = `${failure.code}: ${failure.message}${cause}`.slice(0, LAST_ERROR_MAX_LENGTH);
      await db.update(blobCleanup).set({ lastError }).where(inArray(blobCleanup.id, ids));
      summary.error = toErrorPayload(failure);
      break;
    }
    await db.delete(blobCleanup).where(inArray(blobCleanup.id, ids));
    summary.deleted += urls.length;
  }

  const [left] = await db.select({ value: count() }).from(blobCleanup);
  summary.pending = left?.value ?? 0;
  return summary;
}
