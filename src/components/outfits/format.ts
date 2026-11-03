// Wording and number formats for the outfit pages. Calendar days (worn_on)
// are formatted as the day they name, without a time zone shift, so the server
// render and the browser's hydration print the same text.

import { formatDay } from "@/components/item-detail/format"

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
const CELSIUS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

/** "3 Nov 2026" for a YYYY-MM-DD calendar day. */
export function formatCalendarDay(day: string): string {
  return DAY.format(new Date(`${day}T00:00:00Z`))
}

/** "3 Nov 2026" for an ISO timestamp, in the owner's time zone. */
export function formatTimestampDay(iso: string): string {
  return formatDay(iso)
}

function celsius(value: number): string {
  // A real minus sign reads better than a hyphen and is announced as "minus".
  return `${CELSIUS.format(value).replace("-", "−")} °C`
}

/** "4 to 12 °C", "From 4 °C", "Up to 12 °C", or null when neither is set. */
export function formatWeatherRange(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) {
    return min === max ? celsius(min) : `${CELSIUS.format(min).replace("-", "−")} to ${celsius(max)}`
  }
  if (min !== null) return `From ${celsius(min)}`
  if (max !== null) return `Up to ${celsius(max)}`
  return null
}

/** "Never worn", "Worn once", "Worn 3 times". */
export function formatTimesWorn(count: number): string {
  if (count === 0) return "Never worn"
  if (count === 1) return "Worn once"
  return `Worn ${count} times`
}

/** "Rated 4 of 5". */
export function formatRating(rating: number): string {
  return `Rated ${rating} of 5`
}

/** A temperature field's text as a number: a comma counts as the decimal point; empty is null, other text NaN. */
export function parseCelsius(text: string): number | null {
  const trimmed = text.trim().replace(",", ".").replace("−", "-")
  return trimmed === "" ? null : Number(trimmed)
}
