import type { Metadata } from "next"
import { Suspense } from "react"

import { PageHeader } from "@/components/layout/page-header"
import { RelocationForm } from "@/components/relocate/relocation-form"
import { RelocationHistory } from "@/components/relocate/relocation-history"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { defaultRelocationDates } from "@/lib/relocation/contracts"
import { estimateRelocation, startRelocation } from "@/server/actions/relocation"
import { listClimateProfiles } from "@/server/services/climate"
import { listRelocationAnalyses } from "@/server/services/relocation"

export const metadata: Metadata = {
  title: "Relocate",
}

// Static shell (D-041): the header and the skeleton prerender; the session,
// the climate profiles and the earlier runs are read in the Suspense child.
export default function RelocatePage() {
  return (
    <>
      <PageHeader
        title="Relocate"
        description="Decide what to bring, leave, donate or sell for a new climate, what to buy, and how to pack."
      />
      <Suspense fallback={<RelocateSkeleton />}>
        <RelocateContent />
      </Suspense>
    </>
  )
}

async function RelocateContent() {
  await verifySession()
  const db = getDb()
  const [profiles, runs] = await Promise.all([listClimateProfiles(db), listRelocationAnalyses(db)])
  // After the session check, so this runs at request time, never in the prerender.
  const defaultDates = defaultRelocationDates(new Date())
  return (
    <div className="flex flex-col gap-12">
      <RelocationForm
        profiles={profiles}
        defaultDates={defaultDates}
        actions={{ estimateRelocation, startRelocation }}
      />
      <RelocationHistory runs={runs} />
    </div>
  )
}

function RelocateSkeleton() {
  return (
    <div className="flex max-w-2xl flex-col gap-6" aria-busy="true">
      <p className="sr-only">Loading the relocation form…</p>
      <Skeleton className="h-16 w-full" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-11 w-36" />
    </div>
  )
}
