import type { ReactNode } from "react"
import { CircleAlert, TriangleAlert } from "lucide-react"

import { Progress } from "@/components/ui/progress"
import { formatUsd } from "@/lib/ai/cost"
import { cn } from "@/lib/utils"
import type { UsageBreakdownRow, UsageSummary } from "@/server/services/usage"

import {
  CALL_STATUS_LABELS,
  PURPOSE_LABELS,
  formatCallTime,
  formatCount,
  formatDay,
  formatLatency,
  formatRatio,
  shareOf,
} from "./format"

// Server-rendered view of the usage summary. Meters state their level in words
// as well as colour; wide tables scroll inside their own focusable region so
// the page itself never scrolls sideways at phone width.

const WARN_SHARE = 0.8

type MeterProps = {
  id: string
  title: string
  value: number
  max: number
  /** The whole reading in words, for the visible line and aria-valuetext. */
  reading: string
  children?: ReactNode
}

function Meter({ id, title, value, max, reading, children }: MeterProps) {
  const share = shareOf(value, max)
  const full = value >= max
  const warn = !full && share >= WARN_SHARE
  const titleId = `${id}-title`
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10"
    >
      <h2 id={titleId} className="font-heading text-base font-semibold">
        {title}
      </h2>
      <p className="text-2xl font-semibold tabular-nums">{reading}</p>
      <Progress
        value={value}
        max={max}
        aria-labelledby={titleId}
        aria-valuetext={reading}
        className={cn(
          "[&_[data-slot=progress-track]]:h-2",
          full && "[&_[data-slot=progress-indicator]]:bg-destructive",
          warn && "[&_[data-slot=progress-indicator]]:bg-amber-500"
        )}
      />
      {full ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
          <CircleAlert aria-hidden className="size-4" />
          Limit reached
        </p>
      ) : warn ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-300">
          <TriangleAlert aria-hidden className="size-4" />
          {formatRatio(share)} used
        </p>
      ) : null}
      {children ? <div className="flex flex-col gap-1 text-sm text-muted-foreground">{children}</div> : null}
    </section>
  )
}

/** A table that scrolls sideways inside its own box; the region is focusable so keyboards can scroll it. */
type TableRegionProps = { id: string; title: string; description?: string; children: ReactNode }

function TableRegion({ id, title, description, children }: TableRegionProps) {
  const titleId = `${id}-title`
  return (
    // No aria-labelledby here: the scroll box below is the named region, and two
    // regions with one name would be a duplicate landmark.
    <section className="flex min-w-0 flex-col gap-2">
      <h2 id={titleId} className="font-heading text-base font-semibold">
        {title}
      </h2>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      <div
        role="region"
        aria-labelledby={titleId}
        tabIndex={0}
        className="max-w-full overflow-x-auto rounded-lg border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {children}
      </div>
    </section>
  )
}

const TH = "px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground"
const TH_NUM = "px-3 py-2 text-right font-medium whitespace-nowrap text-muted-foreground"
const TD = "px-3 py-2 whitespace-nowrap"
const TD_NUM = "px-3 py-2 text-right whitespace-nowrap tabular-nums"

function BreakdownTable<K extends string>({
  rows,
  label,
  heading,
}: {
  rows: UsageBreakdownRow<K>[]
  label: (key: K) => ReactNode
  heading: string
}) {
  if (rows.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No Claude calls yet.</p>
  }
  return (
    <table className="w-full min-w-[44rem] border-collapse text-sm">
      <thead className="border-b bg-muted/50">
        <tr>
          <th scope="col" className={TH}>
            {heading}
          </th>
          <th scope="col" className={TH_NUM}>
            Calls
          </th>
          <th scope="col" className={TH_NUM}>
            Input tokens
          </th>
          <th scope="col" className={TH_NUM}>
            Output tokens
          </th>
          <th scope="col" className={TH_NUM}>
            Cache read
          </th>
          <th scope="col" className={TH_NUM}>
            Cache write
          </th>
          <th scope="col" className={TH_NUM}>
            Cost this month
          </th>
          <th scope="col" className={TH_NUM}>
            Cost all time
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b last:border-b-0">
            <th scope="row" className={cn(TD, "text-left font-medium")}>
              {label(row.key)}
            </th>
            <td className={TD_NUM}>{formatCount(row.calls)}</td>
            <td className={TD_NUM}>{formatCount(row.inputTokens)}</td>
            <td className={TD_NUM}>{formatCount(row.outputTokens)}</td>
            <td className={TD_NUM}>{formatCount(row.cacheReadTokens)}</td>
            <td className={TD_NUM}>{formatCount(row.cacheWriteTokens)}</td>
            <td className={TD_NUM}>{formatUsd(row.costUsd)}</td>
            <td className={TD_NUM}>{formatUsd(row.allTimeCostUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RecentCallsTable({ calls }: { calls: UsageSummary["recentCalls"] }) {
  if (calls.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No Claude calls yet.</p>
  }
  return (
    <table className="w-full min-w-[42rem] border-collapse text-sm">
      <thead className="border-b bg-muted/50">
        <tr>
          <th scope="col" className={TH}>
            Time (UTC)
          </th>
          <th scope="col" className={TH}>
            Purpose and model
          </th>
          <th scope="col" className={TH}>
            Status
          </th>
          <th scope="col" className={TH_NUM}>
            Input
          </th>
          <th scope="col" className={TH_NUM}>
            Output
          </th>
          <th scope="col" className={TH_NUM}>
            Cache read / write
          </th>
          <th scope="col" className={TH_NUM}>
            Cost
          </th>
          <th scope="col" className={TH_NUM}>
            Latency
          </th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call) => (
          <tr key={call.id} className="border-b last:border-b-0">
            <td className={cn(TD, "tabular-nums")}>
              <time dateTime={call.createdAt}>{formatCallTime(call.createdAt)}</time>
            </td>
            {/* Model and error code sit on a second line, so the table fits a
                desktop content column without scrolling sideways. */}
            <td className={TD}>
              <span className="block">
                {PURPOSE_LABELS[call.purpose]}
                {call.isBatch ? <span className="text-muted-foreground"> · batch</span> : null}
              </span>
              <span className="block font-mono text-xs text-muted-foreground">{call.model}</span>
            </td>
            <td className={cn(TD, call.status === "success" ? undefined : "text-destructive")}>
              <span className="block">{CALL_STATUS_LABELS[call.status]}</span>
              {call.errorCode ? (
                <span className="block font-mono text-xs text-muted-foreground">{call.errorCode}</span>
              ) : null}
            </td>
            <td className={TD_NUM}>{formatCount(call.inputTokens)}</td>
            <td className={TD_NUM}>{formatCount(call.outputTokens)}</td>
            <td className={TD_NUM}>
              {formatCount(call.cacheReadTokens)} / {formatCount(call.cacheWriteTokens)}
            </td>
            <td className={TD_NUM}>{formatUsd(call.costUsd)}</td>
            <td className={TD_NUM}>{formatLatency(call.latencyMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Stat({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

export function UsageSummaryView({ summary }: { summary: UsageSummary }) {
  const { month, allTime, cache, pendingBatches, blob } = summary
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Meter
          id="usage-month"
          title="This month"
          value={month.spentUsd}
          max={month.budgetUsd}
          reading={`${formatUsd(month.spentUsd)} of ${formatUsd(month.budgetUsd)}`}
        >
          <p>
            {formatUsd(month.remainingUsd)} left · resets on {formatDay(month.resetsAt)} (UTC)
          </p>
          {pendingBatches.count > 0 ? (
            <p>
              {formatUsd(month.pendingBatchUsd)} reserved for {pendingBatches.count} pending{" "}
              {pendingBatches.count === 1 ? "batch" : "batches"}
            </p>
          ) : null}
          <p>New AI work stops when the budget is used up.</p>
        </Meter>
        <Meter
          id="usage-credit"
          title="Prepaid credit"
          value={allTime.spentUsd}
          max={allTime.creditUsd}
          reading={`${formatUsd(allTime.spentUsd)} of ${formatUsd(allTime.creditUsd)}`}
        >
          <p>{formatUsd(allTime.remainingCreditUsd)} left, counting every Claude call so far.</p>
        </Meter>
        <Meter
          id="usage-blob"
          title="Blob uploads this month"
          value={blob.estimatedAdvancedOps}
          max={blob.limit}
          reading={`About ${formatCount(blob.estimatedAdvancedOps)} of ${formatCount(blob.limit)}`}
        >
          <p>
            {formatCount(blob.clientUploads)} from the browser, {formatCount(blob.serverPuts)} from the server.
          </p>
          <p>
            An estimate of Vercel Blob advanced operations (Hobby allows {formatCount(blob.limit)} a month), counted
            from stored images. Uploads dropped as duplicates are not included; the Vercel dashboard has the exact
            number.
          </p>
        </Meter>
      </div>

      <section aria-labelledby="usage-cache-title" className="flex flex-col gap-3">
        <h2 id="usage-cache-title" className="font-heading text-base font-semibold">
          Prompt cache this month
        </h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat term="Hit ratio" value={formatRatio(cache.hitRatio)} />
          <Stat term="Cache read tokens" value={formatCount(cache.readTokens)} />
          <Stat term="Cache write tokens" value={formatCount(cache.writeTokens)} />
          <Stat term="Calls" value={formatCount(month.totals.calls)} />
        </dl>
        <p className="text-sm text-muted-foreground">
          Hit ratio is cache reads divided by all input tokens (uncached, cache reads and cache writes). Cached
          reads cost a fraction of normal input.
        </p>
      </section>

      <TableRegion id="usage-purpose" title="By purpose" description="Tokens and calls are for this month.">
        <BreakdownTable rows={summary.byPurpose} heading="Purpose" label={(key) => PURPOSE_LABELS[key]} />
      </TableRegion>

      <TableRegion id="usage-model" title="By model" description="Tokens and calls are for this month.">
        <BreakdownTable
          rows={summary.byModel}
          heading="Model"
          label={(key) => <span className="font-mono text-xs">{key}</span>}
        />
      </TableRegion>

      <TableRegion
        id="usage-recent"
        title="Recent calls"
        description="The last 50 attempts, failed ones included; each retry is its own row."
      >
        <RecentCallsTable calls={summary.recentCalls} />
      </TableRegion>
    </div>
  )
}
