import { readFileSync } from "node:fs"
import vm from "node:vm"

import { describe, expect, it, vi } from "vitest"

// public/sw.js is a plain script with no build step, so it runs here in a VM
// context with fake `self`, `caches` and `fetch`. The point is the privacy rule:
// pages, API responses and RSC payloads must never land in a cache.

const ORIGIN = "https://wardrobe.test"
const SW_SOURCE = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8")

type RequestLike = string | URL | { url: string; redirect?: RequestRedirect }

function absoluteUrl(input: RequestLike): string {
  if (typeof input === "string" || input instanceof URL) return new URL(input, ORIGIN).href
  return input.url
}

// In a real worker relative URLs resolve against the worker's location; Node's Request needs a base.
class WorkerRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === "string" ? new URL(input, ORIGIN) : input, init)
  }
}

class FakeCache {
  readonly entries = new Map<string, Response>()

  constructor(private readonly fetchImpl: (input: RequestLike) => Promise<Response>) {}

  async match(request: RequestLike): Promise<Response | undefined> {
    return this.entries.get(absoluteUrl(request))?.clone()
  }

  async put(request: RequestLike, response: Response): Promise<void> {
    if (response.status === 206) throw new TypeError("Partial responses cannot be cached")
    const key = absoluteUrl(request)
    // Like the real Cache API, a re-put moves the entry to the end of the key order.
    this.entries.delete(key)
    this.entries.set(key, response)
  }

  async addAll(requests: readonly RequestLike[]): Promise<void> {
    const responses = await Promise.all(requests.map((request) => this.fetchImpl(request)))
    responses.forEach((response) => {
      if (!response.ok) throw new TypeError(`addAll got HTTP ${response.status}`)
    })
    await Promise.all(requests.map((request, index) => this.put(request, responses[index])))
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url))
  }

  async delete(request: RequestLike): Promise<boolean> {
    return this.entries.delete(absoluteUrl(request))
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>()

  constructor(private readonly fetchImpl: (input: RequestLike) => Promise<Response>) {}

  async open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name)
    if (!cache) {
      cache = new FakeCache(this.fetchImpl)
      this.stores.set(name, cache)
    }
    return cache
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()]
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name)
  }

  async match(request: RequestLike): Promise<Response | undefined> {
    for (const cache of this.stores.values()) {
      const hit = await cache.match(request)
      if (hit) return hit
    }
    return undefined
  }

  /** Every cached URL path (with query), across all caches. */
  cachedPaths(): string[] {
    return [...this.stores.values()].flatMap((cache) =>
      [...cache.entries.keys()].map((url) => {
        const { pathname, search } = new URL(url)
        return pathname + search
      })
    )
  }
}

function offlineHtml(stylesheet: string): string {
  return `<!DOCTYPE html><html><head><link rel="stylesheet" href="${stylesheet}" data-precedence="next"/></head><body>You are offline</body></html>`
}

type Listener = (event: unknown) => void

function loadWorker() {
  const network = {
    online: true,
    routes: new Map<string, () => Response>([
      ["/offline", () => new Response(offlineHtml("/_next/static/chunks/a.css"), { headers: { "Content-Type": "text/html" } })],
      ["/_next/static/chunks/a.css", () => new Response("body{color:red}")],
      ["/icons/icon-192.png", () => new Response("png")],
      ["/icons/icon-512.png", () => new Response("png")],
      ["/wardrobe", () => new Response("<p>private wardrobe</p>")],
      ["/login", () => new Response("<form>login</form>")],
      ["/_next/static/chunks/app.js", () => new Response("console.log(1)")],
      ["/_next/static/media/clip.mp4", () => new Response("partial", { status: 206 })],
    ]),
    redirects: new Map<string, string>(),
  }

  const fetchMock = vi.fn(async (input: RequestLike): Promise<Response> => {
    if (!network.online) throw new TypeError("Failed to fetch")
    const url = new URL(absoluteUrl(input))
    const target = network.redirects.get(url.pathname)
    if (target !== undefined) {
      const mode = typeof input === "object" && "redirect" in input ? input.redirect : "follow"
      if (mode === "error") throw new TypeError("Redirect was not allowed")
      const followed = network.routes.get(target)?.() ?? new Response("Not found", { status: 404 })
      Object.defineProperty(followed, "redirected", { value: true })
      return followed
    }
    return network.routes.get(url.pathname)?.() ?? new Response("Not found", { status: 404 })
  })

  const storage = new FakeCacheStorage(fetchMock)
  const listeners = new Map<string, Listener>()
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  }

  vm.runInContext(
    SW_SOURCE,
    vm.createContext({ self, caches: storage, fetch: fetchMock, Request: WorkerRequest, Response, URL }),
    { filename: "sw.js" }
  )

  function listener(type: string): Listener {
    const found = listeners.get(type)
    if (!found) throw new Error(`sw.js registers no ${type} listener`)
    return found
  }

  async function runExtendable(type: "install" | "activate"): Promise<void> {
    const pending: Promise<unknown>[] = []
    listener(type)({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
    await Promise.all(pending)
  }

  function dispatchFetch(request: { url: string; method?: string; mode?: RequestMode }) {
    const pending: Promise<unknown>[] = []
    let response: Promise<Response> | undefined
    listener("fetch")({
      request: { method: "GET", mode: "cors", ...request, url: new URL(request.url, ORIGIN).href },
      respondWith: (value: Response | Promise<Response>) => {
        response = Promise.resolve(value)
      },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    })
    return {
      response,
      /** Waits for the response and every waitUntil, including ones added after an await. */
      async settled(): Promise<void> {
        await response?.catch(() => undefined)
        for (let index = 0; index < pending.length; index++) await pending[index]
      },
    }
  }

  return { network, fetchMock, storage, self, runExtendable, dispatchFetch }
}

async function bodyOf(response: Promise<Response> | undefined): Promise<string> {
  if (!response) throw new Error("the worker did not respond")
  return (await response).text()
}

describe("public/sw.js", () => {
  it("precaches the offline page, the stylesheets it links and the icons, without following redirects", async () => {
    const worker = loadWorker()
    await worker.runExtendable("install")

    expect(worker.storage.cachedPaths().sort()).toEqual(
      ["/_next/static/chunks/a.css", "/icons/icon-192.png", "/icons/icon-512.png", "/offline"].sort()
    )
    const offlineRequest = worker.fetchMock.mock.calls
      .map(([input]) => input)
      .find((input): input is Request => input instanceof Request && input.url === `${ORIGIN}/offline`)
    expect(offlineRequest?.redirect).toBe("error")
    expect(offlineRequest?.cache).toBe("reload")
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce()
  })

  it("fails the install instead of caching a redirected offline page", async () => {
    const worker = loadWorker()
    worker.network.redirects.set("/offline", "/login")

    await expect(worker.runExtendable("install")).rejects.toThrow()
    expect(worker.storage.cachedPaths()).not.toContain("/offline")
    expect(worker.self.skipWaiting).not.toHaveBeenCalled()
  })

  it("answers navigations from the network and never caches them", async () => {
    const worker = loadWorker()
    await worker.runExtendable("install")

    const navigation = worker.dispatchFetch({ url: "/wardrobe", mode: "navigate" })
    expect(await bodyOf(navigation.response)).toBe("<p>private wardrobe</p>")
    await navigation.settled()
    expect(worker.storage.cachedPaths()).not.toContain("/wardrobe")
  })

  it("serves the precached offline page, styled, when the network fails", async () => {
    const worker = loadWorker()
    await worker.runExtendable("install")
    worker.network.online = false

    const navigation = worker.dispatchFetch({ url: "/wardrobe", mode: "navigate" })
    expect(await bodyOf(navigation.response)).toContain("You are offline")
    await navigation.settled()

    const stylesheet = worker.dispatchFetch({ url: "/_next/static/chunks/a.css", mode: "no-cors" })
    expect(await bodyOf(stylesheet.response)).toBe("body{color:red}")
  })

  it.each([
    ["a POST", { url: "/wardrobe", method: "POST", mode: "navigate" as const }],
    ["a cross-origin request", { url: "https://cdn.example/_next/static/chunks/x.js" }],
    ["an API request", { url: "/api/items" }],
    ["an RSC payload", { url: "/wardrobe?_rsc=abc123" }],
    ["an image outside /_next/static", { url: "/icons/icon-192.png", mode: "no-cors" as const }],
  ])("leaves %s to the browser", async (_label, request) => {
    const worker = loadWorker()
    await worker.runExtendable("install")
    const before = worker.storage.cachedPaths()

    const result = worker.dispatchFetch(request)
    expect(result.response).toBeUndefined()
    await result.settled()
    expect(worker.storage.cachedPaths()).toEqual(before)
  })

  it("caches full static responses cache-first but never partial ones", async () => {
    const worker = loadWorker()

    const first = worker.dispatchFetch({ url: "/_next/static/chunks/app.js", mode: "no-cors" })
    expect(await bodyOf(first.response)).toBe("console.log(1)")
    await first.settled()
    expect(worker.storage.cachedPaths()).toContain("/_next/static/chunks/app.js")

    worker.network.online = false
    const second = worker.dispatchFetch({ url: "/_next/static/chunks/app.js", mode: "no-cors" })
    expect(await bodyOf(second.response)).toBe("console.log(1)")

    worker.network.online = true
    const partial = worker.dispatchFetch({ url: "/_next/static/media/clip.mp4", mode: "no-cors" })
    expect((await partial.response)?.status).toBe(206)
    await partial.settled()
    expect(worker.storage.cachedPaths()).not.toContain("/_next/static/media/clip.mp4")
  })

  it("deletes caches from earlier versions on activate and claims open pages", async () => {
    const worker = loadWorker()
    const old = await worker.storage.open("wardrobe-shell-v1")
    await old.put("/offline", new Response("old offline page"))
    await worker.runExtendable("install")
    const current = await worker.storage.keys()

    await worker.runExtendable("activate")

    expect(await worker.storage.keys()).toEqual(current.filter((name) => name !== "wardrobe-shell-v1"))
    expect(worker.self.clients.claim).toHaveBeenCalledOnce()
  })

  it("refreshes the offline page after a deploy and swaps in the new stylesheets", async () => {
    const worker = loadWorker()
    await worker.runExtendable("install")

    // A new deploy: /offline now links a different stylesheet hash.
    worker.network.routes.set("/offline", () => new Response(offlineHtml("/_next/static/chunks/b.css")))
    worker.network.routes.set("/_next/static/chunks/b.css", () => new Response("body{color:blue}"))
    const online = worker.dispatchFetch({ url: "/wardrobe", mode: "navigate" })
    await online.settled()

    expect(worker.storage.cachedPaths()).toContain("/_next/static/chunks/b.css")
    expect(worker.storage.cachedPaths()).not.toContain("/_next/static/chunks/a.css")

    worker.network.online = false
    const offline = worker.dispatchFetch({ url: "/settings", mode: "navigate" })
    expect(await bodyOf(offline.response)).toContain("/_next/static/chunks/b.css")
    const stylesheet = worker.dispatchFetch({ url: "/_next/static/chunks/b.css", mode: "no-cors" })
    expect(await bodyOf(stylesheet.response)).toBe("body{color:blue}")
  })
})
