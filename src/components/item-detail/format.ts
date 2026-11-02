// Formatting for the item detail page. Dates use one fixed time zone, the
// owner's (Bologna now, Hamburg after the move; both Central European), so
// the server render and the browser's hydration always print the same day.

const OWNER_TIME_ZONE = "Europe/Berlin"

const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: OWNER_TIME_ZONE,
})

const ONE_DECIMAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

/** "2 Nov 2026". */
export function formatDay(iso: string): string {
  return DAY.format(new Date(iso))
}

/** "850 KB", "2.4 MB"; decimal units, as file managers show them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${INTEGER.format(Math.max(1, Math.round(bytes / 1_000)))} KB`
  return `${ONE_DECIMAL.format(bytes / 1_000_000)} MB`
}

/** "Never", "Once", "3 times". */
export function formatWearCount(count: number): string {
  if (count === 0) return "Never"
  if (count === 1) return "Once"
  return `${INTEGER.format(count)} times`
}
