import type { Metadata } from "next"
import { Suspense } from "react"

import { PageHeader } from "@/components/layout/page-header"
import { ShoppingAdviceSection } from "@/components/shopping/advice-section"
import { ShoppingListView } from "@/components/shopping/shopping-list"
import { Skeleton } from "@/components/ui/skeleton"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import {
  addShoppingItem,
  deleteShoppingItem,
  searchLinkableItems,
  updateShoppingItem,
} from "@/server/actions/shopping"
import { getShoppingList } from "@/server/services/shopping"

export const metadata: Metadata = {
  title: "Shopping",
}

const ACTIONS = { addShoppingItem, updateShoppingItem, deleteShoppingItem, searchLinkableItems }

// Static shell plus one Suspense child that reads the session and the list at
// request time (D-041).
export default function ShoppingPage() {
  return (
    <>
      <PageHeader title="Shopping" description="What to buy to fill the gaps in your wardrobe." />
      <Suspense fallback={<ShoppingSkeleton />}>
        <ShoppingContent />
      </Suspense>
      {/* No fallback: with FEATURE_SHOPPING_AI off the section renders nothing (D-040). */}
      <Suspense fallback={null}>
        <ShoppingAdviceSection />
      </Suspense>
    </>
  )
}

async function ShoppingContent() {
  await verifySession()
  const list = await getShoppingList(getDb())
  // ShoppingListView reads the list again after item and shopping-list
  // changes elsewhere in the tab, keeping its own saves (D-107, D-151, D-180).
  return <ShoppingListView list={list} actions={ACTIONS} />
}

function ShoppingSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <p className="sr-only">Loading your shopping list…</p>
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-11 w-32" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-3 lg:order-1">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-40 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-xl lg:order-2" />
      </div>
    </div>
  )
}
