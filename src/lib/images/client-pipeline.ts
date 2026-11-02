// Browser half of the image pipeline (D-032). Client components import this;
// server code never does. Module scope touches no browser API, so a client
// component that imports it still renders on the server.
//
// One path for every browser: decode with createImageBitmap (EXIF orientation
// applied, resized at decode time), draw onto an HTMLCanvasElement, encode JPEG.
// HEIC, which only Safari decodes natively, is converted to JPEG first by a
// lazily loaded heic-to (LGPL-3.0, kept in its own chunk).

import { UPLOAD_LIMITS } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";

export const CLIENT_MAX_LONG_EDGE = 2048;
export const CLIENT_JPEG_QUALITY = 0.85;
// Only an intermediate step before the final encode, so it stays high to limit
// generation loss.
const HEIC_INTERMEDIATE_QUALITY = 0.92;

/** ISO-BMFF brands of HEIF/HEIC stills and sequences. */
export const HEIC_BRANDS = ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"] as const;
// AVIF is HEIF with AV1 inside and lists mif1 too, but every current browser
// decodes it natively, so it must not be routed through the HEIC converter.
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRAND_SET = new Set<string>(HEIC_BRANDS);

/** Enough bytes for any real ftyp box: header, major brand, version and a dozen compatible brands. */
export const SNIFF_BYTES = 256;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "gif", "bmp"]);

export const INSECURE_CONTEXT_MESSAGE = "Open the app over HTTPS to add photos.";

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCodePoint(...bytes.subarray(start, end));
}

/**
 * True when the bytes start with an ISO-BMFF `ftyp` box whose major or
 * compatible brands mark a HEIF/HEIC image. Sniffing is needed because
 * `file.type` is often empty for .heic files on Windows and in Chrome.
 */
export function sniffHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  // Sizes 0 (to end of file) and 1 (64-bit size) never occur for ftyp in
  // practice; only the major brand is trusted then.
  const end = boxSize >= 16 ? Math.min(boxSize, bytes.length) : 12;
  const brands = [ascii(bytes, 8, 12)];
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii(bytes, offset, offset + 4));
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return false;
  return brands.some((brand) => HEIC_BRAND_SET.has(brand));
}

/** Reads the first bytes of a file and sniffs them; for filtering before the full pipeline runs. */
export async function needsHeicDecode(file: Blob): Promise<boolean> {
  return sniffHeic(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
}

/**
 * A cheap filter for folder imports, which also contain sidecar and system
 * files: an image MIME type or a known image extension. HEIC files often have
 * an empty type, hence the extension check; the pipeline still verifies the bytes.
 */
export function isLikelyImageFile(file: { name: string; type: string }): boolean {
  if (file.type.startsWith("image/")) return true;
  const dot = file.name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase());
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * The size to decode at: the long edge at most `maxEdge`, aspect ratio kept
 * (rounded, never below 1 px), and never larger than the input.
 */
export function computeTargetSize(
  width: number,
  height: number,
  maxEdge: number = CLIENT_MAX_LONG_EDGE,
): { width: number; height: number } {
  if (!isPositiveInteger(width) || !isPositiveInteger(height) || !isPositiveInteger(maxEdge)) {
    throw new RangeError("computeTargetSize needs positive integer dimensions.");
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longEdge;
  return width >= height
    ? { width: maxEdge, height: Math.max(1, Math.round(height * scale)) }
    : { width: Math.max(1, Math.round(width * scale)), height: maxEdge };
}

/**
 * sha256 hex digest via Web Crypto. crypto.subtle exists only in secure
 * contexts (HTTPS or localhost), so a phone on http://192.168.x.x gets a clear
 * error instead of a weaker hash.
 */
export async function sha256Hex(data: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<string> {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new AppError("VALIDATION", INSECURE_CONTEXT_MESSAGE, { reason: "insecure_context" });
  }
  const digest = await subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** sha256 of the file exactly as picked; the pre-upload dedupe key (items.source_hash). */
export async function computeSourceHash(file: Blob): Promise<string> {
  return sha256Hex(await file.arrayBuffer());
}

async function loadHeicConverter() {
  try {
    // About 3 MB of WASM-backed code, so it is fetched only when a HEIC shows up.
    return (await import("heic-to")).heicTo;
  } catch (error) {
    throw new AppError(
      "UPSTREAM",
      "The HEIC converter could not be loaded. Check your connection and try again.",
      { reason: "heic_converter_unavailable" },
      { cause: error },
    );
  }
}

async function heicToJpeg(file: Blob): Promise<Blob> {
  const heicTo = await loadHeicConverter();
  try {
    return await heicTo({ blob: file, type: "image/jpeg", quality: HEIC_INTERMEDIATE_QUALITY });
  } catch (error) {
    throw new AppError(
      "VALIDATION",
      "This HEIC photo could not be converted.",
      { reason: "heic_decode_failed" },
      { cause: error },
    );
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new AppError("VALIDATION", "This browser could not encode the photo.", { reason: "encode_failed" }));
        } else {
          resolve(blob);
        }
      },
      "image/jpeg",
      CLIENT_JPEG_QUALITY,
    );
  });
}

async function decodeResizeEncode(source: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  let probe: ImageBitmap;
  try {
    // Only the oriented natural size is needed here. Nothing is drawn at full
    // size, which iOS would refuse above its canvas area limit.
    probe = await createImageBitmap(source, { imageOrientation: "from-image" });
  } catch (error) {
    throw new AppError(
      "VALIDATION",
      "This file is not a photo this browser can read.",
      { reason: "undecodable" },
      { cause: error },
    );
  }
  const target = computeTargetSize(probe.width, probe.height);
  probe.close();

  const bitmap = await createImageBitmap(source, {
    imageOrientation: "from-image",
    resizeWidth: target.width,
    resizeHeight: target.height,
    resizeQuality: "high",
  });
  const canvas = document.createElement("canvas");
  try {
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new AppError("VALIDATION", "This browser cannot prepare photos.", { reason: "no_canvas" });
    }
    // JPEG has no alpha: transparent pixels would otherwise encode as black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(bitmap, 0, 0);
    const blob = await canvasToJpeg(canvas);
    // Safari encodes some types as PNG without saying so; check what came back.
    if (blob.type !== "image/jpeg") {
      throw new AppError("VALIDATION", "This browser could not encode the photo as JPEG.", { reason: "encode_type" });
    }
    return { blob, width: target.width, height: target.height };
  } finally {
    bitmap.close();
    // Releases the backing store now; iOS caps the total canvas memory per page.
    canvas.width = 0;
    canvas.height = 0;
  }
}

export type PreparedImage = {
  /** image/jpeg, long edge at most 2048 px, no EXIF. */
  blob: Blob;
  width: number;
  height: number;
  /** sha256 hex of the original file bytes (before any conversion). */
  sourceHash: string;
  /** The picked file's name, cut to the register route's 255-character limit. */
  originalFilename: string;
};

/**
 * Turns a picked file into the JPEG to upload: HEIC converted first, EXIF
 * orientation applied, long edge at most 2048 px, JPEG q0.85, metadata (EXIF,
 * GPS) dropped by the canvas re-encode. Throws AppError with a user-facing
 * message and `details.reason`.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // First, so an insecure context fails before any decoding work.
  const sourceHash = await sha256Hex(bytes);
  const decodable = sniffHeic(bytes.subarray(0, SNIFF_BYTES)) ? await heicToJpeg(file) : file;
  const { blob, width, height } = await decodeResizeEncode(decodable);
  if (blob.size > UPLOAD_LIMITS.originalMaxBytes) {
    throw new AppError("VALIDATION", "This photo is too large to upload.", { reason: "too_large" });
  }
  return { blob, width, height, sourceHash, originalFilename: file.name.slice(0, 255) };
}
