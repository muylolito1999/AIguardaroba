/* global self, caches */
// Offline-shell service worker. Plain script with no build step: next.config serves
// /sw.js with no-store headers and registration sets updateViaCache 'none', so an
// edit here reaches installed clients on their next visit. Bump a cache name whenever
// what that cache holds changes, so activate can drop the old one.

// The shell cache holds the offline page, the stylesheets it links and the icons.
// Runtime copies of build files live in their own cache, so trimming those never
// evicts the shell.
const SHELL_CACHE = "wardrobe-shell-v2"
const STATIC_CACHE = "wardrobe-static-v1"
const CURRENT_CACHES = new Set([SHELL_CACHE, STATIC_CACHE])
const OFFLINE_URL = "/offline"
const ICONS = ["/icons/icon-192.png", "/icons/icon-512.png"]
// This file rarely changes, so hashed build files from old deploys would pile up forever without a cap.
const MAX_STATIC_ENTRIES = 200
// Next.js links global CSS as <link rel="stylesheet" href="/_next/static/chunks/<hash>.css">.
const STYLESHEET_HREF = /href="(\/_next\/static\/[^"]+?\.css(?:\?[^"]*)?)"/g

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(async (cache) => {
        await cache.addAll(ICONS.map((url) => precacheRequest(url)))
        await cacheOfflinePage(cache)
      })
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => !CURRENT_CACHES.has(name)).map((name) => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === "navigate") {
    // Pages are network-only and never written to the cache: they carry private
    // wardrobe data that must not outlive a logout or show up stale. When the
    // network fails, the precached static /offline page stands in.
    event.waitUntil(refreshOfflinePage())
    event.respondWith(fetch(request).catch(offlineFallback))
    return
  }

  if (url.pathname.startsWith("/_next/static/")) {
    // Build files are content-hashed, so a cached copy can never go stale.
    event.respondWith(cacheFirst(event))
  }
  // Everything else (API routes, RSC payloads, images, Server Actions) goes to the network untouched.
})

// 'reload' bypasses the HTTP cache so a fresh install never stores a stale copy.
// 'error' turns a redirect (for example to /login) into a failure: a redirected
// response cannot answer a navigation, so caching one would break the fallback.
function precacheRequest(url) {
  return new Request(url, { cache: "reload", redirect: "error" })
}

// Stores /offline together with the stylesheets it links. The page that installed the
// worker loaded its CSS before the worker controlled it, so without this the fallback
// would render unstyled until a later full page load happened to fetch the CSS.
async function cacheOfflinePage(cache) {
  const response = await fetch(precacheRequest(OFFLINE_URL))
  if (!response.ok) throw new Error(`Precaching ${OFFLINE_URL} failed with HTTP ${response.status}`)
  const html = await response.clone().text()
  const stylesheets = [...new Set(Array.from(html.matchAll(STYLESHEET_HREF), (match) => match[1].replaceAll("&amp;", "&")))]
  // Stylesheets first: the stored page must never link files the cache lacks.
  await cache.addAll(stylesheets)
  await cache.put(OFFLINE_URL, response)

  // Stylesheets of earlier builds are no longer linked by the stored page.
  const linked = new Set(stylesheets.map((href) => new URL(href, self.location.origin).href))
  const stale = (await cache.keys()).filter(
    (request) => new URL(request.url).pathname.startsWith("/_next/static/") && !linked.has(request.url)
  )
  await Promise.all(stale.map((request) => cache.delete(request)))
}

async function offlineFallback() {
  const cache = await caches.open(SHELL_CACHE)
  return (await cache.match(OFFLINE_URL)) ?? Response.error()
}

async function cacheFirst(event) {
  // Searches every cache, so the offline page's stylesheets in the shell cache count too.
  const cached = await caches.match(event.request)
  if (cached) return cached
  const response = await fetch(event.request)
  // Only full 200s: cache.put rejects partial (206) responses.
  if (response.status === 200) {
    // Clone now, before the page starts reading the body.
    const copy = response.clone()
    event.waitUntil(
      caches.open(STATIC_CACHE).then(async (cache) => {
        await cache.put(event.request, copy)
        await trimStatic(cache)
      })
    )
  }
  return response
}

// Cache keys come back in insertion order, so the oldest build files go first.
async function trimStatic(cache) {
  const keys = await cache.keys()
  const excess = keys.length - MAX_STATIC_ENTRIES
  if (excess > 0) await Promise.all(keys.slice(0, excess).map((request) => cache.delete(request)))
}

// A deploy changes the page and its stylesheet hashes, so the stored /offline copy is
// re-fetched (with its stylesheets) once per worker start.
let offlinePageRefreshed = false
async function refreshOfflinePage() {
  if (offlinePageRefreshed) return
  offlinePageRefreshed = true
  try {
    await cacheOfflinePage(await caches.open(SHELL_CACHE))
  } catch {
    // Offline, a redirect or a broken deploy: keep the copy we have and try again on the next navigation.
    offlinePageRefreshed = false
  }
}
