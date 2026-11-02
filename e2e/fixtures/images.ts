import { createHash } from "node:crypto"

import sharp from "sharp"

// Tiny JPEG photos generated at run time, so no binary fixtures live in the
// repository. Each colour gives different bytes, so each file has its own
// source hash.

export type PhotoFixture = {
  name: string
  mimeType: "image/jpeg"
  buffer: Buffer
  /** sha256 of the bytes: what the browser sends as the source hash. */
  sourceHash: string
}

export async function makeJpegFixture(
  name: string,
  background: { r: number; g: number; b: number },
): Promise<PhotoFixture> {
  const buffer = await sharp({ create: { width: 64, height: 48, channels: 3, background } })
    .jpeg({ quality: 80 })
    .toBuffer()
  return { name, mimeType: "image/jpeg", buffer, sourceHash: createHash("sha256").update(buffer).digest("hex") }
}
