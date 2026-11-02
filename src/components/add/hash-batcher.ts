// Coalesces source-hash lookups: photos that finish preparing within a short
// window share one POST /api/items/check-hashes instead of one request each.
// The window is short and has no other wait condition, so a lookup can never
// hold a pipeline lane while waiting for files that have not started yet.

import type { CheckHashesData } from "@/lib/items/contracts"
import { err, type Result } from "@/lib/result"

/** The id of the item that already has the hash, or null when it is new. */
export type HashLookup = Result<string | null>

export type HashBatcher = { lookup(sourceHash: string): Promise<HashLookup> }

export const HASH_BATCH_WINDOW_MS = 50
/** The route accepts at most 500 hashes per request. */
export const HASH_BATCH_MAX = 500

export function createHashBatcher(
  check: (sourceHashes: string[]) => Promise<Result<CheckHashesData>>,
  options: { windowMs?: number; maxBatch?: number } = {},
): HashBatcher {
  const windowMs = options.windowMs ?? HASH_BATCH_WINDOW_MS
  const maxBatch = options.maxBatch ?? HASH_BATCH_MAX
  let waiting = new Map<string, Array<(lookup: HashLookup) => void>>()
  let timer: ReturnType<typeof setTimeout> | null = null

  async function send(batch: Map<string, Array<(lookup: HashLookup) => void>>): Promise<void> {
    let result: Result<CheckHashesData>
    try {
      result = await check([...batch.keys()])
    } catch {
      // Every waiter must settle, or its pipeline lane would stay blocked.
      result = err("INTERNAL", "Could not check for photos you already added.")
    }
    for (const [hash, resolvers] of batch) {
      const lookup: HashLookup = result.ok ? { ok: true, data: result.data.known[hash] ?? null } : result
      for (const resolve of resolvers) resolve(lookup)
    }
  }

  function flush(): void {
    timer = null
    const pending = waiting
    waiting = new Map()
    // Split into requests the route accepts.
    let batch = new Map<string, Array<(lookup: HashLookup) => void>>()
    for (const [hash, resolvers] of pending) {
      batch.set(hash, resolvers)
      if (batch.size === maxBatch) {
        void send(batch)
        batch = new Map()
      }
    }
    if (batch.size > 0) void send(batch)
  }

  return {
    lookup(sourceHash) {
      return new Promise<HashLookup>((resolve) => {
        const resolvers = waiting.get(sourceHash)
        if (resolvers) resolvers.push(resolve)
        else waiting.set(sourceHash, [resolve])
        timer ??= setTimeout(flush, windowMs)
      })
    },
  }
}
