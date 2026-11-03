import Link from "next/link"
import { Luggage, SearchX } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

/**
 * /relocate/[id] and its print page for an id that is malformed or names no
 * analysis. Rendered by notFound() inside the page's Suspense child, so it
 * replaces the page within the app layout and the navigation stays usable.
 */
export default function RelocationNotFound() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          {/* The page's only h1: the page it replaces never rendered its own. */}
          <h1 className="font-heading text-xl font-semibold">Analysis not found</h1>
        </EmptyTitle>
        <EmptyDescription>
          This relocation analysis does not exist. It may have been deleted, or the link is incomplete.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link href="/relocate" className={buttonVariants({ size: "touch" })}>
          <Luggage aria-hidden />
          Go to Relocate
        </Link>
      </EmptyContent>
    </Empty>
  )
}
