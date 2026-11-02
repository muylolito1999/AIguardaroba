"use client"

import { useId, useState } from "react"
import { ExternalLink } from "lucide-react"

import { ItemPhoto } from "@/components/items/item-photo"
import { RemoveBackgroundButton } from "@/components/items/remove-background-button"
import { ChoiceGroup } from "@/components/items/tag-form-controls"
import { buttonVariants } from "@/components/ui/button"
import type { ItemCardDto } from "@/lib/items/contracts"
import type { ItemDetailDto } from "@/lib/items/wardrobe"

import { formatBytes } from "./format"

const VIEWS = ["cutout", "photo"] as const
type View = (typeof VIEWS)[number]
const VIEW_LABELS: Record<View, string> = { cutout: "Cut-out", photo: "Photo" }

export type ItemGalleryProps = {
  item: ItemDetailDto
  /** The item's display name, for alt text. */
  name: string
  /** A new cut-out was stored; receives the server's card. */
  onCutout: (item: ItemCardDto) => void
}

/**
 * The processed photo large, or the background-free cut-out when there is
 * one (a toggle switches between the two), a link to the uploaded original in
 * a new tab, and background removal. The original is never shown inline: it
 * can be several megabytes, and the processed copy is made from it.
 */
export function ItemGallery({ item, name, onCutout }: ItemGalleryProps) {
  const viewLabelId = useId()
  const [preferred, setPreferred] = useState<View>("cutout")
  const { nobg, processed, thumb } = item.images
  const view: View = nobg !== null ? preferred : "photo"
  const image = view === "cutout" ? nobg : (processed ?? thumb)
  const original = item.original

  return (
    <div className="flex flex-col gap-3">
      <ItemPhoto
        image={image}
        alt={view === "cutout" ? `${name}, background removed` : `Photo of ${name}`}
        loading="eager"
        className="mx-auto aspect-square w-full max-w-md md:max-w-none"
      />
      {nobg !== null ? (
        <div className="flex flex-col gap-1.5">
          <p id={viewLabelId} className="text-sm font-medium">
            Show
          </p>
          <ChoiceGroup
            labelId={viewLabelId}
            values={VIEWS}
            labels={VIEW_LABELS}
            value={view}
            onChange={setPreferred}
            buttonRef={null}
          />
        </div>
      ) : null}
      {original !== null ? (
        <div className="flex flex-col gap-1">
          <a
            href={original.url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: "outline", size: "touch", className: "self-start" })}
          >
            <ExternalLink aria-hidden />
            Open original{" "}
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <p className="text-xs text-muted-foreground tabular-nums">
            As uploaded: {original.width} × {original.height} px, {formatBytes(original.bytes)}
          </p>
        </div>
      ) : null}
      {/* Optional and independent of tagging (D-034); it works from the processed photo. */}
      {processed !== null ? (
        <RemoveBackgroundButton
          item={item}
          onDone={(next) => {
            // Show what was just made.
            setPreferred("cutout")
            onCutout(next)
          }}
        />
      ) : null}
    </div>
  )
}
