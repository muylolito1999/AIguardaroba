"use client"

import { Loader2, LogOut } from "lucide-react"
import { useFormStatus } from "react-dom"

import { Button } from "@/components/ui/button"
import { logout } from "@/server/actions/auth"

type LogoutButtonProps = {
  variant?: "outline" | "ghost"
  /** `touch` gives the 44 px target; the sidebar uses it too to match its 44 px rows. */
  size?: "touch" | "default"
  /** Sizes the form; the button fills it, so `self-start` keeps it compact in a column. */
  className?: string
}

/**
 * A plain form posting to the logout action, so it works without JavaScript;
 * the action clears the session cookie and redirects to /login.
 */
export function LogoutButton({ variant = "outline", size = "touch", className }: LogoutButtonProps) {
  return (
    <form action={logout} className={className}>
      <LogoutSubmit variant={variant} size={size} />
    </form>
  )
}

// useFormStatus reads the enclosing form, so the button must be its own component.
function LogoutSubmit({ variant, size }: Required<Pick<LogoutButtonProps, "variant" | "size">>) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className="w-full"
      disabled={pending}
      focusableWhenDisabled
      aria-busy={pending}
    >
      {pending ? <Loader2 className="animate-spin" /> : <LogOut />}
      Log out
    </Button>
  )
}
