import type { ClimateMonth, ClimateProfileInput } from "./types";

// A placeholder until the owner supplies real normals (D-012). Only the two
// figures the spec gives are set: July highs ≈ 31 °C and January highs ≈ 6–7 °C
// (stored as 6.5). Everything else stays null rather than invented, and the
// relocation prompt flags the profile as a placeholder.

export const BOLOGNA_SPEC_NOTES =
  "hot humid summers (July highs ≈ 31 °C), cold foggy winters (Jan highs ≈ 6–7 °C), far fewer rainy days";

const KNOWN_TMAX: Readonly<Record<number, number>> = { 1: 6.5, 7: 31 };

export const BOLOGNA_MONTHS: ClimateMonth[] = Array.from({ length: 12 }, (_, index) => ({
  month: index + 1,
  tmax: KNOWN_TMAX[index + 1] ?? null,
  tmin: null,
  tmean: null,
  precip_mm: null,
  precip_days: null,
  sunshine_h: null,
  notes: null,
}));

export const BOLOGNA: ClimateProfileInput = {
  slug: "bologna",
  city: "Bologna",
  country: "Italy",
  lat: 44.49,
  lon: 11.34,
  timezone: "Europe/Rome",
  source: "Placeholder from the owner's description; exact values to be filled in by the owner.",
  months: BOLOGNA_MONTHS,
  windNotes: "",
  notes: `Placeholder for comparison: ${BOLOGNA_SPEC_NOTES}. Exact monthly values are to be filled in by the owner.`,
  isDefault: false,
  isPlaceholder: true,
};
