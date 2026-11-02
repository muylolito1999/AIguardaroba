import Link from "next/link"
import { Archive, Plus, SearchX, Shirt } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { DEFAULT_ITEM_FILTERS } from "@/lib/items/filters"

import { wardrobeHref } from "./use-wardrobe-filters"

export type WardrobeEmptyProps =
  | { kind: "no-items" }
  | {
      kind: "all-archived"
      /** Archived items, which the default view hides. */
      archived: number
    }
  | {
      kind: "no-matches"
      /** Clears search and every filter (the sort stays). */
      onReset: () => void
    }

const ARCHIVED_HREF = wardrobeHref({ ...DEFAULT_ITEM_FILTERS, status: ["archived"] })

/**
 * The grid's empty states: nothing in the wardrobe yet, every item archived
 * (so the default view shows none), or nothing matching the filters.
 */
export function WardrobeEmpty(props: WardrobeEmptyProps) {
  if (props.kind === "all-archived") {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Archive aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h2>{props.archived === 1 ? "Your only item is archived" : `All ${props.archived} items are archived`}</h2>
          </EmptyTitle>
          <EmptyDescription>
            Archived items stay out of the wardrobe until you unarchive them on their page.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center">
          {/* Styled Links rather than Button render={<Link />}: Base UI's Button
              would add a button role to the anchor. */}
          <Link href={ARCHIVED_HREF} className={buttonVariants({ size: "touch" })}>
            <Archive aria-hidden />
            Show archived items
          </Link>
          <Link href="/add" className={buttonVariants({ variant: "outline", size: "touch" })}>
            <Plus aria-hidden />
            Add items
          </Link>
        </EmptyContent>
      </Empty>
    )
  }

  if (props.kind === "no-items") {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Shirt aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h2>No items yet</h2>
          </EmptyTitle>
          <EmptyDescription>Photograph your clothes and they will show up here once uploaded.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {/* A styled Link rather than Button render={<Link />}: Base UI's Button
              would add a button role to the anchor. */}
          <Link href="/add" className={buttonVariants({ size: "touch" })}>
            <Plus aria-hidden />
            Add items
          </Link>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchX aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          <h2>No items match</h2>
        </EmptyTitle>
        <EmptyDescription>Try a different search, or reset the filters to see everything again.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button type="button" variant="outline" size="touch" onClick={props.onReset}>
          Reset filters
        </Button>
      </EmptyContent>
    </Empty>
  )
}
