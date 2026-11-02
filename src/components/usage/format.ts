// Formatting for the usage page. Dates and times are shown in UTC because
// the budget month is a UTC month; the page says so next to them.

import type { AiCallStatus, AiPurpose } from "@/lib/db/enums"

export const PURPOSE_LABELS: Record<AiPurpose, string> = {
  tagging: "Tagging",
  relocation_chunk: "Relocation: item groups",
  relocation_repair: "Relocation: repairs",
  relocation_synthesis: "Relocation: summary",
  outfit_suggestion: "Outfit suggestions",
  shopping: "Shopping advice",
  smoke_test: "Smoke test",
}

export const CALL_STATUS_LABELS: Record<AiCallStatus, string> = {
  success: "Success",
  invalid_output: "Invalid output",
  max_tokens: "Hit token limit",
  refusal: "Refused",
  error: "Error",
}

const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const PERCENT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 })
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
const CALL_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
})

export function formatCount(value: number): string {
  return INTEGER.format(value)
}

/** 0.3 -> "30%"; null (nothing to divide) -> "n/a". */
export function formatRatio(ratio: number | null): string {
  return ratio === null ? "n/a" : PERCENT.format(ratio)
}

/** "1 December 2026", in UTC. */
export function formatDay(iso: string): string {
  return DAY.format(new Date(iso))
}

/** "3 Nov, 08:05", in UTC. */
export function formatCallTime(iso: string): string {
  return CALL_TIME.format(new Date(iso))
}

/** "850 ms", "12.3 s", or a dash when the call has no latency (it failed before sending). */
export function formatLatency(ms: number | null): string {
  if (ms === null) return "–"
  return ms < 1_000 ? `${formatCount(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`
}

/** Share of a limit, clamped to 0..1, for colouring meters. */
export function shareOf(value: number, limit: number): number {
  if (limit <= 0) return 1
  return Math.min(1, Math.max(0, value / limit))
}
