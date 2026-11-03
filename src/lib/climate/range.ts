// Climate helpers for the relocation run. Pure and client-safe (no Node APIs,
// no server imports): the form shows the months of a range with the same
// function the server uses to build the prompt.

import type { ClimateMonth } from "./types";

export const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function yearMonth(value: string, label: string): { year: number; month: number } {
  const match = ISO_DATE.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  if (!match || month < 1 || month > 12) throw new RangeError(`${label} must be a date in the form YYYY-MM-DD.`);
  return { year, month };
}

/**
 * The months (1 to 12) a date range touches, in order from dateFrom's month,
 * each once: Nov to Feb gives [11, 12, 1, 2]. A range of 12 months or more
 * gives all twelve, still starting at dateFrom's month. Throws a RangeError for
 * a malformed date or an end before the start (validate the form first).
 */
export function monthsInRange(dateFrom: string, dateTo: string): number[] {
  const from = yearMonth(dateFrom, "dateFrom");
  const to = yearMonth(dateTo, "dateTo");
  if (dateTo < dateFrom) throw new RangeError("dateTo must not be before dateFrom.");
  const span = (to.year - from.year) * 12 + (to.month - from.month) + 1;
  return Array.from({ length: Math.min(12, span) }, (_, index) => ((from.month - 1 + index) % 12) + 1);
}

/** The fields of a climate profile the prompt needs (the DB row and the seed input both fit). */
export type ClimatePromptProfile = {
  city: string;
  country: string;
  source: string;
  months: readonly ClimateMonth[];
  windNotes: string;
  notes: string;
  isPlaceholder: boolean;
};

export const PLACEHOLDER_LINE =
  "PLACEHOLDER DATA: this profile is incomplete and partly estimated, not measured normals. " +
  "Values shown as ? are unknown. Reason cautiously, say so in the summary, and never cite a missing number.";

const COLUMNS = "month|tmax °C|tmin °C|tmean °C|precip mm|rain days (≥1 mm)|sunshine h";

function value(number: number | null): string {
  return number === null ? "?" : number.toFixed(1);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Yearly figures from the 12 months; null unless every value is known. */
function annualLine(months: readonly ClimateMonth[]): string | null {
  if (months.length !== 12) return null;
  const sum = (pick: (month: ClimateMonth) => number | null): number | null => {
    let total = 0;
    for (const month of months) {
      const entry = pick(month);
      if (entry === null) return null;
      total += entry;
    }
    return total;
  };
  const tmax = sum((m) => m.tmax);
  const tmin = sum((m) => m.tmin);
  const tmean = sum((m) => m.tmean);
  const precip = sum((m) => m.precip_mm);
  const days = sum((m) => m.precip_days);
  const sunshine = sum((m) => m.sunshine_h);
  if (tmax === null || tmin === null || tmean === null || precip === null || days === null || sunshine === null) {
    return null;
  }
  // Precipitation in whole millimetres: summed from rounded monthly values it
  // can miss a stated yearly total by a tenth (770.4 against Hamburg's 770.5),
  // and two different figures in one prompt would contradict each other.
  return (
    `Year (computed from the 12 months): tmax ${(tmax / 12).toFixed(1)} / tmin ${(tmin / 12).toFixed(1)} / ` +
    `tmean ${(tmean / 12).toFixed(1)} °C, about ${Math.round(precip)} mm, ${Math.round(days)} rain days, ` +
    `${Math.round(sunshine)} sunshine hours`
  );
}

/** The relocation prompt's heading for the month table: its first month is the arrival month. */
export const STAY_MONTHS_HEADING = "Monthly normals for the stay, in order (arrival month first):";

/**
 * The climate block of the relocation prompt: a compact table of the given
 * months in the given order (the first is the arrival month; unknown values
 * are ?), the yearly line when all 12 months are complete, then the wind
 * notes and notes verbatim, and a PLACEHOLDER DATA line for placeholder
 * profiles. Deterministic, because it is part of the run's cache key.
 * `heading` replaces the table's heading for a prompt that is not about a
 * stay (the shopping advice lists January to December); the default keeps
 * the relocation prompt, and its cache keys, as they are.
 */
export function describeClimateForPrompt(
  profile: ClimatePromptProfile,
  months: readonly number[],
  options: { heading?: string } = {},
): string {
  const byMonth = new Map(profile.months.map((entry) => [entry.month, entry]));
  const lines = [`Destination: ${profile.city}, ${profile.country}`, `Source: ${profile.source}`];
  if (profile.isPlaceholder) lines.push(PLACEHOLDER_LINE);

  lines.push(options.heading ?? STAY_MONTHS_HEADING, COLUMNS);
  const monthNotes: string[] = [];
  for (const month of months) {
    const name = MONTH_NAMES[month - 1];
    if (name === undefined) throw new RangeError(`Month ${month} is not between 1 and 12.`);
    const entry = byMonth.get(month);
    if (entry === undefined) {
      lines.push(`${name}|?|?|?|?|?|?`);
      continue;
    }
    lines.push(
      [
        name,
        value(entry.tmax),
        value(entry.tmin),
        value(entry.tmean),
        value(entry.precip_mm),
        value(entry.precip_days),
        value(entry.sunshine_h),
      ].join("|"),
    );
    if (entry.notes !== null && entry.notes.trim() !== "") monthNotes.push(`${name}: ${oneLine(entry.notes)}`);
  }
  if (monthNotes.length > 0) lines.push(`Month notes: ${monthNotes.join("; ")}`);

  const annual = annualLine(profile.months);
  if (annual !== null) lines.push(annual);
  if (profile.windNotes.trim() !== "") lines.push(`Wind: ${profile.windNotes}`);
  if (profile.notes.trim() !== "") lines.push(`Notes: ${profile.notes}`);
  return lines.join("\n");
}
