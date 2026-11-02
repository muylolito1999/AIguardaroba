import Link from "next/link"
import { Droplets, Layers, Thermometer, Wind } from "lucide-react"
import type { ReactNode } from "react"

import { ItemPhoto } from "@/components/items/item-photo"
import { CATEGORY_LABELS, DECISION_LABELS, STATUS_LABELS } from "@/components/items/tag-options"
import type { ItemStatus } from "@/lib/db/enums"
import { itemDisplayName, type WardrobeItemDto } from "@/lib/items/wardrobe"
import { cn } from "@/lib/utils"

/**
 * Status badges, worded like the Status filter, the item page and /stats
 * (STATUS_LABELS); a confirmed item needs none.
 */
const STATUS_BADGES: Partial<Record<ItemStatus, string>> = {
  pending_tagging: STATUS_LABELS.pending_tagging,
  tagged: STATUS_LABELS.tagged,
  archived: STATUS_LABELS.archived,
}

function CardBadge({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "status" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[0.7rem] font-medium whitespace-nowrap [&>svg]:size-3",
        tone === "status"
          ? "border border-foreground/25 text-foreground"
          : "bg-secondary text-secondary-foreground"
      )}
    >
      {children}
    </span>
  )
}

/** The badges a card shows, in a fixed order, as text (never colour alone). */
function cardBadges(item: WardrobeItemDto): ReactNode[] {
  const badges: ReactNode[] = []
  const status = STATUS_BADGES[item.status]
  if (status !== undefined) {
    badges.push(
      <CardBadge key="status" tone="status">
        {status}
      </CardBadge>
    )
  }
  if (item.warmthLevel !== null) {
    badges.push(
      <CardBadge key="warmth">
        <Thermometer aria-hidden />
        <span aria-hidden>{item.warmthLevel}</span>
        <span className="sr-only">Warmth {item.warmthLevel} of 5</span>
      </CardBadge>
    )
  }
  if (item.waterproof === true) {
    badges.push(
      <CardBadge key="waterproof">
        <Droplets aria-hidden />
        Waterproof
      </CardBadge>
    )
  }
  if (item.windproof === true) {
    badges.push(
      <CardBadge key="windproof">
        <Wind aria-hidden />
        Windproof
      </CardBadge>
    )
  }
  if (item.decision !== "undecided") {
    badges.push(<CardBadge key="decision">{DECISION_LABELS[item.decision]}</CardBadge>)
  }
  if (item.wearCount > 0) {
    badges.push(
      <CardBadge key="wear">
        <span aria-hidden>Worn {item.wearCount}×</span>
        <span className="sr-only">
          Worn {item.wearCount} {item.wearCount === 1 ? "time" : "times"}
        </span>
      </CardBadge>
    )
  }
  if (item.multipleItemsDetected) {
    badges.push(
      <CardBadge key="several">
        <Layers aria-hidden />
        Several items
      </CardBadge>
    )
  }
  return badges
}

export type ItemCardProps = {
  item: WardrobeItemDto
  /** Eager for the first rows on screen, lazy for the rest. */
  loading?: "eager" | "lazy"
}

/**
 * One wardrobe tile. The link holds the photo, the display name and the
 * category, which are its accessible name, so a screen reader says "Navy
 * coat, Outerwear" and then the badges, which describe it. The badges sit
 * after the link rather than inside it: a link whose name leaves out part of
 * its visible text fails WCAG 2.5.3 (axe label-content-name-mismatch). The
 * link's ::after covers the whole card, so a tap on a badge still opens the
 * item, and the card draws the focus ring. The photo's alt is empty because
 * the name is already the link text.
 */
export function ItemCard({ item, loading = "lazy" }: ItemCardProps) {
  const name = itemDisplayName(item)
  const nameId = `wardrobe-item-${item.id}-name`
  const categoryId = `wardrobe-item-${item.id}-category`
  const badgesId = `wardrobe-item-${item.id}-badges`
  const badges = cardBadges(item)

  return (
    <div className="group/card relative flex min-w-0 flex-col gap-1 rounded-xl p-1 transition-colors hover:bg-muted/60 has-[a:focus-visible]:ring-3 has-[a:focus-visible]:ring-ring has-[a:focus-visible]:ring-offset-2 has-[a:focus-visible]:ring-offset-background">
      <Link
        href={`/wardrobe/${item.id}`}
        aria-labelledby={item.category === null ? nameId : `${nameId} ${categoryId}`}
        aria-describedby={badges.length > 0 ? badgesId : undefined}
        className="flex min-w-0 flex-col gap-2 outline-none after:absolute after:inset-0 after:rounded-xl"
      >
        <ItemPhoto image={item.thumb} alt="" loading={loading} className="aspect-square w-full rounded-lg" />
        <span className="flex min-w-0 flex-col gap-1 px-0.5">
          <span id={nameId} className="truncate text-sm font-medium text-foreground">
            {name}
          </span>
          {/* A space between name and category in the text, so the visible text
              reads "Navy coat Outerwear" like the name; the flex layout ignores it. */}
          {" "}
          {item.category !== null ? (
            <span id={categoryId} className="truncate text-xs text-muted-foreground">
              {CATEGORY_LABELS[item.category]}
            </span>
          ) : null}
        </span>
      </Link>
      {badges.length > 0 ? (
        <span id={badgesId} className="flex flex-wrap gap-1 px-0.5 pb-0.5">
          {badges}
        </span>
      ) : null}
    </div>
  )
}
