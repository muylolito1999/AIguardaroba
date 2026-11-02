// Browser call to POST /api/items/[id]/tag. Tagging runs in a Route Handler
// rather than a Server Action so several items can be tagged at once (D-035).
// Every outcome comes back as a Result, so callers render one error path for
// HTTP errors, unreadable responses and network failures alike.

import { ITEM_API, TagDataSchema, resultSchema, type TagData } from "@/lib/items/contracts"
import { noteWardrobeChangeIfOk } from "@/lib/items/wardrobe-changes"
import { err, type Result } from "@/lib/result"

const TagResultSchema = resultSchema(TagDataSchema)

export type TagRequestOptions = {
  /** Re-tag an item that already has tags (the Re-tag button). */
  force?: boolean
  /**
   * The batch the card shows the item waiting in ("Tag now instead"). When the
   * batch was applied meanwhile, the server answers with its tags instead of
   * paying for a forced call. Sent only when set.
   */
  batchId?: string
  /** Injected by tests; the browser's fetch otherwise. */
  fetchImpl?: typeof fetch
}

export async function requestTagging(itemId: string, options: TagRequestOptions = {}): Promise<Result<TagData>> {
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(ITEM_API.tag(itemId), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        force: options.force ?? false,
        ...(options.batchId === undefined ? {} : { batchId: options.batchId }),
      }),
    })
  } catch {
    return err("UPSTREAM", "Could not reach the server. Check your connection and try again.")
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A platform error page (a function timeout, for example) is not JSON.
    return err("UPSTREAM", `The server answered with an unexpected response (HTTP ${response.status}). Try again.`)
  }
  const parsed = TagResultSchema.safeParse(body)
  if (!parsed.success) {
    return err("UPSTREAM", `The server answered with an unexpected response (HTTP ${response.status}). Try again.`)
  }
  // Tags change what the wardrobe list shows (D-107).
  return noteWardrobeChangeIfOk(parsed.data)
}
