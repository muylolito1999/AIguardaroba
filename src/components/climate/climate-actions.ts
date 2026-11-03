// The Server Actions /settings/climate calls, as plain function types. The
// page passes the real actions from src/server/actions/climate.ts down as
// props, so these client components never import the action module and tests
// can hand in fakes.

import type { ClimateProfileDto } from "@/lib/relocation/contracts"
import type { Result } from "@/lib/result"

import type { ClimateProfileUpdate } from "./climate-model"

export type UpdateClimateProfileAction = (input: ClimateProfileUpdate) => Promise<Result<ClimateProfileDto>>

export type SetDefaultClimateProfileAction = (input: { id: string }) => Promise<Result<ClimateProfileDto>>

export type ClimateActions = {
  updateClimateProfile: UpdateClimateProfileAction
  setDefaultClimateProfile: SetDefaultClimateProfileAction
}
