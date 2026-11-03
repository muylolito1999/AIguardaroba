import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { Plus } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import { SecondaryNavLinks } from "@/components/layout/secondary-nav-links"
import { buttonVariants } from "@/components/ui/button"
import { WardrobeSkeleton } from "@/components/wardrobe/grid-skeleton"
import { WardrobeResults } from "@/components/wardrobe/wardrobe-results"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { parseItemFilters } from "@/lib/items/filters"
import { listWardrobeItems } from "@/server/services/items-query"

// Absolute, because the template would render "Wardrobe · Wardrobe".
export const metadata: Metadata = {
  title: { absolute: "Wardrobe" },
}

// Static shell (D-041): the header and the Suspense fallback prerender; the
// session, the URL's filters and the database read happen in the child.
export default function WardrobePage({ searchParams }: PageProps<"/wardrobe">) {
  return (
    <>
      <PageHeader
        title="Wardrobe"
        description="Everything you own, tagged and searchable."
        actions={
          <>
            {/* Phones only: the sidebar lists Today and Outfits from md up (D-218). */}
            <SecondaryNavLinks className="md:hidden" />
            {/* A styled Link rather than Button render={<Link />}: Base UI's Button
                would add a button role to the anchor. The Stats link sits in the
                toolbar next to Sort. */}
            <Link href="/add" className={buttonVariants({ size: "touch" })}>
              <Plus aria-hidden />
              Add items
            </Link>
          </>
        }
      />
      {/* No key: a filter change keeps the current results on screen (a
          transition) instead of falling back to the skeleton. */}
      <Suspense fallback={<WardrobeSkeleton />}>
        <WardrobeSection searchParams={searchParams} />
      </Suspense>
    </>
  )
}

async function WardrobeSection({ searchParams }: Pick<PageProps<"/wardrobe">, "searchParams">) {
  await verifySession()
  // Never throws: unknown keys and invalid values are dropped.
  const filters = parseItemFilters(await searchParams)
  const list = await listWardrobeItems(getDb(), filters)
  return <WardrobeResults filters={filters} list={list} />
}
