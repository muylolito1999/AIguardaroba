// Wording and number formats for /today. Calendar days are formatted as the
// day they name (no time zone shift) and times in the forecast's own zone,
// so the server render and the browser print the same text.

import type { WeatherSnapshot } from "@/lib/weather/open-meteo"

const DAY_HEADING = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
})

/** "Tuesday 3 November" for a YYYY-MM-DD calendar day. */
export function formatDayHeading(day: string): string {
  return DAY_HEADING.format(new Date(`${day}T00:00:00Z`))
}

/** Whole degrees with a real minus sign, which reads better than a hyphen and is announced as "minus". */
export function formatDegrees(celsius: number): string {
  const rounded = Math.round(celsius)
  // Math.round(-0.4) is -0, which would print as "−0".
  return `${rounded < 0 ? "−" : ""}${Math.abs(rounded)} °C`
}

/** "2 to 8 °C", or one value when both round to the same degree. */
export function formatDegreeRange(min: number, max: number): string {
  const low = formatDegrees(min)
  const high = formatDegrees(max)
  return low === high ? low : `${low.replace(" °C", "")} to ${high}`
}

/** "80 % chance of rain", or that the chance is unknown. */
export function formatRainChance(probability: number | null): string {
  return probability === null ? "Chance of rain unknown" : `${Math.round(probability)} % chance of rain`
}

/** "3.4 mm" with one decimal, "0 mm" for none. */
export function formatPrecipitation(mm: number): string {
  return mm === 0 ? "0 mm" : `${(Math.round(mm * 10) / 10).toFixed(1)} mm`
}

/** "14:20" in the given IANA time zone. */
export function formatTimeIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(
    new Date(iso)
  )
}

export type WeatherKind = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "thunder" | "unknown"

/** The WMO 4677 family of a weather code, for its icon. */
export function weatherKind(code: WeatherSnapshot["weatherCode"]): WeatherKind {
  if (code === 0 || code === 1) return "clear"
  if (code === 2) return "partly"
  if (code === 3) return "cloudy"
  if (code === 45 || code === 48) return "fog"
  if (code >= 51 && code <= 57) return "drizzle"
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain"
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow"
  if (code >= 95 && code <= 99) return "thunder"
  return "unknown"
}

/** "1 item", "3 items". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}
