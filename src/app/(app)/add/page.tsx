import type { Metadata } from "next"
import { Suspense } from "react"

import { AddFlow } from "@/components/add/add-flow"
import { AddFlowSkeleton } from "@/components/add/add-flow-skeleton"
import { PageHeader } from "@/components/layout/page-header"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { getTaggingSetupResult } from "@/server/services/tagging-setup"

export const metadata: Metadata = {
  title: "Add items",
}

// Static shell; the session, budget and model settings load in the Suspense
// child (D-041). Nothing here needs ANTHROPIC_API_KEY or the Blob token, so the
// page renders before either is configured and the flow reports what is missing.
// An invalid model or budget setting (CONFIG) disables only tagging; picking,
// uploading and registering photos keep working.
export default function AddPage() {
  return (
    <>
      <PageHeader
        title="Add items"
        description="Take photos or pick them from your library. They are resized on this device and uploaded; Claude tags them when you start tagging."
      />
      <Suspense fallback={<AddFlowSkeleton />}>
        <AddFlowSection />
      </Suspense>
    </>
  )
}

async function AddFlowSection() {
  await verifySession()
  const setup = await getTaggingSetupResult(getDb(), new Date())
  return <AddFlow setup={setup} />
}
