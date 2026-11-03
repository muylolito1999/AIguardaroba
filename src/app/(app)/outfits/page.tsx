import type { Metadata } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { Suspense } from "react"

import { PageHeader } from "@/components/layout/page-header"
import { OutfitList } from "@/components/outfits/outfit-list"
import { OutfitListSkeleton } from "@/components/outfits/skeletons"
import { buttonVariants } from "@/components/ui/button"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { logWear, undoWear } from "@/server/actions/wear"
import { listOutfits } from "@/server/services/outfits"

export const metadata: Metadata = {
  title: "Outfits",
}

const ACTIONS = { logWear, undoWear }

// Static shell plus one Suspense child that reads the session and the
// outfits at request time (D-041).
export default function OutfitsPage() {
  return (
    <>
      <PageHeader
        title="Outfits"
        description="Items you like to wear together, and how often you wore them."
        actions={
          <Link href="/outfits/new" className={buttonVariants({ size: "touch" })}>
            <Plus aria-hidden />
            New outfit
          </Link>
        }
      />
      <Suspense fallback={<OutfitListSkeleton />}>
        <OutfitsContent />
      </Suspense>
    </>
  )
}

async function OutfitsContent() {
  await verifySession()
  const outfits = await listOutfits(getDb())
  // OutfitList reads the list again after item and outfit changes elsewhere in the tab (D-107).
  return <OutfitList outfits={outfits} actions={ACTIONS} />
}
