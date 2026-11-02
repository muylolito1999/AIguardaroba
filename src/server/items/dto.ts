import "server-only";

import { inArray } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { SEASONS, type Season } from "@/lib/db/enums";
import { itemImages, items, type Item, type ItemImage } from "@/lib/db/schema";
import { isUuid, type ItemCardDto, type ItemImageRef } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";

function isSeason(value: string): value is Season {
  return (SEASONS as readonly string[]).includes(value);
}

function imageRef(image: ItemImage | undefined): ItemImageRef | null {
  return image === undefined ? null : { url: image.blobUrl, width: image.width, height: image.height };
}

/** ai_raw is the validated tagging output; read defensively because older rows may predate a field. */
function multipleItemsDetected(aiRaw: unknown): boolean {
  return (
    typeof aiRaw === "object" &&
    aiRaw !== null &&
    "multiple_items_detected" in aiRaw &&
    aiRaw.multiple_items_detected === true
  );
}

/** Pure mapper from an item row and its image rows (any order, other items' rows ignored) to the card DTO. */
export function toItemCardDto(item: Item, images: readonly ItemImage[]): ItemCardDto {
  const own = images.filter((image) => image.itemId === item.id);
  const byKind = (kind: ItemImage["kind"]) => own.find((image) => image.kind === kind);
  return {
    id: item.id,
    status: item.status,
    createdAt: item.createdAt.toISOString(),
    name: item.name,
    category: item.category,
    subcategory: item.subcategory,
    colors: item.colors,
    colorHex: item.colorHex,
    materialGuess: item.materialGuess,
    materials: item.materials,
    warmthLevel: item.warmthLevel,
    waterproof: item.waterproof,
    windproof: item.windproof,
    insulated: item.insulated,
    breathable: item.breathable,
    // The items_seasons_check constraint already limits the values; the guard narrows the type.
    seasons: item.seasons.filter(isSeason),
    formality: item.formality,
    pattern: item.pattern,
    fit: item.fit,
    condition: item.condition,
    brand: item.brand,
    size: item.size,
    description: item.description,
    notes: item.notes,
    purchasePrice: item.purchasePrice,
    currency: item.currency,
    purchaseDate: item.purchaseDate,
    location: item.location,
    decision: item.decision,
    aiConfidence: item.aiConfidence,
    multipleItemsDetected: multipleItemsDetected(item.aiRaw),
    userEditedFields: item.userEditedFields,
    taggingError: item.taggingError,
    taggingBatchId: item.taggingBatchId,
    aiModel: item.aiModel,
    images: {
      thumb: imageRef(byKind("thumb")),
      processed: imageRef(byKind("processed")),
      nobg: imageRef(byKind("nobg")),
    },
  };
}

async function selectCards(db: Db, ids: readonly string[]): Promise<Map<string, ItemCardDto>> {
  const unique = [...new Set(ids)];
  // A malformed id cannot match a row, and Postgres would reject it with a
  // uuid syntax error, so it is left out and reported as not found.
  const valid = unique.filter(isUuid);
  if (valid.length === 0) return new Map();
  const [rows, images] = await Promise.all([
    db.select().from(items).where(inArray(items.id, valid)),
    db.select().from(itemImages).where(inArray(itemImages.itemId, valid)),
  ]);
  return new Map(rows.map((row) => [row.id, toItemCardDto(row, images)]));
}

/** One item card. Throws NOT_FOUND when the id is unknown or malformed. */
export async function loadItemCard(db: Db, id: string): Promise<ItemCardDto> {
  await requireSession();
  const card = (await selectCards(db, [id])).get(id);
  if (card === undefined) throw new AppError("NOT_FOUND", "That item no longer exists.", { itemId: id });
  return card;
}

/** Item cards in the order of `ids`. Throws NOT_FOUND, listing the missing ids, when any is unknown. */
export async function loadItemCards(db: Db, ids: readonly string[]): Promise<ItemCardDto[]> {
  await requireSession();
  if (ids.length === 0) return [];
  const cards = await selectCards(db, ids);
  const missing = [...new Set(ids)].filter((id) => !cards.has(id));
  if (missing.length > 0) {
    throw new AppError("NOT_FOUND", "Some items no longer exist.", { itemIds: missing });
  }
  return ids.map((id) => {
    const card = cards.get(id);
    // Unreachable after the missing check; keeps the type narrow without a cast.
    if (card === undefined) throw new AppError("NOT_FOUND", "That item no longer exists.", { itemId: id });
    return card;
  });
}
