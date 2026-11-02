// How add-flow failures read in the queue and in toasts. Server payloads are
// already safe to show (toErrorPayload strips internals); this only adds
// context the generic messages lack, chiefly for CONFIG, which reaches the
// browser as one fixed message whatever is misconfigured (D-053). The hints
// describe the setting rather than spell out the variable name, so the client
// bundle stays free of server variable names (the Phase 3 build check greps
// for them); README's Environment section maps them to variables.

import { errorToast, isAppError, type AppErrorPayload } from "@/lib/result"

import type { UploadStep } from "./upload-queue"

export type AddFlowStep = UploadStep | "tag" | "batch"

export type DescribedError = {
  /** Short, for the entry's status line. */
  error: AppErrorPayload
  toast: { title: string; description: string; type: "error" }
}

const CONFIG_BY_STEP: Record<AddFlowStep, { message: string; hint: string }> = {
  prepare: { message: "The server is misconfigured.", hint: "Check the server logs." },
  check: { message: "The server is misconfigured.", hint: "Check the server logs." },
  // The upload token and register both need the Blob store's read-write token.
  upload: {
    message: "Uploads are not configured on the server.",
    hint: "Check that the Blob store's read-write token is set in the server environment, then see the server logs.",
  },
  register: {
    message: "Uploads are not configured on the server.",
    hint: "Check that the Blob store's read-write token is set in the server environment, then see the server logs.",
  },
  tag: {
    message: "Tagging is not configured on the server.",
    hint: "Check that the Anthropic API key is set in the server environment, then see the server logs.",
  },
  batch: {
    message: "Tagging is not configured on the server.",
    hint: "Check that the Anthropic API key is set in the server environment, then see the server logs.",
  },
}

export function describeError(step: AddFlowStep, error: AppErrorPayload): DescribedError {
  if (error.code === "CONFIG") {
    const { message, hint } = CONFIG_BY_STEP[step]
    return {
      error: { code: "CONFIG", message },
      toast: { ...errorToast(error), description: `${message} ${hint}` },
    }
  }
  const toast = errorToast(error)
  return { error, toast: step === "prepare" ? { ...toast, title: "Photo could not be read" } : toast }
}

/**
 * prepareImage() throws AppErrors with user-facing messages ("This photo is
 * too large to upload."); anything else is a browser decode failure whose
 * text is not meant for users.
 */
export function prepareFailure(thrown: unknown): AppErrorPayload {
  if (isAppError(thrown)) return { code: thrown.code, message: thrown.message }
  return { code: "VALIDATION", message: "Could not read this photo." }
}

/** One toast per step and error code: repeated failures update it instead of stacking. */
export function toastIdFor(step: AddFlowStep, error: AppErrorPayload): string {
  return `add-${step}-${error.code}`
}
