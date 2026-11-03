import Link from "next/link"
import { Shirt } from "lucide-react"

import { ItemPhoto } from "@/components/items/item-photo"
import { Badge } from "@/components/ui/badge"
import type { RelocationItemRefDto } from "@/lib/relocation/contracts"
import { cn } from "@/lib/utils"

/** The item's thumbnail, decorative: the name always follows it. */
export function ItemThumb({ item, className }: { item: RelocationItemRefDto | undefined; className?: string }) {
  if (item?.thumb == null) {
    return (
      <span
        aria-hidden
        className={cn("flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground", className)}
      >
        <Shirt className="size-4" />
      </span>
    )
  }
  return <ItemPhoto image={item.thumb} alt="" className={cn("shrink-0 rounded-md", className)} />
}

/** "Deleted" or "Archived" when the item changed since the run, or null. */
export function itemGoneLabel(item: RelocationItemRefDto | undefined): string | null {
  if (item === undefined || !item.exists) return "Deleted"
  if (item.status === "archived") return "Archived"
  return null
}

/**
 * An item named by a result: thumbnail and name, linking to its page. Items
 * deleted since the run cannot be opened and show greyed.
 */
export function ItemRef({ item, className }: { item: RelocationItemRefDto | undefined; className?: string }) {
  const gone = itemGoneLabel(item)
  const name = item?.name ?? "Unknown item"
  const content = (
    <>
      <ItemThumb item={item} className="size-10" />
      <span className="min-w-0 break-words text-pretty">{name}</span>
      {gone !== null ? <Badge variant="outline">{gone}</Badge> : null}
    </>
  )
  if (item === undefined || !item.exists) {
    return <span className={cn("flex min-h-11 items-center gap-2 text-muted-foreground opacity-70", className)}>{content}</span>
  }
  return (
    <Link
      href={`/wardrobe/${item.id}`}
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-md underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        gone !== null && "text-muted-foreground",
        className
      )}
    >
      {content}
    </Link>
  )
}
