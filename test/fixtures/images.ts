import sharp from "sharp";

// Test images generated with sharp at test time rather than committed
// binaries: each fixture states exactly what it contains.

export type Rgb = { r: number; g: number; b: number };

export const RED: Rgb = { r: 255, g: 0, b: 0 };
export const BLUE: Rgb = { r: 0, g: 0, b: 255 };

/** A single-colour JPEG; different colours give different processed hashes. */
export function solidJpeg(width: number, height: number, color: Rgb = { r: 40, g: 60, b: 90 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export function solidPng(width: number, height: number, color: Rgb = { r: 40, g: 60, b: 90 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

/**
 * A 400x200 landscape JPEG, red left half and blue right half, tagged with EXIF
 * orientation 6 ("rotate 90° clockwise to display"). Shown correctly it is a
 * 200x400 portrait with red on top and blue at the bottom.
 */
export async function orientation6Jpeg(): Promise<Buffer> {
  const blueHalf = await sharp({ create: { width: 200, height: 200, channels: 3, background: BLUE } })
    .png()
    .toBuffer();
  return sharp({ create: { width: 400, height: 200, channels: 3, background: RED } })
    .composite([{ input: blueHalf, left: 200, top: 0 }])
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

/** The RGB value of one pixel of an encoded image. */
export async function pixelAt(image: Buffer, x: number, y: number): Promise<Rgb> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { r: data[offset] ?? -1, g: data[offset + 1] ?? -1, b: data[offset + 2] ?? -1 };
}
