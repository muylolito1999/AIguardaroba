import "server-only";

import { eq } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { itemImages, items, type Item, type ItemImage } from "@/lib/db/schema";
import { isUuid } from "@/lib/items/contracts";
import type { ItemDetailDto } from "@/lib/items/wardrobe";
import { AppError } from "@/lib/result";
import { toItemCardDto } from "@/server/items/dto";

// The item detail page's read: the card the review screen shows, plus what
// only the detail page needs (wear history, the last change and the uploaded
// original with its size). The card mapping is shared with toItemCardDto, so
// both screens always agree on the tag fields.

/** Pure mapper from an item row and its image rows (any order, other items' rows ignored) to the detail DTO. */
export function toItemDetailDto(item: Item, images: readonly ItemImage[]): ItemDetailDto {
  const original = images.find((image) => image.itemId === item.id && image.kind === "original");
  return {
    ...toItemCardDto(item, images),
    updatedAt: item.updatedAt.toISOString(),
    wearCount: item.wearCount,
    lastWornAt: item.lastWornAt === null ? null : item.lastWornAt.toISOString(),
    original:
      original === undefined
        ? null
        : { url: original.blobUrl, width: original.width, height: original.height, bytes: original.bytes },
  };
}

/** One item for /wardrobe/[id]. Throws NOT_FOUND when the id is unknown or malformed. */
export async function loadItemDetail(db: Db, id: string): Promise<ItemDetailDto> {
  await requireSession();
  // A malformed id cannot match a row, and Postgres would reject it with a
  // uuid syntax error (a 500), so it is answered as not found.
  if (!isUuid(id)) throw new AppError("NOT_FOUND", "That item no longer exists.", { itemId: id });
  const [[row], images] = await Promise.all([
    db.select().from(items).where(eq(items.id, id)),
    db.select().from(itemImages).where(eq(itemImages.itemId, id)),
  ]);
  if (row === undefined) throw new AppError("NOT_FOUND", "That item no longer exists.", { itemId: id });
  return toItemDetailDto(row, images);
}
