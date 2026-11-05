import Link from "next/link"
import { ChartColumn, Plus } from "lucide-react"

import {
  CATEGORY_LABELS,
  DECISION_LABELS,
  LOCATION_LABELS,
  WARMTH_RUBRIC,
} from "@/components/items/tag-options"
import { formatCount } from "@/components/usage/format"
import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ITEM_CATEGORIES, ITEM_DECISIONS, ITEM_LOCATIONS } from "@/lib/db/enums"
import { WARMTH_LEVELS } from "@/lib/items/contracts"
import type { WardrobeStatsDto } from "@/server/services/stats"

import { BarTable, type BarRow } from "./bar-table"
import { WinterChecklist } from "./winter-checklist"

// Server-rendered view of the wardrobe stats. Every number is printed as
// text; the bars only repeat it visually. The breakdowns count clothes only;
// running gear has its own tile, and the winter checklist counts it too (D-249).

function itemsPhrase(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "item" : "items"}`
}

/** Categories largest first, so the bars compare at a glance; ties keep the enum order. */
export function categoryRows(byCategory: WardrobeStatsDto["byCategory"]): BarRow[] {
  return ITEM_CATEGORIES.map((category, order) => ({ category, order, value: byCategory[category] }))
    .toSorted((a, b) => b.value - a.value || a.order - b.order)
    .map(({ category, value }) => ({ key: category, label: CATEGORY_LABELS[category], value }))
}

function Tile({ term, value }: { term: string; value: number }) {
  // justify-between keeps the numbers in a row level when a term wraps.
  return (
    <div className="flex flex-col justify-between gap-0.5 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      {/* Proportional figures: a standalone number, not a column. */}
      <dd className="text-2xl font-semibold">{formatCount(value)}</dd>
    </div>
  )
}

function Overview({ totals }: { totals: WardrobeStatsDto["totals"] }) {
  return (
    <section aria-labelledby="stats-overview-title" className="flex flex-col gap-3">
      <h2 id="stats-overview-title" className="font-heading text-base font-semibold">
        Overview
      </h2>
      {/* Six tiles: two or three to a row, all six once there is room. */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile term="Items" value={totals.all} />
        <Tile term="Confirmed" value={totals.confirmed} />
        <Tile term="Tagged, not confirmed" value={totals.tagged} />
        <Tile term="Waiting for tags" value={totals.pending} />
        <Tile term="Archived" value={totals.archived} />
        <Tile term="Running gear" value={totals.running} />
      </dl>
      <p className="text-sm text-muted-foreground">
        Items counts your clothes except archived ones. Archived items and running gear are counted only in their
        own tiles; the winter checklist also counts running gear.
      </p>
      {totals.pending > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-muted/50 p-4">
          <p className="min-w-0 flex-1 basis-60 text-sm">
            {itemsPhrase(totals.pending)} {totals.pending === 1 ? "is" : "are"} waiting for tags and{" "}
            {totals.pending === 1 ? "is" : "are"} left out of the category, warmth, weather and winter numbers.
          </p>
          <Link href="/add/review" className={buttonVariants({ variant: "outline", size: "touch" })}>
            Review untagged items
          </Link>
        </div>
      ) : null}
    </section>
  )
}

function NothingTagged() {
  return (
    <section aria-labelledby="stats-tags-title" className="flex flex-col gap-1">
      <h2 id="stats-tags-title" className="font-heading text-base font-semibold">
        Categories, warmth and weather
      </h2>
      <p className="text-sm text-muted-foreground">These appear once at least one piece of clothing is tagged.</p>
    </section>
  )
}

function NoItems({ archived }: { archived: number }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ChartColumn />
        </EmptyMedia>
        <EmptyTitle>No items yet</EmptyTitle>
        <EmptyDescription>
          Add photos of your clothes and the counts, warmth spread and winter checklist show up here.
          {archived > 0 ? ` ${itemsPhrase(archived)} archived and not counted.` : null}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link href="/add" className={buttonVariants({ size: "touch" })}>
          <Plus aria-hidden />
          Add items
        </Link>
      </EmptyContent>
    </Empty>
  )
}

export function StatsView({ stats }: { stats: WardrobeStatsDto }) {
  const { totals } = stats
  // Running gear alone still shows the page: its tile and the winter
  // checklist, which counts it (D-249).
  if (totals.all === 0 && totals.running === 0) return <NoItems archived={totals.archived} />

  const taggedTotal = totals.tagged + totals.confirmed
  const taggedBase = `Tagged and confirmed clothes (${formatCount(taggedTotal)}).`
  const allBase = `All clothes except archived ones, untagged included (${formatCount(totals.all)}).`

  return (
    <div className="flex min-w-0 flex-col gap-10">
      <Overview totals={totals} />
      <WinterChecklist rows={stats.winterReadiness} />
      <div className="grid min-w-0 gap-x-12 gap-y-10 lg:grid-cols-2">
        {taggedTotal === 0 ? (
          <NothingTagged />
        ) : (
          <>
            <BarTable
              id="stats-category"
              title="By category"
              description={taggedBase}
              labelHeader="Category"
              rows={categoryRows(stats.byCategory)}
            />
            <BarTable
              id="stats-warmth"
              title="Warmth"
              description={`${taggedBase} From 1, summer and very light, to 5, heavy winter.`}
              labelHeader="Warmth level"
              rows={WARMTH_LEVELS.map((level) => ({
                key: String(level),
                label: (
                  <>
                    <span className="font-medium tabular-nums">{level}</span> {WARMTH_RUBRIC[level].label}
                  </>
                ),
                hint: WARMTH_RUBRIC[level].examples ?? undefined,
                value: stats.warmth[level],
              }))}
            />
            <BarTable
              id="stats-weather"
              title="Weather protection"
              description={`${taggedBase} Each bar is a share of all of them.`}
              labelHeader="Protection"
              max={taggedTotal}
              rows={[
                { key: "waterproof", label: "Waterproof", value: stats.flags.waterproof },
                { key: "windproof", label: "Windproof", value: stats.flags.windproof },
                { key: "insulated", label: "Insulated", value: stats.flags.insulated },
              ]}
            />
          </>
        )}
        <BarTable
          id="stats-decision"
          title="Decisions"
          description={allBase}
          labelHeader="Decision"
          rows={ITEM_DECISIONS.map((decision) => ({
            key: decision,
            label: DECISION_LABELS[decision],
            value: stats.byDecision[decision],
          }))}
        />
        <BarTable
          id="stats-location"
          title="Locations"
          description={allBase}
          labelHeader="Location"
          rows={ITEM_LOCATIONS.map((location) => ({
            key: location,
            label: LOCATION_LABELS[location],
            value: stats.byLocation[location],
          }))}
        />
      </div>
    </div>
  )
}
