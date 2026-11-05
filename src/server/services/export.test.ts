import { getTableName, isTable } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedDatabase } from "@/lib/climate/seed";
import type { Db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  aiBatches,
  aiCalls,
  analyses,
  analysisParts,
  items,
  loginAttempts,
  outfitItems,
  outfits,
  packingChecklistItems,
  shoppingListItems,
  wearLogs,
  type Item,
} from "@/lib/db/schema";
import { CSV_BOM, CSV_EOL, ITEM_CSV_HEADERS } from "@/lib/export/csv";
import { readAll, readZipEntries } from "@/lib/export/zip-reader.testing";
import { ZIP_MANIFEST_NAME, type ZipManifest } from "@/lib/export/zip-plan";
import { AppError } from "@/lib/result";

import { makeTestDb, schemaTableNames, type TestDb } from "../../../test/db";
import { makeImage, makeItem, makeTaggedItem } from "../../../test/factories";
import { createFakeBlobStorage, type FakeBlobStorage } from "../../../test/fakes/blob";
import {
  EXPORT_JSON_TABLES,
  createCsvExport,
  createImageZip,
  createJsonExport,
  downloadResponse,
  exportFileName,
  getImageExportOverview,
  isCrossSiteRequest,
  isStoredBlobUrl,
} from "./export";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const NOW = new Date("2026-11-02T09:30:00.000Z");

/** Creation times a second apart, so "oldest first" never depends on the clock's resolution. */
function createdAt(second: number): Date {
  return new Date(Date.UTC(2026, 10, 1, 8, 0, second));
}
const KEY_HASH = "f".repeat(64);

let testDb: TestDb;
let fake: FakeBlobStorage;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  fake = createFakeBlobStorage();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.close();
});

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await readAll(stream));
}

/** A stored photo in the fake Blob store, with its item_images row. */
async function storePhoto(item: Item, kind: "processed" | "original" | "nobg" | "thumb", body: Buffer, contentType = "image/webp") {
  const blob = fake.upload(`items/${item.id}/${kind}.webp`, body, contentType);
  await makeImage(testDb.db, item.id, {
    kind,
    blobUrl: blob.url,
    blobPathname: blob.pathname,
    contentType,
    bytes: body.length,
  });
  return blob;
}

/** One row in every exported table, plus a login attempt that must stay out. */
async function seedEverything(db: Db) {
  await seedDatabase(db);
  const coat = await makeTaggedItem(db, { name: "Navy coat", notes: "=SUM(A1)", createdAt: createdAt(1) });
  const scarf = await makeItem(db, { name: "Red scarf", collection: "running", createdAt: createdAt(2) });
  await makeImage(db, coat.id, { kind: "processed" });
  await makeImage(db, coat.id, { kind: "thumb" });
  await makeImage(db, coat.id, { kind: "original", contentType: "image/jpeg" });

  const [batch] = await db
    .insert(aiBatches)
    .values({ anthropicBatchId: "msgbatch_1", purpose: "tagging", model: "claude-haiku-5-5", requestCount: 1 })
    .returning();
  const [analysis] = await db
    .insert(analyses)
    .values({ kind: "relocation", model: "claude-opus-5-5", promptVersion: "reloc-v1", result: { ok: true } })
    .returning();
  if (batch === undefined || analysis === undefined) throw new Error("seed failed");
  await db.insert(analysisParts).values({ analysisId: analysis.id, kind: "chunk", partIndex: 0, input: { items: 1 } });
  await db.insert(shoppingListItems).values({ itemType: "Rain jacket", analysisId: analysis.id, specs: ["hood"] });
  await db.insert(packingChecklistItems).values({ analysisId: analysis.id, itemId: coat.id, label: "Coat", group: "suitcase" });
  const [outfit] = await db.insert(outfits).values({ name: "Rainy Monday" }).returning();
  if (outfit === undefined) throw new Error("seed failed");
  await db.insert(outfitItems).values({ outfitId: outfit.id, itemId: coat.id, slot: "outerwear" });
  await db.insert(wearLogs).values({ itemId: coat.id, wornOn: "2026-11-01" });
  await db.insert(aiCalls).values({ model: "claude-haiku-5-5", purpose: "tagging", status: "success", itemId: coat.id });
  await db.insert(loginAttempts).values({ keyHash: KEY_HASH, success: false });
  return { coat, scarf };
}

describe("JSON export", () => {
  it("streams every user table, items with their photos, and leaves login attempts out", async () => {
    const { coat, scarf } = await seedEverything(testDb.db);

    const download = await createJsonExport({ db: testDb.db, now: NOW });
    expect(download.fileName).toBe("wardrobe-2026-11-02.json");
    expect(download.contentType).toBe("application/json; charset=utf-8");
    const text = await streamText(download.body);
    const parsed = JSON.parse(text) as Record<string, unknown> & { items: Array<Record<string, unknown>> };

    expect(Object.keys(parsed)).toEqual(["exportedAt", "version", ...EXPORT_JSON_TABLES]);
    expect(parsed.exportedAt).toBe(NOW.toISOString());
    expect(parsed.version).toBe(1);
    expect(text).not.toContain(KEY_HASH);
    expect(text).not.toMatch(/login_?attempts/i);

    expect(parsed.items.map((item) => item.id)).toEqual([coat.id, scarf.id]);
    const exportedCoat = parsed.items[0];
    expect(exportedCoat).toMatchObject({ name: "Navy coat", notes: "=SUM(A1)", warmthLevel: 4, colors: ["navy"] });
    // The full row, the collection included (D-252).
    expect(exportedCoat?.collection).toBe("clothing");
    expect(parsed.items[1]?.collection).toBe("running");
    expect(exportedCoat?.createdAt).toBe(coat.createdAt.toISOString());
    expect(exportedCoat?.images).toEqual([
      expect.objectContaining({ kind: "original", contentType: "image/jpeg", width: 1024, height: 768, bytes: 120_000 }),
      expect.objectContaining({ kind: "processed", url: expect.stringContaining(`items/${coat.id}/processed`) }),
      expect.objectContaining({ kind: "thumb" }),
    ]);
    expect(parsed.items[1]?.images).toEqual([]);

    for (const table of EXPORT_JSON_TABLES) expect(Array.isArray(parsed[table]), table).toBe(true);
    const counts = Object.fromEntries(EXPORT_JSON_TABLES.map((table) => [table, (parsed[table] as unknown[]).length]));
    expect(counts).toMatchObject({
      appSettings: 1,
      analyses: 1,
      analysisParts: 1,
      shoppingListItems: 1,
      packingChecklistItems: 1,
      outfits: 1,
      outfitItems: 1,
      wearLogs: 1,
      aiCalls: 1,
      aiBatches: 1,
    });
    expect(counts.climateProfiles).toBeGreaterThan(0);
    expect(parsed.shoppingListItems).toEqual([expect.objectContaining({ itemType: "Rain jacket", specs: ["hood"] })]);
  });

  it("covers every table in the schema except the ones left out on purpose", () => {
    const exported = EXPORT_JSON_TABLES.map((key) => {
      const table: unknown = schema[key];
      // A renamed schema export fails here instead of being skipped.
      if (!isTable(table)) throw new Error(`${key} is not a table in the schema`);
      return getTableName(table);
    });
    expect(schemaTableNames().filter((name) => !exported.includes(name))).toEqual([
      // Files of deleted items still to be removed from Blob (D-234): the app's own
      // bookkeeping, nothing of the owner's.
      "blob_cleanup",
      // The ids of deleted items, which a register may not use again (D-238):
      // bookkeeping too.
      "deleted_items",
      // Nested under each item, not a section of its own.
      "item_images",
      // Keyed hashes derived from SESSION_SECRET, nothing of the owner's (D-114).
      "login_attempts",
    ]);
  });

  it("is valid JSON with empty arrays when every table is empty", async () => {
    const text = await streamText((await createJsonExport({ db: testDb.db, now: NOW })).body);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const table of EXPORT_JSON_TABLES) expect(parsed[table], table).toEqual([]);
  });

  it("pages through items that share a creation time without skipping or repeating any", async () => {
    // One statement: every row gets the same now(), so only the id orders them.
    const sameInstant = await testDb.db
      .insert(items)
      .values(Array.from({ length: 5 }, (_, index) => ({ imageHash: `${"a".repeat(63)}${index}`, name: `Batch ${index}` })))
      .returning({ id: items.id });
    const later = await makeItem(testDb.db, { name: "Later", createdAt: new Date(Date.now() + 60_000) });
    const latest = await makeItem(testDb.db, { name: "Latest", createdAt: new Date(Date.now() + 120_000) });

    const text = await streamText((await createJsonExport({ db: testDb.db, now: NOW, pageSize: 2 })).body);
    const ids = (JSON.parse(text) as { items: Array<{ id: string }> }).items.map((item) => item.id);

    expect(ids).toEqual([...sameInstant.map((row) => row.id).sort(), later.id, latest.id]);
  });

  it("checks the session before reading anything", async () => {
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));
    const select = vi.spyOn(testDb.db, "select");
    await expect(createJsonExport({ db: testDb.db })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(createCsvExport({ db: testDb.db })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(getImageExportOverview(testDb.db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      createImageZip({ db: testDb.db, fetch: fake.fetch, signal: new AbortController().signal }, { kind: "processed", part: 1 }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(select).not.toHaveBeenCalled();
  });

  it("errors the stream, and logs, when a read fails part-way", async () => {
    await makeItem(testDb.db);
    await makeItem(testDb.db);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let selects = 0;
    const flaky = new Proxy(testDb.db, {
      get(target, property, receiver) {
        if (property === "select") {
          selects += 1;
          if (selects > 2) return () => { throw new Error("connection reset"); };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const download = await createJsonExport({ db: flaky, now: NOW, pageSize: 1 });
    await expect(streamText(download.body)).rejects.toThrow("connection reset");
    expect(log).toHaveBeenCalledWith("[export json] failed while streaming:", expect.any(Error));
  });
});

describe("CSV export", () => {
  it("writes a BOM, the header and one CRLF row per item, archived ones included", async () => {
    const coat = await makeTaggedItem(testDb.db, { name: "Coat, navy", notes: "=1+1", createdAt: createdAt(1) });
    const archived = await makeItem(testDb.db, { status: "archived", name: "Old hat", collection: "running", createdAt: createdAt(2) });
    const processed = await storePhoto(coat, "processed", Buffer.from("p"));
    const original = await storePhoto(coat, "original", Buffer.from("o"), "image/jpeg");
    await storePhoto(coat, "thumb", Buffer.from("t"));

    const download = await createCsvExport({ db: testDb.db, now: NOW });
    expect(download.fileName).toBe("wardrobe-2026-11-02.csv");
    expect(download.contentType).toBe("text/csv; charset=utf-8");
    const text = await streamText(download.body);

    expect(text.startsWith(CSV_BOM)).toBe(true);
    const lines = text.slice(CSV_BOM.length).split(CSV_EOL);
    expect(lines.at(-1)).toBe("");
    expect(lines[0]).toBe(ITEM_CSV_HEADERS.join(","));
    expect(lines.slice(1, -1)).toHaveLength(2);
    expect(lines[1]).toContain(`${coat.id},"Coat, navy",outerwear`);
    expect(lines[1]).toContain(`,'=1+1,`);
    // The photo URLs (no cut-out), then the collection, the last column (D-252).
    expect(lines[1]?.endsWith(`,${processed.url},${original.url},,clothing`)).toBe(true);
    expect(lines[2]?.startsWith(`${archived.id},Old hat,,`)).toBe(true);
    expect(lines[2]?.endsWith(",,,,running")).toBe(true);
  });

  it("has only the header when there are no items", async () => {
    const text = await streamText((await createCsvExport({ db: testDb.db })).body);
    expect(text).toBe(`${CSV_BOM}${ITEM_CSV_HEADERS.join(",")}${CSV_EOL}`);
  });
});

describe("photo export overview", () => {
  it("lists per kind the photo count and parts with sizes and links", async () => {
    const coat = await makeTaggedItem(testDb.db, { createdAt: createdAt(1) });
    const hat = await makeTaggedItem(testDb.db, { category: "hat_beanie", name: "Beanie", createdAt: createdAt(2) });
    await storePhoto(coat, "processed", Buffer.alloc(300));
    await storePhoto(hat, "processed", Buffer.alloc(200));
    await storePhoto(coat, "original", Buffer.alloc(900), "image/jpeg");

    const overview = await getImageExportOverview(testDb.db);

    expect(overview.map((kind) => [kind.kind, kind.photoCount, kind.parts.length])).toEqual([
      ["processed", 2, 1],
      ["original", 1, 1],
      ["nobg", 0, 0],
    ]);
    const part = overview[0]?.parts[0];
    expect(part).toMatchObject({
      part: 1,
      parts: 1,
      photoCount: 2,
      exact: true,
      fileName: "wardrobe-images-processed-part-1-of-1.zip",
      href: "/api/export/images?kind=processed&part=1",
    });
    // The archive is the photos plus the manifest and the ZIP headers.
    expect(part?.estimatedBytes).toBeGreaterThan(500);
  });
});

describe("photo ZIP", () => {
  async function seedPhotos(count: number) {
    const stored = [];
    for (let index = 0; index < count; index += 1) {
      const item = await makeTaggedItem(testDb.db, { name: `Coat ${index}`, createdAt: createdAt(index) });
      const blob = await storePhoto(item, "processed", Buffer.from(`photo-${index}`));
      stored.push({ item, blob });
    }
    return stored;
  }

  it("streams the manifest, then each photo fetched in order, with a predicted length", async () => {
    const stored = await seedPhotos(3);
    const download = await createImageZip(
      { db: testDb.db, fetch: fake.fetch, signal: new AbortController().signal, now: NOW },
      { kind: "processed", part: 1 },
    );
    expect(download.fileName).toBe("wardrobe-images-processed-part-1-of-1.zip");
    expect(download.contentType).toBe("application/zip");

    const zip = await readAll(download.body);
    expect(zip.byteLength).toBe(download.length);
    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual([
      ZIP_MANIFEST_NAME,
      ...stored.map(({ item }, index) => `outerwear/coat-${index}-${item.id.slice(0, 8)}-processed.webp`),
    ]);
    expect(entries.slice(1).map((entry) => Buffer.from(entry.data).toString())).toEqual(["photo-0", "photo-1", "photo-2"]);
    expect(fake.fetched).toEqual(stored.map(({ blob }) => blob.url));

    const manifest = JSON.parse(Buffer.from(entries[0]?.data ?? []).toString()) as ZipManifest;
    expect(manifest.files.map((file) => [file.itemId, file.sourceUrl, file.bytes])).toEqual(
      stored.map(({ item, blob }, index) => [item.id, blob.url, `photo-${index}`.length]),
    );
  });

  it("answers NOT_FOUND for a part beyond the plan", async () => {
    await seedPhotos(1);
    const deps = { db: testDb.db, fetch: fake.fetch, signal: new AbortController().signal };
    await expect(createImageZip(deps, { kind: "processed", part: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createImageZip(deps, { kind: "nobg", part: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.fetched).toEqual([]);
  });

  it("refuses a part with a photo outside the Blob store before fetching anything", async () => {
    await seedPhotos(1);
    const stray = await makeTaggedItem(testDb.db, { createdAt: createdAt(30) });
    await makeImage(testDb.db, stray.id, { kind: "processed", blobUrl: "https://169.254.169.254/latest/meta-data" });

    const attempt = createImageZip(
      { db: testDb.db, fetch: fake.fetch, signal: new AbortController().signal },
      { kind: "processed", part: 1 },
    );
    await expect(attempt).rejects.toMatchObject({ code: "INTERNAL", details: { itemId: stray.id } });
    expect(fake.fetched).toEqual([]);
  });

  it("stops fetching once the request is aborted", async () => {
    const stored = await seedPhotos(3);
    const controller = new AbortController();
    const fetched: string[] = [];
    const fetchThenLeave: typeof fetch = async (input, init) => {
      const url = String(input);
      fetched.push(url);
      // The browser goes away while the second photo downloads.
      if (url === stored[1]?.blob.url) {
        controller.abort();
        init?.signal?.throwIfAborted();
      }
      return fake.fetch(input, init);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const download = await createImageZip(
      { db: testDb.db, fetch: fetchThenLeave, signal: controller.signal },
      { kind: "processed", part: 1 },
    );
    await expect(readAll(download.body)).rejects.toThrow();
    expect(fetched).toEqual([stored[0]?.blob.url, stored[1]?.blob.url]);
    // A client leaving is not a server failure.
    expect(log).not.toHaveBeenCalled();
  });

  it("ends the archive with an error, and logs it, when a photo cannot be fetched", async () => {
    const stored = await seedPhotos(3);
    fake.blobs.delete(stored[1]?.blob.url ?? "");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const download = await createImageZip(
      { db: testDb.db, fetch: fake.fetch, signal: new AbortController().signal },
      { kind: "processed", part: 1 },
    );
    await expect(readAll(download.body)).rejects.toMatchObject({ code: "UPSTREAM", details: { itemId: stored[1]?.item.id } });
    expect(fake.fetched).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("processed part 1 of 1 stopped at outerwear/coat-1-"), expect.any(AppError));
  });

  it("fails a photo that takes longer than the per-file timeout", async () => {
    await seedPhotos(1);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const download = await createImageZip(
      { db: testDb.db, fetch: hang, signal: new AbortController().signal, fileTimeoutMs: 20 },
      { kind: "processed", part: 1 },
    );
    await expect(readAll(download.body)).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("fails rather than break the promised length when a photo's size differs from the database", async () => {
    const [first] = await seedPhotos(1);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const blob = fake.blobs.get(first?.blob.url ?? "");
    if (blob === undefined) throw new Error("missing blob");
    blob.body = Buffer.from("a different, longer body");

    const download = await createImageZip(
      { db: testDb.db, fetch: fake.fetch, signal: new AbortController().signal },
      { kind: "processed", part: 1 },
    );
    await expect(readAll(download.body)).rejects.toMatchObject({ code: "UPSTREAM" });
  });
});

describe("helpers", () => {
  it("accepts only https URLs on a public Blob host", () => {
    expect(isStoredBlobUrl("https://abc123.public.blob.vercel-storage.com/items/x.webp")).toBe(true);
    expect(isStoredBlobUrl("http://abc123.public.blob.vercel-storage.com/items/x.webp")).toBe(false);
    expect(isStoredBlobUrl("https://abc123.public.blob.vercel-storage.com:8443/x")).toBe(false);
    expect(isStoredBlobUrl("https://user:pw@abc123.public.blob.vercel-storage.com/x")).toBe(false);
    expect(isStoredBlobUrl("https://public.blob.vercel-storage.com/x")).toBe(false);
    expect(isStoredBlobUrl("https://abc.public.blob.vercel-storage.com.evil.example/x")).toBe(false);
    expect(isStoredBlobUrl("https://localhost/x")).toBe(false);
    expect(isStoredBlobUrl("/icons/icon-192.png")).toBe(false);
  });

  it("names files by UTC date and sends downloads as uncached attachments", async () => {
    expect(exportFileName("csv", new Date("2026-12-31T23:30:00Z"))).toBe("wardrobe-2026-12-31.csv");
    const response = downloadResponse({
      body: new Blob(["{}"]).stream(),
      fileName: "wardrobe-2026-11-02.json",
      contentType: "application/json; charset=utf-8",
      length: null,
    });
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="wardrobe-2026-11-02.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe("{}");
  });

  it("recognises requests started by another site", () => {
    const at = (site?: string) =>
      new Request("http://localhost:3000/api/export/json", site === undefined ? {} : { headers: { "sec-fetch-site": site } });
    expect(isCrossSiteRequest(at("cross-site"))).toBe(true);
    expect(isCrossSiteRequest(at("same-origin"))).toBe(false);
    expect(isCrossSiteRequest(at("none"))).toBe(false);
    expect(isCrossSiteRequest(at())).toBe(false);
  });
});
