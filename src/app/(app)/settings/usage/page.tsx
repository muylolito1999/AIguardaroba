import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { ArrowLeft } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { UsageSummaryView } from "@/components/usage/usage-summary"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { getUsageSummary } from "@/server/services/usage"

export const metadata: Metadata = {
  title: "AI usage",
}

// Static shell plus one Suspense child that reads the session and the
// database at request time (D-041).
export default function UsagePage() {
  return (
    <>
      <PageHeader
        title="AI usage"
        description="Claude spend against the monthly budget and the prepaid credit, plus Blob uploads."
        actions={
          <Link href="/settings" className={buttonVariants({ variant: "outline", size: "touch" })}>
            <ArrowLeft aria-hidden />
            Settings
          </Link>
        }
      />
      <Suspense fallback={<UsageSkeleton />}>
        <UsageContent />
      </Suspense>
    </>
  )
}

async function UsageContent() {
  // Also defers to request time, so the month window below reads the real clock.
  await verifySession()
  const summary = await getUsageSummary({ db: getDb(), now: new Date() })
  return <UsageSummaryView summary={summary} />
}

function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <p className="sr-only">Loading AI usage…</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-40 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-48 rounded-xl" />
    </div>
  )
}
