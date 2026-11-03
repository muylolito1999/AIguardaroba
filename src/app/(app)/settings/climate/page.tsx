import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { ArrowLeft } from "lucide-react"

import { ClimateProfiles } from "@/components/climate/climate-profiles"
import { PageHeader } from "@/components/layout/page-header"
import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { setDefaultClimateProfile, updateClimateProfile } from "@/server/actions/climate"
import { listClimateProfiles } from "@/server/services/climate"

export const metadata: Metadata = {
  title: "Climate profiles",
}

const ACTIONS = { updateClimateProfile, setDefaultClimateProfile }

// Static shell plus one Suspense child that reads the session and the
// profiles at request time (D-041).
export default function ClimateSettingsPage() {
  return (
    <>
      <PageHeader
        title="Climate profiles"
        description="Monthly climate values the relocation plan reasons from. An empty value means unknown."
        actions={
          <Link href="/settings" className={buttonVariants({ variant: "outline", size: "touch" })}>
            <ArrowLeft aria-hidden />
            Settings
          </Link>
        }
      />
      <Suspense fallback={<ClimateSkeleton />}>
        <ClimateContent />
      </Suspense>
    </>
  )
}

async function ClimateContent() {
  await verifySession()
  const profiles = await listClimateProfiles(getDb())
  return <ClimateProfiles profiles={profiles} actions={ACTIONS} />
}

function ClimateSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <p className="sr-only">Loading climate profiles…</p>
      {[0, 1].map((index) => (
        <Skeleton key={index} className="h-[40rem] rounded-xl" />
      ))}
    </div>
  )
}
