import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { CONFIG_ERROR_MESSAGE, isAppError } from "@/lib/result"
import { addGapsToShoppingList } from "@/server/actions/relocation"
import { getShoppingAdviceState } from "@/server/services/shopping-advice"

import type { ShoppingAdviceStateDto } from "./advice-model"
import { AdvicePanel } from "./advice-panel"

// The "What to buy next" section of /shopping (D-040), a server component the
// page renders in its own Suspense boundary, below the list. With
// FEATURE_SHOPPING_AI off it renders nothing, and the service reads nothing
// but the flag. Item and shopping list changes elsewhere in the tab refresh
// the whole page through the list's own checks (D-107, D-151), which reads
// this section again too.

const SECTION_CLASS = "mt-10 border-t pt-8"

async function readState(): Promise<ShoppingAdviceStateDto | "misconfigured"> {
  try {
    return await getShoppingAdviceState(getDb())
  } catch (error) {
    // A flag or model variable with an unusable value: say so in the section
    // without its details (D-053), and keep the list above usable.
    if (!isAppError(error) || error.code !== "CONFIG") throw error
    console.error("[shopping-advice] configuration error:", error)
    return "misconfigured"
  }
}

export async function ShoppingAdviceSection() {
  await verifySession()
  const state = await readState()
  if (state === "misconfigured") {
    return (
      <section aria-label="What to buy next" className={SECTION_CLASS}>
        <Alert variant="destructive">
          <AlertTitle>What to buy next is unavailable</AlertTitle>
          <AlertDescription>{CONFIG_ERROR_MESSAGE}</AlertDescription>
        </Alert>
      </section>
    )
  }
  if (!state.enabled) return null
  return (
    <div className={SECTION_CLASS}>
      <AdvicePanel state={state} addGapsToShoppingList={addGapsToShoppingList} />
    </div>
  )
}
