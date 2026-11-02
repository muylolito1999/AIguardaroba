import type { Metadata } from "next"
import Link from "next/link"
import { Plus, Shirt } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

// Absolute, because the template would render "Wardrobe · Wardrobe".
export const metadata: Metadata = {
  title: { absolute: "Wardrobe" },
}

export default function WardrobePage() {
  return (
    <>
      <PageHeader title="Wardrobe" description="Everything you own, tagged and searchable." />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Shirt />
          </EmptyMedia>
          <EmptyTitle>Browsing comes in Phase 4</EmptyTitle>
          <EmptyDescription>
            Filters, search and the photo grid land in Phase 4. Until then, start by adding a few
            items.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {/* A styled Link rather than Button render={<Link />}: Base UI's Button adds
              type="button" or role="button" to the anchor, which misstates it as a button. */}
          <Link href="/add" className={buttonVariants({ size: "touch" })}>
            <Plus />
            Add items
          </Link>
        </EmptyContent>
      </Empty>
    </>
  )
}
