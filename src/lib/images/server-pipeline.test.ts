import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/result";

import { BLUE, orientation6Jpeg, pixelAt, RED, solidJpeg, solidPng } from "../../../test/fixtures/images";
import { encodeWebp, processImage } from "./server-pipeline";

function expectColorNear(actual: { r: number; g: number; b: number }, expected: { r: number; g: number; b: number }) {
  // Lossy WebP shifts colours slightly; a few levels either way is still the same colour.
  expect(Math.abs(actual.r - expected.r)).toBeLessThan(24);
  expect(Math.abs(actual.g - expected.g)).toBeLessThan(24);
  expect(Math.abs(actual.b - expected.b)).toBeLessThan(24);
}

async function expectValidation(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe("VALIDATION");
  return error as AppError;
}

describe("processImage", () => {
  it("makes a 1024 px processed WebP and a 400 px thumbnail from a 3000x4000 photo", async () => {
    const result = await processImage(await solidJpeg(3000, 4000));

    expect(result.processed).toMatchObject({ width: 768, height: 1024, contentType: "image/webp" });
    expect(result.thumb).toMatchObject({ width: 300, height: 400, contentType: "image/webp" });
    expect(result.source).toEqual({ width: 3000, height: 4000, format: "jpeg" });

    for (const encoded of [result.processed, result.thumb]) {
      const metadata = await sharp(encoded.buffer).metadata();
      expect(metadata.format).toBe("webp");
      expect({ width: metadata.width, height: metadata.height }).toEqual({
        width: encoded.width,
        height: encoded.height,
      });
      expect(encoded.bytes).toBe(encoded.buffer.length);
    }
  });

  it("hashes the processed bytes with sha256", async () => {
    const result = await processImage(await solidJpeg(1200, 900));
    expect(result.imageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.imageHash).toBe(createHash("sha256").update(result.processed.buffer).digest("hex"));
  });

  it("gives the same hash for the same input and a different one for a different photo", async () => {
    const input = await solidJpeg(1600, 1200);
    const [first, second, other] = await Promise.all([
      processImage(input),
      processImage(Buffer.from(input)),
      processImage(await solidJpeg(1600, 1200, { r: 200, g: 180, b: 20 })),
    ]);
    expect(second.imageHash).toBe(first.imageHash);
    expect(other.imageHash).not.toBe(first.imageHash);
  });

  it("applies EXIF orientation 6 before resizing", async () => {
    const result = await processImage(await orientation6Jpeg());

    // Stored 400x200 landscape, displayed as a 200x400 portrait.
    expect(result.source).toEqual({ width: 200, height: 400, format: "jpeg" });
    expect(result.processed).toMatchObject({ width: 200, height: 400 });
    expect(result.thumb).toMatchObject({ width: 200, height: 400 });
    // The left (red) half of the stored pixels ends up on top.
    expectColorNear(await pixelAt(result.processed.buffer, 100, 40), RED);
    expectColorNear(await pixelAt(result.processed.buffer, 100, 360), BLUE);
  });

  it("strips metadata from both outputs", async () => {
    const result = await processImage(await orientation6Jpeg());
    for (const encoded of [result.processed, result.thumb]) {
      const metadata = await sharp(encoded.buffer).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
    }
  });

  it("never upscales a small photo", async () => {
    const result = await processImage(await solidPng(320, 240));
    expect(result.processed).toMatchObject({ width: 320, height: 240 });
    expect(result.thumb).toMatchObject({ width: 320, height: 240 });
    expect(result.source.format).toBe("png");
  });

  it("rejects bytes that are not an image with VALIDATION", async () => {
    await expectValidation(processImage(Buffer.from("definitely not a photo")));
    await expectValidation(processImage(Buffer.alloc(0)));
  });

  it("rejects a truncated JPEG with VALIDATION", async () => {
    const jpeg = await solidJpeg(800, 600);
    await expectValidation(processImage(jpeg.subarray(0, Math.floor(jpeg.length / 2))));
  });

  it("rejects formats other than JPEG, PNG and WebP", async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: RED } })
      .gif()
      .toBuffer();
    await expectValidation(processImage(gif));
  });

  it("refuses images above the pixel limit before decoding them", async () => {
    const error = await expectValidation(processImage(await solidJpeg(3000, 4000), { maxInputPixels: 1_000_000 }));
    expect(error.details).toEqual({ reason: "too_many_pixels" });
  });
});

describe("encodeWebp", () => {
  it("keeps transparency, as the nobg images need", async () => {
    const png = await sharp({
      create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const encoded = await encodeWebp(png, { longEdge: 1024, quality: 80 });
    const metadata = await sharp(encoded.buffer).metadata();
    expect(metadata.hasAlpha).toBe(true);
    expect(encoded).toMatchObject({ width: 50, height: 50 });
  });
});
