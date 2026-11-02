import Link from "next/link"
import { CheckCheck, Plus, Shirt } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

type ReviewEmptyProps = {
  /** True once this visit confirmed the last item; the copy then says so. */
  afterConfirming?: boolean
  /** id for the title, so the list can move focus to it after the last card leaves. */
  titleId?: string
}

/** Nothing left to review. Shared by the page (no items at all) and the list (all confirmed). */
export function ReviewEmpty({ afterConfirming = false, titleId }: ReviewEmptyProps) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CheckCheck aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          <h2 id={titleId} tabIndex={titleId ? -1 : undefined} className="outline-none">
            {afterConfirming ? "All caught up" : "Nothing to review"}
          </h2>
        </EmptyTitle>
        <EmptyDescription>
          {afterConfirming
            ? "Every item here is confirmed and in your wardrobe."
            : "New photos show up here once they are uploaded, so you can check Claude's tags."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="sm:flex-row sm:justify-center">
        {/* Styled links rather than Button render={<Link />}: Base UI's Button would
            add a button role to the anchor. */}
        <Link href="/add" className={buttonVariants({ size: "touch" })}>
          <Plus aria-hidden />
          Add items
        </Link>
        <Link href="/wardrobe" className={buttonVariants({ variant: "outline", size: "touch" })}>
          <Shirt aria-hidden />
          Wardrobe
        </Link>
      </EmptyContent>
    </Empty>
  )
}
