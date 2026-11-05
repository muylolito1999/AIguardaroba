import Link from "next/link"
import { Archive, Footprints, Plus, SearchX, Shirt } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { ItemCollection } from "@/lib/db/enums"
import { DEFAULT_ITEM_FILTERS } from "@/lib/items/filters"

import { wardrobeHref } from "./use-wardrobe-filters"

export type WardrobeEmptyProps =
  | {
      kind: "no-items"
      /** The view that has no items (D-251). */
      collection: ItemCollection
    }
  | {
      kind: "all-archived"
      /** The view whose items are all archived; its link keeps to that view. */
      collection: ItemCollection
      /** Archived items, which the default view hides. */
      archived: number
    }
  | {
      kind: "no-matches"
      /** Clears search and every filter (the sort and the view stay). */
      onReset: () => void
    }

/** The archived items of one view. */
function archivedHref(collection: ItemCollection) {
  return wardrobeHref({ ...DEFAULT_ITEM_FILTERS, collection, status: ["archived"] })
}

function archivedTitle(collection: ItemCollection, archived: number): string {
  if (collection === "clothing") {
    return archived === 1 ? "Your only item is archived" : `All ${archived} items are archived`
  }
  return archived === 1
    ? "Your only piece of running gear is archived"
    : `All ${archived} pieces of running gear are archived`
}

/**
 * The grid's empty states: nothing in this view yet, every item of it
 * archived (so the default statuses show none), or nothing matching the
 * filters. The Clothes and Running views each have their own (D-251).
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
            <h2>{archivedTitle(props.collection, props.archived)}</h2>
          </EmptyTitle>
          <EmptyDescription>
            Archived items stay out of the wardrobe until you unarchive them on their page.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center">
          {/* Styled Links rather than Button render={<Link />}: Base UI's Button
              would add a button role to the anchor. */}
          <Link href={archivedHref(props.collection)} className={buttonVariants({ size: "touch" })}>
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

  if (props.kind === "no-items" && props.collection === "clothing") {
    // Worded for this view only, so it holds whether or not the Running view
    // has gear, with no extra count to read (D-251).
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Shirt aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h2>No clothes yet</h2>
          </EmptyTitle>
          <EmptyDescription>
            Photograph your clothes and they will show up here once uploaded. Running gear is under “Running”.
          </EmptyDescription>
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

  if (props.kind === "no-items") {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Footprints aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h2>No running gear yet</h2>
          </EmptyTitle>
          <EmptyDescription>
            Turn on the “Adding running gear” switch on Add items before you add the photos, or move an item
            here with the “Running gear” switch on its page.
          </EmptyDescription>
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
