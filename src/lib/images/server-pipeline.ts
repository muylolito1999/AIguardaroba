import "server-only";

import { createHash } from "node:crypto";

import sharp, { type Metadata } from "sharp";

import { AppError } from "@/lib/result";

// Server half of the image pipeline (D-033): the uploaded original becomes a
// 1024 px WebP for display and tagging plus a 400 px thumbnail. The processed
// bytes are hashed, and that hash is the dedupe and tagging-cache key.

export const PROCESSED_LONG_EDGE = 1024;
export const PROCESSED_WEBP_QUALITY = 80;
export const THUMB_LONG_EDGE = 400;
export const THUMB_WEBP_QUALITY = 75;

/**
 * Decompression-bomb guard. The browser sends at most 2048 px on the long edge,
 * and 50 MP still covers a 48 MP camera photo whose client skipped the resize,
 * while a crafted 10 MiB file declaring huge dimensions is refused before
 * libvips allocates memory for it.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

const ACCEPTED_FORMATS = ["jpeg", "png", "webp"] as const;
type AcceptedFormat = (typeof ACCEPTED_FORMATS)[number];

function isAcceptedFormat(format: string): format is AcceptedFormat {
  return (ACCEPTED_FORMATS as readonly string[]).includes(format);
}

export type EncodedImage = {
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
  contentType: "image/webp";
};

export type ProcessImageResult = {
  processed: EncodedImage;
  thumb: EncodedImage;
  /** sha256 hex of the processed WebP bytes. */
  imageHash: string;
  /** The input as displayed (EXIF orientation applied), for the original's image row. */
  source: { width: number; height: number; format: AcceptedFormat };
};

export type ProcessImageOptions = { maxInputPixels?: number };

function unreadable(cause: unknown): AppError {
  return new AppError("VALIDATION", "This file is not a photo we can read. Use a JPEG, PNG or WebP image.", undefined, {
    cause,
  });
}

/**
 * Re-encodes an image as WebP with its long edge at most `longEdge` (never
 * upscaled). `rotate()` applies the EXIF orientation first, because sharp
 * drops all metadata (EXIF, GPS, ICC) on output and the photo would otherwise
 * come out sideways.
 */
export async function encodeWebp(
  input: Buffer,
  { longEdge, quality, maxInputPixels = MAX_INPUT_PIXELS }: { longEdge: number; quality: number; maxInputPixels?: number },
): Promise<EncodedImage> {
  const { data, info } = await sharp(input, { limitInputPixels: maxInputPixels, failOn: "warning" })
    .rotate()
    .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height, bytes: data.length, contentType: "image/webp" };
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Validates and processes an uploaded original. Throws VALIDATION for
 * anything sharp cannot decode, for formats other than JPEG, PNG and WebP, and
 * for images above the pixel limit.
 */
export async function processImage(input: Buffer, options: ProcessImageOptions = {}): Promise<ProcessImageResult> {
  const maxInputPixels = options.maxInputPixels ?? MAX_INPUT_PIXELS;

  let metadata: Metadata;
  try {
    // Reads the header only, so a format or size problem is caught before any
    // pixel is decoded. The limit is checked below rather than here, so an
    // oversized photo gets its own message; the encoders still enforce it.
    metadata = await sharp(input, { limitInputPixels: false }).metadata();
  } catch (error) {
    throw unreadable(error);
  }
  if (!isAcceptedFormat(metadata.format)) throw unreadable(new Error(`Unsupported format: ${metadata.format}`));

  const { width, height } = metadata.autoOrient;
  if (width * height > maxInputPixels) {
    throw new AppError("VALIDATION", "This photo has too many pixels. Resize it and try again.", {
      reason: "too_many_pixels",
    });
  }

  let processed: EncodedImage;
  let thumb: EncodedImage;
  try {
    [processed, thumb] = await Promise.all([
      encodeWebp(input, { longEdge: PROCESSED_LONG_EDGE, quality: PROCESSED_WEBP_QUALITY, maxInputPixels }),
      encodeWebp(input, { longEdge: THUMB_LONG_EDGE, quality: THUMB_WEBP_QUALITY, maxInputPixels }),
    ]);
  } catch (error) {
    // A valid header over truncated or corrupt pixel data fails here.
    throw unreadable(error);
  }

  return {
    processed,
    thumb,
    imageHash: sha256Hex(processed.buffer),
    source: { width, height, format: metadata.format },
  };
}
