"use client"

import Link from "next/link"
import { CloudRain, Plus, Shirt, Sparkles, Star } from "lucide-react"
import { useId } from "react"

import { useRefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { OutfitListItemDto } from "@/lib/outfits/contracts"
import { useSharedRefresh } from "@/lib/saved-since-read"

import { formatCalendarDay, formatRating, formatTimesWorn, formatWeatherRange } from "./format"
import type { WearActions } from "./outfit-actions"
import { useRefreshAfterOutfitChanges } from "./outfit-changes"
import { OutfitCollage } from "./outfit-thumbs"
import { WoreOutfitButton } from "./wore-outfit-button"

export type OutfitListProps = {
  /** The server's list, newest first; a new array on every read. */
  outfits: OutfitListItemDto[]
  actions: WearActions
}

/**
 * The saved outfits as cards. The list shows item names, photos and wear
 * counts, so it reads itself again when shown after an item or outfit change
 * elsewhere in the tab, and while shown after a wear or an Undo (D-107): one
 * read per show for both (useSharedRefresh).
 */
export function OutfitList({ outfits, actions }: OutfitListProps) {
  const refresh = useSharedRefresh()
  useRefreshAfterItemChanges(outfits, refresh)
  useRefreshAfterOutfitChanges(outfits, refresh)

  if (outfits.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Shirt aria-hidden />
          </EmptyMedia>
          <EmptyTitle>No outfits yet</EmptyTitle>
          <EmptyDescription>Put together items you like to wear together, then log when you wear them.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link href="/outfits/new" className={buttonVariants({ size: "touch" })}>
            <Plus aria-hidden />
            New outfit
          </Link>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <ul aria-label="Outfits" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {outfits.map((outfit) => (
        <li key={outfit.id} className="min-w-0">
          <OutfitCard outfit={outfit} actions={actions} />
        </li>
      ))}
    </ul>
  )
}

function OutfitCard({ outfit, actions }: { outfit: OutfitListItemDto; actions: WearActions }) {
  const titleId = useId()
  const weather = formatWeatherRange(outfit.weatherMinC, outfit.weatherMaxC)
  const pieces = outfit.items.map((item) => item.name).join(", ")

  return (
    <article
      aria-labelledby={titleId}
      className="flex h-full flex-col gap-3 rounded-xl border bg-card p-3 text-card-foreground"
    >
      <div className="flex gap-3">
        {/* A large tap target for touch; keyboard and screen-reader users have the name's link. */}
        <Link href={`/outfits/${outfit.id}`} tabIndex={-1} aria-hidden className="w-28 shrink-0 sm:w-32">
          <OutfitCollage items={outfit.items} />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 id={titleId} className="font-heading text-base leading-snug font-semibold break-words">
            <Link
              href={`/outfits/${outfit.id}`}
              className="-my-2.5 inline-block rounded-sm py-2.5 underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {outfit.name}
            </Link>
          </h2>
          {outfit.occasion !== null ? <p className="text-sm text-muted-foreground">{outfit.occasion}</p> : null}
          <div className="flex flex-wrap gap-1.5">
            {outfit.source === "ai" ? (
              <Badge variant="secondary">
                <Sparkles aria-hidden />
                AI
                <span className="sr-only"> suggestion</span>
              </Badge>
            ) : null}
            {weather !== null ? <Badge variant="outline">{weather}</Badge> : null}
            {outfit.rainOk ? (
              <Badge variant="outline">
                <CloudRain aria-hidden />
                Fine in rain
              </Badge>
            ) : null}
            {outfit.rating !== null ? (
              <Badge variant="outline">
                <Star aria-hidden />
                <span aria-hidden>{outfit.rating}/5</span>
                <span className="sr-only">{formatRating(outfit.rating)}</span>
              </Badge>
            ) : null}
          </div>
          <p className="text-sm">
            {formatTimesWorn(outfit.timesWorn)}
            {outfit.lastWornOn !== null ? (
              <span className="text-muted-foreground">
                {" · last "}
                <time dateTime={outfit.lastWornOn}>{formatCalendarDay(outfit.lastWornOn)}</time>
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <p className="line-clamp-2 text-sm text-muted-foreground">
        {outfit.items.length === 0 ? (
          "No items left: its items were deleted."
        ) : (
          <>
            <span className="sr-only">Items: </span>
            {pieces}
          </>
        )}
      </p>
      <WoreOutfitButton
        outfitId={outfit.id}
        outfitName={outfit.name}
        logWear={actions.logWear}
        undoWear={actions.undoWear}
        disabled={outfit.items.length === 0}
        describedBy={titleId}
        className="mt-auto self-start"
      />
    </article>
  )
}
