// Wear tracking's shared contract: the inputs of logging and undoing a wear,
// the result the item page and /today show, and the calendar-day helpers the
// service uses. Client- and server-safe: zod, the client-safe date schema and
// the weather snapshot schema only.

import { z } from "zod";

import { IsoDateSchema, parseIsoDate } from "@/lib/relocation/contracts";
import { AppError } from "@/lib/result";
import { WeatherSnapshotSchema } from "@/lib/weather/open-meteo";

/** How long after logging a wear its Undo still works. */
export const WEAR_UNDO_WINDOW_MS = 600_000;
/** Items one log call or one undo may touch: an outfit holds at most 12 (MAX_OUTFIT_ITEMS). */
export const MAX_WEAR_ITEMS = 12;

const distinct = (ids: readonly string[]) => new Set(ids).size === ids.length;

const ids = (noun: string) =>
  z
    .array(z.uuid())
    .min(1, { error: `Choose at least one ${noun}.` })
    .max(MAX_WEAR_ITEMS, { error: `At most ${MAX_WEAR_ITEMS} at a time.` })
    .refine(distinct, { error: `Each ${noun} only once.` });

const wearOptions = {
  /** The day worn; defaults to today in the home profile's time zone and is never in the future (resolveWornOn). */
  wornOn: IsoDateSchema.optional(),
  /** Today's weather when the wear comes from /today. */
  weather: WeatherSnapshotSchema.nullable().optional(),
};

export const LogWearInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("items"), itemIds: ids("item"), ...wearOptions }),
  z.strictObject({ kind: z.literal("outfit"), outfitId: z.uuid(), ...wearOptions }),
]);
export type LogWearInput = z.infer<typeof LogWearInputSchema>;

export const UndoWearInputSchema = z.strictObject({ logIds: ids("wear log") });
export type UndoWearInput = z.infer<typeof UndoWearInputSchema>;

export type WearLogResultDto = {
  /** YYYY-MM-DD. */
  wornOn: string;
  /** The wear_logs rows this call inserted; Undo sends them back. */
  logIds: string[];
  /** Every item of the request with its counts after the call. */
  items: { id: string; wearCount: number; lastWornAt: string | null }[];
  /**
   * Item ids not logged again: a log for the same item, day and target (the
   * outfit, or no outfit) already exists, so logging is idempotent.
   */
  alreadyLogged: string[];
  /** ISO 8601: when Undo stops working. */
  undoUntil: string;
};

// ---------------------------------------------------------------------------
// Calendar days
// ---------------------------------------------------------------------------

function zonedParts(timeZone: string, at: Date): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const out: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  return out;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** The calendar day of `now` in an IANA time zone, as YYYY-MM-DD. Throws a RangeError for an unknown zone. */
export function calendarDayIn(timeZone: string, now: Date): string {
  const { year = 0, month = 0, day = 0 } = zonedParts(timeZone, now);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/**
 * Noon of a calendar day in a time zone, as an instant: what last_worn_at
 * records for a wear on that day, so the stored timestamp falls on the same
 * calendar day in that zone and in UTC (European zones are within 2 h of UTC).
 */
export function noonOn(date: string, timeZone: string): Date {
  const parsed = parseIsoDate(date);
  if (parsed === null) throw new RangeError(`Not a valid date: ${date}`);
  const wallClock = Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12);
  // The zone's offset at a guess, applied twice in case the guess sits across a DST change.
  let instant = wallClock;
  for (let pass = 0; pass < 2; pass += 1) {
    const p = zonedParts(timeZone, new Date(instant));
    const shown = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
    instant += wallClock - shown;
  }
  return new Date(instant);
}

/**
 * The day a wear is logged for: `wornOn` when given, otherwise `today` (the
 * home time zone's calendar day). A day after today is refused with VALIDATION.
 */
export function resolveWornOn(wornOn: string | undefined, today: string): string {
  const day = wornOn ?? today;
  if (day > today) throw new AppError("VALIDATION", "A wear cannot be logged for a future day.");
  return day;
}
