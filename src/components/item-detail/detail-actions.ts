// The Server Actions the item detail page calls, as plain function types. The
// page passes the real actions from src/server/actions/items.ts down as props,
// so these client components never import the action module themselves and
// tests can hand in fakes.

import type { LogWearAction, UndoWearAction } from "@/components/outfits/outfit-actions"
import type {
  ConfirmItemAction,
  TagItemByHandAction,
  UpdateItemTagsAction,
} from "@/components/items/review-actions"
import type { ItemDecision, ItemLocation } from "@/lib/db/enums"
import type { ItemCardDto } from "@/lib/items/contracts"
import type { ItemDetailDto } from "@/lib/items/wardrobe"
import type { Result } from "@/lib/result"

export type SetItemDecisionAction = (input: { id: string; decision: ItemDecision }) => Promise<Result<ItemCardDto>>

export type SetItemLocationAction = (input: { id: string; location: ItemLocation }) => Promise<Result<ItemCardDto>>

/** Archived from any status; archiving again changes nothing. */
export type ArchiveItemAction = (input: { id: string }) => Promise<Result<ItemDetailDto>>

/** Back to confirmed with a complete tag set, pending_tagging otherwise. */
export type UnarchiveItemAction = (input: { id: string }) => Promise<Result<ItemDetailDto>>

/** Photos in Blob first, then the rows; UPSTREAM or CONFIG leave everything in place. */
export type DeleteItemAction = (input: { id: string }) => Promise<Result<{ deleted: true }>>

export type ItemDetailActions = {
  updateItemTags: UpdateItemTagsAction
  confirmItem: ConfirmItemAction
  tagItemByHand: TagItemByHandAction
  setItemDecision: SetItemDecisionAction
  setItemLocation: SetItemLocationAction
  archiveItem: ArchiveItemAction
  unarchiveItem: UnarchiveItemAction
  deleteItem: DeleteItemAction
  /** "+1 worn today" and its Undo. */
  logWear: LogWearAction
  undoWear: UndoWearAction
}
