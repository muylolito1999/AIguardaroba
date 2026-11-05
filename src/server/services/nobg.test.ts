import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { blobCleanup, itemImages, items, type Item } from "@/lib/db/schema";
import type { BlobStorage } from "@/lib/images/blob";
import { nobgUploadPathname, type NobgBody } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, makeItem } from "../../../test/factories";
import { createFakeBlobStorage, FAKE_BLOB_ORIGIN, type FakeBlob, type FakeBlobStorage } from "../../../test/fakes/blob";
import { solidPng } from "../../../test/fixtures/images";
import { runBlobCleanup } from "./blob-cleanup";
import { deleteItem } from "./item-lifecycle";
import { attachNobgImage, nobgPathname, type AttachNobgDeps } from "./nobg";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

let testDb: TestDb;
let fake: FakeBlobStorage;
let cutout: Buffer;

/** A transparent canvas with an opaque red block in the middle, like the model's output. */
async function cutoutPng(width: number, height: number): Promise<Buffer> {
  const garment = await sharp({
    create: { width: width / 2, height: height / 2, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: garment, left: width / 4, top: height / 4 }])
    .png()
    .toBuffer();
}

async function alphaAt(image: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels + 3] ?? -1;
}

beforeAll(async () => {
  testDb = await makeTestDb();
  // Larger than the 1024 px long edge, so the resize is exercised too.
  cutout = await cutoutPng(1200, 1600);
});

beforeEach(async () => {
  await testDb.truncateAll();
  fake = createFakeBlobStorage();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterAll(async () => {
  await testDb.close();
});

function deps(overrides: Partial<AttachNobgDeps> = {}): AttachNobgDeps {
  return { db: testDb.db, storage: fake, fetch: fake.fetch, ...overrides };
}

async function itemWithPhoto(): Promise<Item> {
  const item = await makeItem(testDb.db);
  await makeImage(testDb.db, item.id, { kind: "processed" });
  return item;
}

/** Simulates the button's upload of a cut-out for `itemId`. */
function uploadCutout(itemId: string, body: Buffer = cutout, contentType = "image/png"): FakeBlob {
  return fake.upload(nobgUploadPathname(itemId), body, contentType);
}

function bodyFor(blob: FakeBlob): NobgBody {
  return { url: blob.url, pathname: blob.pathname };
}

async function nobgRows(itemId: string) {
  return testDb.db
    .select()
    .from(itemImages)
    .where(eq(itemImages.itemId, itemId))
    .then((rows) => rows.filter((row) => row.kind === "nobg"));
}

function putPathnames(): string[] {
  return fake.calls.filter((call) => call.method === "put").map((call) => String(call.target));
}

function deletedUrls(): string[] {
  return fake.calls.filter((call) => call.method === "del").flatMap((call) => call.target);
}

async function thrownBy(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError)) throw error;
  return error;
}

describe("attachNobgImage", () => {
  it("stores the cut-out as a WebP with alpha, records the nobg row and deletes the uploaded PNG", async () => {
    const item = await itemWithPhoto();
    const upload = uploadCutout(item.id);

    const result = await attachNobgImage(deps(), item.id, bodyFor(upload));

    expect(requireSession).toHaveBeenCalled();
    expect(putPathnames()).toEqual([nobgPathname(item.id)]);
    expect(fake.fetched).toEqual([upload.url]);

    const [row, ...others] = await nobgRows(item.id);
    expect(others).toEqual([]);
    expect(row).toMatchObject({ contentType: "image/webp", width: 768, height: 1024 });
    expect(row?.blobPathname.startsWith(`items/${item.id}/nobg`)).toBe(true);
    expect(row?.blobPathname.endsWith(".webp")).toBe(true);

    const stored = fake.blobs.get(row?.blobUrl ?? "");
    expect(stored?.contentType).toBe("image/webp");
    expect(row?.bytes).toBe(stored?.body.length);
    const metadata = await sharp(stored?.body).metadata();
    expect(metadata).toMatchObject({ format: "webp", hasAlpha: true, width: 768, height: 1024 });
    // Corner transparent, garment opaque: the alpha channel survived the re-encode.
    expect(await alphaAt(stored?.body ?? Buffer.alloc(0), 2, 2)).toBe(0);
    expect(await alphaAt(stored?.body ?? Buffer.alloc(0), 384, 512)).toBe(255);

    // The uploaded PNG was only an input.
    expect(fake.blobs.has(upload.url)).toBe(false);
    expect(deletedUrls()).toEqual([upload.url]);

    expect(result.item.id).toBe(item.id);
    expect(result.item.images.nobg).toEqual({ url: row?.blobUrl, width: 768, height: 1024 });
    expect(result.item.images.processed).not.toBeNull();
  });

  it("replaces an earlier cut-out and deletes its blob", async () => {
    const item = await itemWithPhoto();
    const old = await fake.put(nobgPathname(item.id), Buffer.from("old webp"), { contentType: "image/webp" });
    await makeImage(testDb.db, item.id, {
      kind: "nobg",
      blobUrl: old.url,
      blobPathname: old.pathname,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const upload = uploadCutout(item.id);

    const result = await attachNobgImage(deps(), item.id, bodyFor(upload));

    const [row, ...others] = await nobgRows(item.id);
    expect(others).toEqual([]);
    expect(row?.blobUrl).not.toBe(old.url);
    expect(fake.blobs.has(row?.blobUrl ?? "")).toBe(true);
    expect(row?.createdAt.getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00Z").getTime());
    expect(fake.blobs.has(old.url)).toBe(false);
    expect(fake.blobs.has(upload.url)).toBe(false);
    expect(deletedUrls().sort()).toEqual([old.url, upload.url].sort());
    expect(result.item.images.nobg?.url).toBe(row?.blobUrl);
    // Queued in the save's transaction and taken off the queue once deleted (D-245).
    expect(await testDb.db.select().from(blobCleanup)).toEqual([]);
  });

  describe("when Blob fails to delete (D-245)", () => {
    async function itemWithOldCutout(): Promise<{ item: Item; old: FakeBlob }> {
      const item = await itemWithPhoto();
      const old = fake.upload(`items/${item.id}/nobg.webp`, Buffer.from("old webp"), "image/webp");
      await makeImage(testDb.db, item.id, { kind: "nobg", blobUrl: old.url, blobPathname: old.pathname });
      return { item, old };
    }

    it("keeps the replaced cut-out queued, and the next cleanup run deletes it", async () => {
      const { item, old } = await itemWithOldCutout();
      fake.failNext("del", new Error("Blob is down"));

      const result = await attachNobgImage(deps({ now: () => new Date("2026-11-05T10:00:00Z") }), item.id, bodyFor(uploadCutout(item.id)));

      expect(result.item.images.nobg?.url).not.toBe(old.url);
      expect(fake.blobs.has(old.url)).toBe(true);
      const [queuedRow, ...rest] = await testDb.db.select().from(blobCleanup);
      expect(rest).toEqual([]);
      expect(queuedRow).toMatchObject({ url: old.url, itemId: item.id, reason: "cutout_replaced", attempts: 1 });
      expect(queuedRow?.lastError).toMatch(/UPSTREAM|CONFIG/);

      const run = await runBlobCleanup({ db: testDb.db, storage: fake }, { deadlineAt: Date.now() + 60_000, maxItems: 10 });
      expect(run).toMatchObject({ deleted: 1, pending: 0, error: null });
      expect(fake.blobs.has(old.url)).toBe(false);
    });

    it("leaves nothing of the item in the store once the item is deleted and the cron has run", async () => {
      const { item, old } = await itemWithOldCutout();
      fake.failNext("del", new Error("Blob is down"));
      await attachNobgImage(deps(), item.id, bodyFor(uploadCutout(item.id)));
      expect(fake.blobs.has(old.url)).toBe(true);

      await deleteItem(testDb.db, item.id, { storage: fake, cleanupBudgetMs: 5_000 });
      // The delete's own run skips a file tried within the hour (D-234); it stays queued for the cron.
      expect(await testDb.db.select({ url: blobCleanup.url }).from(blobCleanup)).toEqual([{ url: old.url }]);

      await runBlobCleanup({ db: testDb.db, storage: fake }, { deadlineAt: Date.now() + 60_000, maxItems: 100 });
      expect([...fake.blobs.values()].filter((blob) => blob.pathname.startsWith(`items/${item.id}/`))).toEqual([]);
      expect(await testDb.db.select().from(blobCleanup)).toEqual([]);
    });

    it("queues the uploaded PNG it could not delete", async () => {
      const item = await itemWithPhoto();
      const upload = uploadCutout(item.id);
      fake.failNext("del", new Error("Blob is down"));

      await attachNobgImage(deps(), item.id, bodyFor(upload));

      expect(fake.blobs.has(upload.url)).toBe(true);
      expect(await testDb.db.select().from(blobCleanup)).toMatchObject([
        { url: upload.url, itemId: item.id, reason: "upload_abandoned", attempts: 0 },
      ]);
    });
  });

  it("refuses a URL that is not in the store, without fetching or deleting anything", async () => {
    const item = await itemWithPhoto();
    const foreign = `https://example.com/items/${item.id}/nobg.png`;

    const error = await thrownBy(
      attachNobgImage(deps(), item.id, { url: foreign, pathname: `items/${item.id}/nobg.png` }),
    );

    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({ reason: "not_in_store" });
    expect(fake.fetched).toEqual([]);
    expect(deletedUrls()).toEqual([]);
    expect(putPathnames()).toEqual([]);
    expect(await nobgRows(item.id)).toEqual([]);
  });

  it("refuses another item's cut-out and leaves it alone", async () => {
    const item = await itemWithPhoto();
    const other = await itemWithPhoto();
    const othersUpload = uploadCutout(other.id);

    const error = await thrownBy(attachNobgImage(deps(), item.id, bodyFor(othersUpload)));

    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({ reason: "wrong_pathname" });
    expect(fake.blobs.has(othersUpload.url)).toBe(true);
    expect(deletedUrls()).toEqual([]);
    expect(fake.fetched).toEqual([]);
  });

  it("refuses the item's stored WebP cut-out as input, so a crafted request cannot delete it", async () => {
    const item = await itemWithPhoto();
    const current = await fake.put(nobgPathname(item.id), Buffer.from("current webp"), { contentType: "image/webp" });

    const error = await thrownBy(attachNobgImage(deps(), item.id, { url: current.url, pathname: current.pathname }));

    expect(error.code).toBe("VALIDATION");
    expect(fake.blobs.has(current.url)).toBe(true);
    expect(deletedUrls()).toEqual([]);
  });

  it("refuses a PNG under a name other than the requested upload", async () => {
    const item = await itemWithPhoto();
    const stray = fake.upload(`items/${item.id}/nobg/extra.png`, cutout, "image/png");

    const error = await thrownBy(attachNobgImage(deps(), item.id, bodyFor(stray)));

    expect(error.details).toMatchObject({ reason: "wrong_pathname" });
    expect(fake.blobs.has(stray.url)).toBe(true);
  });

  it("refuses a pathname that differs from the stored one", async () => {
    const item = await itemWithPhoto();
    const upload = uploadCutout(item.id);

    const error = await thrownBy(
      attachNobgImage(deps(), item.id, { url: upload.url, pathname: nobgUploadPathname(item.id) }),
    );

    expect(error.details).toMatchObject({ reason: "pathname_mismatch" });
    expect(fake.blobs.has(upload.url)).toBe(true);
  });

  it("answers NOT_FOUND for a deleted item and removes its uploaded PNG", async () => {
    const itemId = randomUUID();
    const upload = uploadCutout(itemId);

    const error = await thrownBy(attachNobgImage(deps(), itemId, bodyFor(upload)));

    expect(error.code).toBe("NOT_FOUND");
    expect(putPathnames()).toEqual([]);
    expect(fake.fetched).toEqual([]);
    expect(fake.blobs.has(upload.url)).toBe(false);
  });

  it("answers NOT_FOUND for a malformed id without touching the store", async () => {
    const error = await thrownBy(
      attachNobgImage(deps(), "not-a-uuid", {
        url: `${FAKE_BLOB_ORIGIN}/items/not-a-uuid/nobg.png`,
        pathname: "items/not-a-uuid/nobg.png",
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(fake.calls).toEqual([]);
  });

  it("refuses a PNG without transparency and deletes it", async () => {
    const item = await itemWithPhoto();
    const opaque = uploadCutout(item.id, await solidPng(400, 400));

    const error = await thrownBy(attachNobgImage(deps(), item.id, bodyFor(opaque)));

    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({ reason: "no_alpha" });
    expect(putPathnames()).toEqual([]);
    expect(fake.blobs.has(opaque.url)).toBe(false);
    expect(await nobgRows(item.id)).toEqual([]);
  });

  it("refuses bytes that are not a PNG even when stored as image/png", async () => {
    const item = await itemWithPhoto();
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer();
    const upload = uploadCutout(item.id, jpeg);

    const error = await thrownBy(attachNobgImage(deps(), item.id, bodyFor(upload)));

    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({ reason: "unreadable" });
    expect(fake.blobs.has(upload.url)).toBe(false);
  });

  it("treats a short read as a store failure, not a bad image", async () => {
    const item = await itemWithPhoto();
    const upload = uploadCutout(item.id);
    const shortFetch: typeof fetch = async () =>
      new Response(new Uint8Array(cutout.subarray(0, 100)), { status: 200 });

    const error = await thrownBy(attachNobgImage(deps({ fetch: shortFetch }), item.id, bodyFor(upload)));

    expect(error.code).toBe("UPSTREAM");
    expect(error.details).toMatchObject({ reason: "incomplete" });
    expect(putPathnames()).toEqual([]);
    expect(fake.blobs.has(upload.url)).toBe(false);
  });

  it("refuses a body longer than the size the store reported", async () => {
    const item = await itemWithPhoto();
    const upload = uploadCutout(item.id);
    const longFetch: typeof fetch = async () =>
      new Response(new Uint8Array(Buffer.concat([cutout, Buffer.alloc(10)])), { status: 200 });

    const error = await thrownBy(attachNobgImage(deps({ fetch: longFetch }), item.id, bodyFor(upload)));

    expect(error.code).toBe("UPSTREAM");
    expect(error.details).toMatchObject({ reason: "too_long" });
  });

  it("deletes the new WebP when the item disappears before the row is written", async () => {
    const item = await itemWithPhoto();
    const upload = uploadCutout(item.id);
    const storage: BlobStorage = {
      ...fake,
      async put(pathname, body, options) {
        const stored = await fake.put(pathname, body, options);
        await testDb.db.delete(items).where(eq(items.id, item.id));
        return stored;
      },
    };

    const error = await thrownBy(attachNobgImage(deps({ storage }), item.id, bodyFor(upload)));

    expect(error.code).toBe("NOT_FOUND");
    expect(fake.urlsUnder(`items/${item.id}/`)).toEqual([]);
  });

  it("checks the session before anything else", async () => {
    requireSession.mockRejectedValueOnce(new AppError("UNAUTHENTICATED", "Sign in again."));
    const item = await itemWithPhoto();
    const upload = uploadCutout(item.id);

    const error = await thrownBy(attachNobgImage(deps(), item.id, bodyFor(upload)));

    expect(error.code).toBe("UNAUTHENTICATED");
    expect(fake.calls).toEqual([]);
  });
});
