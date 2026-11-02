import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/result";

import {
  computeSourceHash,
  computeTargetSize,
  INSECURE_CONTEXT_MESSAGE,
  isLikelyImageFile,
  needsHeicDecode,
  sha256Hex,
  sniffHeic,
} from "./client-pipeline";

// The browser-only parts (createImageBitmap, canvas, heic-to) are checked in a
// visible browser; these are the pure helpers they rely on.

/** An ISO-BMFF ftyp box: size, "ftyp", major brand, minor version 0, compatible brands. */
function ftyp(major: string, compatible: string[] = [], declaredSize?: number): Uint8Array<ArrayBuffer> {
  const size = 16 + 4 * compatible.length;
  const bytes = new Uint8Array(size + 8);
  new DataView(bytes.buffer).setUint32(0, declaredSize ?? size);
  const write = (text: string, offset: number) => bytes.set(new TextEncoder().encode(text), offset);
  write("ftyp", 4);
  write(major, 8);
  compatible.forEach((brand, index) => write(brand, 16 + 4 * index));
  // The next box header, to make sure the scan stops at the ftyp box size.
  write("meta", size + 4);
  return bytes;
}

const JPEG_START = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sniffHeic", () => {
  it.each(["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"])("detects the %s major brand", (brand) => {
    expect(sniffHeic(ftyp(brand))).toBe(true);
  });

  it("detects HEIC listed only as a compatible brand", () => {
    expect(sniffHeic(ftyp("isom", ["mp41", "heic"]))).toBe(true);
    // An iPhone photo: major heic, compatible mif1 and heic.
    expect(sniffHeic(ftyp("heic", ["mif1", "heic"]))).toBe(true);
  });

  it("rejects JPEG, PNG and short input", () => {
    expect(sniffHeic(JPEG_START)).toBe(false);
    expect(sniffHeic(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))).toBe(false);
    expect(sniffHeic(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79]))).toBe(false);
    expect(sniffHeic(new Uint8Array())).toBe(false);
  });

  it("rejects other ISO-BMFF files such as MP4 video", () => {
    expect(sniffHeic(ftyp("isom", ["iso2", "avc1", "mp41"]))).toBe(false);
  });

  it("leaves AVIF to the browser even though it lists mif1", () => {
    expect(sniffHeic(ftyp("avif", ["mif1", "miaf"]))).toBe(false);
    expect(sniffHeic(ftyp("mif1", ["avif", "miaf"]))).toBe(false);
  });

  it("does not read brands past the ftyp box", () => {
    const bytes = ftyp("isom", ["mp41"]);
    // "heic" right after the box must not count.
    const extended = new Uint8Array(bytes.length + 4);
    extended.set(bytes);
    extended.set(new TextEncoder().encode("heic"), 20);
    expect(sniffHeic(extended)).toBe(false);
  });

  it("trusts only the major brand when the box size is not a plain 32-bit size", () => {
    expect(sniffHeic(ftyp("isom", ["heic"], 0))).toBe(false);
    expect(sniffHeic(ftyp("heic", [], 1))).toBe(true);
  });
});

describe("needsHeicDecode", () => {
  it("sniffs the first bytes of a Blob", async () => {
    expect(await needsHeicDecode(new Blob([ftyp("heic", ["mif1"])]))).toBe(true);
    expect(await needsHeicDecode(new Blob([JPEG_START]))).toBe(false);
  });
});

describe("computeTargetSize", () => {
  it("scales the long edge down to the maximum and keeps the aspect ratio", () => {
    expect(computeTargetSize(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(computeTargetSize(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(computeTargetSize(8064, 6048, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(computeTargetSize(4000, 4000)).toEqual({ width: 2048, height: 2048 });
  });

  it("rounds the short edge and never returns zero", () => {
    expect(computeTargetSize(3000, 2001, 1000)).toEqual({ width: 1000, height: 667 });
    expect(computeTargetSize(10_000, 3, 100)).toEqual({ width: 100, height: 1 });
  });

  it("never upscales", () => {
    expect(computeTargetSize(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(computeTargetSize(2048, 1000)).toEqual({ width: 2048, height: 1000 });
    expect(computeTargetSize(1, 1)).toEqual({ width: 1, height: 1 });
  });

  it("rejects non-positive or fractional sizes", () => {
    expect(() => computeTargetSize(0, 100)).toThrow(RangeError);
    expect(() => computeTargetSize(100, -1)).toThrow(RangeError);
    expect(() => computeTargetSize(10.5, 100)).toThrow(RangeError);
    expect(() => computeTargetSize(100, 100, 0)).toThrow(RangeError);
  });
});

describe("hashing", () => {
  it("returns the lowercase sha256 hex of the bytes", async () => {
    const bytes = new TextEncoder().encode("a photo's bytes");
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(await sha256Hex(bytes)).toBe(expected);
    expect(await computeSourceHash(new Blob([bytes]))).toBe(expected);
  });

  it("refuses to hash without Web Crypto (an insecure context) and says to use HTTPS", async () => {
    vi.stubGlobal("crypto", {});
    const error = await computeSourceHash(new Blob(["x"])).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "VALIDATION",
      message: INSECURE_CONTEXT_MESSAGE,
      details: { reason: "insecure_context" },
    });
  });
});

describe("isLikelyImageFile", () => {
  it("accepts image MIME types and known image extensions", () => {
    expect(isLikelyImageFile({ name: "a.jpg", type: "image/jpeg" })).toBe(true);
    expect(isLikelyImageFile({ name: "IMG_0001.HEIC", type: "" })).toBe(true);
    expect(isLikelyImageFile({ name: "scan", type: "image/png" })).toBe(true);
  });

  it("skips sidecar and system files", () => {
    expect(isLikelyImageFile({ name: "IMG_0001.AAE", type: "" })).toBe(false);
    expect(isLikelyImageFile({ name: ".DS_Store", type: "" })).toBe(false);
    expect(isLikelyImageFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
    expect(isLikelyImageFile({ name: ".heic", type: "" })).toBe(false);
  });
});
