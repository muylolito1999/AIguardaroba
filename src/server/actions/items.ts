"use server";

import { z } from "zod";

import { getAnthropic } from "@/lib/ai/client";
import { getDb } from "@/lib/db";
import { ITEM_DECISIONS, ITEM_LOCATIONS } from "@/lib/db/enums";
import { getBlobStorage } from "@/lib/images/blob";
import { ItemPatchSchema, UncheckedDefaultsSchema } from "@/lib/items/contracts";
import { ok } from "@/lib/result";
import {
  BATCH_MAX_ITEMS,
  BATCH_MIN_ITEMS,
  pollTaggingBatches as pollBatchesService,
  startTaggingBatch as startBatchService,
} from "@/server/services/batches";
import {
  archiveItem as archiveItemService,
  deleteItem as deleteItemService,
  unarchiveItem as unarchiveItemService,
} from "@/server/services/item-lifecycle";
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

/**
 * "Fill in by hand" on a pending card: tags the item from the form, without
 * Claude. uncheckedDefaults names the fields left at the form's own starting
 * value, which the service checks and keeps out of user_edited_fields (D-232).
 */
export const tagItemByHand = authedAction(
  z.strictObject({
    id: z.uuid(),
    patch: ItemPatchSchema,
    confirm: z.boolean(),
    uncheckedDefaults: UncheckedDefaultsSchema,
  }),
  async ({ id, patch, confirm, uncheckedDefaults }) =>
    ok(await tagItemByHandService(getDb(), id, patch, { confirm, uncheckedDefaults })),
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

// Item detail page (/wardrobe/[id]). Like the review actions, these return
// DTOs and revalidate nothing: the detail page reads uncached data in a
// Suspense child, and the client updates what it already shows.

/**
 * The decision quick toggle. A one-field patch through updateItem: decision is
 * not a tag field, so user_edited_fields is untouched.
 */
export const setItemDecision = authedAction(
  z.strictObject({ id: z.uuid(), decision: z.enum(ITEM_DECISIONS) }),
  async ({ id, decision }) => ok(await updateItem(getDb(), id, { decision })),
  { name: "setItemDecision" },
);

/** The location quick toggle; a one-field patch like setItemDecision. */
export const setItemLocation = authedAction(
  z.strictObject({ id: z.uuid(), location: z.enum(ITEM_LOCATIONS) }),
  async ({ id, location }) => ok(await updateItem(getDb(), id, { location })),
  { name: "setItemLocation" },
);

export const archiveItem = authedAction(
  z.strictObject({ id: z.uuid() }),
  async ({ id }) => ok(await archiveItemService(getDb(), id)),
  { name: "archiveItem" },
);

export const unarchiveItem = authedAction(
  z.strictObject({ id: z.uuid() }),
  async ({ id }) => ok(await unarchiveItemService(getDb(), id)),
  { name: "unarchiveItem" },
);

/**
 * Deletes the item, its photos in Blob first. The storage is built before the
 * service runs, so a missing BLOB_READ_WRITE_TOKEN is a CONFIG error before
 * anything is deleted.
 */
export const deleteItem = authedAction(
  z.strictObject({ id: z.uuid() }),
  async ({ id }) => {
    const storage = getBlobStorage();
    return ok(await deleteItemService(getDb(), id, { storage }));
  },
  { name: "deleteItem" },
);
