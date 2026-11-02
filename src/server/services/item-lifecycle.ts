import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import type { ItemStatus } from "@/lib/db/enums";
import { itemImages, items, type Item } from "@/lib/db/schema";
import { blobFailure, deleteBlobsQuietly, type BlobStorage } from "@/lib/images/blob";
import { isUuid } from "@/lib/items/contracts";
import type { ItemDetailDto } from "@/lib/items/wardrobe";
import { AppError } from "@/lib/result";
import { loadItemDetail } from "@/server/items/detail";
import { missingTagFields } from "@/server/services/items";

// Archive, unarchive and delete from the item detail page.
//
// Archiving hides an item (the wardrobe's default filter and the relocation
// snapshot leave archived items out) without losing anything. Deleting is
// final: the photos go first, so a Blob failure leaves the item and every row
// intact and the owner can simply try again; only then are the rows deleted.
// The schema's foreign keys decide what happens to rows that point at the
// item (see deleteItem).

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
};

const BLOB_DELETE_FAILED =
  "The photos could not be deleted from storage, so the item was kept. Try again in a moment.";

async function imageUrls(db: Pick<Db, "select">, id: Item["id"]): Promise<string[]> {
  const rows = await db.select({ url: itemImages.blobUrl }).from(itemImages).where(eq(itemImages.itemId, id));
  return [...new Set(rows.map((row) => row.url))];
}

/**
 * Deletes an item for good: every photo it has in Blob (one del() call), then
 * its rows in one transaction. If Blob refuses or fails, nothing in the
 * database changes: UPSTREAM (or CONFIG for a token problem) is thrown and the
 * owner can retry.
 *
 * What the schema's foreign keys do when the item row goes:
 * - item_images: deleted (ON DELETE CASCADE); their blobs are already gone.
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

  // Blob first and outside the transaction: no row lock is held during a network call.
  const urls = await imageUrls(db, id);
  if (urls.length > 0) {
    try {
      await deps.storage.del(urls);
    } catch (error) {
      const failure = blobFailure(error, "delete an item's photos");
      // UPSTREAM is an expected error the action wrapper does not log; the
      // cause is kept here so a failing store can be diagnosed.
      if (failure.code !== "CONFIG") console.error(`[item-lifecycle] deleting the photos of item ${id} failed:`, error);
      if (failure.code === "UPSTREAM") {
        throw new AppError("UPSTREAM", BLOB_DELETE_FAILED, { itemId: id }, { cause: error });
      }
      throw failure;
    }
  }

  const deleted = new Set(urls);
  let late: string[] = [];
  await db.transaction(async (tx) => {
    // The lock makes a concurrent image insert (a background cut-out being
    // registered) wait for this transaction and then fail on the missing
    // item, so the image list read below is the final one.
    const [row] = await tx.select({ id: items.id }).from(items).where(eq(items.id, id)).for("update");
    // Deleted by another request meanwhile: its photos are gone and so is the row.
    if (row === undefined) return;
    late = (await imageUrls(tx, id)).filter((url) => !deleted.has(url));
    await tx.delete(items).where(eq(items.id, id));
  });

  // A photo attached between the del() above and the lock; the item is gone
  // either way, so a failure here is only logged for manual cleanup.
  await deleteBlobsQuietly(deps.storage, late, `deleting item ${id}`);
  return { deleted: true };
}
