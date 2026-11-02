// Browser-side calls for the add flow. Every call resolves to a Result and
// never throws, so the pipeline handles server refusals, network failures and
// odd responses the same way. fetch and the Blob put are injected for tests.

import type { z } from "zod"

import {
  blobErrorMessage,
  postJson,
  progressUntilSettled,
  requestClientToken,
  unexpectedResponse,
  type FetchLike,
  type PutBlobLike,
} from "@/lib/images/blob-upload-client"
import {
  CheckHashesDataSchema,
  ITEM_API,
  RegisterDataSchema,
  TagDataSchema,
  originalUploadPathname,
  resultSchema,
  type CheckHashesBody,
  type CheckHashesData,
  type RegisterBody,
  type RegisterData,
  type TagBody,
  type TagData,
} from "@/lib/items/contracts"
import { err, ok, type Result } from "@/lib/result"

import type { TaggingSetup } from "./cost-quote"
import { requestTaggingSetup } from "./tagging-setup-request"

export {
  NETWORK_ERROR_MESSAGE,
  type FetchLike,
  type PutBlobLike,
  type UploadProgress,
} from "@/lib/images/blob-upload-client"

export type UploadedBlob = { url: string; pathname: string }

export type UploadOriginalInput = {
  itemId: string
  sourceHash: string
  blob: Blob
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

export type AddApi = {
  checkHashes(sourceHashes: string[]): Promise<Result<CheckHashesData>>
  uploadOriginal(input: UploadOriginalInput): Promise<Result<UploadedBlob>>
  register(body: RegisterBody, signal?: AbortSignal): Promise<Result<RegisterData>>
  tagItem(itemId: string, body: TagBody): Promise<Result<TagData>>
  /** The tagging model, rates and month's budget, read again (GET /api/ai/tagging-setup). */
  taggingSetup(): Promise<Result<TaggingSetup>>
}

export function createAddApi({ fetch, putBlob }: { fetch: FetchLike; putBlob: PutBlobLike }): AddApi {
  async function postResult<T>(
    url: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<Result<T>> {
    const answer = await postJson(fetch, url, body, signal)
    if (!answer.ok) return answer
    const parsed = resultSchema(schema).safeParse(answer.data.json)
    return parsed.success ? parsed.data : unexpectedResponse(answer.data.response.status)
  }

  return {
    checkHashes(sourceHashes) {
      const body: CheckHashesBody = { sourceHashes }
      return postResult(ITEM_API.checkHashes, body, CheckHashesDataSchema)
    },

    async uploadOriginal({ itemId, sourceHash, blob, signal, onProgress }) {
      const pathname = originalUploadPathname(itemId)
      const token = await requestClientToken(fetch, pathname, { kind: "original", itemId, sourceHash }, signal)
      if (!token.ok) return token
      const progress = progressUntilSettled(
        onProgress ? (event) => onProgress(Math.min(100, Math.max(0, Math.round(event.percentage)))) : undefined,
      )
      try {
        const stored = await putBlob(pathname, blob, {
          access: "public",
          token: token.data,
          contentType: "image/jpeg",
          abortSignal: signal,
          onUploadProgress: progress.onUploadProgress,
        })
        return ok({ url: stored.url, pathname: stored.pathname })
      } catch (error) {
        return err("UPSTREAM", `Upload to storage failed: ${blobErrorMessage(error)}`)
      } finally {
        progress.settle()
      }
    },

    register(body, signal) {
      return postResult(ITEM_API.register, body, RegisterDataSchema, signal)
    },

    tagItem(itemId, body) {
      return postResult(ITEM_API.tag(itemId), body, TagDataSchema)
    },

    taggingSetup() {
      // The route is only ever called with a path string.
      return requestTaggingSetup({ fetchImpl: (input, init) => fetch(String(input), init) })
    },
  }
}
