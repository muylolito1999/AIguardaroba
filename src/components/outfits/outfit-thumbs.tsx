import { ImageOff, Shirt } from "lucide-react"

import type { OutfitItemDto } from "@/lib/outfits/contracts"
import { cn } from "@/lib/utils"

/** Thumbs in a collage; an outfit with more shows "+N" on the last tile. */
const COLLAGE_TILES = 4

type ItemThumbProps = {
  url: string | null
  /** Empty when the name is next to the thumb, so it is not read twice. */
  alt: string
  className?: string
}

/**
 * An item's thumbnail as a plain <img> (the thumbs are made at upload, D-033),
 * square and contained, or a placeholder when it has none. The <picture>
 * wrapper is what Next's no-img-element lint rule accepts.
 */
export function ItemThumb({ url, alt, className }: ItemThumbProps) {
  if (url === null) {
    return (
      <span
        className={cn(
          "flex aspect-square shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
          className
        )}
      >
        <ImageOff aria-hidden className="size-4" />
        {alt === "" ? null : <span className="sr-only">{alt}, no photo</span>}
      </span>
    )
  }
  return (
    <picture className={cn("block aspect-square shrink-0 overflow-hidden rounded-md bg-muted", className)}>
      <img src={url} alt={alt} width={96} height={96} loading="lazy" decoding="async" className="size-full object-contain" />
    </picture>
  )
}

/**
 * Up to four item thumbs in a 2 × 2 grid, the main pieces first (the items
 * come in slot order). Decorative: the card lists the outfit's items as text.
 */
export function OutfitCollage({ items, className }: { items: readonly OutfitItemDto[]; className?: string }) {
  if (items.length === 0) {
    return (
      <div
        aria-hidden
        className={cn("flex aspect-square items-center justify-center rounded-lg bg-muted text-muted-foreground", className)}
      >
        <Shirt className="size-8" />
      </div>
    )
  }
  const shown = items.slice(0, COLLAGE_TILES)
  const more = items.length - shown.length
  return (
    <div aria-hidden className={cn("grid aspect-square grid-cols-2 gap-1 rounded-lg bg-muted/50 p-1", className)}>
      {shown.map((item, index) => (
        <div key={item.itemId} className="relative">
          <ItemThumb url={item.thumbUrl} alt="" className="size-full bg-background" />
          {more > 0 && index === shown.length - 1 ? (
            <span className="absolute inset-0 flex items-center justify-center rounded-md bg-background/75 text-sm font-medium">
              +{more + 1}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
