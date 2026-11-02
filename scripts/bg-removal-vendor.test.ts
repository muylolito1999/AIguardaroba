import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { modifyRouteRegex } from "next/dist/lib/redirect-status"
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match"
import { describe, expect, it } from "vitest"

import { BG_DOWNLOAD_BYTES } from "@/lib/images/bg-removal"
import { BG_REMOVAL_ASSET_PATH, BG_REMOVAL_FILE_BYTES } from "@/lib/images/bg-removal-assets"

import nextConfig from "../next.config"

import { buildResourceMap, MODEL_CDN_BASE, ORT_FILES, PINNED_VERSIONS } from "./bg-removal-vendor"

const PUBLIC_PATH = new URL(BG_REMOVAL_ASSET_PATH, "https://wardrobe.example").href
const IMMUTABLE = "public, max-age=31536000, immutable"

/** How the library turns a chunk name into a URL (resource.ts in @imgly/background-removal 1.7.0). */
function chunkUrl(name: string): URL {
  return new URL(name, PUBLIC_PATH)
}

async function headerRules() {
  const rules = (await nextConfig.headers?.()) ?? []
  for (const rule of rules) {
    // pathMatcher below only reads `source`.
    if (rule.has !== undefined || rule.missing !== undefined) throw new Error(`${rule.source} uses has/missing`)
  }
  return rules
}

/** The matcher Next builds for a header rule (server/lib/router-utils/filesystem.js, buildCustomRoute). */
function pathMatcher(source: string) {
  return getPathMatch(source, {
    strict: true,
    removeUnnamedParams: true,
    regexModifier: (regex) => modifyRouteRegex(regex),
  })
}

/** The Cache-Control next.config.ts gives a path: the last matching rule that sets it wins. */
async function cacheControlFor(pathname: string): Promise<string | undefined> {
  let value: string | undefined
  for (const rule of await headerRules()) {
    if (pathMatcher(rule.source)(pathname) === false) continue
    for (const header of rule.headers) {
      if (header.key.toLowerCase() === "cache-control") value = header.value
    }
  }
  return value
}

describe("the served resources.json", () => {
  const map = buildResourceMap()

  it("lists only the CPU path's model, wasm and loader", () => {
    expect(Object.keys(map).sort()).toEqual([
      "/models/isnet_quint8",
      "/onnxruntime-web/ort-wasm-simd-threaded.mjs",
      "/onnxruntime-web/ort-wasm-simd-threaded.wasm",
    ])
  })

  it("serves both onnxruntime files from the app's own origin", () => {
    for (const file of ORT_FILES) {
      const entry = map[file.key]
      expect(entry?.chunks.map((chunk) => chunkUrl(chunk.name).href)).toEqual([`${PUBLIC_PATH}${file.file}`])
      expect(entry?.size).toBe(file.size)
      expect(entry?.chunks[0]?.offsets).toEqual([0, file.size])
    }
  })

  it("fetches the model, which is data only, from IMG.LY's CDN in contiguous chunks", () => {
    const model = map["/models/isnet_quint8"]
    if (model === undefined) throw new Error("no model entry")
    let next = 0
    for (const chunk of model.chunks) {
      expect(chunkUrl(chunk.name).href).toBe(`${MODEL_CDN_BASE}${chunk.hash}`)
      expect(chunk.offsets[0]).toBe(next)
      next = chunk.offsets[1]
    }
    expect(next).toBe(model.size)
    expect(model.size).toBe(BG_REMOVAL_FILE_BYTES.model)
  })

  it("matches the download size the confirmation dialog states", () => {
    const total = Object.values(map).reduce((sum, entry) => sum + entry.size, 0)
    expect(BG_DOWNLOAD_BYTES).toBe(total)
  })
})

describe("the pinned versions", () => {
  it("name the asset path, so an upgrade moves the served files to a new URL", () => {
    expect(BG_REMOVAL_ASSET_PATH).toBe(
      `/vendor/bg-removal/imgly-${PINNED_VERSIONS["@imgly/background-removal"]}-ort-${PINNED_VERSIONS["onnxruntime-web"]}/`,
    )
  })

  it("pick the model's data package, as the library's own default does", () => {
    expect(MODEL_CDN_BASE).toContain(`/background-removal-data/${PINNED_VERSIONS["@imgly/background-removal"]}/`)
  })
})

describe("the cache headers in next.config.ts", () => {
  it("revalidate resources.json on every load, since it can change under the same path", async () => {
    expect(await cacheControlFor(`${BG_REMOVAL_ASSET_PATH}resources.json`)).toBe("no-cache")
  })

  it("cache only the two hash-pinned onnxruntime files as immutable", async () => {
    const pinned = ORT_FILES.map((file) => file.file)
    const candidates = [...pinned, "resources.json", "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.jsep.mjs", "other.js"]
    const immutable: string[] = []
    for (const name of candidates) {
      if ((await cacheControlFor(`${BG_REMOVAL_ASSET_PATH}${name}`)) === IMMUTABLE) immutable.push(name)
    }
    expect(immutable.sort()).toEqual([...pinned].sort())
  })

  it("set no Cache-Control anywhere else in the folder", async () => {
    for (const pathname of [
      "/vendor/bg-removal/",
      "/vendor/bg-removal/ort-wasm-simd-threaded.wasm",
      BG_REMOVAL_ASSET_PATH,
      `${BG_REMOVAL_ASSET_PATH}other.js`,
      `${BG_REMOVAL_ASSET_PATH}nested/ort-wasm-simd-threaded.wasm`,
      `${BG_REMOVAL_ASSET_PATH}nested/resources.json`,
    ]) {
      expect(await cacheControlFor(pathname), pathname).toBeUndefined()
    }
  })

  it("have no rule that covers the whole folder", async () => {
    for (const rule of await headerRules()) {
      const match = pathMatcher(rule.source)
      if (match(`${BG_REMOVAL_ASSET_PATH}any-other-file`) === false) continue
      // Only site-wide rules reach the folder's other files, and none of them sets Cache-Control.
      expect(match("/wardrobe"), rule.source).not.toBe(false)
      expect(
        rule.headers.map((header) => header.key.toLowerCase()),
        rule.source,
      ).not.toContain("cache-control")
    }
  })
})

describe("the installed packages", () => {
  const nodeModules = path.join(process.cwd(), "node_modules")

  it("are the pinned versions", async () => {
    for (const [name, version] of Object.entries(PINNED_VERSIONS)) {
      const manifest = JSON.parse(await readFile(path.join(nodeModules, name, "package.json"), "utf8")) as {
        version: string
      }
      expect(manifest.version, name).toBe(version)
    }
  })

  it("hold onnxruntime files with exactly the pinned hashes and sizes", async () => {
    for (const file of ORT_FILES) {
      const bytes = await readFile(path.join(nodeModules, "onnxruntime-web", "dist", file.file))
      expect(bytes.byteLength, file.file).toBe(file.size)
      expect(createHash("sha256").update(bytes).digest("hex"), file.file).toBe(file.sha256)
    }
  })
})
