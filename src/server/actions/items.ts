"use server";

import { z } from "zod";

import { getAnthropic } from "@/lib/ai/client";
import { getDb } from "@/lib/db";
import { ItemPatchSchema } from "@/lib/items/contracts";
import { ok } from "@/lib/result";
import {
  BATCH_MAX_ITEMS,
  BATCH_MIN_ITEMS,
  pollTaggingBatches as pollBatchesService,
  startTaggingBatch as startBatchService,
} from "@/server/services/batches";
import {
  confirmItem as confirmItemService,
  confirmItems as confirmItemsService,
  CONFIRM_MANY_MAX,
  tagItemByHand as tagItemByHandService,
  updateItem,
} from "@/server/services/items";

import { authedAction } from "./_wrap";

// Single mutations from the add and review screens (D-035: parallel work such
// as tagging goes through Route Handlers instead). Each action returns the
// updated DTO and revalidates nothing: the review list reads uncached data in
// a Suspense child, so there is no cache entry to expire, and the client
// replaces the card it already holds.

export const updateItemTags = authedAction(
  z.strictObject({ id: z.uuid(), patch: ItemPatchSchema }),
  async ({ id, patch }) => ok(await updateItem(getDb(), id, patch)),
  { name: "updateItemTags" },
);

export const confirmItem = authedAction(
  z.strictObject({ id: z.uuid(), patch: ItemPatchSchema.optional() }),
  async ({ id, patch }) => ok(await confirmItemService(getDb(), id, patch)),
  { name: "confirmItem" },
);

export const confirmItems = authedAction(
  z.strictObject({ ids: z.array(z.uuid()).min(1).max(CONFIRM_MANY_MAX) }),
  async ({ ids }) => ok(await confirmItemsService(getDb(), ids)),
  { name: "confirmItems" },
);

/** "Fill in by hand" on a pending card: tags the item from the form, without Claude. */
export const tagItemByHand = authedAction(
  z.strictObject({ id: z.uuid(), patch: ItemPatchSchema, confirm: z.boolean() }),
  async ({ id, patch, confirm }) => ok(await tagItemByHandService(getDb(), id, patch, { confirm })),
  { name: "tagItemByHand" },
);

export const startTaggingBatch = authedAction(
  z.strictObject({ itemIds: z.array(z.uuid()).min(BATCH_MIN_ITEMS).max(BATCH_MAX_ITEMS) }),
  async ({ itemIds }) => ok(await startBatchService({ db: getDb(), anthropic: getAnthropic, fetch }, itemIds)),
  { name: "startTaggingBatch" },
);

/**
 * Per Batches API request while the review page renders: a slow API then
 * shows the page's "not checked" notice instead of holding the page.
 */
const REVIEW_POLL_TIMEOUT_MS = 10_000;

/** Takes no argument; the review page calls it before loading the list. */
export const pollTaggingBatches = authedAction(
  z.void(),
  async () =>
    ok(
      await pollBatchesService({ db: getDb(), anthropic: getAnthropic, requestTimeoutMs: REVIEW_POLL_TIMEOUT_MS }),
    ),
  { name: "pollTaggingBatches" },
);
