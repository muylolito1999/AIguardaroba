import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { Suspense } from "react"

import { BackToOutfits } from "@/components/outfits/back-to-outfits"
import { OutfitDetail } from "@/components/outfits/outfit-detail"
import { OutfitFormSkeleton } from "@/components/outfits/skeletons"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import type { Db } from "@/lib/db/client"
import { isUuid } from "@/lib/items/contracts"
import type { OutfitDetailDto } from "@/lib/outfits/contracts"
import { AppError } from "@/lib/result"
import { deleteOutfit, saveOutfit } from "@/server/actions/outfits"
import { logWear, undoWear } from "@/server/actions/wear"
import { getOutfit, listCandidatesBySlot } from "@/server/services/outfits"

// Static: the title cannot name the outfit, because reading it needs the
// session and the database, which only the Suspense child may touch (D-041).
export const metadata: Metadata = {
  title: "Outfit",
}

const ACTIONS = { saveOutfit, deleteOutfit, logWear, undoWear }

// Static shell (the skeleton, with a working back link) plus one Suspense
// child that awaits the params promise, checks the session and reads the
// outfit (D-041). notFound() there renders ./not-found.tsx in place of the page.
export default function OutfitPage({ params }: PageProps<"/outfits/[id]">) {
  return (
    <Suspense fallback={<OutfitPageSkeleton />}>
      <OutfitContent params={params} />
    </Suspense>
  )
}

async function OutfitContent({ params }: Pick<PageProps<"/outfits/[id]">, "params">) {
  const { id } = await params
  await verifySession()
  // A malformed id cannot be an outfit; answering not found here saves a query.
  if (!isUuid(id)) notFound()

  const db = getDb()
  const [outfit, candidates] = await Promise.all([loadOrNotFound(db, id), listCandidatesBySlot(db)])
  // Keyed by the outfit, so the builder starts from this outfit's values; a
  // refresh of the same outfit keeps the owner's edits.
  return <OutfitDetail key={outfit.id} outfit={outfit} candidates={candidates} actions={ACTIONS} />
}

/** The outfit, or the not-found page when it does not exist (deleted, or a stale link). */
async function loadOrNotFound(db: Db, id: string): Promise<OutfitDetailDto> {
  try {
    return await getOutfit(db, id)
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound()
    throw error
  }
}

function OutfitPageSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true">
      <BackToOutfits className="mb-2" />
      <p className="sr-only">Loading the outfit…</p>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56 max-w-full" />
          <Skeleton className="h-5 w-32" />
        </div>
        <Skeleton className="h-11 w-40" />
      </div>
      <Skeleton className="mb-8 h-5 w-48" />
      <OutfitFormSkeleton />
    </div>
  )
}
