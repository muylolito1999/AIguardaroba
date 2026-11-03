import type { Metadata } from "next"
import { Suspense } from "react"

import { PageHeader } from "@/components/layout/page-header"
import { BackToOutfits } from "@/components/outfits/back-to-outfits"
import { NewOutfit } from "@/components/outfits/new-outfit"
import { OutfitFormSkeleton } from "@/components/outfits/skeletons"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { saveOutfit } from "@/server/actions/outfits"
import { listCandidatesBySlot } from "@/server/services/outfits"

export const metadata: Metadata = {
  title: "New outfit",
}

// Static shell (the back link and heading) plus one Suspense child that reads
// the session and every slot's items at request time (D-041).
export default function NewOutfitPage() {
  return (
    <div className="flex flex-col">
      <BackToOutfits className="mb-2" />
      <PageHeader title="New outfit" description="Pick an item for each slot you want to fill." />
      <Suspense fallback={<OutfitFormSkeleton />}>
        <NewOutfitContent />
      </Suspense>
    </div>
  )
}

async function NewOutfitContent() {
  await verifySession()
  const candidates = await listCandidatesBySlot(getDb())
  return <NewOutfit candidates={candidates} saveOutfit={saveOutfit} />
}
