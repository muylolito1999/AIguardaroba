import { Skeleton } from "@/components/ui/skeleton"

/** The /outfits fallback: a few cards. */
export function OutfitListSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
      <p className="sr-only">Loading your outfits…</p>
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex flex-col gap-3 rounded-xl border p-3">
          <div className="flex gap-3">
            <Skeleton className="aspect-square w-28 shrink-0 rounded-lg sm:w-32" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-5 w-24" />
            </div>
          </div>
          <Skeleton className="h-11 w-40" />
        </div>
      ))}
    </div>
  )
}

/** The builder's fallback: the slot rows and the first fields. */
export function OutfitFormSkeleton() {
  return (
    <div className="flex max-w-2xl flex-col gap-4" aria-busy="true">
      <p className="sr-only">Loading your items…</p>
      <Skeleton className="h-6 w-24" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((index) => (
          <Skeleton key={index} className="h-16 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-6 w-24" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  )
}
