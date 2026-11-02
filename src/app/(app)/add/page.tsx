import type { Metadata } from "next"
import { Camera } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export const metadata: Metadata = {
  title: "Add items",
}

export default function AddPage() {
  return (
    <>
      <PageHeader
        title="Add items"
        description="Photograph clothes and let Claude tag them."
      />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Camera />
          </EmptyMedia>
          <EmptyTitle>Uploads come in Phase 3</EmptyTitle>
          <EmptyDescription>
            Camera and photo-library upload, automatic tagging and the review step land in Phase 3.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  )
}
