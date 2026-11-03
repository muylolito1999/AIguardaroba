// The Server Actions the review screen calls, as plain function types. The
// page passes the real actions from src/server/actions/items.ts down as props,
// so these client components never import the action module themselves and
// tests can hand in fakes.

import type { HandTagDefaultField, ItemCardDto, ItemPatch, StartTaggingBatchData } from "@/lib/items/contracts"
import type { Result } from "@/lib/result"

export type UpdateItemTagsAction = (input: { id: string; patch: ItemPatch }) => Promise<Result<ItemCardDto>>

export type ConfirmItemAction = (input: { id: string; patch?: ItemPatch }) => Promise<Result<ItemCardDto>>

export type ConfirmItemsAction = (input: { ids: string[] }) => Promise<Result<{ confirmed: number }>>

export type StartTaggingBatchAction = (input: { itemIds: string[] }) => Promise<Result<StartTaggingBatchData>>

/**
 * Stores tags the owner filled in by hand on a pending item in no batch:
 * status tagged, or confirmed when confirm is true; ai_raw stays null.
 * The fields in uncheckedDefaults, left at the form's own starting value, are
 * stored but not marked as the owner's, so a later Re-tag may replace them
 * (D-232). CONFLICT when the item is no longer pending or waits in a batch;
 * VALIDATION with details.missing when a required field is missing.
 */
export type TagItemByHandAction = (input: {
  id: string
  patch: ItemPatch
  confirm: boolean
  uncheckedDefaults: HandTagDefaultField[]
}) => Promise<Result<ItemCardDto>>

export type ReviewActions = {
  updateItemTags: UpdateItemTagsAction
  confirmItem: ConfirmItemAction
  confirmItems: ConfirmItemsAction
  startTaggingBatch: StartTaggingBatchAction
  tagItemByHand: TagItemByHandAction
}
