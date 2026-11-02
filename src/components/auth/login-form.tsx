"use client"

import { Suspense, useActionState, useEffect, useId, useRef } from "react"
import { useSearchParams } from "next/navigation"
import { CircleAlert, Loader2, LogIn } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { login, type LoginState } from "@/server/actions/auth"

const INITIAL_STATE: LoginState = {}

/**
 * The server action goes straight into useActionState and <form action>, so
 * the form also works before hydration and without JavaScript: the browser
 * posts it, the action redirects on success, and an error re-renders the page
 * with the returned state. That re-render needs /login to be fully static
 * (D-054), so nothing here reads the request on the server.
 */
export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, INITIAL_STATE)
  const passwordId = useId()
  const errorId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)
  const error = state.error

  // React clears the form after each submission; putting focus back in the
  // empty field lets the owner retype at once, and its aria-describedby makes
  // screen readers read the error again.
  useEffect(() => {
    if (state.error) passwordRef.current?.focus()
  }, [state])

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {error ? (
        <Alert variant="destructive" id={errorId}>
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor={passwordId}>Password</Label>
        <Input
          ref={passwordRef}
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          // The only field on a page that exists to fill it in.
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="h-11"
        />
      </div>
      {/* useSearchParams renders this on the client only, which keeps the page
          fully static. Before hydration the field is missing and the action
          reads `next` from the Referer instead. */}
      <Suspense fallback={null}>
        <NextField />
      </Suspense>
      <Button
        type="submit"
        size="touch"
        className="w-full"
        disabled={pending}
        // Keeps focus on the button while pending instead of dropping it to <body>.
        focusableWhenDisabled
        aria-busy={pending}
      >
        {pending ? <Loader2 className="animate-spin" /> : <LogIn />}
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}

/**
 * Carries the page the proxy bounced the visitor away from (`?next=`) into the
 * login action, which accepts only same-origin relative paths.
 */
function NextField() {
  const next = useSearchParams().get("next")
  if (!next) return null
  return <input type="hidden" name="next" value={next} />
}
