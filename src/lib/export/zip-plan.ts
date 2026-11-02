// How the photo export is cut into ZIP parts and what each file is called.
// Pure, so the export page (which lists the parts) and the download route
// (which streams one) share one plan and can never disagree about which
// photos part N holds.

import { predictLength } from "client-zip";

import type { ImageKind, ItemCategory } from "@/lib/db/enums";
import { itemDisplayName } from "@/lib/items/wardrobe";

/** Kinds offered as ZIPs; thumbnails are small derived copies of `processed`. */
export const EXPORT_IMAGE_KINDS = ["processed", "original", "nobg"] as const satisfies readonly ImageKind[];
export type ExportImageKind = (typeof EXPORT_IMAGE_KINDS)[number];

/**
 * Photos per ZIP. Bounds one download's time within the route's 300 s limit
 * (originals are up to 10 MB each) and keeps a failed part cheap to retry.
 */
export const ZIP_PART_MAX_ITEMS = 100;

/** Written first in every part: which item each file belongs to. */
export const ZIP_MANIFEST_NAME = "manifest.json";

/** Longest slug of the display name inside a file name. */
export const ZIP_SLUG_MAX = 40;

const EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** The file extension for a stored content type; "bin" for anything unexpected. */
export function extensionFor(contentType: string): string {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSIONS[base] ?? "bin";
}

/**
 * ASCII-only, lowercase, hyphen-separated, at most `max` characters. Accents
 * are folded (é -> e) and everything else becomes a separator, so the name
 * extracts the same on Windows, macOS and Linux.
 */
export function slugify(text: string, max = ZIP_SLUG_MAX): string {
  const folded = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug === "" ? "item" : slug;
}

export type ZipNameSource = {
  id: string;
  name: string | null;
  subcategory: string | null;
  category: ItemCategory | null;
  /** The stored image's content type, for the extension. */
  contentType: string;
};

/**
 * '<category or untagged>/<slug of the display name>-<first 8 of the id>-<kind>.<ext>'.
 * The id prefix makes names of same-named items differ; planZipParts still
 * de-duplicates, for the rare items whose ids share those 8 characters.
 */
export function fileNameFor(item: ZipNameSource, kind: ExportImageKind): string {
  const folder = item.category ?? "untagged";
  const idPrefix = item.id.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${folder}/${slugify(itemDisplayName(item))}-${idPrefix}-${kind}.${extensionFor(item.contentType)}`;
}

/** `wardrobe-images-processed-part-2-of-3.zip`. */
export function zipFileName(kind: ExportImageKind, part: number, parts: number): string {
  return `wardrobe-images-${kind}-part-${part}-of-${parts}.zip`;
}

/** The download URL of one part. */
export function zipPartHref(kind: ExportImageKind, part: number): string {
  return `/api/export/images?${new URLSearchParams({ kind, part: String(part) }).toString()}`;
}

export type ZipImageSource = {
  /** The stored blob_url; the only address the server ever fetches. */
  url: string;
  contentType: string;
  /** Stored size; null when unknown, which drops the exact archive size. */
  bytes: number | null;
  /** ISO 8601; becomes the file's date in the archive. */
  createdAt: string | null;
};

export type ZipPlanItem = {
  id: string;
  name: string | null;
  subcategory: string | null;
  category: ItemCategory | null;
  /** The item's stored images; a kind it lacks is skipped for that kind's ZIPs. */
  images: Partial<Record<ExportImageKind, ZipImageSource>>;
};

export type ZipPlanEntry = {
  itemId: string;
  /** Unique (ignoring case) across every part of the kind. */
  fileName: string;
  url: string;
  contentType: string;
  bytes: number | null;
  lastModified: string | null;
};

export type ZipManifest = {
  version: 1;
  kind: ExportImageKind;
  part: number;
  parts: number;
  files: Array<{ itemId: string; fileName: string; sourceUrl: string; bytes: number | null; contentType: string }>;
};

export type ZipPartPlan = {
  kind: ExportImageKind;
  /** 1-based. */
  part: number;
  parts: number;
  fileName: string;
  /** In archive order, after the manifest. */
  entries: ZipPlanEntry[];
  /** The manifest.json text, built from the plan alone so its size is known in advance. */
  manifest: string;
  /** Sum of the known photo sizes. */
  knownBytes: number;
  /** The archive's exact byte length (client-zip predictLength); null when a size is unknown. */
  predictedLength: number | null;
};

export type ZipPlan = {
  kind: ExportImageKind;
  /** Items that have an image of this kind. */
  itemCount: number;
  parts: ZipPartPlan[];
};

export type PlanZipOptions = {
  kind: ExportImageKind;
  maxItems?: number;
};

function withSuffix(fileName: string, n: number): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? `${fileName}-${n}` : `${fileName.slice(0, dot)}-${n}${fileName.slice(dot)}`;
}

/** Case-insensitive, because Windows and macOS extract "A.jpg" and "a.jpg" onto the same file. */
function claimName(fileName: string, used: Set<string>): string {
  let candidate = fileName;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = withSuffix(fileName, n);
  used.add(candidate.toLowerCase());
  return candidate;
}

export function manifestText(manifest: ZipManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** UTF-8 byte length of the manifest, as client-zip will store it. */
export function manifestBytes(manifest: string): Uint8Array {
  return new TextEncoder().encode(manifest);
}

type SizedEntry = ZipPlanEntry & { bytes: number };

function allSized(entries: readonly ZipPlanEntry[]): entries is SizedEntry[] {
  return entries.every((entry) => entry.bytes !== null);
}

/**
 * The archive length client-zip will produce for these entries, in this order:
 * the manifest first, then the photos. Null when any photo's size is unknown,
 * because a wrong Content-Length breaks the download.
 */
export function predictPartLength(manifest: string, entries: readonly ZipPlanEntry[]): number | null {
  if (!allSized(entries)) return null;
  const length = predictLength([
    { name: ZIP_MANIFEST_NAME, size: manifestBytes(manifest).byteLength },
    ...entries.map((entry) => ({ name: entry.fileName, size: entry.bytes })),
  ]);
  return Number(length);
}

/**
 * Splits the items that have an image of `kind` into parts of at most
 * `maxItems`, keeping the input order (the service passes oldest first).
 */
export function planZipParts(items: readonly ZipPlanItem[], options: PlanZipOptions): ZipPlan {
  const maxItems = options.maxItems ?? ZIP_PART_MAX_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new RangeError("maxItems must be a positive integer");
  const { kind } = options;

  const used = new Set<string>([ZIP_MANIFEST_NAME]);
  const entries: ZipPlanEntry[] = [];
  for (const item of items) {
    const image = item.images[kind];
    if (image === undefined) continue;
    entries.push({
      itemId: item.id,
      fileName: claimName(fileNameFor({ ...item, contentType: image.contentType }, kind), used),
      url: image.url,
      contentType: image.contentType,
      bytes: image.bytes,
      lastModified: image.createdAt,
    });
  }

  const parts = Math.ceil(entries.length / maxItems);
  const plans: ZipPartPlan[] = [];
  for (let index = 0; index < parts; index += 1) {
    const partEntries = entries.slice(index * maxItems, (index + 1) * maxItems);
    const part = index + 1;
    const manifest = manifestText({
      version: 1,
      kind,
      part,
      parts,
      files: partEntries.map((entry) => ({
        itemId: entry.itemId,
        fileName: entry.fileName,
        sourceUrl: entry.url,
        bytes: entry.bytes,
        contentType: entry.contentType,
      })),
    });
    plans.push({
      kind,
      part,
      parts,
      fileName: zipFileName(kind, part, parts),
      entries: partEntries,
      manifest,
      knownBytes: partEntries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
      predictedLength: predictPartLength(manifest, partEntries),
    });
  }
  return { kind, itemCount: entries.length, parts: plans };
}
