// Browser call to POST /api/outfits/suggest. A Route Handler rather than a
// Server Action, because the Claude call can take a minute or more and
// actions run one at a time per client (D-035). Every outcome comes back as a
// Result: HTTP errors, unreadable answers (a platform timeout page) and
// network failures alike.

import { postJson, unexpectedResponse, type FetchLike } from "@/lib/images/blob-upload-client"
import { resultSchema } from "@/lib/items/contracts"
import type { Result } from "@/lib/result"

import { TodaySuggestionSchema, type TodaySuggestionDto } from "./today-model"

export const SUGGEST_OUTFITS_URL = "/api/outfits/suggest"

const SuggestResultSchema = resultSchema(TodaySuggestionSchema)

/**
 * Asks for today's three outfits. `force` asks for new ones even when a
 * suggestion for the same items exists ("Suggest again"); without it the
 * server answers a stored one for free. The fetch defaults to the browser's,
 * looked up at call time.
 */
export async function postSuggestOutfits(
  options: { force?: boolean } = {},
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<Result<TodaySuggestionDto>> {
  const answer = await postJson(fetchImpl, SUGGEST_OUTFITS_URL, options.force === true ? { force: true } : {})
  if (!answer.ok) return answer
  const parsed = SuggestResultSchema.safeParse(answer.data.json)
  return parsed.success ? parsed.data : unexpectedResponse(answer.data.response.status)
}
