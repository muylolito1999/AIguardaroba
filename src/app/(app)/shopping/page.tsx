import type { Metadata } from "next"
import { ShoppingBag } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export const metadata: Metadata = {
  title: "Shopping",
}

export default function ShoppingPage() {
  return (
    <>
      <PageHeader title="Shopping" description="What to buy to fill the gaps in your wardrobe." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShoppingBag />
          </EmptyMedia>
          <EmptyTitle>The shopping list comes in Phases 5 and 6</EmptyTitle>
          <EmptyDescription>
            The list fed by relocation gaps lands in Phase 5; AI-ranked suggestions follow in
            Phase 6.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  )
}
