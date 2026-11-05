import { Skeleton } from "@/components/ui/skeleton"

/** Suspense fallback for the add flow: the running-gear switch, the picker buttons and the drop zone. */
export function AddFlowSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      {/* The "Adding running gear" row: label, a description of one or two lines, and the switch. */}
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-4 w-2/3 md:hidden" />
        </div>
        <Skeleton className="h-[18.4px] w-8 rounded-full" />
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 md:flex-row">
          <Skeleton className="h-14 w-full md:h-11 md:w-36" />
          <Skeleton className="h-11 w-full md:w-40" />
          <Skeleton className="hidden h-11 w-40 md:block" />
        </div>
        <Skeleton className="hidden h-36 w-full rounded-xl md:block" />
      </div>
    </div>
  )
}
