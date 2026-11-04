import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import type { ItemStatus } from "@/lib/db/enums";
import { blobCleanup, deletedItems, itemImages, items, type Item } from "@/lib/db/schema";
import type { BlobStorage } from "@/lib/images/blob";
import { isUuid } from "@/lib/items/contracts";
import type { ItemDetailDto } from "@/lib/items/wardrobe";
import { AppError } from "@/lib/result";
import { loadItemDetail } from "@/server/items/detail";
import { runBlobCleanup, type BlobCleanupReason } from "@/server/services/blob-cleanup";
import { missingTagFields } from "@/server/services/items";

// Archive, unarchive and delete from the item detail page.
//
// Archiving hides an item (the wardrobe's default filter and the relocation
// snapshot leave archived items out) without losing anything. Deleting is
// final: one transaction deletes the item, records its id in deleted_items
// and its photo URLs in blob_cleanup, and the files are deleted from Blob
// after the commit, now or by a later cleanup run (D-234, D-238). The
// schema's foreign keys decide what
// happens to rows that point at the item (see deleteItem).

function notFound(id: string): AppError {
  return new AppError("NOT_FOUND", "That item no longer exists.", { itemId: id });
}

/**
 * The status an archived item returns to (D-128). An item whose tags are not
 * complete goes back to waiting for tags, whatever it was. Otherwise it goes
 * back to the status it was archived from: confirmed only when the owner had
 * confirmed it; tagged when Claude's tags still awaited the owner's check,
 * including an item archived while waiting for tags that a batch or a Re-tag
 * tagged meanwhile (the owner has never seen those tags). A row archived
 * before archived_from existed (null) keeps the earlier rule: complete tags
 * count as confirmed.
 */
export function statusAfterUnarchive(
  row: Parameters<typeof missingTagFields>[0] & Pick<Item, "archivedFrom">,
): ItemStatus {
  if (missingTagFields(row).length > 0) return "pending_tagging";
  if (row.archivedFrom === "tagged" || row.archivedFrom === "pending_tagging") return "tagged";
  return "confirmed";
}

/**
 * Archives an item from any status and records that status in archived_from.
 * Archiving an archived item changes nothing (not even updated_at).
 */
export async function archiveItem(db: Db, id: string): Promise<ItemDetailDto> {
  await requireSession();
  if (!isUuid(id)) throw notFound(id);
  // One conditional update, so no lock is needed; a missing item is reported by
  // the read below. SET reads the row as it was before the update, so
  // archived_from gets the status the item is leaving.
  await db
    .update(items)
    .set({ status: "archived", archivedFrom: sql`${items.status}` })
    .where(and(eq(items.id, id), ne(items.status, "archived")));
  return loadItemDetail(db, id);
}

/**
 * Brings an archived item back to the status statusAfterUnarchive picks and
 * clears archived_from. An item that is not archived is left alone, so a
 * repeated click is harmless.
 */
export async function unarchiveItem(db: Db, id: string): Promise<ItemDetailDto> {
  await requireSession();
  if (!isUuid(id)) throw notFound(id);
  await db.transaction(async (tx) => {
    // Locked, so an edit saved meanwhile cannot change the tags this decision is based on.
    const [row] = await tx.select().from(items).where(eq(items.id, id)).for("update");
    if (row === undefined) throw notFound(id);
    if (row.status !== "archived") return;
    await tx
      .update(items)
      .set({ status: statusAfterUnarchive(row), archivedFrom: null })
      .where(eq(items.id, id));
  });
  return loadItemDetail(db, id);
}

export type DeleteItemDeps = {
  /** Built by the caller (getBlobStorage()), so a missing token fails before anything is deleted. */
  storage: BlobStorage;
  /** Tests pass a fixed clock for the cleanup run. */
  now?: () => Date;
  /** How long the cleanup after the commit may take; defaults to AFTER_DELETE_BUDGET_MS. Tests pass a short one. */
  cleanupBudgetMs?: number;
};

const DELETED_ITEM: BlobCleanupReason = "item_deleted";

/**
 * The cleanup run after a delete: the deleted item's files, plus a few files
 * of earlier deletes that are still queued. Files tried within the last hour
 * are left to the daily cron, and the run ends at the first failure.
 */
const AFTER_DELETE_CLEANUP = { maxItems: 4, retryAfterMs: 60 * 60 * 1000 } as const;

/**
 * The most a delete waits for Blob after its commit (D-237). The owner waits
 * for the dialog meanwhile; normally the whole run takes well under a second,
 * and during an outage the item is reported deleted after this long, with
 * its files queued for the cron.
 */
export const AFTER_DELETE_BUDGET_MS = 8_000;

/**
 * Deletes an item for good. One transaction locks the item, records its id in
 * deleted_items (so a retried register cannot bring it back, D-238), records
 * the URL of every photo it has in blob_cleanup and deletes the item, so
 * either all of that happens or none of it. After the commit the photos are
 * deleted from Blob (one del() call, then up to three more for files earlier
 * deletes left queued) and their queue rows removed; if Blob fails, or does
 * not answer within AFTER_DELETE_BUDGET_MS, the item is still deleted, the
 * failure is logged and stored with the queued URLs, and the cron or the next
 * delete tries again (D-234, D-237). The call answers deleted either way. A
 * failure before or at the commit changes nothing and is thrown.
 *
 * What the schema's foreign keys do when the item row goes:
 * - item_images: deleted (ON DELETE CASCADE); their URLs are queued first.
 * - outfit_items: deleted (CASCADE); the outfits stay, without this item.
 * - wear_logs that name the item: deleted (CASCADE), including rows that also
 *   name an outfit. The detail page's confirmation says the wear history goes.
 * - shopping_list_items.linked_item_id, packing_checklist_items.item_id and
 *   ai_calls.item_id: set to null (SET NULL); those rows stay, so the
 *   shopping and packing lists keep their entries and the AI cost history is
 *   complete.
 */
export async function deleteItem(db: Db, id: string, deps: DeleteItemDeps): Promise<{ deleted: true }> {
  await requireSession();
  if (!isUuid(id)) throw notFound(id);
  const [exists] = await db.select({ id: items.id }).from(items).where(eq(items.id, id));
  if (exists === undefined) throw notFound(id);

  await db.transaction(async (tx) => {
    // The lock makes a concurrent image insert (a background cut-out being
    // saved) wait for this transaction and then fail on the missing item, so
    // the image list read below is the final one and every URL is queued.
    const [row] = await tx.select({ id: items.id }).from(items).where(eq(items.id, id)).for("update");
    // Deleted by another request meanwhile, which queued the photos.
    if (row === undefined) return;
    // Listed already only if a row was inserted under a deleted id by other
    // means than a register (a script, a hand-made row); that must not block
    // its delete.
    await tx.insert(deletedItems).values({ itemId: id }).onConflictDoNothing({ target: deletedItems.itemId });
    const images = await tx.select({ url: itemImages.blobUrl }).from(itemImages).where(eq(itemImages.itemId, id));
    const urls = [...new Set(images.map((image) => image.url))];
    if (urls.length > 0) {
      await tx
        .insert(blobCleanup)
        .values(urls.map((url) => ({ url, itemId: id, reason: DELETED_ITEM })))
        // Uploads never share a URL (each has a random suffix), but seeded demo
        // items do; a URL already queued keeps its first row.
        .onConflictDoNothing({ target: blobCleanup.url });
    }
    await tx.delete(items).where(eq(items.id, id));
  });

  // The item is gone from here on, so nothing below may fail the delete: the
  // cleanup logs and stores its own Blob failure (a call that does not answer
  // in time included), and anything else (the database going away after the
  // commit) is logged; the URLs stay queued for the cron either way.
  const deadlineAt = Date.now() + (deps.cleanupBudgetMs ?? AFTER_DELETE_BUDGET_MS);
  try {
    await runBlobCleanup(
      { db, storage: deps.storage, now: deps.now },
      { ...AFTER_DELETE_CLEANUP, deadlineAt, firstItemId: id },
    );
  } catch (error) {
    console.error(`[item-lifecycle] item ${id} is deleted, but the photo cleanup after it failed:`, error);
  }
  return { deleted: true };
}
