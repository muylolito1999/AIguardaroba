import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"
import { ArrowLeft } from "lucide-react"

import { DataDownloads } from "@/components/export/data-downloads"
import { PhotoExports, PhotoExportsSkeleton } from "@/components/export/photo-exports"
import { RefreshAfterItemChanges } from "@/components/items/refresh-after-item-changes"
import { PageHeader } from "@/components/layout/page-header"
import { buttonVariants } from "@/components/ui/button"
import { verifySession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db"
import { ZIP_PART_MAX_ITEMS } from "@/lib/export/zip-plan"
import { getImageExportOverview } from "@/server/services/export"

export const metadata: Metadata = {
  title: "Export your data",
}

// Static shell: the explanations and the JSON and CSV links need no data.
// The photo parts read the database, so they render in a Suspense child at
// request time (D-041).
export default function ExportPage() {
  return (
    <>
      <PageHeader
        title="Export your data"
        description="Download your wardrobe in open formats, to keep a copy or move it elsewhere."
        actions={
          <Link href="/settings" className={buttonVariants({ variant: "outline", size: "touch" })}>
            <ArrowLeft aria-hidden />
            Settings
          </Link>
        }
      />
      <div className="flex max-w-5xl flex-col gap-10">
        <section aria-labelledby="export-data-heading" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="export-data-heading" className="font-heading text-lg font-semibold">
              Wardrobe data
            </h2>
            <p className="text-sm text-muted-foreground text-pretty">
              Both files come straight from the database and download in seconds. They do not need the
              photo store; their photo columns are links into it.
            </p>
          </div>
          <DataDownloads />
        </section>

        <section aria-labelledby="export-photos-heading" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 id="export-photos-heading" className="font-heading text-lg font-semibold">
              Photos
            </h2>
            <p className="text-sm text-muted-foreground text-pretty">
              Each ZIP holds up to {ZIP_PART_MAX_ITEMS} photos in a folder per category, plus a
              manifest.json that lists every file&rsquo;s item, source link and size.
            </p>
            <p className="text-sm text-muted-foreground text-pretty">
              The server fetches each photo from the photo store (Vercel Blob) while you download, so
              every part counts toward the Blob data-transfer allowance, by about its size. If a photo
              cannot be fetched, the download stops with an error rather than leave it out: download that
              part again.
            </p>
          </div>
          <Suspense fallback={<PhotoExportsSkeleton />}>
            <PhotoExportsContent />
          </Suspense>
        </section>
      </div>
    </>
  )
}

async function PhotoExportsContent() {
  await verifySession()
  const summaries = await getImageExportOverview(getDb())
  return (
    <>
      <PhotoExports summaries={summaries} />
      {/* Next keeps this page too: shown again after an item changed elsewhere in the tab (a new upload,
          a cut-out, a delete), it reads the parts again, so a backup taken from it lists every photo (D-138). */}
      <RefreshAfterItemChanges snapshot={summaries} />
    </>
  )
}
