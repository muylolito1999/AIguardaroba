"use client"

import { memo, useCallback, type ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useRefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import { useRefreshAfterShoppingChanges } from "@/components/shopping/shopping-changes"
import type { ItemDecision } from "@/lib/db/enums"
import type { PackingRowDto, RelocationViewDto } from "@/lib/relocation/contracts"
import { useSavedOverlay, useServerCopy } from "@/lib/saved-since-read"

import type { RelocationResultActions } from "./actions"
import {
  formatCalendarDay,
  formatDay,
  formatEur,
  formatMonths,
  formatUsdEstimate,
  modelLabel,
  notComingNote,
  plural,
} from "./format"
import { GapsTab } from "./results-gaps"
import { ItemsTab } from "./results-items"
import { LayeringTab, WarningsTab } from "./results-layering"
import { PackingTab } from "./results-packing"

// Panels whose props are the view and stable actions: memoised, so a decision
// or a packing change re-renders only the panels that show it (D-174).
const GapsPanel = memo(GapsTab)
const LayeringPanel = memo(LayeringTab)
const WarningsPanel = memo(WarningsTab)

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

function SummaryCard({ view }: { view: RelocationViewDto }) {
  const meta = view.result.meta
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Summary</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="whitespace-pre-line text-pretty">{view.result.summary}</p>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Climate">
            <span className="flex flex-wrap items-center gap-2">
              {view.profile === null ? "Profile removed" : `${view.profile.city}, ${view.profile.country}`}
              {view.profile?.isPlaceholder ? <Badge variant="outline">Placeholder data</Badge> : null}
            </span>
          </Fact>
          <Fact label="Period">
            {formatCalendarDay(view.params.dateFrom)} to {formatCalendarDay(view.params.dateTo)} ·{" "}
            {formatMonths(view.months)}
          </Fact>
          <Fact label="Items analysed">{plural(meta.item_count, "item", "items")}</Fact>
          <Fact label="Purchase budget">
            {view.params.purchaseBudgetEur === null ? "None given" : formatEur(view.params.purchaseBudgetEur)}
          </Fact>
          <Fact label="Model">
            {modelLabel(view.model)}
            {view.effort === null ? "" : ` · ${view.effort} effort`}
          </Fact>
          <Fact label="Cost">
            {formatUsdEstimate(view.costUsd)}
            {view.estimatedCostUsd === null ? "" : ` (estimated ${formatUsdEstimate(view.estimatedCostUsd)})`}
          </Fact>
          <Fact label="Finished">{view.completedAt === null ? "Not yet" : formatDay(view.completedAt)}</Fact>
        </dl>
      </CardContent>
    </Card>
  )
}

export type RelocationResultsProps = {
  view: RelocationViewDto
  actions: RelocationResultActions
}

/**
 * A finished relocation analysis: the summary, then tabs for the items
 * (with the owner's overrides), gaps, layering systems, the packing checklist
 * and warnings. The panels stay mounted while another tab is shown, so
 * selections and drafts survive switching.
 */
export function RelocationResults({ view, actions }: RelocationResultsProps) {
  // Every read of this page goes through one refresh, so the saves shown over
  // the view survive a copy read before them, and one show reads once (D-180).
  const copy = useServerCopy(view)
  // The cards show each item's current decision, name and photo: Back after
  // an item change elsewhere in the tab reads them again (D-107). Its own
  // overrides already show, so changes noted while shown do not (D-151).
  useRefreshAfterItemChanges(view, copy.refresh, { refreshWhileShown: false })
  // The Gaps tab shows which gaps are on the shopping list. A gap row deleted
  // on /shopping is noted there, and Back to this page, kept by Next, reads
  // it again so the gap can be added again (D-173).
  useRefreshAfterShoppingChanges(view, copy.refresh)

  // Decisions saved here that the view may not hold yet; the Items and
  // Packing tabs both read the owner's decision through this.
  const [savedDecisions, saveDecision] = useSavedOverlay<ItemDecision>(copy)
  const decisionOf = (itemId: string): ItemDecision =>
    savedDecisions.get(itemId) ?? view.items[itemId]?.currentDecision ?? "undecided"
  // Packing extras added or removed here: the Packing tab's count and its
  // panel show the same rows.
  const [addedRows, saveAddedRow] = useSavedOverlay<PackingRowDto>(copy)
  const [removedRows, saveRemovedRow] = useSavedOverlay<true>(copy)
  // Stable, so the Packing tab's memoised rows keep their props (D-174).
  const onExtraRemoved = useCallback((rowId: string) => saveRemovedRow(rowId, true), [saveRemovedRow])
  // An extra the view already holds shows once: a read asked for before the add
  // can reach the server after it, and the overlay keeps the row until a read
  // asked for after the add arrives (D-180, D-183).
  const listedIds = new Set(view.packing.map((row) => row.id))
  const packingRows = [...view.packing, ...[...addedRows.values()].filter((row) => !listedIds.has(row.id))].filter(
    (row) => !removedRows.has(row.id)
  )
  const result = view.result
  const aiDecisions = new Map(result.items.map((entry) => [entry.item_id, entry.decision]))
  // A row whose item is no longer coming is marked and left out of the counts (D-181).
  const comingCount = packingRows.filter(
    (row) => row.itemId === null || notComingNote(decisionOf(row.itemId), aiDecisions.get(row.itemId)) === null
  ).length

  const tabs = [
    { value: "items", label: "Items", count: result.items.length },
    { value: "gaps", label: "Gaps", count: result.gaps.length },
    { value: "layering", label: "Layering", count: result.layering_systems.length },
    { value: "packing", label: "Packing", count: comingCount },
    { value: "warnings", label: "Warnings", count: result.warnings.length },
  ] as const

  return (
    <div className="flex flex-col gap-6">
      <SummaryCard view={view} />
      <Tabs defaultValue="items" className="gap-4">
        {/* The list's height is set under the tabs' data-horizontal variant; this
            replaces it, so the 44 px triggers can wrap onto a second row at 390 px.
            The triggers drop their 100 %-of-the-list height for the same reason:
            with two rows each grew to the list's full height, and the second row
            spilled over the content below. */}
        <TabsList className="w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto sm:w-fit">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="h-auto min-h-11 flex-none px-3">
              {`${tab.label} `}
              {/* The trigger's own colour: muted text on the muted tab list was
                  4.3:1, below AA for 12 px text. */}
              <span className="text-xs tabular-nums">{tab.count}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="items" keepMounted>
          <ItemsTab
            view={view}
            decisionOf={decisionOf}
            onDecisionSaved={saveDecision}
            refresh={copy.refresh}
            actions={{
              setItemDecision: actions.setItemDecision,
              applyAiDecisionsToUndecided: actions.applyAiDecisionsToUndecided,
            }}
          />
        </TabsContent>
        <TabsContent value="gaps" keepMounted>
          <GapsPanel view={view} copy={copy} addGapsToShoppingList={actions.addGapsToShoppingList} />
        </TabsContent>
        <TabsContent value="layering" keepMounted>
          <LayeringPanel view={view} />
        </TabsContent>
        <TabsContent value="packing" keepMounted>
          <PackingTab
            view={view}
            copy={copy}
            rows={packingRows}
            onExtraAdded={(row) => saveAddedRow(row.id, row)}
            onExtraRemoved={onExtraRemoved}
            decisionOf={decisionOf}
            actions={{
              setPackingItemPacked: actions.setPackingItemPacked,
              addPackingExtra: actions.addPackingExtra,
              deletePackingExtra: actions.deletePackingExtra,
            }}
          />
        </TabsContent>
        <TabsContent value="warnings" keepMounted>
          <WarningsPanel view={view} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
