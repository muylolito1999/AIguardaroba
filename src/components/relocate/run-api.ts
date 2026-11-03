// Browser call to POST /api/analyses/[id]/parts/[partId]. Parts run in a Route
// Handler rather than a Server Action so up to four can run at once (D-035).
// Every outcome comes back as a Result: HTTP errors, unreadable answers (a
// platform timeout page) and network failures alike.

import { z } from "zod"

import { ANALYSIS_STATUSES, PART_STATUSES } from "@/lib/db/enums"
import { postJson, unexpectedResponse, type FetchLike } from "@/lib/images/blob-upload-client"
import { resultSchema } from "@/lib/items/contracts"
import type { RelocationRunDto } from "@/lib/relocation/contracts"
import type { Result } from "@/lib/result"

export function relocationPartUrl(analysisId: string, partId: string): string {
  return `/api/analyses/${encodeURIComponent(analysisId)}/parts/${encodeURIComponent(partId)}`
}

// Unknown keys are dropped, so the server can add fields first.
const RelocationPartSchema = z.object({
  id: z.string(),
  kind: z.enum(["chunk", "synthesis"]),
  partIndex: z.number().int(),
  status: z.enum(PART_STATUSES),
  itemCount: z.number().int(),
  costUsd: z.number(),
  attempts: z.number().int(),
  error: z.string().nullable(),
})

export const RelocationRunSchema: z.ZodType<RelocationRunDto> = z.object({
  analysisId: z.string(),
  status: z.enum(ANALYSIS_STATUSES),
  parts: z.array(RelocationPartSchema),
  estimatedCostUsd: z.number().nullable(),
  costUsd: z.number(),
})

const RunResultSchema = resultSchema(RelocationRunSchema)

/**
 * Runs one part (a chunk or the synthesis) and answers with the whole run as
 * the server sees it afterwards. retry is set only for the owner's Retry of a
 * failed part: without it the server answers a failed part as it is (D-157).
 * The fetch defaults to the browser's, looked up at call time.
 */
export async function postRelocationPart(
  analysisId: string,
  partId: string,
  options: { retry?: boolean } = {},
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<Result<RelocationRunDto>> {
  const body = options.retry === true ? { retry: true } : {}
  const answer = await postJson(fetchImpl, relocationPartUrl(analysisId, partId), body)
  if (!answer.ok) return answer
  const parsed = RunResultSchema.safeParse(answer.data.json)
  return parsed.success ? parsed.data : unexpectedResponse(answer.data.response.status)
}
