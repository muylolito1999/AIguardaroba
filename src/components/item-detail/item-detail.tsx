"use client"

import { useCallback, useId, useLayoutEffect, useRef, useState } from "react"
import { Archive, Clock, Layers } from "lucide-react"

import { ItemTagForm } from "@/components/items/item-tag-form"
import { RefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import { hasTags } from "@/components/items/tag-form-model"
import { CATEGORY_LABELS, STATUS_LABELS } from "@/components/items/tag-options"
import { requestTagging } from "@/components/items/tag-request"
import { PageHeader } from "@/components/layout/page-header"
import { Badge } from "@/components/ui/badge"
import type { ItemDecision, ItemLocation, ItemStatus } from "@/lib/db/enums"
import { focusWasLost } from "@/lib/focus"
import type { ItemCardDto } from "@/lib/items/contracts"
import { itemDisplayName, type ItemDetailDto } from "@/lib/items/wardrobe"
import { noteWardrobeChange } from "@/lib/items/wardrobe-changes"

import { BackToWardrobe } from "./back-to-wardrobe"
import { DangerZone } from "./danger-zone"
import type { ItemDetailActions } from "./detail-actions"
import { ItemGallery } from "./item-gallery"
import { ItemMeta } from "./item-meta"
import { PendingTags } from "./pending-tags"
import { PlanToggles } from "./plan-toggles"
import { WornToday } from "./worn-today"

const STATUS_BADGE: Record<ItemStatus, "default" | "secondary" | "outline"> = {
  pending_tagging: "secondary",
  tagged: "outline",
  confirmed: "default",
  archived: "secondary",
}

export type ItemDetailProps = {
  item: ItemDetailDto
  actions: ItemDetailActions
  /** Injected by tests; POSTs /api/items/[id]/tag otherwise. */
  tagRequest?: typeof requestTagging
}

/**
 * The whole item detail page below the static shell: photos, the move plan
 * and location toggles, the tags (the review form, the tagging controls or an
 * archived notice), dates and wear history, and archive or delete.
 *
 * Next keeps this page mounted but hidden (Activity) after a navigation and
 * serves Back and Forward from its client cache, with the item as it was
 * read. When an item change was noted in this tab since (the review page
 * confirmed or tagged it, say), the page reads itself again when shown
 * (D-107), and the newer server item replaces the local copy. Its own saves
 * already show here, so a change noted while it is shown does not refresh it.
 * A form with unsaved edits keeps them, and its other fields take the newer
 * values (useTagForm), so a Save never sends back what changed elsewhere.
 * Every update from a request changes only the fields that request owns, so a
 * late answer never undoes something newer.
 */
export function ItemDetail({ item: serverItem, actions, tagRequest = requestTagging }: ItemDetailProps) {
  const [item, setItem] = useState(serverItem)
  const [lastServerItem, setLastServerItem] = useState(serverItem)
  const tagsHeadingRef = useRef<HTMLHeadingElement>(null)
  const tagsSectionRef = useRef<HTMLElement>(null)
  const focusTagsRef = useRef(false)
  const planId = useId()
  const tagsId = useId()
  const detailsId = useId()
  const dangerId = useId()

  if (serverItem !== lastServerItem) {
    setLastServerItem(serverItem)
    setItem(serverItem)
  }

  const name = itemDisplayName(item)
  const tagged = hasTags(item)

  // The tagging controls give way to the form once the item has tags; the
  // heading takes focus so keyboard and screen-reader users land on the new
  // form, unless they moved elsewhere during the call.
  useLayoutEffect(() => {
    if (!tagged || !focusTagsRef.current) return
    focusTagsRef.current = false
    const active = document.activeElement
    if (focusWasLost(active) || tagsSectionRef.current?.contains(active)) tagsHeadingRef.current?.focus()
  }, [tagged])

  const patchItem = useCallback((patch: Partial<ItemDetailDto>) => {
    setItem((previous) => ({ ...previous, ...patch }))
    // Every patch follows a change the server confirmed; the wardrobe list,
    // kept as it was in Next's back/forward cache, reads itself again (D-107).
    noteWardrobeChange()
  }, [])

  /** A request that owns every tag field (Save, Confirm, Re-tag, tagging) returned the server's card. */
  const applyCard = useCallback(
    (card: ItemCardDto) => {
      // The card has every ItemCardDto field; the detail-only ones stay as they are.
      patchItem(card)
    },
    [patchItem]
  )

  // The wear logger already noted the change (D-107); only the counts shown here follow.
  const applyWearCounts = useCallback((counts: Pick<ItemDetailDto, "wearCount" | "lastWornAt">) => {
    setItem((previous) => ({ ...previous, ...counts }))
  }, [])

  function handleTagged(card: ItemCardDto) {
    focusTagsRef.current = true
    applyCard(card)
  }

  return (
    <div className="flex flex-col">
      <RefreshAfterItemChanges snapshot={serverItem} refreshWhileShown={false} />
      <BackToWardrobe className="mb-2" />
      <PageHeader
        title={name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_BADGE[item.status]}>
              {item.status === "archived" ? <Archive aria-hidden /> : null}
              {STATUS_LABELS[item.status]}
            </Badge>
            {item.category !== null ? (
              <span>
                {CATEGORY_LABELS[item.category]}
                {item.subcategory !== null && item.subcategory.trim() !== "" ? ` · ${item.subcategory}` : ""}
              </span>
            ) : null}
            {item.multipleItemsDetected ? (
              <Badge variant="outline">
                <Layers aria-hidden />
                Several items in photo
              </Badge>
            ) : null}
            {item.taggingBatchId !== null ? (
              <Badge variant="outline">
                <Clock aria-hidden />
                In batch
              </Badge>
            ) : null}
          </span>
        }
      />

      <div className="grid gap-8 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="md:sticky md:top-4 md:self-start">
          <ItemGallery item={item} name={name} onCutout={(card) => patchItem({ images: card.images })} />
        </div>

        <div className="flex min-w-0 flex-col gap-10">
          <section aria-labelledby={planId} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 id={planId} className="font-heading text-lg font-semibold">
                Plan and location
              </h2>
              <p className="text-sm text-muted-foreground">Each choice is saved as soon as you make it.</p>
            </div>
            <PlanToggles
              itemId={item.id}
              decision={item.decision}
              location={item.location}
              setItemDecision={actions.setItemDecision}
              setItemLocation={actions.setItemLocation}
              onDecisionSaved={(decision: ItemDecision) => patchItem({ decision })}
              onLocationSaved={(location: ItemLocation) => patchItem({ location })}
            />
          </section>

          <section ref={tagsSectionRef} aria-labelledby={tagsId} className="flex flex-col gap-4">
            <h2
              ref={tagsHeadingRef}
              id={tagsId}
              tabIndex={-1}
              className="font-heading text-lg font-semibold outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Tags
            </h2>
            {item.multipleItemsDetected ? (
              <p className="text-sm text-muted-foreground">
                Claude saw more than one item in the photo and tagged the most prominent one.
              </p>
            ) : null}
            {item.status === "archived" ? (
              <p className="text-sm text-muted-foreground text-pretty">
                Archived items cannot be edited. Unarchive this item below to change its tags.
              </p>
            ) : tagged ? (
              <ItemTagForm
                mode="detail"
                item={item}
                updateItemTags={actions.updateItemTags}
                confirmItem={actions.confirmItem}
                onItemChange={applyCard}
                tagRequest={tagRequest}
              />
            ) : (
              <PendingTags
                item={item}
                tagItemByHand={actions.tagItemByHand}
                tagRequest={tagRequest}
                onTagged={handleTagged}
                onTaggingError={(message) => patchItem({ taggingError: message })}
              />
            )}
          </section>

          <section aria-labelledby={detailsId} className="flex flex-col gap-4">
            <h2 id={detailsId} className="font-heading text-lg font-semibold">
              Details
            </h2>
            <ItemMeta item={item} />
            <WornToday
              item={item}
              name={name}
              logWear={actions.logWear}
              undoWear={actions.undoWear}
              onCountsChange={applyWearCounts}
            />
          </section>

          <section
            aria-labelledby={dangerId}
            className="flex flex-col gap-4 rounded-xl border border-destructive/30 p-4"
          >
            <h2 id={dangerId} className="font-heading text-lg font-semibold">
              Archive or delete
            </h2>
            <DangerZone
              item={item}
              name={name}
              archiveItem={actions.archiveItem}
              unarchiveItem={actions.unarchiveItem}
              deleteItem={actions.deleteItem}
              onStatusChange={(detail) => patchItem({ status: detail.status, updatedAt: detail.updatedAt })}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
