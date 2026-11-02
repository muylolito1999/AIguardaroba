import type { ClimateMonth, ClimateProfileInput } from "./types";

// Spec section 6, copied as given (D-012). The relocation prompt reasons from
// these numbers, so they must not be rounded or "corrected"; the notes are the
// spec's own sentences, unchanged, including its typography (−, –, ≈, ≥).

export const HAMBURG_SOURCE = "WMO 1991–2020 normals, Hamburg-Fuhlsbüttel (WMO 10147)";

/** The spec's column legend for the monthly values and the yearly line. */
export const HAMBURG_COLUMNS =
  "Monthly values: tmax °C / tmin °C / tmean °C / precipitation mm / days ≥1 mm / sunshine h.";

/** The yearly figures exactly as the spec states them. */
export const HAMBURG_YEARLY_LINE = "13.6 / 5.7 / 9.7 / 770.5 mm / 188 days / 1,617 h";

export const HAMBURG_ANNUAL = {
  tmax: 13.6,
  tmin: 5.7,
  tmean: 9.7,
  precip_mm: 770.5,
  precip_days: 188,
  sunshine_h: 1617,
} as const;

export const HAMBURG_EXTRA_NOTES =
  "humidity 83–88 % in Nov–Feb; ~18 snow-cover days/year (Jan–Feb most); " +
  "typical coldest night of the year around −11 °C; " +
  "~62 frost days/year (city average, DWD Klimareport 2021); " +
  "~29 storm days/year with gusts ≥ 62 km/h (DWD, 1981–2010); " +
  "frequent drizzle, persistent wind, very short winter daylight (≈ 7.5 h in December). " +
  "Rain is frequent but usually light, so a breathable waterproof shell and waterproof footwear " +
  "matter more than heavy insulation alone.";

export const HAMBURG_WIND_NOTES =
  "~29 storm days/year with gusts ≥ 62 km/h (DWD, 1981–2010); frequent drizzle, persistent wind";

type Row = readonly [tmax: number, tmin: number, tmean: number, precipMm: number, precipDays: number, sunshineH: number];

// Jan to Dec: tmax °C / tmin °C / tmean °C / precipitation mm / days ≥1 mm / sunshine h.
const ROWS: readonly Row[] = [
  [4.2, -0.5, 2.1, 66.7, 17.7, 44.9],
  [5.2, -0.5, 2.4, 54.9, 16.2, 66.8],
  [8.7, 1.1, 4.9, 56.7, 15.2, 119.9],
  [13.9, 4.0, 9.1, 39.2, 12.8, 182.8],
  [18.0, 7.6, 13.0, 57.8, 13.8, 221.2],
  [20.9, 10.8, 16.0, 74.4, 15.3, 210.3],
  [23.2, 13.3, 18.3, 81.8, 16.0, 218.8],
  [23.0, 13.1, 18.0, 77.5, 15.8, 202.7],
  [18.8, 10.1, 14.4, 64.7, 14.5, 152.4],
  [13.6, 6.3, 10.0, 63.0, 16.2, 109.3],
  [8.2, 2.9, 5.7, 61.1, 16.9, 51.4],
  [5.0, 0.4, 2.9, 72.6, 18.0, 36.1],
];

export const HAMBURG_MONTHS: ClimateMonth[] = ROWS.map(
  ([tmax, tmin, tmean, precip_mm, precip_days, sunshine_h], index) => ({
    month: index + 1,
    tmax,
    tmin,
    tmean,
    precip_mm,
    precip_days,
    sunshine_h,
    notes: null,
  }),
);

export const HAMBURG: ClimateProfileInput = {
  slug: "hamburg",
  city: "Hamburg",
  country: "Germany",
  lat: 53.633,
  lon: 9.988,
  timezone: "Europe/Berlin",
  source: HAMBURG_SOURCE,
  months: HAMBURG_MONTHS,
  windNotes: HAMBURG_WIND_NOTES,
  notes: `${HAMBURG_COLUMNS} Year: ${HAMBURG_YEARLY_LINE}. ${HAMBURG_EXTRA_NOTES}`,
  isDefault: true,
  isPlaceholder: false,
};
