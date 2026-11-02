// The resources.json that @imgly/background-removal reads from its publicPath
// (D-081), and the pinned onnxruntime files behind it. Pure, so the test can
// check the manifest without writing anything.

import { BG_REMOVAL_FILE_BYTES, PINNED_VERSIONS } from "@/lib/images/bg-removal-assets"

/** The versions this manifest was written for; the build step refuses any other. */
export { PINNED_VERSIONS } from "@/lib/images/bg-removal-assets"

/**
 * The onnxruntime files the CPU path loads, with the sha256 of the 1.21.0
 * release. The .mjs runs as script in the app's origin, so a copy that does
 * not match fails the build instead of being served. next.config.ts caches
 * exactly these two file names as immutable; a file added here needs its own
 * rule there (the test checks both lists agree).
 */
export const ORT_FILES = [
  {
    key: "/onnxruntime-web/ort-wasm-simd-threaded.wasm",
    file: "ort-wasm-simd-threaded.wasm",
    mime: "application/wasm",
    size: BG_REMOVAL_FILE_BYTES.wasm,
    sha256: "06b3f98e5aa2fffec1e3ac57a48bf1073828c6624e14d210750bc596c2e35d65",
  },
  {
    key: "/onnxruntime-web/ort-wasm-simd-threaded.mjs",
    file: "ort-wasm-simd-threaded.mjs",
    mime: "text/javascript",
    size: BG_REMOVAL_FILE_BYTES.mjs,
    sha256: "e9ba2350c370278fc90108f1514fb9ce6a4051341ab977b5b0dca7eca9e78dfa",
  },
] as const

/**
 * IMG.LY's CDN path for the model: the library's own default, which names the
 * data package after the library's version.
 */
export const MODEL_CDN_BASE =
  `https://staticimgly.com/@imgly/background-removal-data/${PINNED_VERSIONS["@imgly/background-removal"]}/dist/`

/**
 * The isnet_quint8 entry of that CDN's resources.json for 1.7.0: each chunk
 * is named by its sha256, with its byte range in the model.
 */
export const MODEL_CHUNKS: ReadonlyArray<readonly [hash: string, start: number, end: number]> = [
  ["f27ae13d9f59f61a6a1b5d9a91c203f2c613346083f02072c27c91672ccda8cf", 0, 4_194_304],
  ["064e16ef5bd663f4c8b2d2531c018973282906db2b80c9995731340b84d28a47", 4_194_304, 8_388_608],
  ["829842727f98368990f103f052e112e521dd27123b9f6b8615efa6cb32bfaa4f", 8_388_608, 12_582_912],
  ["9d4c548caff42434be7b42d2f46e35a0da25f4d679ff4218b72bc8cf8fd4d291", 12_582_912, 16_777_216],
  ["f3ce5fa0c5dc650423b4cb885d9fce1dbf043ee002c4a161688f36c2d2a122e0", 16_777_216, 20_971_520],
  ["0a2415f50fe3072be594f7c4c66787f9465efed8dae6010b02f8575ea36bf81b", 20_971_520, 25_165_824],
  ["a2385cccf96fda2efcf32b61349bc9c3a8ccb9be2246e45db6bfca6e37b78117", 25_165_824, 29_360_128],
  ["ef08462567a199c89e0701ad47876c8fdc1b5eb487bbd6c2b58dd65fdc8bdc47", 29_360_128, 33_554_432],
  ["e57a35056b1480bc581977524cf0c19994542cb044626cfffca0b304a6cf227c", 33_554_432, 37_748_736],
  ["b7b88898b9ab9e43209322097282f88e9e02315273e291373366261cd0a77059", 37_748_736, 41_943_040],
  ["b275d60a2e1790daff7c9040fd99a3897bfdf7d1550da1ccf8bea60902e9c585", 41_943_040, BG_REMOVAL_FILE_BYTES.model],
]

type ResourceChunk = { hash: string; name: string; offsets: [number, number] }
export type ResourceEntry = { chunks: ResourceChunk[]; size: number; mime: string }
export type ResourceMap = Record<string, ResourceEntry>

/**
 * The served resources.json: the model's chunks by absolute CDN URL (the
 * library resolves chunk names against publicPath, and an absolute name stays
 * as it is), the onnxruntime files as single chunks next to this file. Only
 * the CPU path's three entries exist, so no other runtime can be loaded.
 */
export function buildResourceMap(): ResourceMap {
  const map: ResourceMap = {
    "/models/isnet_quint8": {
      chunks: MODEL_CHUNKS.map(([hash, start, end]) => ({
        hash,
        name: `${MODEL_CDN_BASE}${hash}`,
        offsets: [start, end],
      })),
      size: BG_REMOVAL_FILE_BYTES.model,
      // The CDN's own spelling, kept so the model blob is typed exactly as before.
      mime: "application/octet-steam",
    },
  }
  for (const file of ORT_FILES) {
    map[file.key] = {
      chunks: [{ hash: file.sha256, name: file.file, offsets: [0, file.size] }],
      size: file.size,
      mime: file.mime,
    }
  }
  return map
}
