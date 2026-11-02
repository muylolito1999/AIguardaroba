import type { ReactNode } from "react"
import { Download, FileBraces, FileSpreadsheet } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"

// The JSON and CSV downloads. Static: the links need no data, and the
// routes check the session themselves when they are opened.

type DownloadCardProps = {
  id: string
  icon: ReactNode
  title: string
  href: string
  linkLabel: string
  children: ReactNode
}

function DownloadCard({ id, icon, title, href, linkLabel, children }: DownloadCardProps) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10"
    >
      <h3 id={id} className="flex items-center gap-2 font-heading text-base font-semibold">
        {icon}
        {title}
      </h3>
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">{children}</div>
      {/* A plain link, not next/link: the response is a file, not a page. Without a download
          attribute, an error (for example an ended session) opens as a readable message
          instead of being saved as a broken file. */}
      <a href={href} className={buttonVariants({ variant: "outline", size: "touch", className: "mt-auto self-start" })}>
        <Download aria-hidden />
        {linkLabel}
      </a>
    </section>
  )
}

export function DataDownloads() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <DownloadCard
        id="export-json-heading"
        icon={<FileBraces aria-hidden className="size-4" />}
        title="Everything as JSON"
        href="/api/export/json"
        linkLabel="Download JSON"
      >
        <p>
          Every item with all its tags, notes, decisions and wear counts, and its photos&rsquo; links,
          kinds and sizes. Also climate profiles, app settings, relocation analyses, shopping and
          packing lists, outfits, wear logs and the AI usage log.
        </p>
        <p>Login attempts are left out: they only serve the sign-in rate limit.</p>
      </DownloadCard>
      <DownloadCard
        id="export-csv-heading"
        icon={<FileSpreadsheet aria-hidden className="size-4" />}
        title="Items as CSV"
        href="/api/export/csv"
        linkLabel="Download CSV"
      >
        <p>
          One row per item, archived ones included, for Excel, Numbers or Google Sheets. Lists such as
          colours and seasons are joined with semicolons, and the last three columns link to the
          processed, original and cut-out photos.
        </p>
        <p>
          Text that a spreadsheet could run as a formula starts with an apostrophe, so opening the file
          never runs anything.
        </p>
      </DownloadCard>
    </div>
  )
}
