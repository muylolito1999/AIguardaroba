import "server-only";

import { and, eq } from "drizzle-orm";

import { assertWithinBudget } from "@/lib/ai/budget";
import { callStructured, type CacheTtl, type StructuredRequest } from "@/lib/ai/call";
import type { AnthropicLike } from "@/lib/ai/client";
import { estimateTaggingCostUsd, estimateTaggingDryRunUsd } from "@/lib/ai/cost";
import { MODELS, type PricedModelId } from "@/lib/ai/models";
import {
  buildTaggingContent,
  TAG_PROMPT_VERSION,
  TAGGING_PARAMS,
  TAGGING_SYSTEM_PROMPT,
  type TaggingImageMediaType,
  type TaggingImageSource,
} from "@/lib/ai/tagging/prompt";
import { ItemTagsSchema, ItemTagsWireSchema, type ItemTags } from "@/lib/ai/tagging/schema";
import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { itemImages, items, type Item, type ItemImage } from "@/lib/db/schema";
import { isUuid, type TagData } from "@/lib/items/contracts";
import { AppError, CONFIG_ERROR_MESSAGE, INTERNAL_ERROR_MESSAGE } from "@/lib/result";
import { loadItemCard } from "@/server/items/dto";
import { taggedItemUpdate } from "@/server/items/user-edited-fields";

// Tags one item with Claude (D-023). The item's ai_raw is the tag cache
// (keyed by image_hash, which is unique per item): an item that has tags is
// never sent again unless the owner presses Re-tag (force). The request is
// budget-checked first; on success the tags are written in one update that
// keeps the owner's edited fields; on failure the item keeps its status and
// gets a tagging_error the review card shows next to Retry.

/** The route allows 60 s; this leaves time for the image read and the final writes. */
export const TAG_DEADLINE_MS = 50_000;
/** Reading the processed WebP (about 100–300 KB) from Blob. */
export const PROCESSED_FETCH_TIMEOUT_MS = 10_000;
/** The Messages API rejects larger base64 images; processed images are far smaller. */
export const MAX_TAGGING_IMAGE_BYTES = 5 * 1024 * 1024;
/** Longest tagging_error stored; the card shows it in one or two lines. */
export const MAX_TAGGING_ERROR_LENGTH = 300;

const BASE64_MEDIA_TYPES: readonly TaggingImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export type TagItemDeps = {
  db: Db;
  /** Called only when Claude is needed, so a cached answer works without an API key. */
  anthropic: () => AnthropicLike;
  /** Reads the processed photo for the base64 request. */
  fetch: typeof fetch;
  /** Defaults to the configured tagging model (CLAUDE_TAGGING_MODEL or Haiku 5.5). */
  model?: PricedModelId;
  /** Epoch ms; defaults to Date.now. */
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type TagItemOptions = {
  /** Re-tag: call Claude even when the item already has tags. */
  force?: boolean;
  /**
   * Send exactly what a Message Batches request sends (the image as a URL
   * source, a 1-hour cache TTL): the synchronous dry run before a batch (D-024).
   */
  batchShape?: boolean;
  /**
   * The batch the caller believes the item waits in ("Tag now instead" on a
   * review card). When the item is no longer linked to it and already has
   * tags, that batch (or another tagging) was applied after the card was
   * rendered, so the tags are returned without a call, even with force.
   */
  batchId?: string;
};

/** Tags from Claude, or a pending item tagged by hand (status tagged, ai_raw null). */
function hasTags(row: Item): boolean {
  return row.aiRaw !== null || row.status !== "pending_tagging";
}

/**
 * The request body fields of a tagging call. Batch requests are built from
 * the same function, so the dry run and the batch differ only in the image URL.
 */
export function taggingRequest(model: PricedModelId, source: TaggingImageSource, cacheTtl: CacheTtl): StructuredRequest {
  return {
    model,
    system: TAGGING_SYSTEM_PROMPT,
    cacheTtl,
    content: buildTaggingContent(source),
    wire: ItemTagsWireSchema,
    effort: TAGGING_PARAMS.effort,
    maxTokens: TAGGING_PARAMS.maxTokens,
  };
}

/** The short, user-facing reason stored in tagging_error. CONFIG and unexpected errors stay generic. */
export function taggingErrorMessage(error: unknown): string {
  if (!(error instanceof AppError) || error.code === "INTERNAL") return INTERNAL_ERROR_MESSAGE;
  if (error.code === "CONFIG") return CONFIG_ERROR_MESSAGE;
  return error.message.length > MAX_TAGGING_ERROR_LENGTH
    ? `${error.message.slice(0, MAX_TAGGING_ERROR_LENGTH - 1)}…`
    : error.message;
}

function notFound(itemId: string): AppError {
  return new AppError("NOT_FOUND", "That item no longer exists.", { itemId });
}

function photoUnreadable(cause?: unknown, details?: Record<string, unknown>): AppError {
  return new AppError("UPSTREAM", "The item's photo could not be read for tagging. Try again.", details, { cause });
}

async function loadItem(db: Db, itemId: string): Promise<{ row: Item; processed: ItemImage | undefined }> {
  if (!isUuid(itemId)) throw notFound(itemId);
  const [[row], [processed]] = await Promise.all([
    db.select().from(items).where(eq(items.id, itemId)),
    db
      .select()
      .from(itemImages)
      .where(and(eq(itemImages.itemId, itemId), eq(itemImages.kind, "processed"))),
  ]);
  if (row === undefined) throw notFound(itemId);
  return { row, processed };
}

/** The processed image as a base64 source; the URL never leaves our own store's row. */
async function readProcessedImage(fetchImpl: typeof fetch, image: ItemImage): Promise<TaggingImageSource> {
  const mediaType = BASE64_MEDIA_TYPES.find((type) => type === image.contentType);
  if (mediaType === undefined) {
    throw new AppError("VALIDATION", "This photo's format cannot be sent to Claude.", {
      contentType: image.contentType,
    });
  }
  let response: Response;
  try {
    response = await fetchImpl(image.blobUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(PROCESSED_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw photoUnreadable(error);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw photoUnreadable(undefined, { status: response.status });
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    throw photoUnreadable(error);
  }
  if (bytes.byteLength === 0) throw photoUnreadable(undefined, { reason: "empty" });
  if (bytes.byteLength > MAX_TAGGING_IMAGE_BYTES) {
    throw new AppError("VALIDATION", "The photo is too large to send to Claude.", { bytes: bytes.byteLength });
  }
  return { type: "base64", mediaType, data: Buffer.from(bytes).toString("base64") };
}

/** Writes the tags under a row lock, so edits saved during the call are respected. */
async function applyTags(db: Db, itemId: string, tags: ItemTags, model: PricedModelId): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(items).where(eq(items.id, itemId)).for("update");
    if (current === undefined) throw notFound(itemId);
    await tx
      .update(items)
      .set(taggedItemUpdate(current, tags, { model, promptVersion: TAG_PROMPT_VERSION }))
      .where(eq(items.id, itemId));
  });
}

/**
 * Stores why tagging failed. The status is left alone: a pending item stays
 * pending_tagging, and a re-tagged item keeps its earlier tags and status.
 */
async function recordFailure(db: Db, itemId: string, error: unknown): Promise<void> {
  try {
    await db
      .update(items)
      .set({ taggingError: taggingErrorMessage(error) })
      .where(eq(items.id, itemId));
  } catch (writeError) {
    // The caller rethrows the tagging error itself; this one only goes to the log.
    console.error(`[tag-item] could not store the tagging error for item ${itemId}:`, writeError);
  }
}

/**
 * Tags an item, or returns its existing tags (`cached: true`, no AI call)
 * unless `force`. An item tagged by hand counts as tagged. With `batchId`, an
 * item that left that batch and has tags is returned as cached even with
 * `force`. Throws AppError: NOT_FOUND, CONFLICT (the item is waiting in a
 * batch; force overrides, which the review card's "Tag now instead" sends),
 * BUDGET_EXCEEDED (nothing sent, nothing stored) and any tagging failure,
 * after storing it as the item's tagging_error.
 */
export async function tagItem(deps: TagItemDeps, itemId: string, options: TagItemOptions = {}): Promise<TagData> {
  await requireSession();
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const deadlineAt = now() + TAG_DEADLINE_MS;
  const force = options.force === true;

  const { row, processed } = await loadItem(db, itemId);
  // A stale card's "Tag now instead": the batch result already arrived.
  const batchApplied = options.batchId !== undefined && row.taggingBatchId !== options.batchId && hasTags(row);
  if (batchApplied || (!force && hasTags(row))) return { cached: true, item: await loadItemCard(db, itemId) };
  if (row.taggingBatchId !== null && !force) {
    // Tagging it now as well would pay twice for the same photo.
    throw new AppError("CONFLICT", 'This item is waiting in a tagging batch. Use "Tag now instead" on its review card to tag it now.', {
      itemId,
      batchId: row.taggingBatchId,
    });
  }
  if (processed === undefined) {
    throw new AppError("NOT_FOUND", "This item has no processed photo to tag.", { itemId, reason: "no_processed_image" });
  }

  const model = deps.model ?? MODELS.tagging;
  const batchShape = options.batchShape === true;
  // Checked before anything is sent; a blocked request is not a tagging failure.
  // The batch-shaped dry run writes the 1-hour cache, which costs more to write.
  const estimateUsd = batchShape ? estimateTaggingDryRunUsd(model) : estimateTaggingCostUsd({ count: 1, model });
  await assertWithinBudget(db, { estimateUsd, now: new Date(now()) });

  let tags: ItemTags;
  try {
    const anthropic = deps.anthropic();
    const source: TaggingImageSource = batchShape
      ? { type: "url", url: processed.blobUrl }
      : await readProcessedImage(deps.fetch, processed);
    const result = await callStructured({
      ...taggingRequest(model, source, batchShape ? "1h" : "5m"),
      deps: {
        anthropic,
        db,
        now,
        ...(deps.random === undefined ? {} : { random: deps.random }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      },
      purpose: TAGGING_PARAMS.purpose,
      strict: ItemTagsSchema,
      maxTokensCeiling: TAGGING_PARAMS.maxTokensCeiling,
      deadlineAt,
      links: { itemId },
    });
    tags = result.data;
  } catch (error) {
    await recordFailure(db, itemId, error);
    throw error;
  }

  await applyTags(db, itemId, tags, model);
  return { cached: false, item: await loadItemCard(db, itemId) };
}
