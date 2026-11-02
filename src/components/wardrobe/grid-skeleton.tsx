import { Skeleton } from "@/components/ui/skeleton"

/**
 * Placeholder tiles in a CSS grid close to computeGridLayout's columns
 * (2 on phones, up to 6 on wide screens), so the swap to the real grid moves
 * little.
 */
export function GridSkeletonTiles({ count = 12 }: { count?: number }) {
  return (
    <div
      aria-hidden
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 p-1">
          <Skeleton className="aspect-square w-full rounded-lg" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

/** The /wardrobe Suspense fallback: toolbar, chip row and tiles, the same heights as the real ones. */
export function WardrobeSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <p className="sr-only" role="status">
        Loading your wardrobe…
      </p>
      <div className="flex flex-col gap-2 md:flex-row">
        <Skeleton className="h-11 w-full md:flex-1" />
        <div className="flex gap-2">
          <Skeleton className="h-11 w-24" />
          <Skeleton className="h-11 flex-1 md:w-44 md:flex-none" />
          <Skeleton className="h-11 w-24" />
        </div>
      </div>
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-11 w-28 shrink-0 rounded-full" />
        ))}
      </div>
      <Skeleton className="h-5 w-24" />
      <GridSkeletonTiles />
    </div>
  )
}
