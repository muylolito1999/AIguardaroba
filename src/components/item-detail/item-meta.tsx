import type { ReactNode } from "react"

import type { ItemDetailDto } from "@/lib/items/wardrobe"

import { formatDay, formatWearCount } from "./format"

export type ItemMetaProps = {
  item: Pick<
    ItemDetailDto,
    "createdAt" | "updatedAt" | "wearCount" | "lastWornAt" | "aiModel" | "status" | "taggingError"
  >
}

/** Who tagged the item: Claude's model, the owner, or nobody yet. */
function taggedBy(item: ItemMetaProps["item"]): string {
  if (item.aiModel !== null) return item.aiModel
  // Tags without a model were filled in by hand (D-093); an archived item may have none at all.
  return item.status === "tagged" || item.status === "confirmed" ? "You, by hand" : "Not tagged yet"
}

/** Dates, wear history and tagging details, as a description list. */
export function ItemMeta({ item }: ItemMetaProps) {
  const rows: Array<{ term: string; value: ReactNode }> = [
    { term: "Added", value: <time dateTime={item.createdAt}>{formatDay(item.createdAt)}</time> },
    // As of the last full read (page load, archive or unarchive): edits return
    // item cards, which carry no updated_at. Days only, so that rarely shows.
    { term: "Last changed", value: <time dateTime={item.updatedAt}>{formatDay(item.updatedAt)}</time> },
    { term: "Worn", value: formatWearCount(item.wearCount) },
    {
      term: "Last worn",
      value: item.lastWornAt === null ? "Never" : <time dateTime={item.lastWornAt}>{formatDay(item.lastWornAt)}</time>,
    },
    { term: "Tagged by", value: <span className="break-all">{taggedBy(item)}</span> },
  ]
  if (item.taggingError !== null) {
    rows.push({
      term: "Last tagging error",
      value: <span className="text-destructive">{item.taggingError}</span>,
    })
  }

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {rows.map((row) => (
        <div key={row.term} className="contents">
          <dt className="text-muted-foreground">{row.term}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
