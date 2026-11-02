// Browser call to GET /api/ai/tagging-setup: the tagging model, its rates and
// the month's budget, read again after tagging spent some of it. A re-read
// through this route replaces a whole-page router.refresh(), which re-ran the
// page's server reads and could swap the page for its error boundary
// mid-upload. Every outcome comes back as a Result; the call never throws.

import { z } from "zod"

import { NETWORK_ERROR_MESSAGE } from "@/lib/images/blob-upload-client"
import { resultSchema } from "@/lib/items/contracts"
import { err, type Result } from "@/lib/result"

import type { TaggingSetup } from "./cost-quote"

export const TAGGING_SETUP_API = "/api/ai/tagging-setup"

const RatesSchema = z.object({ firstItemUsd: z.number(), nextItemUsd: z.number() })

export const TaggingSetupSchema: z.ZodType<TaggingSetup> = z.object({
  model: z.object({ id: z.string(), label: z.string() }),
  costQuote: z.object({ standard: RatesSchema, batch: RatesSchema, dryRunUsd: z.number() }),
  budget: z.object({ budgetUsd: z.number(), remainingUsd: z.number(), resetsAt: z.string() }),
})

const TaggingSetupResultSchema = resultSchema(TaggingSetupSchema)

function unexpectedResponse(status: number): Result<never> {
  return err("UPSTREAM", `The server answered with an unexpected response (HTTP ${status}). Try again.`)
}

export async function requestTaggingSetup(
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Result<TaggingSetup>> {
  // Resolved per call, so the browser's fetch keeps window as its receiver.
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  let response: Response
  try {
    response = await fetchImpl(TAGGING_SETUP_API, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: options.signal,
    })
  } catch {
    return err("UPSTREAM", NETWORK_ERROR_MESSAGE)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A platform error page (a function timeout, for example) is not JSON.
    return unexpectedResponse(response.status)
  }
  const parsed = TaggingSetupResultSchema.safeParse(body)
  return parsed.success ? parsed.data : unexpectedResponse(response.status)
}
