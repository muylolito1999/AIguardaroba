import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { Suspense } from "react"
import { desc, inArray, sql } from "drizzle-orm"
import { CircleAlert, Info, Plus } from "lucide-react"

import { ReviewEmpty } from "@/components/items/review-empty"
import { ReviewList } from "@/components/items/review-list"
import { PageHeader } from "@/components/layout/page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb, type Db } from "@/lib/db"
import type { ItemStatus } from "@/lib/db/enums"
import { items } from "@/lib/db/schema"
import {
  confirmItem,
  confirmItems,
  pollTaggingBatches,
  startTaggingBatch,
  tagItemByHand,
  updateItemTags,
} from "@/server/actions/items"
import { loadItemCards } from "@/server/items/dto"
import { getTaggingSetupResult } from "@/server/services/tagging-setup"

export const metadata: Metadata = {
  title: "Review items",
}

/** Newest items the page loads; the list says so when more are waiting. */
const REVIEW_LIMIT = 200
const REVIEW_STATUSES: ItemStatus[] = ["pending_tagging", "tagged"]

// Static shell plus one Suspense child for the session, the batch poll and
// the database reads (D-041).
export default function ReviewPage() {
  return (
    <>
      <PageHeader
        title="Review items"
        description="Check Claude's tags, fix anything that is wrong, then confirm."
        actions={
          <Link href="/add" className={buttonVariants({ variant: "outline", size: "touch" })}>
            <Plus aria-hidden />
            Add more
          </Link>
        }
      />
      <Suspense fallback={<ReviewSkeleton />}>
        <ReviewItems />
      </Suspense>
    </>
  )
}

/** Item results applied by this visit's poll, and why any batch could not be checked. */
type PollOutcome = { processed: number; problems: string[] }

/**
 * Applies finished tagging batches before the list loads (the plan's "polled
 * on page visit", next to the daily cron). A failure must not hide the items
 * already here, so it becomes a notice instead of an error page. One batch
 * that cannot be read does not hide the results applied from the others.
 */
async function pollBatches(): Promise<PollOutcome> {
  try {
    const result = await pollTaggingBatches()
    if (!result.ok) return { processed: 0, problems: [result.error.message] }
    const problems = [...new Set(result.data.errors.map((error) => error.message))]
    return { processed: result.data.processed, problems }
  } catch (error) {
    // Lets Next's own control-flow errors (redirects, prerender bail-outs) through.
    unstable_rethrow(error)
    console.error("[review] polling tagging batches failed:", error)
    return { processed: 0, problems: ["Finished batches could not be checked."] }
  }
}

/** One problem as it is; several as a count with the first one. */
function pollProblemText(problems: readonly string[]): string {
  const [first = ""] = problems
  return problems.length === 1 ? first : `${problems.length} batches could not be checked: ${first}`
}

async function reviewItemIds(db: Db): Promise<{ ids: string[]; total: number }> {
  const waiting = inArray(items.status, REVIEW_STATUSES)
  const [rows, [count]] = await Promise.all([
    db
      .select({ id: items.id })
      .from(items)
      .where(waiting)
      .orderBy(desc(items.createdAt), desc(items.id))
      .limit(REVIEW_LIMIT),
    db
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(items)
      .where(waiting),
  ])
  return { ids: rows.map((row) => row.id), total: count?.total ?? rows.length }
}

async function ReviewItems() {
  await verifySession()
  const poll = await pollBatches()
  const db = getDb()
  // An invalid model or budget setting (CONFIG) disables only the tagging
  // controls, with the reason, so the owner can still review and confirm.
  const [{ ids, total }, tagging] = await Promise.all([reviewItemIds(db), getTaggingSetupResult(db, new Date())])
  const cards = await loadItemCards(db, ids)

  return (
    <div className="flex flex-col gap-6">
      {poll.problems.length > 0 ? (
        <Alert>
          <CircleAlert aria-hidden />
          <AlertTitle>Batch results not checked</AlertTitle>
          <AlertDescription>
            {pollProblemText(poll.problems)} Items in a batch may still show as waiting; reload the page to try
            again.
          </AlertDescription>
        </Alert>
      ) : null}
      {/* Shown next to the problem notice: results from the batches that could be read were applied. */}
      {poll.processed > 0 ? (
        // Good news, not a problem: announced politely.
        <Alert role="status">
          <Info aria-hidden />
          <AlertDescription>
            Applied {poll.processed} finished batch {poll.processed === 1 ? "result" : "results"}.
          </AlertDescription>
        </Alert>
      ) : null}
      {cards.length === 0 ? (
        <ReviewEmpty />
      ) : (
        <ReviewList
          items={cards}
          totalCount={total}
          tagging={tagging}
          actions={{ updateItemTags, confirmItem, confirmItems, startTaggingBatch, tagItemByHand }}
        />
      )}
    </div>
  )
}

function ReviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <p className="sr-only">Loading items to review…</p>
      <Skeleton className="h-20 rounded-xl" />
      {[0, 1].map((index) => (
        <div key={index} className="grid gap-4 rounded-xl p-4 ring-1 ring-foreground/10 md:grid-cols-[14rem_1fr]">
          <Skeleton className="aspect-square w-full max-w-xs rounded-lg" />
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}
