"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"

import type { RelocationEstimateDto, RelocationParamsInput } from "@/lib/relocation/contracts"
import type { AppErrorPayload } from "@/lib/result"

import { settle, type EstimateRelocationAction } from "./actions"

/** Quiet time after the last change before the form asks for a new estimate. */
export const ESTIMATE_DEBOUNCE_MS = 400

export type EstimateState = {
  /** The last estimate the server gave, possibly for earlier inputs (see fresh). */
  estimate: RelocationEstimateDto | null
  /** The last answer was a failure for the current inputs. */
  error: AppErrorPayload | null
  /** The shown estimate and error belong to the current inputs. */
  fresh: boolean
  /** A request for the current inputs is waiting or running. */
  loading: boolean
}

type Answer =
  | { key: string; ok: true; estimate: RelocationEstimateDto }
  | { key: string; ok: false; error: AppErrorPayload }

/**
 * The live pre-run estimate. Asks ESTIMATE_DEBOUNCE_MS after the inputs last
 * changed and keeps only the answer to the latest request, so a slow answer
 * for older inputs never replaces a newer one. `key` identifies the inputs
 * (the JSON of the params); `params` null means the form is invalid and
 * nothing is asked. The effect runs again when Next shows the page again, so
 * Back to the form asks once more: the wardrobe or the cached run may have
 * changed meanwhile.
 */
export function useRelocationEstimate(
  params: RelocationParamsInput | null,
  key: string,
  estimateRelocation: EstimateRelocationAction
): EstimateState {
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [lastEstimate, setLastEstimate] = useState<RelocationEstimateDto | null>(null)
  const latestRequest = useRef(0)

  // Not a dependency: a new action reference after a refresh asks for nothing new.
  const ask = useEffectEvent(async (requestParams: RelocationParamsInput, requestKey: string, request: number) => {
    const result = await settle(() => estimateRelocation(requestParams))
    if (request !== latestRequest.current) return
    if (result.ok) {
      setLastEstimate(result.data)
      setAnswer({ key: requestKey, ok: true, estimate: result.data })
    } else {
      setAnswer({ key: requestKey, ok: false, error: result.error })
    }
  })

  useEffect(() => {
    // Every run supersedes earlier requests, also when the inputs became invalid.
    const request = ++latestRequest.current
    if (params === null) return
    const timer = setTimeout(() => void ask(params, key, request), ESTIMATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [params, key])

  const fresh = answer !== null && answer.key === key
  return {
    estimate: fresh && answer.ok ? answer.estimate : lastEstimate,
    error: fresh && !answer.ok ? answer.error : null,
    fresh,
    loading: params !== null && !fresh,
  }
}
