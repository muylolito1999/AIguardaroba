import { ImageOff } from "lucide-react"

import type { ItemImageRef } from "@/lib/items/contracts"
import { cn } from "@/lib/utils"

type ItemPhotoProps = {
  image: ItemImageRef | null
  /** Describes the photo; the item's name is usually enough. */
  alt: string
  className?: string
  /** Eager for the first cards on screen, lazy for the rest. */
  loading?: "eager" | "lazy"
}

/**
 * A Blob photo as a plain <img>: the processed and thumbnail sizes are made at
 * upload (D-033), so the Image Optimization quota is never used. The <picture>
 * wrapper is what Next's no-img-element lint rule accepts as a deliberate
 * unoptimized image. width and height reserve the space before it loads.
 */
export function ItemPhoto({ image, alt, className, loading = "lazy" }: ItemPhotoProps) {
  if (image === null) {
    return (
      <div
        className={cn(
          "flex aspect-square w-full items-center justify-center rounded-lg bg-muted text-muted-foreground",
          className
        )}
      >
        <ImageOff aria-hidden className="size-6" />
        <span className="sr-only">No photo</span>
      </div>
    )
  }
  return (
    <picture className={cn("block overflow-hidden rounded-lg bg-muted", className)}>
      <img
        src={image.url}
        alt={alt}
        width={image.width}
        height={image.height}
        loading={loading}
        decoding="async"
        className="h-full w-full object-contain"
      />
    </picture>
  )
}
