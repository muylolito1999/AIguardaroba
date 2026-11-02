import { describe, expect, it } from "vitest"

import { formatBytes, formatPartSize, formatPhotoCount } from "./format"

describe("formatBytes", () => {
  it("uses decimal units with one decimal above bytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(850)).toBe("850 B")
    expect(formatBytes(1_000)).toBe("1 KB")
    expect(formatBytes(12_345)).toBe("12.3 KB")
    expect(formatBytes(41_234_567)).toBe("41.2 MB")
    expect(formatBytes(1_250_000_000)).toBe("1.3 GB")
    expect(formatBytes(-5)).toBe("0 B")
  })
})

describe("formatPartSize", () => {
  it("marks estimates", () => {
    expect(formatPartSize(41_234_567, true)).toBe("41.2 MB")
    expect(formatPartSize(41_234_567, false)).toBe("about 41.2 MB")
  })
})

describe("formatPhotoCount", () => {
  it("pluralises", () => {
    expect(formatPhotoCount(1)).toBe("1 photo")
    expect(formatPhotoCount(0)).toBe("0 photos")
    expect(formatPhotoCount(1200)).toBe("1,200 photos")
  })
})
