// @vitest-environment node
import { existsSync } from "node:fs"
import path from "node:path"

import sharp from "sharp"
import { describe, expect, it } from "vitest"

import manifest from "./manifest"

const publicFile = (src: string) => path.join(process.cwd(), "public", src)

describe("web app manifest", () => {
  const m = manifest()
  const icons = [...(m.icons ?? []), ...(m.shortcuts ?? []).flatMap((s) => s.icons ?? [])]

  it("launches standalone on the wardrobe", () => {
    expect(m.id).toBe("/")
    expect(m.start_url).toBe("/wardrobe")
    expect(m.scope).toBe("/")
    expect(m.display).toBe("standalone")
  })

  it("only references icons that exist under public/", () => {
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(existsSync(publicFile(icon.src)), icon.src).toBe(true)
    }
  })

  it("declares sizes that match the generated PNGs", async () => {
    for (const icon of icons) {
      const { width, height } = await sharp(publicFile(icon.src)).metadata()
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes)
    }
  })

  it("includes an opaque 512px maskable icon", async () => {
    const maskable = m.icons?.find((i) => i.purpose === "maskable" && i.sizes === "512x512")
    expect(maskable).toBeDefined()
    if (!maskable) return
    // A transparent maskable icon shows the launcher's backdrop through the mask.
    const { hasAlpha } = await sharp(publicFile(maskable.src)).metadata()
    expect(hasAlpha).toBe(false)
  })

  it("offers an Add shortcut", () => {
    expect(m.shortcuts).toEqual([expect.objectContaining({ short_name: "Add", url: "/add" })])
  })
})

describe("apple touch icon", () => {
  it("is an opaque 180px PNG", async () => {
    const file = path.join(process.cwd(), "src", "app", "apple-icon.png")
    const { width, height, hasAlpha } = await sharp(file).metadata()
    expect({ width, height, hasAlpha }).toEqual({ width: 180, height: 180, hasAlpha: false })
  })
})
