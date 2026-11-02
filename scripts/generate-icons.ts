// Renders assets/icon.svg into the PNG icons that the manifest and iOS need.
// The outputs are committed, so this only needs to run after the art changes: `pnpm icons`.
import { copyFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"

import sharp, { type OutputInfo } from "sharp"

const BACKGROUND = "#0a0a0a"
/** Width and height of the viewBox in assets/icon.svg. */
const SOURCE_SIZE = 512
/** Keeps the glyph inside the maskable safe zone (a centred circle 80% wide), so circular masks never clip it. */
const MASKABLE_GLYPH_SCALE = 0.7

// pnpm runs package scripts from the package root, so cwd is the project root.
const root = process.cwd()
const fromRoot = (...segments: string[]) => path.join(root, ...segments)

/** Rasterises the SVG at exactly size×size. Rendering at the target density keeps strokes crisp. */
function render(svg: Buffer, size: number) {
  return sharp(svg, { density: (72 * size) / SOURCE_SIZE }).resize(size, size)
}

function report(file: string, info: OutputInfo) {
  const relative = path.relative(root, file).split(path.sep).join("/")
  console.log(
    `wrote ${relative} (${info.width}x${info.height}, ${info.channels} channels, ${info.size} bytes)`
  )
}

async function main() {
  const sourcePath = fromRoot("assets", "icon.svg")
  const svg = await readFile(sourcePath).catch((error: unknown) => {
    throw new Error(`Cannot read ${sourcePath}. Run this from the project root.`, {
      cause: error,
    })
  })

  const iconsDir = fromRoot("public", "icons")
  const appDir = fromRoot("src", "app")
  await mkdir(iconsDir, { recursive: true })
  await mkdir(appDir, { recursive: true })

  // "any" icons keep the transparent rounded corners of the source art.
  const anyIcons = [192, 512].map((size) => ({
    size,
    file: path.join(iconsDir, `icon-${size}.png`),
  }))
  const anyInfo = await Promise.all(
    anyIcons.map(({ size, file }) => render(svg, size).png().toFile(file))
  )
  anyIcons.forEach(({ file }, i) => report(file, anyInfo[i]))

  // Maskable: the scaled art is padded out to an opaque full-bleed square, so
  // whatever shape the launcher cuts out is filled edge to edge.
  const maskableFile = path.join(iconsDir, "icon-maskable-512.png")
  const inner = Math.round(SOURCE_SIZE * MASKABLE_GLYPH_SCALE)
  const before = Math.floor((SOURCE_SIZE - inner) / 2)
  const after = SOURCE_SIZE - inner - before
  const maskable = render(svg, inner)
    .flatten({ background: BACKGROUND })
    .extend({ top: before, bottom: after, left: before, right: after, background: BACKGROUND })
    .png()
  report(maskableFile, await maskable.toFile(maskableFile))

  // iOS fills transparent pixels with black or white, so the apple icon is flattened to an opaque square.
  const appleFile = path.join(appDir, "apple-icon.png")
  report(appleFile, await render(svg, 180).flatten({ background: BACKGROUND }).png().toFile(appleFile))

  // Next serves app/icon.svg as the favicon through the metadata file convention.
  const faviconFile = path.join(appDir, "icon.svg")
  await copyFile(sourcePath, faviconFile)
  console.log(`copied assets/icon.svg to ${path.relative(root, faviconFile).split(path.sep).join("/")}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
