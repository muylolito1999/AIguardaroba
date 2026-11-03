"use client"

import { useId, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import Link from "next/link"
import { Luggage, Plus, ShoppingBag, X } from "lucide-react"

import { useRefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { ShoppingItemDto, ShoppingListDto } from "@/lib/relocation/contracts"
import { useSavedOverlay, useServerCopy } from "@/lib/saved-since-read"

import { AddShoppingItemForm } from "./add-shopping-item-form"
import { BudgetPanel } from "./budget-panel"
import type { ShoppingActions } from "./shopping-actions"
import { noteShoppingListChangeShownIn, useRefreshAfterShoppingChanges } from "./shopping-changes"
import { compareShoppingItems, groupByPriority, PRIORITY_LABELS } from "./shopping-model"
import { ShoppingRow } from "./shopping-row"

/** Puts a new row where the server's order would, without moving the rows already shown. */
function insertInOrder(items: readonly ShoppingItemDto[], added: ShoppingItemDto): ShoppingItemDto[] {
  const index = items.findIndex((item) => compareShoppingItems(item, added) > 0)
  return index === -1 ? [...items, added] : [...items.slice(0, index), added, ...items.slice(index)]
}

/**
 * The server's rows with what this page saved since: a changed row replaces
 * its row in place, a deleted one is gone, an added one goes where the
 * server's order would put it (in the order they were added).
 */
function withSaves(
  listed: readonly ShoppingItemDto[],
  saved: ReadonlyMap<string, ShoppingItemDto>,
  gone: ReadonlyMap<string, true>
): ShoppingItemDto[] {
  const known = new Set(listed.map((row) => row.id))
  let rows = listed.filter((row) => !gone.has(row.id)).map((row) => saved.get(row.id) ?? row)
  for (const [id, row] of saved) {
    if (!known.has(id) && !gone.has(id)) rows = insertInOrder(rows, row)
  }
  return rows
}

export type ShoppingListViewProps = {
  list: ShoppingListDto
  actions: ShoppingActions
}

/**
 * The shopping list: rows grouped as Must have, Should have and Nice to have,
 * the budget panel, and the form for adding a row by hand. Changes replace the
 * row in place; the server's order (To buy first) comes back with the next
 * read, so a row does not jump away while the owner is pressing it.
 */
export function ShoppingListView({ list, actions }: ShoppingListViewProps) {
  // Every read of this page goes through one refresh, so a row saved here
  // survives a list read before the save, and one show reads once (D-180).
  const copy = useServerCopy(list)
  // Linked items show their name and photo, so an item change elsewhere makes the list stale (D-107).
  useRefreshAfterItemChanges(list, copy.refresh)
  // Gaps added on a plan, or a run finished in this tab (D-151, D-173).
  useRefreshAfterShoppingChanges(list, copy.refresh)

  const formId = useId()
  const formHeadingId = useId()
  // Rows saved, added or deleted here that the list may not hold yet.
  const [savedRows, saveRow] = useSavedOverlay<ShoppingItemDto>(copy)
  const [goneRows, saveGone] = useSavedOverlay<true>(copy)
  const items = useMemo(() => withSaves(list.items, savedRows, goneRows), [list.items, savedRows, goneRows])
  const [formOpen, setFormOpen] = useState(false)
  const formRef = useRef<HTMLElement>(null)
  const summaryRef = useRef<HTMLParagraphElement>(null)

  function openForm() {
    flushSync(() => setFormOpen(true))
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus()
  }

  function saved(item: ShoppingItemDto) {
    saveRow(item.id, item)
  }

  function deleted(id: string) {
    // A plan kept by Next shows this gap as on the list until it reads again (D-173).
    if (items.some((row) => row.id === id && row.gapKey !== null)) noteShoppingListChangeShownIn(list)
    saveGone(id, true)
    // The row and its buttons are gone; the count says what is left.
    requestAnimationFrame(() => summaryRef.current?.focus())
  }

  const groups = groupByPriority(items)
  const toBuy = items.filter((item) => item.status === "todo").length

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p ref={summaryRef} tabIndex={-1} className="text-sm text-muted-foreground outline-none">
          {items.length === 0
            ? "Your list is empty."
            : `${items.length} ${items.length === 1 ? "entry" : "entries"} on your list, ${toBuy} still to buy.`}
        </p>
        <Button
          type="button"
          variant={formOpen ? "outline" : "default"}
          size="touch"
          aria-expanded={formOpen}
          aria-controls={formOpen ? formId : undefined}
          onClick={() => (formOpen ? setFormOpen(false) : openForm())}
        >
          {formOpen ? <X aria-hidden /> : <Plus aria-hidden />}
          Add item
        </Button>
      </div>

      {formOpen ? (
        <section
          id={formId}
          ref={formRef}
          aria-labelledby={formHeadingId}
          className="flex flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground"
        >
          <h2 id={formHeadingId} className="font-heading text-base font-semibold">
            Add an item
          </h2>
          <AddShoppingItemForm
            addShoppingItem={actions.addShoppingItem}
            onAdded={(item) => saveRow(item.id, item)}
          />
        </section>
      ) : null}

      {items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShoppingBag />
            </EmptyMedia>
            <EmptyTitle>Nothing on your list yet</EmptyTitle>
            <EmptyDescription>
              A relocation plan finds what your wardrobe is missing for the new climate. Add its gaps here with one
              tap, or add an item by hand.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link href="/relocate" className={buttonVariants({ variant: "outline", size: "touch" })}>
              <Luggage aria-hidden />
              Plan the move
            </Link>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <div className="lg:sticky lg:top-4 lg:order-2">
            <BudgetPanel items={items} latestBudgetEur={list.latestBudgetEur} latestAnalysisId={list.latestAnalysisId} />
          </div>
          <div className="flex min-w-0 flex-col gap-8 lg:order-1">
            {groups.map((group) => (
              <section key={group.priority} aria-labelledby={`${formId}-priority-${group.priority}`} className="flex flex-col gap-3">
                <h2 id={`${formId}-priority-${group.priority}`} className="font-heading text-base font-semibold">
                  {PRIORITY_LABELS[group.priority]}{" "}
                  <span className="font-normal text-muted-foreground">({group.items.length})</span>
                </h2>
                <ul className="flex flex-col gap-3">
                  {group.items.map((item) => (
                    <ShoppingRow key={item.id} item={item} actions={actions} onSaved={saved} onDeleted={deleted} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
