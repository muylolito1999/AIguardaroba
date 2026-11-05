"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import type { ItemCollection } from "@/lib/db/enums"
import { cn } from "@/lib/utils"

import { previousWardrobeListHref, readNavigation, wardrobeListHref } from "./wardrobe-return"

export type BackToWardrobeProps = {
  /**
   * The item's current collection, whose view the plain link opens (D-251).
   * The loading shell cannot know the item and leaves it out: clothing.
   */
  collection?: ItemCollection
  className?: string
}

/**
 * The back link. A plain link to the wardrobe view of the item's collection
 * (/wardrobe, or /wardrobe?collection=running for running gear), unless the
 * previous history entry is the wardrobe list: then it goes back in history,
 * so the filters, scroll position and the list's state return as they were.
 * When something about an item was saved meanwhile, the list notices and reads
 * itself again (noteWardrobeChange, D-107), so going back never shows the old
 * item.
 */
export function BackToWardrobe({ collection = "clothing", className }: BackToWardrobeProps) {
  const router = useRouter()

  return (
    <Link
      href={wardrobeListHref(collection)}
      // Only plain client-side navigations come here: modifier clicks open a new tab as usual.
      onNavigate={(event) => {
        if (previousWardrobeListHref(readNavigation(), window.location.origin) === null) return
        event.preventDefault()
        router.back()
      }}
      className={cn(buttonVariants({ variant: "ghost", size: "touch" }), "-ml-3 self-start", className)}
    >
      <ArrowLeft aria-hidden />
      Back to wardrobe
    </Link>
  )
}
