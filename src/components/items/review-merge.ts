// Re-syncs the review list with a newer server list. With Cache Components the
// /add/review route stays mounted in a hidden <Activity> after the owner
// navigates away, and a later visit hands the same ReviewList fresh server
// cards: new items, items confirmed elsewhere, batch results applied by the
// page's poll. Pure, so it can be unit tested without React.

import type { ItemCardDto } from "@/lib/items/contracts"

export type MergeOptions = {
  /**
   * The server list holds only the newest waiting items (the page's limit),
   * so an id missing from it may just have been pushed out by newer uploads.
   */
  capped?: boolean
}

/**
 * The server's list in the server's order, keeping the local card for items
 * the owner is working on.
 *
 * - A server id whose local card is in `keep` (unsaved edits) or `busy` (a
 *   request or the hand-tagging form is open) keeps the local card; any other
 *   id takes the server card, so applied batch results and new tags show.
 * - Ids the server lists for the first time are added.
 * - Local ids the server no longer lists are dropped (confirmed elsewhere),
 *   except busy ones: their request is still running and settles on its own.
 * - When the list is capped, an unlisted card in `keep` stays as well: newer
 *   uploads may have pushed it out of the window, and dropping it would lose
 *   its unsaved edits. Uncapped, a dirty unlisted card is still dropped.
 * - Kept unlisted cards stay after the local card they followed. A card that
 *   left a capped window is older than every listed one, so it ends up after
 *   every server item.
 */
export function mergeServerItems(
  local: readonly ItemCardDto[],
  server: readonly ItemCardDto[],
  keep: ReadonlySet<string>,
  busy: ReadonlySet<string>,
  options: MergeOptions = {}
): ItemCardDto[] {
  const localById = new Map(local.map((item) => [item.id, item]))
  const merged = server.map((item) => {
    const mine = localById.get(item.id)
    return mine !== undefined && (keep.has(item.id) || busy.has(item.id)) ? mine : item
  })

  const serverIds = new Set(server.map((item) => item.id))
  local.forEach((item, index) => {
    if (serverIds.has(item.id)) return
    const kept = busy.has(item.id) || (options.capped === true && keep.has(item.id))
    if (!kept) return
    // After the nearest earlier local card that is still listed, else first.
    let at = 0
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const anchor = local[previous]
      const position = anchor === undefined ? -1 : merged.findIndex((card) => card.id === anchor.id)
      if (position !== -1) {
        at = position + 1
        break
      }
    }
    merged.splice(at, 0, item)
  })
  return merged
}
