import { createHash, randomInt, randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@/lib/db/client";
import { relations } from "@/lib/db/relations";
import { appSettings, blobCleanup, deletedItems, itemImages, items } from "@/lib/db/schema";
import type { BlobStorage } from "@/lib/images/blob";
import { originalUploadPathname, type RegisterBody } from "@/lib/items/contracts";

import { createFakeBlobStorage, type FakeBlobStorage } from "../../../test/fakes/blob";
import { solidJpeg } from "../../../test/fixtures/images";
import { deleteItem } from "./item-lifecycle";
import { registerUpload } from "./register-upload";

// Opt-in check against real Postgres of where registerUpload looks for a
// deleted item id (D-238), because PGlite runs one transaction at a time and
// cannot show an insert waiting for a delete that has not committed.
//
// A register has passed its checks when the same upload is registered by
// another request and the owner deletes that item. The delete's transaction
// is held open after its DELETE (a trigger sleeps in it), and the register
// inserts the same id meanwhile: the insert waits on the primary key, then
// goes ahead once the delete commits. Only a deleted_items read after the
// insert sees the delete's row; one before it (or none) brought the item back
// on photos the delete had queued and the cleanup then deleted.
//
// Run it against a migrated and seeded database (register needs
// app_settings) that nothing else uses meanwhile, since the trigger is on
// the items table for the length of the test; for example the Docker e2e one
// between runs:
//
//   TEST_DATABASE_URL=postgres://wardrobe:wardrobe@localhost:5433/wardrobe_e2e \
//     pnpm exec vitest run src/server/services/register-upload.pg.test.ts
//
// It only touches its own rows (one item id, its queue and deleted_items rows)
// and deletes them afterwards, with the trigger.

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const url = process.env.TEST_DATABASE_URL;
/** How long the delete's transaction stays open after its DELETE. */
const HOLD_SECONDS = 2;

describe.skipIf(!url)("registerUpload and deleteItem of the same id at once, on real Postgres", () => {
  // Names this test's connections, so the waits counted are its own.
  const applicationName = `pg-register-${randomUUID().slice(0, 8)}`;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const trigger = `test_hold_delete_${suffix}`;
  const itemId = randomUUID();
  let pool: Pool;
  let db: Db;
  let fake: FakeBlobStorage;
  let photo: Buffer;

  beforeAll(async () => {
    requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
    pool = new Pool({ connectionString: url, max: 6, application_name: applicationName });
    db = drizzle({ client: pool, relations });
    fake = createFakeBlobStorage();
    // A colour of its own, so the photo is no duplicate of anything in the database.
    photo = await solidJpeg(600, 800, { r: randomInt(256), g: randomInt(256), b: randomInt(256) });
    const [settings] = await db.select({ id: appSettings.id }).from(appSettings);
    if (settings === undefined) throw new Error("app_settings is missing: run `pnpm db:seed` against this database");
    await pool.query(`
      CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.id = '${itemId}' THEN PERFORM pg_sleep(${HOLD_SECONDS}); END IF;
        RETURN OLD;
      END $$;
      CREATE TRIGGER ${trigger} AFTER DELETE ON items FOR EACH ROW EXECUTE FUNCTION ${trigger}();
    `);
  });

  afterAll(async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON items; DROP FUNCTION IF EXISTS ${trigger}();`);
    await db.delete(blobCleanup).where(eq(blobCleanup.itemId, itemId));
    await db.delete(deletedItems).where(eq(deletedItems.itemId, itemId));
    await db.delete(items).where(eq(items.id, itemId));
    await pool.end();
  });

  async function sessionsOfThisTest(condition: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      `select count(*)::int as count from pg_stat_activity where application_name = $1 and ${condition}`,
      [applicationName],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function until(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let tries = 0; tries < 400; tries += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${what} did not happen within 10 s`);
  }

  it("refuses the register once the delete commits, so the item does not come back", async () => {
    const blob = fake.upload(originalUploadPathname(itemId), photo, "image/jpeg");
    const input: RegisterBody = {
      itemId,
      url: blob.url,
      pathname: blob.pathname,
      sourceHash: createHash("sha256").update(`${itemId}-source`).digest("hex"),
      originalFilename: "IMG_0001.HEIC",
      collection: "clothing",
    };
    let deleting: Promise<{ deleted: true }> | undefined;
    let raced = false;
    // Runs at the register's first put, after its checks passed.
    const storage: BlobStorage = {
      ...fake,
      async put(pathname, body, options) {
        if (!raced) {
          raced = true;
          await registerUpload({ db, storage: fake, fetch: fake.fetch }, input);
          deleting = deleteItem(db, itemId, { storage: fake });
          await until(async () => (await sessionsOfThisTest("wait_event = 'PgSleep'")) >= 1, "the delete's hold");
        }
        return fake.put(pathname, body, options);
      },
    };

    const registering = registerUpload({ db, storage, fetch: fake.fetch }, input).then(
      () => null,
      (error: unknown) => error,
    );
    // The register's insert has to wait for the held delete.
    const sawInsertWait = until(
      async () => raced && (await sessionsOfThisTest("wait_event_type = 'Lock'")) >= 1,
      "the insert's wait",
    ).then(
      () => true,
      () => false,
    );
    const error = await registering;

    expect(await sawInsertWait).toBe(true);
    expect(await deleting).toEqual({ deleted: true });
    expect(error).toMatchObject({ code: "VALIDATION", details: { reason: "item_deleted" } });
    expect(await db.select().from(items).where(eq(items.id, itemId))).toEqual([]);
    expect(await db.select().from(itemImages).where(inArray(itemImages.itemId, [itemId]))).toEqual([]);
    expect(await db.select().from(deletedItems).where(eq(deletedItems.itemId, itemId))).toHaveLength(1);
    // The delete's cleanup deleted the first register's files, and the second
    // register deleted the derived images it stored: nothing of the item is left.
    expect(fake.urlsUnder(`items/${itemId}/`)).toEqual([]);
  }, 20_000);
});
