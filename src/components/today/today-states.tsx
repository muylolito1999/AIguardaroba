import Link from "next/link"
import { MapPin } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import { buttonVariants } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

/** /today without a home city: nothing to forecast, so it points at Settings. */
export function NoHomeCity() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MapPin />
        </EmptyMedia>
        <EmptyTitle>No home city yet</EmptyTitle>
        <EmptyDescription>
          Today shows the weather and suggests outfits for your home city. Choose Bologna or Hamburg in Settings.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link href="/settings" className={buttonVariants({ size: "touch" })}>
          Open Settings
        </Link>
      </EmptyContent>
    </Empty>
  )
}

/**
 * The page's heading (its date and city come with the data) and the shape of
 * the weather card and the suggestion button while the page reads.
 */
export function TodaySkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <PageHeader title="Today" description="Loading today’s weather…" className="mb-0" />
      <Skeleton className="h-44 rounded-xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-11 w-44" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
    </div>
  )
}
