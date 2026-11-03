// Browser call to POST /api/shopping/advice. The ranking runs in a Route
// Handler rather than a Server Action because it can take a minute, and
// Server Actions run one at a time per client, which would hold up the
// shopping list's own saves meanwhile (D-035). Every outcome comes back as a
// Result: HTTP errors, unreadable answers (a platform timeout page) and
// network failures alike.

import { postJson, unexpectedResponse, type FetchLike } from "@/lib/images/blob-upload-client"
import { resultSchema } from "@/lib/items/contracts"
import type { Result } from "@/lib/result"

import { ShoppingAdviceRunSchema, type ShoppingAdviceRunDto } from "./advice-model"

export const SHOPPING_ADVICE_URL = "/api/shopping/advice"

const RunResultSchema = resultSchema(ShoppingAdviceRunSchema)

export type RequestShoppingAdvice = (options: { force: boolean }) => Promise<Result<ShoppingAdviceRunDto>>

/**
 * Ranks the candidates, or answers the latest advice again when nothing
 * changed since; force ("Run again") always calls Claude. The fetch defaults
 * to the browser's, looked up at call time.
 */
export async function postShoppingAdvice(
  options: { force: boolean },
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<Result<ShoppingAdviceRunDto>> {
  const answer = await postJson(fetchImpl, SHOPPING_ADVICE_URL, options.force ? { force: true } : {})
  if (!answer.ok) return answer
  const parsed = RunResultSchema.safeParse(answer.data.json)
  return parsed.success ? parsed.data : unexpectedResponse(answer.data.response.status)
}
