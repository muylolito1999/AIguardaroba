import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { ArrowLeft } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import { formatMonths } from "@/components/relocate/format"
import { RelocationResults } from "@/components/relocate/relocation-results"
import { RunProgress } from "@/components/relocate/run-progress"
import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { isUuid } from "@/lib/items/contracts"
import { AppError } from "@/lib/result"
import { setItemDecision } from "@/server/actions/items"
import {
  addGapsToShoppingList,
  addPackingExtra,
  applyAiDecisionsToUndecided,
  deletePackingExtra,
  setPackingItemPacked,
} from "@/server/actions/relocation"
import { getRelocationRun, loadRelocationView } from "@/server/services/relocation"

// Static: the title cannot name the place, because reading the run needs the
// session and the database, which only the Suspense child may touch (D-041).
export const metadata: Metadata = {
  title: "Relocation plan",
}

// One Suspense child awaits the params promise, checks the session and reads
// the run (D-041). An unfinished run shows its progress, which continues it in
// the browser; a finished one shows the results. notFound() renders
// ./not-found.tsx in place of the page.
export default function RelocationRunPage({ params }: PageProps<"/relocate/[id]">) {
  return (
    <Suspense fallback={<RelocationRunSkeleton />}>
      <RelocationRunContent params={params} />
    </Suspense>
  )
}

/** The value, or the not-found page when the analysis does not exist. */
async function orNotFound<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound()
    throw error
  }
}

function BackToRelocate() {
  return (
    <Link href="/relocate" className={buttonVariants({ variant: "outline", size: "touch" })}>
      <ArrowLeft aria-hidden />
      Relocate
    </Link>
  )
}

async function RelocationRunContent({ params }: Pick<PageProps<"/relocate/[id]">, "params">) {
  const { id } = await params
  await verifySession()
  // A malformed id cannot be an analysis; answering not found here saves a query.
  if (!isUuid(id)) notFound()
  const db = getDb()

  const run = await orNotFound(() => getRelocationRun(db, id))
  if (run.status !== "complete") {
    return (
      <>
        <PageHeader
          title="Relocation analysis"
          description="Claude decides on every item in parts, then writes the summary, gaps and packing list."
          actions={<BackToRelocate />}
        />
        {/* Keyed by the run, so another analysis's page never inherits this one's state. */}
        <RunProgress key={run.analysisId} run={run} />
      </>
    )
  }

  const view = await orNotFound(() => loadRelocationView(db, id))
  const place = view.profile === null ? "Relocation" : view.profile.city
  return (
    <>
      {/* RelocationResults reads the page again after item and shopping-list
          changes elsewhere in the tab, through one refresh that keeps its own
          saves (D-107, D-173, D-180). */}
      <PageHeader
        title={`${place} plan`}
        description={`${formatMonths(view.months)} · what to bring, buy and pack.`}
        actions={<BackToRelocate />}
      />
      <RelocationResults
        view={view}
        actions={{
          setItemDecision,
          applyAiDecisionsToUndecided,
          addGapsToShoppingList,
          setPackingItemPacked,
          addPackingExtra,
          deletePackingExtra,
        }}
      />
    </>
  )
}

function RelocationRunSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <p className="sr-only">Loading the analysis…</p>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-11 w-full max-w-md" />
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    </div>
  )
}
