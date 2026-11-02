"use client"

import Link from "next/link"
import { CircleAlert, RotateCcw } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { toErrorPayload } from "@/lib/result"

/** The digest Next attaches to errors from Server Components; it matches the server log entry. */
function digestOf(error: unknown): string | null {
  if (!(error instanceof Error) || !("digest" in error)) return null
  return typeof error.digest === "string" ? error.digest : null
}

/**
 * Errors thrown while rendering a page of the app, for example a database
 * outage or an invalid setting. It renders inside the (app) layout, so the
 * sidebar and the tab bar stay usable. In production Next replaces server
 * error messages with a generic one, so the text here never shows internals
 * (D-053); the digest ties the screen to the server log.
 */
export default function AppErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const { message } = toErrorPayload(error)
  const digest = digestOf(error)

  return (
    <>
      <PageHeader title="Something went wrong" description="This page could not be shown." />
      <div className="flex max-w-xl flex-col gap-4">
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>The page did not load</AlertTitle>
          <AlertDescription>
            <p>{message}</p>
            {digest !== null ? <p className="text-xs">Reference for the server log: {digest}</p> : null}
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="touch" onClick={() => retry()}>
            <RotateCcw aria-hidden />
            Try again
          </Button>
          <Link href="/settings" className={buttonVariants({ variant: "outline", size: "touch" })}>
            Settings
          </Link>
          <Link href="/settings/usage" className={buttonVariants({ variant: "outline", size: "touch" })}>
            AI usage
          </Link>
        </div>
      </div>
    </>
  )
}
