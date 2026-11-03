import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { ArrowLeft } from "lucide-react"

import { RefreshPrintWhenShown } from "@/components/relocate/packing-changes"
import { PrintButton } from "@/components/relocate/print-button"
import { PrintChecklist } from "@/components/relocate/print-checklist"
import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { isUuid } from "@/lib/items/contracts"
import { AppError } from "@/lib/result"
import { getRelocationRun, loadRelocationView } from "@/server/services/relocation"

export const metadata: Metadata = {
  title: "Packing checklist",
}

// The packing checklist on its own, for paper. Static shell plus one Suspense
// child that awaits the params, checks the session and reads the analysis
// (D-041). The app's navigation is hidden in print by its own print:hidden.
export default function RelocationPrintPage({ params }: PageProps<"/relocate/[id]/print">) {
  return (
    <Suspense fallback={<PrintSkeleton />}>
      <PrintContent params={params} />
    </Suspense>
  )
}

async function orNotFound<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound()
    throw error
  }
}

function PrintActions({ id, canPrint }: { id: string; canPrint: boolean }) {
  return (
    <div className="mb-6 flex flex-wrap gap-2 print:hidden">
      <Link href={`/relocate/${id}`} className={buttonVariants({ variant: "outline", size: "touch" })}>
        <ArrowLeft aria-hidden />
        Back to the plan
      </Link>
      {canPrint ? <PrintButton /> : null}
    </div>
  )
}

async function PrintContent({ params }: Pick<PageProps<"/relocate/[id]/print">, "params">) {
  const { id } = await params
  await verifySession()
  if (!isUuid(id)) notFound()
  const db = getDb()

  const run = await orNotFound(() => getRelocationRun(db, id))
  if (run.status !== "complete") {
    return (
      <>
        <PrintActions id={id} canPrint={false} />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Packing checklist</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This analysis has not finished yet, so there is no checklist to print.
        </p>
      </>
    )
  }

  const view = await orNotFound(() => loadRelocationView(db, id))
  return (
    <>
      {/* A new object per server read: Forward after unticking a box or changing a decision on the plan reads again (D-173, D-181). */}
      <RefreshPrintWhenShown read={{ analysisId: view.id }} />
      <PrintActions id={id} canPrint />
      <PrintChecklist view={view} />
    </>
  )
}

function PrintSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <p className="sr-only">Loading the checklist…</p>
      <Skeleton className="h-11 w-48" />
      <Skeleton className="h-8 w-56 max-w-full" />
      <div className="grid gap-6 sm:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-40 w-full" />
        ))}
      </div>
    </div>
  )
}
