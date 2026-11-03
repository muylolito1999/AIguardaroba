// The Server Actions the relocation screens call, as plain function types.
// The pages pass the real actions from src/server/actions/relocation.ts and
// src/server/actions/items.ts down as props, so these client components never
// import the action modules themselves and tests can hand in fakes.

import type { SetItemDecisionAction } from "@/components/item-detail/detail-actions"
import type { PackingGroup } from "@/lib/db/enums"
import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import type {
  PackingRowDto,
  RelocationEstimateDto,
  RelocationParamsInput,
  StartRelocationResult,
} from "@/lib/relocation/contracts"
import { err, type Result } from "@/lib/result"

export type EstimateRelocationAction = (params: RelocationParamsInput) => Promise<Result<RelocationEstimateDto>>

/** A matching completed run comes back as "cached" unless force is set (D-028). */
export type StartRelocationAction = (input: {
  params: RelocationParamsInput
  force: boolean
}) => Promise<Result<StartRelocationResult>>

/** Writes the AI decision to every item of the run the owner left undecided; never touches the others. */
export type ApplyAiDecisionsAction = (input: {
  analysisId: string
}) => Promise<Result<{ updated: number; itemIds: string[] }>>

/** Idempotent on (analysisId, gapKey): gaps already on the list count as alreadyThere. */
export type AddGapsToShoppingListAction = (input: {
  analysisId: string
  gapKeys: string[]
}) => Promise<Result<{ added: number; alreadyThere: number }>>

export type SetPackingItemPackedAction = (input: { id: string; packed: boolean }) => Promise<Result<PackingRowDto>>

export type AddPackingExtraAction = (input: {
  analysisId: string
  group: PackingGroup
  label: string
}) => Promise<Result<PackingRowDto>>

/** Only rows without an item (extras) can be deleted. */
export type DeletePackingExtraAction = (input: { id: string }) => Promise<Result<{ deleted: true }>>

export type RelocationFormActions = {
  estimateRelocation: EstimateRelocationAction
  startRelocation: StartRelocationAction
}

export type RelocationResultActions = {
  setItemDecision: SetItemDecisionAction
  applyAiDecisionsToUndecided: ApplyAiDecisionsAction
  addGapsToShoppingList: AddGapsToShoppingListAction
  setPackingItemPacked: SetPackingItemPackedAction
  addPackingExtra: AddPackingExtraAction
  deletePackingExtra: DeletePackingExtraAction
}

/**
 * Calls a Server Action and turns a throw (offline, a platform error page, an
 * action unknown after a redeploy) into the network error Result, so every
 * caller handles one error path.
 */
export async function settle<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call()
  } catch {
    return err("UPSTREAM", NETWORK_ERROR_MESSAGE)
  }
}
