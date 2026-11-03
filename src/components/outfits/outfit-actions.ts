// The Server Actions the outfit pages, the item page and /today call, as
// plain function types. Pages pass the real actions from
// src/server/actions/{outfits,wear}.ts down as props, so these client
// components never import the action modules themselves and tests can hand in
// fakes.

import type { OutfitDetailDto, OutfitInputValues } from "@/lib/outfits/contracts"
import type { Result } from "@/lib/result"
import type { LogWearInput, UndoWearInput, WearLogResultDto } from "@/lib/wear/contracts"
import type { UndoWearResultDto } from "@/server/services/wear"

export type { UndoWearResultDto }

/** Creates an outfit without `id`, otherwise replaces it. VALIDATION may carry `details.outfitIssues`. */
export type SaveOutfitAction = (input: { id?: string; outfit: OutfitInputValues }) => Promise<Result<OutfitDetailDto>>

export type DeleteOutfitAction = (input: { id: string }) => Promise<Result<{ deleted: true }>>

export type LogWearAction = (input: LogWearInput) => Promise<Result<WearLogResultDto>>

export type UndoWearAction = (input: UndoWearInput) => Promise<Result<UndoWearResultDto>>

export type WearActions = {
  logWear: LogWearAction
  undoWear: UndoWearAction
}

export type OutfitPageActions = WearActions & {
  saveOutfit: SaveOutfitAction
  deleteOutfit: DeleteOutfitAction
}
