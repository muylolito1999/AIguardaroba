// Browser side of a direct Blob upload, shared by the add flow (originals) and
// background removal (cut-outs). The client asks /api/blob/upload for a token
// itself and then calls put() from @vercel/blob/client, instead of using
// upload(): upload() turns every refusal of the token route into one generic
// "Failed to retrieve the client token" error, which hides whether uploads are
// not configured, the session ended or the photo is already stored. Every
// function resolves to a Result and never throws. fetch and put are injected
// so tests need no network.

import type { HandleUploadBody } from "@vercel/blob/client";
import { z } from "zod";

import { ITEM_API, resultSchema, type BlobClientPayload } from "@/lib/items/contracts";
import { err, ok, type Result } from "@/lib/result";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type UploadProgress = { loaded: number; total: number; percentage: number };

/** The subset of `put` from @vercel/blob/client the app uses. */
export type PutBlobLike = (
  pathname: string,
  body: Blob,
  options: {
    access: "public";
    token: string;
    contentType: string;
    abortSignal?: AbortSignal;
    onUploadProgress?: (event: UploadProgress) => void;
  },
) => Promise<{ url: string; pathname: string }>;

export const NETWORK_ERROR_MESSAGE = "Could not reach the server. Check your connection.";

/**
 * A progress callback that goes quiet once the upload has settled. put()
 * throttles its progress events (100 ms, trailing call included), so the last
 * one can arrive after put() resolved; passed on, it would move a photo that
 * is already saving or ready back to "Uploading 100%". Call settle() as soon
 * as put() resolves or rejects.
 */
export function progressUntilSettled(onProgress: ((event: UploadProgress) => void) | undefined): {
  onUploadProgress: ((event: UploadProgress) => void) | undefined;
  settle: () => void;
} {
  if (onProgress === undefined) return { onUploadProgress: undefined, settle: () => {} };
  let settled = false;
  return {
    onUploadProgress: (event) => {
      if (!settled) onProgress(event);
    },
    settle: () => {
      settled = true;
    },
  };
}

export function unexpectedResponse(status: number): Result<never> {
  return err("UPSTREAM", `The server sent an unexpected response (HTTP ${status}).`);
}

/** A Blob SDK error as text for the user, without the SDK's "Vercel Blob: " prefix. */
export function blobErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.replace(/^Vercel Blob:\s*/, "").trim() : "";
  return message === "" ? "unknown error" : message;
}

export type JsonAnswer = { response: Response; json: unknown };

/**
 * POSTs a JSON body and reads a JSON answer. A network failure becomes the
 * standard network error; an answer that is not JSON (a platform error page,
 * for example) becomes an unexpected-response error.
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Result<JsonAnswer>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return err("UPSTREAM", NETWORK_ERROR_MESSAGE);
  }
  try {
    return ok({ response, json: await response.json() });
  } catch {
    return unexpectedResponse(response.status);
  }
}

// What handleUpload() answers on success. The token route returns it
// unchanged; its failures use the app's Result shape.
const ClientTokenSchema = z.object({
  type: z.literal("blob.generate-client-token"),
  clientToken: z.string().min(1),
});
const ErrorResultSchema = resultSchema(z.unknown());

/** Asks /api/blob/upload for a client token for one pathname and payload. */
export async function requestClientToken(
  fetchImpl: FetchLike,
  pathname: string,
  payload: BlobClientPayload,
  signal?: AbortSignal,
): Promise<Result<string>> {
  const event: HandleUploadBody = {
    type: "blob.generate-client-token",
    payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false },
  };
  const answer = await postJson(fetchImpl, ITEM_API.blobUpload, event, signal);
  if (!answer.ok) return answer;
  const { response, json } = answer.data;
  if (response.ok) {
    const token = ClientTokenSchema.safeParse(json);
    return token.success ? ok(token.data.clientToken) : unexpectedResponse(response.status);
  }
  const failure = ErrorResultSchema.safeParse(json);
  return failure.success && !failure.data.ok ? failure.data : unexpectedResponse(response.status);
}
