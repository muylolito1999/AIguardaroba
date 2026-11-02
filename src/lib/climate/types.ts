import { z } from "zod";

// Shared by the seed, the climate editor and the relocation prompt builder.
// Plain zod with no server or database imports, so client forms can use it.

// Every number is nullable: a placeholder profile (Bologna) starts with only
// the values the owner gave, and the editor fills in the rest later (D-012).
const measurement = (min: number, max: number) => z.number().min(min).max(max).nullable();

export const ClimateMonthSchema = z
  .object({
    month: z.number().int().min(1).max(12),
    /** Mean daily maximum, °C. */
    tmax: measurement(-60, 60),
    /** Mean daily minimum, °C. */
    tmin: measurement(-60, 60),
    /** Mean temperature, °C. */
    tmean: measurement(-60, 60),
    /** Total precipitation, mm. */
    precip_mm: measurement(0, 2000),
    /** Days with at least 1 mm of precipitation. */
    precip_days: measurement(0, 31),
    /** Sunshine hours. */
    sunshine_h: measurement(0, 744),
    notes: z.string().nullable(),
  })
  .refine(
    ({ tmin, tmean, tmax }) =>
      (tmin === null || tmax === null || tmin <= tmax) &&
      (tmin === null || tmean === null || tmin <= tmean) &&
      (tmean === null || tmax === null || tmean <= tmax),
    { error: "Temperatures must satisfy tmin ≤ tmean ≤ tmax" },
  );

export type ClimateMonth = z.infer<typeof ClimateMonthSchema>;

export const ClimateMonthsSchema = z
  .array(ClimateMonthSchema)
  .length(12, { error: "A climate profile has exactly 12 months" })
  .refine((months) => months.every((entry, index) => entry.month === index + 1), {
    error: "Months must be ordered January (1) to December (12)",
  });

/** The fields the seed writes to `climate_profiles` (camelCase, as the Drizzle insert type). */
export const ClimateProfileInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, { error: "Use lowercase letters, digits and hyphens" }),
  city: z.string().min(1),
  country: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  timezone: z.string().min(1),
  source: z.string().min(1),
  months: ClimateMonthsSchema,
  windNotes: z.string(),
  notes: z.string(),
  isDefault: z.boolean(),
  isPlaceholder: z.boolean(),
});

export type ClimateProfileInput = z.infer<typeof ClimateProfileInputSchema>;

/** True when every number of every month is filled in. */
export function hasCompleteMonths(months: readonly ClimateMonth[]): boolean {
  return (
    months.length === 12 &&
    months.every(
      (entry) =>
        entry.tmax !== null &&
        entry.tmin !== null &&
        entry.tmean !== null &&
        entry.precip_mm !== null &&
        entry.precip_days !== null &&
        entry.sunshine_h !== null,
    )
  );
}
