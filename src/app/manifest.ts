import type { MetadataRoute } from "next"

const BRAND_DARK = "#0a0a0a"

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Wardrobe",
    short_name: "Wardrobe",
    description:
      "A climate-aware digital wardrobe: catalogue your clothes, plan what to bring on a move, and see what is missing.",
    lang: "en",
    start_url: "/wardrobe",
    scope: "/",
    display: "standalone",
    // No orientation lock: WCAG 1.3.4 asks that content work in both orientations, and the layout is responsive.
    background_color: BRAND_DARK,
    theme_color: BRAND_DARK,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Add items",
        short_name: "Add",
        url: "/add",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  }
}
