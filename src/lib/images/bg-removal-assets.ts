// Where background removal finds its files (D-034, D-081). Pure constants,
// shared by the browser module (src/lib/images/bg-removal.ts) and the build
// step that writes the files (scripts/vendor-bg-removal.ts).
//
// @imgly/background-removal loads onnxruntime's wasm glue (.mjs) as a blob:
// URL and imports it, so that file runs as script in the app's origin. It is
// therefore served from this app, copied at build time from the installed
// onnxruntime-web package and checked against pinned hashes. The model is
// data, not code, and stays on IMG.LY's CDN: the resources.json served here
// points at its chunks by absolute URL, and the library checks every chunk's
// size against that file.

/**
 * The package versions the served files were written for. The build step
 * refuses any other installed version, and the asset path below is built from
 * them, so an upgrade also moves the files to a new URL.
 */
export const PINNED_VERSIONS = {
  "@imgly/background-removal": "1.7.0",
  "onnxruntime-web": "1.21.0",
} as const

/**
 * Path of the served files and of resources.json, named after both pinned
 * versions. Only the two onnxruntime files are cached as immutable
 * (next.config.ts): their hashes are pinned to these versions, so their
 * content cannot change without the path changing. resources.json is
 * generated from scripts/bg-removal-vendor.ts and can change under the same
 * path, so it is revalidated on every load.
 */
export const BG_REMOVAL_ASSET_PATH =
  `/vendor/bg-removal/imgly-${PINNED_VERSIONS["@imgly/background-removal"]}-ort-${PINNED_VERSIONS["onnxruntime-web"]}/`

/** Byte sizes of the three files a CPU run fetches. */
export const BG_REMOVAL_FILE_BYTES = {
  /** isnet_quint8, from IMG.LY's CDN (@imgly/background-removal-data 1.7.0). */
  model: 44_348_940,
  /** onnxruntime-web 1.21.0 dist/ort-wasm-simd-threaded.wasm, served by this app. */
  wasm: 12_666_427,
  /** onnxruntime-web 1.21.0 dist/ort-wasm-simd-threaded.mjs, served by this app. */
  mjs: 26_583,
} as const
