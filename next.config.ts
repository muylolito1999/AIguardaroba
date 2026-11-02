import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera stays allowed for in-app photo capture; nothing else is needed.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  typedRoutes: true,
  images: {
    // Thumbnails are pre-generated at upload, and this avoids the Hobby image-optimization quota.
    unoptimized: true,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async redirects() {
    return [{ source: "/", destination: "/wardrobe", permanent: false }];
  },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // Background removal (scripts/vendor-bg-removal.ts, D-081). One rule per
      // file name, so the rules never overlap and no other path in the folder
      // gets a Cache-Control from here. The two onnxruntime files are written
      // only when their sha256 matches the pin for the onnxruntime version that
      // names the folder (BG_REMOVAL_ASSET_PATH), so a URL always serves the
      // same bytes and can be cached forever.
      {
        source: "/vendor/bg-removal/:dir/ort-wasm-simd-threaded.wasm",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/vendor/bg-removal/:dir/ort-wasm-simd-threaded.mjs",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // Generated from scripts/bg-removal-vendor.ts (model CDN, chunk list,
        // file list), which can change while the folder name stays the same,
        // so the browser revalidates this 4 KB file on every load.
        source: "/vendor/bg-removal/:dir/resources.json",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
      {
        // The service worker must never be cached, or clients keep running a stale one.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
