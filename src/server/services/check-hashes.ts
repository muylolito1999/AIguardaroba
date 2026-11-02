import "server-only";

import { inArray } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { items } from "@/lib/db/schema";
import type { CheckHashesData } from "@/lib/items/contracts";

/**
 * Which of these source hashes (sha256 of the picked files) already belong to
 * an item, so the browser skips those files before spending a Blob upload
 * (D-033). Archived items count: the photo is still in the wardrobe.
 */
export async function checkHashes(db: Db, sourceHashes: readonly string[]): Promise<CheckHashesData> {
  await requireSession();
  const unique = [...new Set(sourceHashes)];
  if (unique.length === 0) return { known: {} };
  const rows = await db
    .select({ id: items.id, sourceHash: items.sourceHash })
    .from(items)
    .where(inArray(items.sourceHash, unique));
  const known: Record<string, string> = {};
  for (const row of rows) {
    if (row.sourceHash !== null) known[row.sourceHash] = row.id;
  }
  return { known };
}
