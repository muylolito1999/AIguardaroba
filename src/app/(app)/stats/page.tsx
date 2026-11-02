import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { ArrowLeft } from "lucide-react"

import { RefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import { PageHeader } from "@/components/layout/page-header"
import { StatsView } from "@/components/stats/stats-view"
import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { getWardrobeStats } from "@/server/services/stats"

export const metadata: Metadata = {
  title: "Stats",
}

// Static shell plus one Suspense child that reads the session and the
// database at request time (D-041).
export default function StatsPage() {
  return (
    <>
      <PageHeader
        title="Stats"
        description="What the wardrobe holds, and whether it is ready for a Hamburg winter."
        actions={
          <Link href="/wardrobe" className={buttonVariants({ variant: "outline", size: "touch" })}>
            <ArrowLeft aria-hidden />
            Wardrobe
          </Link>
        }
      />
      <Suspense fallback={<StatsSkeleton />}>
        <StatsContent />
      </Suspense>
    </>
  )
}

async function StatsContent() {
  await verifySession()
  const stats = await getWardrobeStats(getDb())
  return (
    <>
      {/* Back from an item changed meanwhile (a checklist link, say) reads
          the stats again instead of showing them as they were (D-107). */}
      <RefreshAfterItemChanges snapshot={stats.totals} />
      <StatsView stats={stats} />
    </>
  )
}

function StatsSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-busy="true">
      <p className="sr-only">Loading stats…</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((index) => (
          <Skeleton key={index} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-2">
        {[0, 1].map((index) => (
          <Skeleton key={index} className="h-64 rounded-xl" />
        ))}
      </div>
    </div>
  )
}
