import "server-only";

import { makeZip } from "client-zip";
import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { IMAGE_KINDS } from "@/lib/db/enums";
import {
  aiBatches,
  aiCalls,
  analyses,
  analysisParts,
  appSettings,
  climateProfiles,
  itemImages,
  items,
  outfitItems,
  outfits,
  packingChecklistItems,
  shoppingListItems,
  wearLogs,
  type Item,
  type ItemImage,
} from "@/lib/db/schema";
import { CSV_BOM, CSV_IMAGE_KINDS, itemCsvHeaderRow, itemCsvRow, type CsvImageKind } from "@/lib/export/csv";
import { EXPORT_FORMAT_VERSION, EXPORT_JSON_TABLES, type ExportJsonTable } from "@/lib/export/json-tables";
import {
  EXPORT_IMAGE_KINDS,
  ZIP_MANIFEST_NAME,
  manifestBytes,
  planZipParts,
  zipPartHref,
  type ExportImageKind,
  type ZipImageSource,
  type ZipPartPlan,
  type ZipPlanEntry,
  type ZipPlanItem,
} from "@/lib/export/zip-plan";
import { AppError } from "@/lib/result";

// Data export (spec Phase 4: "my data must be portable"): a streamed JSON
// file of every user table, a streamed CSV of the items, and the photos as
// ZIP parts. Each entry point checks the session before it builds anything
// (D-013); the streams then read the database page by page while the browser
// downloads, so memory stays bounded however large the wardrobe grows.

// The JSON layout lives in a pure module the Playwright spec reads too.
export { EXPORT_FORMAT_VERSION, EXPORT_JSON_TABLES, type ExportJsonTable };

/** Rows per database read while streaming. */
export const EXPORT_PAGE_SIZE = 200;

/** Longest one photo download may take inside a ZIP before the part fails. */
export const ZIP_FILE_TIMEOUT_MS = 30_000;

/** A ready-to-send download: the route wraps it in a Response. */
export type ExportDownload = {
  body: ReadableStream<Uint8Array>;
  fileName: string;
  contentType: string;
  /** Exact byte length when it is known in advance; the streams of rows never know it. */
  length: number | null;
};

export type ExportDeps = {
  db: Db;
  /** The export time; tests pass a fixed one. */
  now?: Date;
  /** Rows per read; tests pass a small one to exercise paging. */
  pageSize?: number;
};

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** `wardrobe-2026-11-02.json`, dated in UTC like the export's exportedAt. */
export function exportFileName(extension: "json" | "csv", now: Date): string {
  return `wardrobe-${now.toISOString().slice(0, 10)}.${extension}`;
}

/** The attachment Response for a download; never cached, since it carries the whole wardrobe. */
export function downloadResponse(download: ExportDownload): Response {
  const headers = new Headers({
    "Content-Type": download.contentType,
    // File names are built from ASCII only (dates, kinds, numbers), so the
    // plain quoted form needs no RFC 5987 encoding.
    "Content-Disposition": `attachment; filename="${download.fileName}"`,
    "Cache-Control": "no-store",
  });
  if (download.length !== null) headers.set("Content-Length", String(download.length));
  return new Response(download.body, { status: 200, headers });
}

/**
 * True for a request a page on another site started (Fetch Metadata). An
 * export link opened from elsewhere would still carry the lax session
 * cookie; the attacker could not read the file, but a ZIP part costs Blob
 * data transfer, so the export routes refuse such requests. Browsers that send
 * no Sec-Fetch-Site (old ones, curl) are let through: the session is the
 * boundary, this only removes the cross-site trigger.
 */
export function isCrossSiteRequest(request: Request): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site";
}

export function crossSiteRefused(): Response {
  // Same shape and status as the authedRoute Origin refusal.
  return Response.json(
    { ok: false, error: { code: "UNAUTHENTICATED", message: "Open the export from the app itself." } },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Turns an async generator of text into a byte stream that reads the next
 * chunk only when the client wants more. A failure after the first byte can
 * no longer change the status code, so the stream is errored instead: the
 * download fails visibly rather than ending as a short file that looks whole.
 */
function textStream(chunks: AsyncGenerator<string>, label: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done === true) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        console.error(`[export ${label}] failed while streaming:`, error);
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

// ---------------------------------------------------------------------------
// Paged reads
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type ItemWithImages = { item: Item; images: ItemImage[] };

const IMAGE_KIND_ORDER = new Map<string, number>(IMAGE_KINDS.map((kind, index) => [kind, index]));

/**
 * Items oldest first, with their image rows, `pageSize` at a time. The keyset
 * cursor is created_at as UTC text with microseconds: a JS Date keeps only
 * milliseconds, and rows inserted in one statement share created_at exactly,
 * so the id breaks ties.
 */
async function* itemPages(db: Db, pageSize: number): AsyncGenerator<ItemWithImages[]> {
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const cursorFilter: SQL | undefined =
      after === null
        ? undefined
        : sql`(${items.createdAt}, ${items.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`;
    const rows = await db
      .select({
        item: items,
        cursorAt: sql<string>`to_char(${items.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(items)
      .where(cursorFilter)
      .orderBy(asc(items.createdAt), asc(items.id))
      .limit(pageSize);
    const last = rows.at(-1);
    if (last === undefined) return;

    const images = await db
      .select()
      .from(itemImages)
      .where(
        inArray(
          itemImages.itemId,
          rows.map((row) => row.item.id),
        ),
      );
    const byItem = new Map<string, ItemImage[]>();
    for (const image of images) byItem.set(image.itemId, [...(byItem.get(image.itemId) ?? []), image]);
    for (const list of byItem.values()) {
      list.sort((a, b) => (IMAGE_KIND_ORDER.get(a.kind) ?? 0) - (IMAGE_KIND_ORDER.get(b.kind) ?? 0));
    }

    yield rows.map((row) => ({ item: row.item, images: byItem.get(row.item.id) ?? [] }));
    if (rows.length < pageSize) return;
    after = { at: last.cursorAt, id: last.item.id };
  }
}

/** Every row of a table with an `id` primary key, in id order, `pageSize` at a time. */
async function* pagesById(db: Db, table: PgTable, id: PgColumn, pageSize: number): AsyncGenerator<Row[]> {
  let after: unknown = undefined;
  for (;;) {
    const rows: Row[] = await db
      .select()
      .from(table)
      .where(after === undefined ? undefined : gt(id, after))
      .orderBy(asc(id))
      .limit(pageSize);
    const last = rows.at(-1);
    if (last === undefined) return;
    yield rows;
    if (rows.length < pageSize) return;
    after = last.id;
  }
}

/** outfit_items has a composite key, so its cursor is the (outfit, item) pair. */
async function* outfitItemPages(db: Db, pageSize: number): AsyncGenerator<Row[]> {
  let after: { outfitId: string; itemId: string } | null = null;
  for (;;) {
    const cursorFilter: SQL | undefined =
      after === null
        ? undefined
        : sql`(${outfitItems.outfitId}, ${outfitItems.itemId}) > (${after.outfitId}::uuid, ${after.itemId}::uuid)`;
    const rows = await db
      .select()
      .from(outfitItems)
      .where(cursorFilter)
      .orderBy(asc(outfitItems.outfitId), asc(outfitItems.itemId))
      .limit(pageSize);
    const last = rows.at(-1);
    if (last === undefined) return;
    yield rows;
    if (rows.length < pageSize) return;
    after = { outfitId: last.outfitId, itemId: last.itemId };
  }
}

/** How each item appears in the JSON: every column, plus its photos without the redundant item id. */
function itemJson({ item, images }: ItemWithImages): Row {
  return {
    ...item,
    images: images.map((image) => ({
      id: image.id,
      kind: image.kind,
      url: image.blobUrl,
      pathname: image.blobPathname,
      contentType: image.contentType,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
      createdAt: image.createdAt,
    })),
  };
}

type JsonSection = { key: ExportJsonTable; pages: (db: Db, pageSize: number) => AsyncGenerator<Row[]> };

const JSON_SECTIONS: readonly JsonSection[] = [
  {
    key: "items",
    async *pages(db, pageSize) {
      for await (const page of itemPages(db, pageSize)) yield page.map(itemJson);
    },
  },
  { key: "climateProfiles", pages: (db, size) => pagesById(db, climateProfiles, climateProfiles.id, size) },
  { key: "appSettings", pages: (db, size) => pagesById(db, appSettings, appSettings.id, size) },
  { key: "analyses", pages: (db, size) => pagesById(db, analyses, analyses.id, size) },
  { key: "analysisParts", pages: (db, size) => pagesById(db, analysisParts, analysisParts.id, size) },
  { key: "shoppingListItems", pages: (db, size) => pagesById(db, shoppingListItems, shoppingListItems.id, size) },
  {
    key: "packingChecklistItems",
    pages: (db, size) => pagesById(db, packingChecklistItems, packingChecklistItems.id, size),
  },
  { key: "outfits", pages: (db, size) => pagesById(db, outfits, outfits.id, size) },
  { key: "outfitItems", pages: outfitItemPages },
  { key: "wearLogs", pages: (db, size) => pagesById(db, wearLogs, wearLogs.id, size) },
  { key: "aiCalls", pages: (db, size) => pagesById(db, aiCalls, aiCalls.id, size) },
  { key: "aiBatches", pages: (db, size) => pagesById(db, aiBatches, aiBatches.id, size) },
];

// ---------------------------------------------------------------------------
// JSON and CSV
// ---------------------------------------------------------------------------

/**
 * `{ exportedAt, version, items: [...], climateProfiles: [...], ... }`, one row
 * per line. Rows are the database rows with camelCase keys as the app reads
 * them: timestamps in ISO 8601, money as numbers, JSON columns as JSON.
 */
async function* jsonChunks(db: Db, exportedAt: Date, pageSize: number): AsyncGenerator<string> {
  yield `{\n"exportedAt": ${JSON.stringify(exportedAt.toISOString())},\n"version": ${EXPORT_FORMAT_VERSION}`;
  for (const section of JSON_SECTIONS) {
    yield `,\n${JSON.stringify(section.key)}: [`;
    let written = 0;
    for await (const rows of section.pages(db, pageSize)) {
      const lines = rows.map((row) => JSON.stringify(row));
      yield `${written === 0 ? "\n" : ",\n"}${lines.join(",\n")}`;
      written += rows.length;
    }
    yield written === 0 ? "]" : "\n]";
  }
  yield "\n}\n";
}

/** The JSON export as a stream. Checks the session first. */
export async function createJsonExport(deps: ExportDeps): Promise<ExportDownload> {
  await requireSession();
  const now = deps.now ?? new Date();
  return {
    body: textStream(jsonChunks(deps.db, now, deps.pageSize ?? EXPORT_PAGE_SIZE), "json"),
    fileName: exportFileName("json", now),
    contentType: "application/json; charset=utf-8",
    length: null,
  };
}

function imageUrls(images: readonly ItemImage[]): Partial<Record<CsvImageKind, string>> {
  const urls: Partial<Record<CsvImageKind, string>> = {};
  for (const image of images) {
    const kind = CSV_IMAGE_KINDS.find((candidate) => candidate === image.kind);
    if (kind !== undefined) urls[kind] = image.blobUrl;
  }
  return urls;
}

async function* csvChunks(db: Db, pageSize: number): AsyncGenerator<string> {
  yield `${CSV_BOM}${itemCsvHeaderRow()}`;
  for await (const page of itemPages(db, pageSize)) {
    yield page.map(({ item, images }) => itemCsvRow({ ...item, imageUrls: imageUrls(images) })).join("");
  }
}

/** The item CSV as a stream, every item including archived ones. Checks the session first. */
export async function createCsvExport(deps: ExportDeps): Promise<ExportDownload> {
  await requireSession();
  const now = deps.now ?? new Date();
  return {
    body: textStream(csvChunks(deps.db, deps.pageSize ?? EXPORT_PAGE_SIZE), "csv"),
    fileName: exportFileName("csv", now),
    contentType: "text/csv; charset=utf-8",
    length: null,
  };
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

// Public Vercel Blob URLs look like https://<store id>.public.blob.vercel-storage.com/<pathname>.
const BLOB_PUBLIC_HOST = /^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/;

/**
 * The only URLs the ZIP route fetches: https on the default port, no
 * credentials, on a public Vercel Blob host. URLs come from item_images rows,
 * never from the request, and this check means a bad row still cannot make
 * the server fetch an arbitrary host or an internal address.
 */
export function isStoredBlobUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    BLOB_PUBLIC_HOST.test(url.hostname)
  );
}

/** Items that have at least one image of `kinds`, oldest first, the order the parts follow. */
async function loadZipPlanItems(db: Db, kinds: readonly ExportImageKind[]): Promise<ZipPlanItem[]> {
  const rows = await db
    .select({
      id: items.id,
      name: items.name,
      subcategory: items.subcategory,
      category: items.category,
      kind: itemImages.kind,
      url: itemImages.blobUrl,
      contentType: itemImages.contentType,
      bytes: itemImages.bytes,
      imageCreatedAt: itemImages.createdAt,
    })
    .from(items)
    .innerJoin(itemImages, and(eq(itemImages.itemId, items.id), inArray(itemImages.kind, [...kinds])))
    .orderBy(asc(items.createdAt), asc(items.id));

  const byId = new Map<string, ZipPlanItem>();
  for (const row of rows) {
    let item = byId.get(row.id);
    if (item === undefined) {
      item = { id: row.id, name: row.name, subcategory: row.subcategory, category: row.category, images: {} };
      byId.set(row.id, item);
    }
    const kind = EXPORT_IMAGE_KINDS.find((candidate) => candidate === row.kind);
    if (kind === undefined) continue;
    const image: ZipImageSource = {
      url: row.url,
      contentType: row.contentType,
      bytes: row.bytes,
      createdAt: row.imageCreatedAt.toISOString(),
    };
    item.images[kind] = image;
  }
  return [...byId.values()];
}

export type ImageExportPart = {
  part: number;
  parts: number;
  photoCount: number;
  /** Exact archive size when predicted, otherwise the sum of the photo sizes. */
  estimatedBytes: number;
  exact: boolean;
  fileName: string;
  href: string;
};

export type ImageExportKindSummary = {
  kind: ExportImageKind;
  photoCount: number;
  parts: ImageExportPart[];
};

/** What /settings/export lists: per kind, its parts with sizes and links. Checks the session first. */
export async function getImageExportOverview(db: Db): Promise<ImageExportKindSummary[]> {
  await requireSession();
  const planItems = await loadZipPlanItems(db, EXPORT_IMAGE_KINDS);
  return EXPORT_IMAGE_KINDS.map((kind) => {
    const plan = planZipParts(planItems, { kind });
    return {
      kind,
      photoCount: plan.itemCount,
      parts: plan.parts.map((part) => ({
        part: part.part,
        parts: part.parts,
        photoCount: part.entries.length,
        estimatedBytes: part.predictedLength ?? part.knownBytes,
        exact: part.predictedLength !== null,
        fileName: part.fileName,
        href: zipPartHref(kind, part.part),
      })),
    };
  });
}

export type ImageZipDeps = {
  db: Db;
  fetch: typeof fetch;
  /** The request's signal: when the browser goes away, no further photo is fetched. */
  signal: AbortSignal;
  /** Date for the manifest entry; defaults to now. */
  now?: Date;
  fileTimeoutMs?: number;
};

type ZipFetchContext = {
  fetch: typeof fetch;
  signal: AbortSignal;
  fileTimeoutMs: number;
  /** A Content-Length was promised, so every body must be exactly its stored size. */
  exactSizes: boolean;
};

function photoFailure(entry: ZipPlanEntry, message: string, cause?: unknown): AppError {
  return new AppError("UPSTREAM", message, { itemId: entry.itemId, fileName: entry.fileName }, { cause });
}

/** Downloads one stored photo in full, so its size can be checked before it enters the archive. */
async function fetchStoredPhoto(entry: ZipPlanEntry, context: ZipFetchContext): Promise<Uint8Array> {
  // Checked again here, right before the request, in case a caller skipped the plan check.
  if (!isStoredBlobUrl(entry.url)) throw foreignPhoto(entry);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(context.fileTimeoutMs)]);
  let body: Uint8Array;
  try {
    // redirect: 'error', because a redirect could lead off the Blob host.
    const response = await context.fetch(entry.url, { signal, redirect: "error", cache: "no-store" });
    if (!response.ok) {
      throw photoFailure(entry, `The photo store answered HTTP ${response.status} for ${entry.fileName}.`);
    }
    body = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    // The browser left: hand back its abort as is, there is nobody to tell.
    if (context.signal.aborted) throw context.signal.reason;
    if (error instanceof AppError) throw error;
    throw photoFailure(entry, `Could not download ${entry.fileName} from the photo store.`, error);
  }
  if (context.exactSizes && entry.bytes !== null && body.byteLength !== entry.bytes) {
    throw photoFailure(
      entry,
      `${entry.fileName} is ${body.byteLength} bytes in the photo store but ${entry.bytes} in the database.`,
    );
  }
  return body;
}

function foreignPhoto(entry: ZipPlanEntry): AppError {
  return new AppError(
    "INTERNAL",
    "A photo in this part has an address outside the photo store, so the part was not exported.",
    { itemId: entry.itemId },
  );
}

type ZipInput = { name: string; input: Uint8Array; lastModified: Date };

/**
 * The manifest, then each photo fetched one at a time as the archive is read.
 * Any failure ends the archive with an error instead of skipping the photo, so
 * a part that downloads completely is always complete.
 */
async function* zipInputs(part: ZipPartPlan, context: ZipFetchContext, now: Date): AsyncGenerator<ZipInput> {
  yield { name: ZIP_MANIFEST_NAME, input: manifestBytes(part.manifest), lastModified: now };
  let current: ZipPlanEntry | undefined;
  try {
    for (const entry of part.entries) {
      current = entry;
      context.signal.throwIfAborted();
      const body = await fetchStoredPhoto(entry, context);
      yield {
        name: entry.fileName,
        input: body,
        lastModified: entry.lastModified === null ? now : new Date(entry.lastModified),
      };
    }
  } catch (error) {
    if (!context.signal.aborted) {
      console.error(
        `[export images] ${part.kind} part ${part.part} of ${part.parts} stopped at ${current?.fileName ?? "the start"}:`,
        error,
      );
    }
    throw error;
  }
}

/**
 * One ZIP part of one photo kind, streamed: the manifest first, then each
 * photo fetched sequentially from its stored blob URL. Checks the session
 * first, and every URL of the part before the first byte is sent.
 */
export async function createImageZip(
  deps: ImageZipDeps,
  request: { kind: ExportImageKind; part: number },
): Promise<ExportDownload> {
  await requireSession();
  const plan = planZipParts(await loadZipPlanItems(deps.db, [request.kind]), { kind: request.kind });
  const part = plan.parts[request.part - 1];
  if (part === undefined) {
    throw new AppError(
      "NOT_FOUND",
      plan.parts.length === 0
        ? "There are no photos of this kind to export."
        : `This export has ${plan.parts.length} part(s); reload the export page for the current list.`,
      { parts: plan.parts.length },
    );
  }
  const foreign = part.entries.find((entry) => !isStoredBlobUrl(entry.url));
  if (foreign !== undefined) throw foreignPhoto(foreign);

  const context: ZipFetchContext = {
    fetch: deps.fetch,
    signal: deps.signal,
    fileTimeoutMs: deps.fileTimeoutMs ?? ZIP_FILE_TIMEOUT_MS,
    exactSizes: part.predictedLength !== null,
  };
  return {
    body: makeZip(zipInputs(part, context, deps.now ?? new Date())),
    fileName: part.fileName,
    contentType: "application/zip",
    length: part.predictedLength,
  };
}
