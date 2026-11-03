import Link from "next/link"
import { SearchX, Shirt } from "lucide-react"

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
 * /outfits/[id] for an id that is malformed or names no outfit (deleted, or a
 * stale link). Rendered by notFound() inside the page's Suspense child, so it
 * replaces the page within the app layout and the navigation stays usable.
 */
export default function OutfitNotFound() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          {/* The page's only h1: the outfit page it replaces never rendered its own. */}
          <h1 className="font-heading text-xl font-semibold">Outfit not found</h1>
        </EmptyTitle>
        <EmptyDescription>
          This outfit does not exist. It may have been deleted, or the link is incomplete.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link href="/outfits" className={buttonVariants({ size: "touch" })}>
          <Shirt aria-hidden />
          Go to your outfits
        </Link>
      </EmptyContent>
    </Empty>
  )
}
