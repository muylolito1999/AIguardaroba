"use client"

import { toast } from "@/components/ui/toast"
import { errorToast, type AppErrorPayload, type Result } from "@/lib/result"

/**
 * Shows an error toast and returns its id. Titles come from `errorToast` so every
 * error code has one wording app-wide; messages are user-safe because
 * toErrorPayload strips internals.
 */
export function toastError(error: AppErrorPayload): string {
  return toast.add({
    ...errorToast(error),
    // Errors are announced assertively; success toasts stay polite.
    priority: "high",
  })
}

/**
 * Toasts a failed result, or the success title when one is given. Returns true on
 * success and narrows the result, so callers can read `result.data` afterwards.
 */
export function toastResult<T>(
  result: Result<T>,
  successTitle?: string
): result is Extract<Result<T>, { ok: true }> {
  if (!result.ok) {
    toastError(result.error)
    return false
  }
  if (successTitle) {
    toast.add({ title: successTitle, type: "success" })
  }
  return true
}
