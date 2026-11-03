import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { isAppError } from "@/lib/result"
import { getShoppingAdviceFlag } from "@/server/services/shopping-advice"

// The read-only feature switches in Settings. They live in the server
// environment, so the page only says how each is set and how to change it.
// Read at request time inside the page's Suspense boundary (D-041), so the
// row shows the running server's value, not the one seen at build time.

type FlagState = "on" | "off" | "unreadable"

async function shoppingAdviceState(): Promise<FlagState> {
  try {
    return (await getShoppingAdviceFlag()).enabled ? "on" : "off"
  } catch (error) {
    // An unusable value: shown without its details (D-053).
    if (!isAppError(error) || error.code !== "CONFIG") throw error
    console.error("[settings] FEATURE_SHOPPING_AI could not be read:", error)
    return "unreadable"
  }
}

const BADGE_TEXT: Record<FlagState, string> = { on: "On", off: "Off", unreadable: "Unreadable" }

function Explanation({ state }: { state: FlagState }) {
  switch (state) {
    case "on":
      return (
        <>
          &ldquo;What to buy next&rdquo; shows on{" "}
          <Link href="/shopping" className="underline underline-offset-4 hover:text-foreground">
            Shopping
          </Link>
          . Each ranking is a paid Claude call; the section shows its estimated cost first.
        </>
      )
    case "off":
      return (
        <>
          &ldquo;What to buy next&rdquo; is hidden on Shopping. To show it, set FEATURE_SHOPPING_AI to true in the server
          environment and redeploy. Each ranking is then a paid Claude call.
        </>
      )
    case "unreadable":
      return <>The server setting has a value it cannot use. Check the server logs.</>
  }
}

export async function FeatureFlags() {
  await verifySession()
  const state = await shoppingAdviceState()
  return (
    <section className="flex flex-col gap-3" aria-labelledby="settings-features-heading">
      <div className="flex flex-col gap-1">
        <h2 id="settings-features-heading" className="font-heading text-base font-semibold">
          Features
        </h2>
        <p className="text-sm text-muted-foreground">
          Optional features are switched on in the server environment, so they cannot be changed here.
        </p>
      </div>
      <div className="flex flex-col gap-1 rounded-lg border p-3">
        <p className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">Shopping advice</span>
          <Badge variant={state === "on" ? "default" : state === "off" ? "outline" : "destructive"}>{BADGE_TEXT[state]}</Badge>
        </p>
        <p className="text-sm text-pretty text-muted-foreground">
          <Explanation state={state} />
        </p>
      </div>
    </section>
  )
}

export function FeatureFlagsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <p className="sr-only">Loading features…</p>
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-4 w-72 max-w-full" />
      <Skeleton className="h-20 rounded-lg" />
    </div>
  )
}
