import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"

import { BackToWardrobe } from "@/components/item-detail/back-to-wardrobe"
import { ItemDetail } from "@/components/item-detail/item-detail"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { isUuid } from "@/lib/items/contracts"
import type { ItemDetailDto } from "@/lib/items/wardrobe"
import { AppError } from "@/lib/result"
import {
  archiveItem,
  confirmItem,
  deleteItem,
  setItemCollection,
  setItemDecision,
  setItemLocation,
  tagItemByHand,
  unarchiveItem,
  updateItemTags,
} from "@/server/actions/items"
import { logWear, undoWear } from "@/server/actions/wear"
import { loadItemDetail } from "@/server/items/detail"

// Static: the title cannot name the item, because reading it needs the
// session and the database, which only the Suspense child may touch (D-041).
export const metadata: Metadata = {
  title: "Item",
}

// Static shell (the skeleton, with a working back link) plus one Suspense
// child that awaits the params promise, checks the session and reads the item
// (D-041). notFound() there renders ./not-found.tsx in place of the page.
export default function ItemDetailPage({ params }: PageProps<"/wardrobe/[id]">) {
  return (
    <Suspense fallback={<ItemDetailSkeleton />}>
      <ItemDetailContent params={params} />
    </Suspense>
  )
}

async function ItemDetailContent({ params }: Pick<PageProps<"/wardrobe/[id]">, "params">) {
  const { id } = await params
  await verifySession()
  // A malformed id cannot be an item; answering not found here saves a query.
  if (!isUuid(id)) notFound()

  const item = await loadOrNotFound(id)

  return (
    <ItemDetail
      item={item}
      actions={{
        updateItemTags,
        confirmItem,
        tagItemByHand,
        setItemDecision,
        setItemLocation,
        setItemCollection,
        archiveItem,
        unarchiveItem,
        deleteItem,
        logWear,
        undoWear,
      }}
    />
  )
}

/** The item, or the not-found page when it does not exist (deleted, or a stale link). */
async function loadOrNotFound(id: string): Promise<ItemDetailDto> {
  try {
    return await loadItemDetail(getDb(), id)
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound()
    throw error
  }
}

function ItemDetailSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true">
      <BackToWardrobe className="mb-2" />
      <p className="sr-only">Loading the item…</p>
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="grid gap-8 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Skeleton className="aspect-square w-full max-w-md rounded-lg md:max-w-none" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-6 w-40" />
          {/* The running gear switch, then the two plan toggles. The switch's
              row is its label and description: 44 px with one description
              line, 21 px more per extra line. Measured in Geist at 14 px, the
              description takes two lines on phones, one from sm, three to six
              in the narrow md column (four on 810 and 820 px tablets), two at
              lg and one from xl. */}
          <Skeleton className="h-16 w-full sm:h-11 md:h-26 lg:h-16 xl:h-11" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  )
}
