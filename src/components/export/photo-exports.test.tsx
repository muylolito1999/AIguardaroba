// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { ImageExportKindSummary } from "@/server/services/export"

import { PhotoExports } from "./photo-exports"

afterEach(cleanup)

const SUMMARIES: ImageExportKindSummary[] = [
  {
    kind: "processed",
    photoCount: 150,
    parts: [
      {
        part: 1,
        parts: 2,
        photoCount: 100,
        estimatedBytes: 41_234_567,
        exact: true,
        fileName: "wardrobe-images-processed-part-1-of-2.zip",
        href: "/api/export/images?kind=processed&part=1",
      },
      {
        part: 2,
        parts: 2,
        photoCount: 50,
        estimatedBytes: 20_000_000,
        exact: false,
        fileName: "wardrobe-images-processed-part-2-of-2.zip",
        href: "/api/export/images?kind=processed&part=2",
      },
    ],
  },
  { kind: "original", photoCount: 0, parts: [] },
  { kind: "nobg", photoCount: 0, parts: [] },
]

describe("PhotoExports", () => {
  it("lists each part with its size and a link named after the kind and part", () => {
    render(<PhotoExports summaries={SUMMARIES} />)
    const processed = screen.getByRole("region", { name: "Processed photos" })

    expect(within(processed).getByText("150 photos in 2 parts")).toBeTruthy()
    expect(within(processed).getByText("100 photos · 41.2 MB")).toBeTruthy()
    expect(within(processed).getByText("50 photos · about 20 MB")).toBeTruthy()
    const links = within(processed).getAllByRole("link")
    expect(links.map((link) => link.textContent)).toEqual([
      "Download processed photos, part 1 of 2",
      "Download processed photos, part 2 of 2",
    ])
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/api/export/images?kind=processed&part=1",
      "/api/export/images?kind=processed&part=2",
    ])
  })

  it("says so when a kind has no photos", () => {
    render(<PhotoExports summaries={SUMMARIES} />)
    expect(within(screen.getByRole("region", { name: "Original uploads" })).getByText("No original uploads yet.")).toBeTruthy()
    expect(within(screen.getByRole("region", { name: "Cut-outs" })).queryAllByRole("link")).toEqual([])
  })
})
