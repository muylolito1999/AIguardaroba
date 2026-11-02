import { describe, expect, it } from "vitest";

import {
  HAMBURG,
  HAMBURG_ANNUAL,
  HAMBURG_EXTRA_NOTES,
  HAMBURG_MONTHS,
  HAMBURG_SOURCE,
  HAMBURG_YEARLY_LINE,
} from "./hamburg";
import { ClimateProfileInputSchema, hasCompleteMonths } from "./types";

function sum(pick: (month: (typeof HAMBURG_MONTHS)[number]) => number | null): number {
  return HAMBURG_MONTHS.reduce((total, month) => total + (pick(month) ?? Number.NaN), 0);
}

describe("Hamburg climate profile", () => {
  it("is a valid, complete, non-placeholder default profile", () => {
    expect(ClimateProfileInputSchema.parse(HAMBURG)).toEqual(HAMBURG);
    expect(hasCompleteMonths(HAMBURG.months)).toBe(true);
    expect(HAMBURG).toMatchObject({
      slug: "hamburg",
      lat: 53.633,
      lon: 9.988,
      timezone: "Europe/Berlin",
      isDefault: true,
      isPlaceholder: false,
    });
  });

  it("cites the spec's source", () => {
    expect(HAMBURG.source).toBe(HAMBURG_SOURCE);
    expect(HAMBURG.source).toBe("WMO 1991–2020 normals, Hamburg-Fuhlsbüttel (WMO 10147)");
  });

  it("has 12 months in calendar order", () => {
    expect(HAMBURG.months.map((month) => month.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("keeps the spec's January and December rows exactly", () => {
    expect(HAMBURG.months[0]).toMatchObject({
      tmax: 4.2,
      tmin: -0.5,
      tmean: 2.1,
      precip_mm: 66.7,
      precip_days: 17.7,
      sunshine_h: 44.9,
    });
    expect(HAMBURG.months[11]).toMatchObject({
      tmax: 5.0,
      tmin: 0.4,
      tmean: 2.9,
      precip_mm: 72.6,
      precip_days: 18.0,
      sunshine_h: 36.1,
    });
  });

  it("has tmin ≤ tmean ≤ tmax in every month", () => {
    for (const { month, tmin, tmean, tmax } of HAMBURG.months) {
      if (tmin === null || tmean === null || tmax === null) throw new Error(`month ${month} has a missing temperature`);
      expect(tmin, `month ${month}`).toBeLessThanOrEqual(tmean);
      expect(tmean, `month ${month}`).toBeLessThanOrEqual(tmax);
    }
  });

  it("has monthly sums that match the stated yearly figures", () => {
    expect(Math.abs(sum((month) => month.precip_mm) - HAMBURG_ANNUAL.precip_mm)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(sum((month) => month.precip_days) - HAMBURG_ANNUAL.precip_days)).toBeLessThanOrEqual(1);
    expect(Math.abs(sum((month) => month.sunshine_h) - HAMBURG_ANNUAL.sunshine_h)).toBeLessThanOrEqual(1);
    expect(Math.abs(sum((month) => month.tmean) / 12 - HAMBURG_ANNUAL.tmean)).toBeLessThanOrEqual(0.1);
  });

  it("states the yearly line verbatim", () => {
    expect(HAMBURG_YEARLY_LINE).toBe("13.6 / 5.7 / 9.7 / 770.5 mm / 188 days / 1,617 h");
    expect(HAMBURG.notes).toContain(`Year: ${HAMBURG_YEARLY_LINE}.`);
  });

  it.each([
    "humidity 83–88 % in Nov–Feb",
    "~18 snow-cover days/year (Jan–Feb most)",
    "typical coldest night of the year around −11 °C",
    "~62 frost days/year (city average, DWD Klimareport 2021)",
    "~29 storm days/year with gusts ≥ 62 km/h (DWD, 1981–2010)",
    "frequent drizzle, persistent wind",
    "very short winter daylight (≈ 7.5 h in December)",
    "Rain is frequent but usually light, so a breathable waterproof shell and waterproof footwear matter more than heavy insulation alone.",
  ])("keeps the spec note %j verbatim", (note) => {
    expect(HAMBURG.notes).toContain(note);
  });

  it("puts the wind facts in the wind notes too", () => {
    expect(HAMBURG.windNotes).toContain("~29 storm days/year with gusts ≥ 62 km/h (DWD, 1981–2010)");
    expect(HAMBURG.windNotes).toContain("persistent wind");
    expect(HAMBURG.notes).toContain(HAMBURG_EXTRA_NOTES);
  });
});
