import "server-only";

import { randomUUID } from "node:crypto";

import type {
  MessageBatch,
  MessageBatchIndividualResponse,
} from "@anthropic-ai/sdk/resources/messages/batches";
import { APIError } from "@anthropic-ai/sdk";
import { and, asc, eq, inArray, isNull, like, lt, ne } from "drizzle-orm";

import { assertWithinBudget } from "@/lib/ai/budget";
import { buildMessageParams, readStructuredReply, replyCallStatus, replyFailure } from "@/lib/ai/call";
import type { AnthropicLike } from "@/lib/ai/client";
import { estimateTaggingBatchRunUsd } from "@/lib/ai/cost";
import { logAiCall, usageColumns } from "@/lib/ai/log";
import { isPricedModel, MODELS, type PricedModelId } from "@/lib/ai/models";
import { backoffMs, classifyError, MAX_ATTEMPTS, parseRetryAfter } from "@/lib/ai/retry";
import { TAG_PROMPT_VERSION } from "@/lib/ai/tagging/prompt";
import { ItemTagsSchema } from "@/lib/ai/tagging/schema";
import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { aiBatches, itemImages, items, type AiBatch } from "@/lib/db/schema";
import {
  DRY_RUN_ITEM_DETAIL,
  isUuid,
  TAGGED_ITEM_DETAIL,
  TAGGING_LIMITS,
  type StartTaggingBatchData,
} from "@/lib/items/contracts";
import { AppError, toErrorPayload, type AppErrorPayload } from "@/lib/result";
import { taggedItemUpdate } from "@/server/items/user-edited-fields";

import { taggingRequest, tagItem, type TagItemDeps } from "./tag-item";

// Bulk tagging through Message Batches (D-024): half price, results usually
// within an hour. Batch parameters are only validated after the whole batch
// ends, so one item is tagged synchronously with exactly the batch parameters
// before the batch is created.
//
// Starting a batch claims its items before anything is paid for: one
// transaction locks the item rows, checks them again, inserts the ai_batches
// row with a placeholder id ("claim:<uuid>") and links the batched items to
// it. A second start for the same items then fails with CONFLICT instead of
// paying for a second dry run and a second batch. After the dry run and
// batches.create, the placeholder is replaced with Anthropic's batch id; if
// either fails, the claim row is deleted, which unlinks its items (ON DELETE
// SET NULL). The whole start stays inside the Server Action's 300 s.
//
// Results are applied by custom_id (the item id) when a poll finds the batch
// ended: on review page visits and from the daily cron. Processing one batch
// is a single transaction under a lock on its row, so overlapping polls cannot
// apply or bill results twice. Polls skip claim rows and delete those a start
// left behind (older than BATCH_CLAIM_STALE_MS).

/** The UI offers a batch above 20 items; fewer are tagged directly. */
export const BATCH_MIN_ITEMS = TAGGING_LIMITS.batchMinItems;
/** One batch per add session; far below the API's 100,000 requests. */
export const BATCH_MAX_ITEMS = TAGGING_LIMITS.batchMaxItems;
/**
 * How long batches.create may keep retrying a rate limit or an overload. The
 * dry run has already been paid for by then, so a short wait is worth it.
 */
export const BATCH_CREATE_DEADLINE_MS = 60_000;
/**
 * The whole start (dry run, batches.create and its retries) must end inside
 * the Server Action's 300 s limit (D-080), with time left to answer, so the
 * page learns which item the dry run tagged.
 */
export const START_DEADLINE_MS = 270_000;
/** One batches.create request; the SDK's own default is 10 minutes. */
export const BATCH_CREATE_ATTEMPT_TIMEOUT_MS = 60_000;
/** A create attempt with less time than this left is not started. */
export const MIN_CREATE_ATTEMPT_MS = 5_000;
/** anthropic_batch_id of a batch row whose items are claimed but whose batch is not created yet. */
export const BATCH_CLAIM_PREFIX = "claim:";
/**
 * A claim older than this was left by a start that was stopped (the platform
 * ends the action at 300 s), so a poll deletes it and frees its items.
 */
export const BATCH_CLAIM_STALE_MS = 15 * 60_000;

export type { StartTaggingBatchData };

/** Whether a batch row is a claim whose Anthropic batch does not exist yet (or is unknown). */
export function isClaim(batch: Pick<AiBatch, "anthropicBatchId">): boolean {
  return batch.anthropicBatchId.startsWith(BATCH_CLAIM_PREFIX);
}

export type BatchPollDeps = {
  db: Db;
  /** Called only when there is a batch to check, so polling with none needs no API key. */
  anthropic: () => AnthropicLike;
  now?: () => number;
  /**
   * Limit for each Batches API request, the results download included. The
   * review page polls while it renders and passes a short one, so a slow API
   * becomes the "not checked" notice instead of a page that hangs; without
   * it the SDK's 10-minute default applies.
   */
  requestTimeoutMs?: number;
};

export type BatchPollSummary = {
  /** Batches whose results were applied in this run. */
  batches: number;
  /** Item results applied in this run (tagged + failed). */
  processed: number;
  tagged: number;
  failed: number;
  /** Batches still running at Anthropic. */
  pending: number;
  /**
   * One entry per batch that could not be checked or applied in this run (it
   * stays open for the next poll). The counts above still cover the others.
   */
  errors: AppErrorPayload[];
};

/** Turns a Message Batches API failure into an AppError with the same codes as callStructured. */
function batchApiFailure(error: unknown, prefix: string): AppError {
  if (error instanceof AppError) return error;
  const classification = classifyError(error);
  return new AppError(classification.code, `${prefix}: ${classification.message}`, classification.details, {
    cause: error,
  });
}

/** Explains a failed dry run; CONFIG and INTERNAL pass through so their details reach only the log. */
function dryRunFailure(error: unknown, itemId: string): unknown {
  if (!(error instanceof AppError) || error.code === "CONFIG" || error.code === "INTERNAL") return error;
  return new AppError(
    error.code,
    `No batch was created: tagging the first item as a test failed. ${error.message}`,
    { ...error.details, [DRY_RUN_ITEM_DETAIL]: itemId },
    { cause: error },
  );
}

/**
 * Whether a failed batches.create certainly created no batch, so sending it
 * again cannot start a second billed batch: a rate limit or an overload, or
 * the API's own "retry this" hint. Connection errors and timeouts are not
 * retried, because the batch may exist although the answer was lost.
 */
function batchCreateRejected(error: unknown): boolean {
  if (!(error instanceof APIError) || typeof error.status !== "number") return false;
  const hint = error.headers?.get("x-should-retry");
  if (hint === "false") return false;
  return error.status === 429 || error.status === 529 || hint === "true";
}

/**
 * Whether a failed batches.create may still have created a batch: no answer
 * arrived (a timeout or a lost connection) or the server failed (5xx). A 4xx
 * refused the request, and our own AppError means no request was sent.
 */
function batchMayExist(error: unknown): boolean {
  if (error instanceof AppError || batchCreateRejected(error)) return false;
  if (!(error instanceof APIError) || typeof error.status !== "number") return true;
  return error.status >= 500;
}

/**
 * batches.create with up to MAX_ATTEMPTS attempts for refusals that created
 * nothing. Each attempt gets a request timeout that ends by `startDeadlineAt`,
 * and no attempt starts with less than MIN_CREATE_ATTEMPT_MS left.
 */
async function createBatch(
  deps: TagItemDeps,
  params: Parameters<AnthropicLike["messages"]["batches"]["create"]>[0],
  startDeadlineAt: number,
): Promise<MessageBatch> {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A wait must leave room for the attempt after it, so the caller gets the
  // API's own error rather than "not enough time".
  const retryDeadlineAt = Math.min(now() + BATCH_CREATE_DEADLINE_MS, startDeadlineAt - MIN_CREATE_ATTEMPT_MS);
  for (let attempt = 1; ; attempt += 1) {
    const remainingMs = startDeadlineAt - now();
    if (remainingMs < MIN_CREATE_ATTEMPT_MS) {
      throw new AppError("AI_TIMEOUT", "There was not enough time left to create the batch. Try again.");
    }
    try {
      return await deps
        .anthropic()
        .messages.batches.create(params, { timeout: Math.min(BATCH_CREATE_ATTEMPT_TIMEOUT_MS, remainingMs) });
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !batchCreateRejected(error)) throw error;
      const delayMs = parseRetryAfter(classifyError(error).headers, now()) ?? backoffMs(attempt, random);
      if (now() + delayMs > retryDeadlineAt) throw error;
      await sleep(delayMs);
    }
  }
}

type Candidate = { id: string; processedUrl: string; taggingError: string | null };

type WaitingColumns = { id: string; status: string; aiRaw: unknown; taggingBatchId: string | null };

/**
 * Every item must exist and wait for tags: pending, untagged and in no batch.
 * Used before the budget check and again under row locks in the claim.
 */
function assertWaiting(ids: readonly string[], rows: readonly WaitingColumns[]): void {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new AppError("NOT_FOUND", "Some items no longer exist.", { itemIds: missing });

  const notWaiting = ids.filter((id) => {
    const row = byId.get(id);
    return row === undefined || row.status !== "pending_tagging" || row.aiRaw !== null || row.taggingBatchId !== null;
  });
  if (notWaiting.length > 0) throw notWaitingConflict(notWaiting);
}

function notWaitingConflict(itemIds: readonly string[]): AppError {
  const subject = itemIds.length === 1 ? "1 item is" : String(itemIds.length) + " items are";
  return new AppError("CONFLICT", `${subject} no longer waiting for tags. Reload the page and try again.`, {
    itemIds: [...itemIds],
  });
}

/** Every item must exist, wait for tags (pending, untagged, in no batch) and have a processed image. */
async function loadCandidates(db: Db, ids: readonly string[]): Promise<Candidate[]> {
  const [rows, images] = await Promise.all([
    db
      .select({
        id: items.id,
        status: items.status,
        aiRaw: items.aiRaw,
        taggingBatchId: items.taggingBatchId,
        taggingError: items.taggingError,
      })
      .from(items)
      .where(inArray(items.id, [...ids])),
    db
      .select({ itemId: itemImages.itemId, url: itemImages.blobUrl })
      .from(itemImages)
      .where(and(inArray(itemImages.itemId, [...ids]), eq(itemImages.kind, "processed"))),
  ]);
  assertWaiting(ids, rows);
  const errors = new Map(rows.map((row) => [row.id, row.taggingError]));
  const urls = new Map(images.map((image) => [image.itemId, image.url]));

  const candidates: Candidate[] = [];
  const noPhoto: string[] = [];
  for (const id of ids) {
    const processedUrl = urls.get(id);
    if (processedUrl === undefined) noPhoto.push(id);
    else candidates.push({ id, processedUrl, taggingError: errors.get(id) ?? null });
  }
  if (noPhoto.length > 0) {
    throw new AppError("NOT_FOUND", "Some items have no processed photo to tag.", {
      itemIds: noPhoto,
      reason: "no_processed_image",
    });
  }
  return candidates;
}

/**
 * Claims the items for a new batch in one transaction, before anything is
 * paid for: locks every row (the dry-run item too), checks them again,
 * inserts the batch row with a placeholder id and links the batched items.
 * Throws CONFLICT, rolling everything back, when another start or a tagging
 * call got there first. Returns the batch row id.
 */
async function claimItems(
  db: Db,
  claim: { ids: readonly string[]; batched: readonly string[]; model: PricedModelId; estimatedCostUsd: number },
): Promise<string> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: items.id, status: items.status, aiRaw: items.aiRaw, taggingBatchId: items.taggingBatchId })
      .from(items)
      .where(inArray(items.id, [...claim.ids]))
      // A fixed lock order, so two overlapping claims cannot deadlock.
      .orderBy(asc(items.id))
      .for("update");
    assertWaiting(claim.ids, rows);

    const [row] = await tx
      .insert(aiBatches)
      .values({
        anthropicBatchId: BATCH_CLAIM_PREFIX + randomUUID(),
        purpose: "tagging",
        model: claim.model,
        status: "in_progress",
        itemIds: [...claim.batched],
        requestCount: claim.batched.length,
        // Only the batch: the dry run reserves its own amount in its budget check.
        estimatedCostUsd: claim.estimatedCostUsd,
      })
      .returning({ id: aiBatches.id });
    if (row === undefined) throw new AppError("INTERNAL", "The batch row was not created.");

    const linked = await tx
      .update(items)
      .set({ taggingBatchId: row.id })
      .where(
        and(
          inArray(items.id, [...claim.batched]),
          eq(items.status, "pending_tagging"),
          isNull(items.taggingBatchId),
        ),
      )
      .returning({ id: items.id });
    if (linked.length < claim.batched.length) {
      const done = new Set(linked.map((entry) => entry.id));
      throw notWaitingConflict(claim.batched.filter((id) => !done.has(id)));
    }
    return row.id;
  });
}

/**
 * Deletes a claim row whose batch was not created; its items are unlinked by
 * the foreign key. Never throws, so the caller's error is the one reported.
 */
async function releaseClaim(db: Db, batchRowId: string): Promise<void> {
  try {
    await db
      .delete(aiBatches)
      .where(and(eq(aiBatches.id, batchRowId), like(aiBatches.anthropicBatchId, `${BATCH_CLAIM_PREFIX}%`)));
  } catch (error) {
    // The row stays until a poll deletes it as stale; its items wait until then.
    console.error(`[batches] could not release the claim ${batchRowId}:`, error);
  }
}

/**
 * Starts a tagging batch for more than 20 pending items: checks the budget
 * for the whole run, claims the items, tags one item synchronously with the
 * batch parameters (no batch when that fails), submits the rest as one batch
 * with custom_id = item id, then records the batch id on the claimed row.
 * The dry-run item is the first one without a stored tagging_error, so an
 * item whose dry run failed is not tried first again.
 */
export async function startTaggingBatch(deps: TagItemDeps, itemIds: readonly string[]): Promise<StartTaggingBatchData> {
  await requireSession();
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const startDeadlineAt = now() + START_DEADLINE_MS;
  const ids = [...new Set(itemIds)];
  if (ids.length < BATCH_MIN_ITEMS) {
    throw new AppError("VALIDATION", `A batch needs more than ${BATCH_MIN_ITEMS - 1} items. Tag fewer items directly.`, {
      count: ids.length,
      min: BATCH_MIN_ITEMS,
    });
  }
  if (ids.length > BATCH_MAX_ITEMS) {
    throw new AppError("VALIDATION", `A batch can hold at most ${BATCH_MAX_ITEMS} items.`, {
      count: ids.length,
      max: BATCH_MAX_ITEMS,
    });
  }
  const malformed = ids.filter((id) => !isUuid(id));
  if (malformed.length > 0) throw new AppError("NOT_FOUND", "Some items no longer exist.", { itemIds: malformed });

  const candidates = await loadCandidates(db, ids);
  const dryRun = candidates.find((candidate) => candidate.taggingError === null) ?? candidates[0];
  if (dryRun === undefined) throw new AppError("INTERNAL", "A batch was started without items.");
  const rest = candidates.filter((candidate) => candidate.id !== dryRun.id);
  const batched = rest.map((candidate) => candidate.id);

  const model = deps.model ?? MODELS.tagging;
  const { batchUsd, totalUsd } = estimateTaggingBatchRunUsd({ count: ids.length, model });
  await assertWithinBudget(db, { estimateUsd: totalUsd, now: new Date(now()) });

  // From here on the claim row reserves batchUsd in the budget, and the dry
  // run's own check adds its amount, so together they check the total again.
  const batchRowId = await claimItems(db, { ids, batched, model, estimatedCostUsd: batchUsd });

  try {
    await tagItem(deps, dryRun.id, { batchShape: true });
  } catch (error) {
    await releaseClaim(db, batchRowId);
    throw dryRunFailure(error, dryRun.id);
  }

  const requests = rest.map((candidate) => ({
    custom_id: candidate.id,
    params: buildMessageParams(taggingRequest(model, { type: "url", url: candidate.processedUrl }, "1h")),
  }));
  let created: MessageBatch;
  try {
    created = await createBatch(deps, { requests }, startDeadlineAt);
  } catch (error) {
    await releaseClaim(db, batchRowId);
    if (batchMayExist(error)) {
      // Nothing records such a batch, so its results would never be applied.
      console.error(
        `[batches] batches.create failed without a clear answer; a batch for claim ${batchRowId} may exist at Anthropic without a known id:`,
        error,
      );
    }
    const failure = batchApiFailure(error, "The first item was tagged, but the batch could not be created");
    // The page marks that item as tagged, so a second attempt does not send it again.
    throw new AppError(failure.code, failure.message, { ...failure.details, [TAGGED_ITEM_DETAIL]: dryRun.id }, {
      cause: error,
    });
  }

  try {
    await db.transaction(async (tx) => {
      await tx.update(aiBatches).set({ anthropicBatchId: created.id }).where(eq(aiBatches.id, batchRowId));
      // Joining a batch clears an earlier tagging failure.
      await tx.update(items).set({ taggingError: null }).where(eq(items.taggingBatchId, batchRowId));
    });
  } catch (error) {
    // The batch exists at Anthropic and will be billed, but without its id on
    // the row no poll applies it; the id in the log is what is needed to
    // recover it. The claim row is deleted as stale by a later poll.
    console.error(`[batches] Anthropic batch ${created.id} was created but could not be recorded:`, error);
    throw error;
  }
  return { batchId: batchRowId, count: ids.length, estimateUsd: totalUsd, dryRunItemId: dryRun.id };
}

// ---------------------------------------------------------------------------
// Polling and applying results
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ResultOutcome = "tagged" | "failed" | "skipped";

const EXPIRED_MESSAGE = "The batch expired before this item was tagged. Tag it again.";
const CANCELED_MESSAGE = "The batch was cancelled before this item was tagged. Tag it again.";
const NO_RESULT_MESSAGE = "The batch returned no result for this item. Tag it again.";

function erroredMessage(type: string): string {
  return `The batch could not tag this item (${type}). Tag it again.`;
}

function pricedModel(batch: AiBatch): PricedModelId {
  if (isPricedModel(batch.model)) return batch.model;
  // Without a price the spend cannot be recorded, and spend must not go unrecorded.
  throw new AppError("CONFIG", `Batch ${batch.anthropicBatchId} used model ${batch.model}, which has no price.`, {
    batchId: batch.id,
  });
}

/**
 * Sets the tagging_error of items still waiting on this batch and unlinks
 * them. Returns how many it changed.
 */
async function markFailed(tx: Tx, itemIds: readonly string[], batchId: string, message: string): Promise<number> {
  if (itemIds.length === 0) return 0;
  const changed = await tx
    .update(items)
    .set({ taggingError: message, taggingBatchId: null })
    .where(and(inArray(items.id, [...itemIds]), eq(items.taggingBatchId, batchId)))
    .returning({ id: items.id });
  return changed.length;
}

/**
 * Applies one result. Succeeded and errored results are logged as ai_calls
 * rows (batch rates; errored ones are not billed) even when the item is
 * skipped, because the spend happened. An item is only changed while it still
 * waits on this batch: one re-tagged or deleted in the meantime is skipped.
 */
async function applyResult(
  tx: Tx,
  batch: AiBatch,
  model: PricedModelId,
  response: MessageBatchIndividualResponse,
): Promise<{ outcome: ResultOutcome; costUsd: number }> {
  const itemId = response.custom_id;
  const [item] = await tx.select().from(items).where(eq(items.id, itemId)).for("update");
  const waiting = item !== undefined && item.taggingBatchId === batch.id;
  const link = { purpose: "tagging" as const, model, attempt: 1, itemId: item === undefined ? null : itemId };
  const result = response.result;

  switch (result.type) {
    case "succeeded": {
      const { message } = result;
      const reply = readStructuredReply(message, ItemTagsSchema);
      const usage = usageColumns(model, message.usage, { batch: true });
      await logAiCall(tx, {
        ...link,
        ...usage,
        status: replyCallStatus(reply),
        stopReason: message.stop_reason,
        requestId: null,
        latencyMs: null,
        errorCode: reply.kind === "ok" ? null : reply.kind,
        errorMessage: reply.kind === "ok" ? null : replyFailure(reply).message,
      });
      if (!waiting) return { outcome: "skipped", costUsd: usage.costUsd };
      if (reply.kind === "ok") {
        await tx
          .update(items)
          .set(taggedItemUpdate(item, reply.data, { model, promptVersion: TAG_PROMPT_VERSION }))
          .where(eq(items.id, itemId));
        return { outcome: "tagged", costUsd: usage.costUsd };
      }
      await markFailed(tx, [itemId], batch.id, replyFailure(reply).message);
      return { outcome: "failed", costUsd: usage.costUsd };
    }
    case "errored": {
      // The API nests the kind one level down: result.error is the envelope.
      const { type, message } = result.error.error;
      await logAiCall(tx, {
        ...link,
        isBatch: true,
        costUsd: 0,
        status: "error",
        requestId: result.error.request_id,
        latencyMs: null,
        errorCode: `batch_${type}`,
        errorMessage: message,
      });
      if (!waiting) return { outcome: "skipped", costUsd: 0 };
      await markFailed(tx, [itemId], batch.id, erroredMessage(type));
      return { outcome: "failed", costUsd: 0 };
    }
    case "canceled":
    case "expired": {
      if (!waiting) return { outcome: "skipped", costUsd: 0 };
      await markFailed(tx, [itemId], batch.id, result.type === "expired" ? EXPIRED_MESSAGE : CANCELED_MESSAGE);
      return { outcome: "failed", costUsd: 0 };
    }
  }
}

type BatchOutcome = { pending: boolean; applied: boolean; tagged: number; failed: number };

type PollSettings = { now: () => number; requestTimeoutMs: number | undefined };

function timedOut(what: string, timeoutMs: number, cause: unknown): AppError {
  const seconds = Math.ceil(timeoutMs / 1000);
  return new AppError("AI_TIMEOUT", `${what}: Claude's Batches API did not answer within ${seconds} s.`, undefined, {
    cause,
  });
}

async function readResults(
  anthropic: AnthropicLike,
  batch: AiBatch,
  timeoutMs: number | undefined,
): Promise<MessageBatchIndividualResponse[]> {
  const what = `The results of batch ${batch.anthropicBatchId} could not be read`;
  // The SDK's timeout ends when the headers arrive; the signal also bounds
  // reading the JSONL body.
  const controller = new AbortController();
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  const options =
    timeoutMs === undefined ? { signal: controller.signal } : { signal: controller.signal, timeout: timeoutMs };
  const results: MessageBatchIndividualResponse[] = [];
  try {
    for await (const result of await anthropic.messages.batches.results(batch.anthropicBatchId, undefined, options)) {
      results.push(result);
    }
  } catch (error) {
    if (controller.signal.aborted && timeoutMs !== undefined) throw timedOut(what, timeoutMs, error);
    throw batchApiFailure(error, what);
  } finally {
    clearTimeout(timer);
  }
  return results;
}

/** Checks one batch and, once it has ended, applies all its results in one transaction. */
async function pollBatch(db: Db, anthropic: AnthropicLike, batch: AiBatch, settings: PollSettings): Promise<BatchOutcome> {
  const { now, requestTimeoutMs } = settings;
  let remote: MessageBatch;
  try {
    remote = await anthropic.messages.batches.retrieve(
      batch.anthropicBatchId,
      undefined,
      requestTimeoutMs === undefined ? undefined : { timeout: requestTimeoutMs },
    );
  } catch (error) {
    throw batchApiFailure(error, `Batch ${batch.anthropicBatchId} could not be checked`);
  }
  if (remote.processing_status !== "ended") {
    if (remote.processing_status !== batch.status) {
      await db
        .update(aiBatches)
        .set({ status: remote.processing_status })
        .where(and(eq(aiBatches.id, batch.id), ne(aiBatches.status, "processed")));
    }
    return { pending: true, applied: false, tagged: 0, failed: 0 };
  }

  const model = pricedModel(batch);
  // Read before the transaction, so no row stays locked while the network is slow.
  const results = await readResults(anthropic, batch, requestTimeoutMs);

  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(aiBatches).where(eq(aiBatches.id, batch.id)).for("update");
    // Another poll applied it while this one was reading.
    if (locked === undefined || locked.status === "processed") {
      return { pending: false, applied: false, tagged: 0, failed: 0 };
    }

    const ours = new Set(locked.itemIds);
    const seen = new Set<string>();
    let tagged = 0;
    let failed = 0;
    let costUsd = 0;
    for (const result of results) {
      if (!ours.has(result.custom_id) || seen.has(result.custom_id)) continue;
      seen.add(result.custom_id);
      const applied = await applyResult(tx, locked, model, result);
      costUsd += applied.costUsd;
      if (applied.outcome === "tagged") tagged += 1;
      if (applied.outcome === "failed") failed += 1;
    }
    // Every request has a result once a batch ends; this only guards against a
    // gap leaving items linked to a finished batch forever.
    const unanswered = locked.itemIds.filter((id) => !seen.has(id));
    failed += await markFailed(tx, unanswered, locked.id, NO_RESULT_MESSAGE);

    const timestamp = new Date(now());
    await tx
      .update(aiBatches)
      .set({
        status: "processed",
        endedAt: remote.ended_at === null ? timestamp : new Date(remote.ended_at),
        processedAt: timestamp,
        costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      })
      .where(and(eq(aiBatches.id, locked.id), ne(aiBatches.status, "processed")));
    return { pending: false, applied: true, tagged, failed };
  });
}

/**
 * Deletes a claim row its start left behind (the start was stopped between
 * claiming and recording the batch id), which unlinks its items so they can be
 * tagged again. Guarded, so a claim that got its batch id meanwhile stays.
 */
async function deleteStaleClaim(db: Db, batch: AiBatch, cutoff: Date): Promise<void> {
  const deleted = await db
    .delete(aiBatches)
    .where(
      and(
        eq(aiBatches.id, batch.id),
        like(aiBatches.anthropicBatchId, `${BATCH_CLAIM_PREFIX}%`),
        lt(aiBatches.createdAt, cutoff),
      ),
    )
    .returning({ id: aiBatches.id });
  if (deleted.length === 0) return;
  console.error(
    `[batches] deleted claim ${batch.id} from ${batch.createdAt.toISOString()}: its batch start never finished, ` +
      `so its ${batch.requestCount} items wait for tags again. A batch may exist at Anthropic without a known id.`,
  );
}

/**
 * Checks every unprocessed batch and applies the results of those that ended.
 * Idempotent: a processed batch is never read again, and a concurrent run
 * waits on the batch row and then skips it. Claim rows have no batch at
 * Anthropic yet: a fresh one is skipped, a stale one deleted. One failing
 * batch does not stop the others: its error is logged and returned in
 * `errors`, next to the counts of the batches that were processed. Only a
 * failure before any batch was tried (reading the open batches, creating the
 * client) is thrown. This is the cron entry point, so it does not check a
 * session (the cron route checks CRON_SECRET); pollTaggingBatches is the
 * session-checked variant.
 */
export async function runBatchPoll(deps: BatchPollDeps): Promise<BatchPollSummary> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const summary: BatchPollSummary = { batches: 0, processed: 0, tagged: 0, failed: 0, pending: 0, errors: [] };
  const open = await db
    .select()
    .from(aiBatches)
    .where(ne(aiBatches.status, "processed"))
    .orderBy(asc(aiBatches.createdAt));

  const fail = (batch: AiBatch, error: unknown): void => {
    console.error(`[batches] polling batch ${batch.anthropicBatchId} failed:`, error);
    summary.errors.push(toErrorPayload(error));
  };

  const cutoff = new Date(now() - BATCH_CLAIM_STALE_MS);
  const created: AiBatch[] = [];
  for (const batch of open) {
    if (!isClaim(batch)) created.push(batch);
    else if (batch.createdAt < cutoff) {
      try {
        await deleteStaleClaim(db, batch, cutoff);
      } catch (error) {
        fail(batch, error);
      }
    }
  }
  if (created.length === 0) return summary;

  const anthropic = deps.anthropic();
  for (const batch of created) {
    try {
      const outcome = await pollBatch(db, anthropic, batch, { now, requestTimeoutMs: deps.requestTimeoutMs });
      if (outcome.pending) summary.pending += 1;
      if (outcome.applied) summary.batches += 1;
      summary.tagged += outcome.tagged;
      summary.failed += outcome.failed;
      summary.processed += outcome.tagged + outcome.failed;
    } catch (error) {
      fail(batch, error);
    }
  }
  return summary;
}

/** The review page's poll: the same work as the cron, for a signed-in owner. */
export async function pollTaggingBatches(deps: BatchPollDeps): Promise<BatchPollSummary> {
  await requireSession();
  return runBatchPoll(deps);
}
