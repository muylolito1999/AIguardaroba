import { Skeleton } from "@/components/ui/skeleton"

/** Suspense fallback for the add flow: the picker buttons and the drop zone. */
export function AddFlowSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 md:flex-row">
        <Skeleton className="h-14 w-full md:h-11 md:w-36" />
        <Skeleton className="h-11 w-full md:w-40" />
        <Skeleton className="hidden h-11 w-40 md:block" />
      </div>
      <Skeleton className="hidden h-36 w-full rounded-xl md:block" />
    </div>
  )
}
