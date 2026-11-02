import type { Metadata } from "next"
import { Luggage } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export const metadata: Metadata = {
  title: "Relocate",
}

export default function RelocatePage() {
  return (
    <>
      <PageHeader
        title="Relocate"
        description="Decide what to bring, leave, donate or sell for a new climate."
      />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Luggage />
          </EmptyMedia>
          <EmptyTitle>Relocation planning comes in Phase 5</EmptyTitle>
          <EmptyDescription>
            Climate-based bring, leave and donate advice, gaps to fill and a packing checklist land
            in Phase 5.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  )
}
