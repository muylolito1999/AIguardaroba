import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { relations } from "@/lib/db/relations";
import { blobCleanup, deletedItems, items } from "@/lib/db/schema";

import { makeImage, makeTaggedItem } from "../../../test/factories";
import { createFakeBlobStorage, type FakeBlobStorage } from "../../../test/fakes/blob";
import { deleteItem } from "./item-lifecycle";

// Opt-in check against real Postgres, because PGlite runs one transaction at
// a time and cannot show a delete waiting on a lock (D-234). Run it against a
// migrated database, for example the Docker e2e one:
//
//   TEST_DATABASE_URL=postgres://wardrobe:wardrobe@localhost:5433/wardrobe_e2e \
//     pnpm exec vitest run src/server/services/item-lifecycle.pg.test.ts
//
// It only touches its own rows (items it creates, their queue rows and their
// deleted_items rows) and deletes whatever is left of them afterwards.

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("deleteItem on real Postgres", () => {
  let pool: Pool;
  let db: Db;
  let storage: FakeBlobStorage;
  const itemIds: string[] = [];

  beforeAll(() => {
    requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
    pool = new Pool({ connectionString: url, max: 6 });
    db = drizzle({ client: pool, relations });
    storage = createFakeBlobStorage();
  });

  afterAll(async () => {
    if (itemIds.length > 0) {
      await db.delete(blobCleanup).where(inArray(blobCleanup.itemId, itemIds));
      await db.delete(deletedItems).where(inArray(deletedItems.itemId, itemIds));
      await db.delete(items).where(inArray(items.id, itemIds));
    }
    await pool.end();
  });

  async function itemWithStoredPhotos(kinds: ReadonlyArray<"original" | "processed" | "thumb" | "nobg">) {
    const item = await makeTaggedItem(db, { status: "confirmed" });
    itemIds.push(item.id);
    const urls: string[] = [];
    for (const kind of kinds) {
      const blob = storage.upload(`items/${item.id}/${kind}.webp`, Buffer.from(kind), "image/webp");
      await makeImage(db, item.id, { kind, blobUrl: blob.url, blobPathname: blob.pathname });
      urls.push(blob.url);
    }
    return { item, urls };
  }

  /** Resolves once `count` sessions of this database wait for a lock, so the test knows the deletes are blocked. */
  async function waitingForLocks(count: number): Promise<void> {
    for (let tries = 0; tries < 100; tries += 1) {
      const result = await pool.query<{ waiting: number }>(
        "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if ((result.rows[0]?.waiting ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`fewer than ${count} sessions waited for a lock within 5 s`);
  }

  /**
   * Locks the item as a cut-out save does, runs `meanwhile` and then ends the
   * transaction. `meanwhile` must not return a pending delete itself (wrap it
   * in an object): awaiting it here, before the lock is released, would wait
   * forever.
   */
  async function holdingItemLock<T>(
    itemId: string,
    meanwhile: (client: PoolClient) => Promise<T>,
    end: "commit" | "rollback",
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from items where id = $1 for update", [itemId]);
      const result = await meanwhile(client);
      await client.query(end);
      return result;
    } catch (error) {
      // Releases the lock, so the waiting deletes can finish and the pool can close.
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  it("queues and deletes a cut-out committed while the delete waited for the item lock", async () => {
    const { item, urls } = await itemWithStoredPhotos(["original", "processed", "thumb"]);
    const cutout = storage.upload(`items/${item.id}/nobg.webp`, Buffer.from("nobg"), "image/webp");

    // What saving a cut-out does (nobg.ts): lock the item, then add its image row.
    const deleting = await holdingItemLock(
      item.id,
      async (client) => {
        await client.query(
          `insert into item_images (item_id, kind, blob_url, blob_pathname, content_type, width, height, bytes)
           values ($1, 'nobg', $2, $3, 'image/webp', 10, 10, 4)`,
          [item.id, cutout.url, cutout.pathname],
        );
        const pending = deleteItem(db, item.id, { storage });
        await waitingForLocks(1);
        return { pending };
      },
      "commit",
    );

    expect(await deleting.pending).toEqual({ deleted: true });
    // The image list was read under the lock, after the cut-out's commit, so its file was queued and deleted too.
    for (const url of [...urls, cutout.url]) expect(storage.blobs.has(url)).toBe(false);
    expect(await db.select().from(blobCleanup).where(inArray(blobCleanup.itemId, [item.id]))).toEqual([]);
  });

  it("answers deleted to two deletes of one item at once and queues each file once", async () => {
    const { item, urls } = await itemWithStoredPhotos(["original", "processed", "thumb", "nobg"]);
    const before = storage.calls.length;

    // Both deletes pass their existence check, then wait for the lock; the
    // holder lets go only once both wait, so they really run at once.
    const both = await holdingItemLock(
      item.id,
      async () => {
        const pending = Promise.all([deleteItem(db, item.id, { storage }), deleteItem(db, item.id, { storage })]);
        await waitingForLocks(2);
        return { pending };
      },
      "rollback",
    );

    expect(await both.pending).toEqual([{ deleted: true }, { deleted: true }]);
    const [left] = await db.select({ value: sql<number>`count(*)::int` }).from(items).where(inArray(items.id, [item.id]));
    expect(left?.value).toBe(0);
    for (const url of urls) expect(storage.blobs.has(url)).toBe(false);
    expect(await db.select().from(blobCleanup).where(inArray(blobCleanup.itemId, [item.id]))).toEqual([]);
    // The second delete found the item gone under the lock and queued nothing;
    // each file was asked for at most twice (both cleanup runs may pick the
    // same rows, which is harmless).
    const dels = storage.calls.slice(before).filter((call) => call.method === "del");
    expect(dels.length).toBeGreaterThanOrEqual(1);
    expect(dels.length).toBeLessThanOrEqual(2);
  });
});
