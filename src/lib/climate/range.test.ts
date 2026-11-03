import { describe, expect, it } from "vitest";

import { BOLOGNA } from "@/lib/climate/bologna";
import { HAMBURG, HAMBURG_EXTRA_NOTES, HAMBURG_WIND_NOTES } from "@/lib/climate/hamburg";
import { describeClimateForPrompt, MONTH_NAMES, monthsInRange, PLACEHOLDER_LINE } from "@/lib/climate/range";

describe("monthsInRange", () => {
  it.each<[string, string, number[]]>([
    ["2026-11-15", "2027-02-10", [11, 12, 1, 2]],
    ["2026-03-01", "2026-03-31", [3]],
    ["2026-03-31", "2026-03-31", [3]],
    ["2026-01-01", "2026-12-31", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
    ["2026-11-03", "2027-11-02", [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ["2026-12-31", "2027-01-01", [12, 1]],
  ])("%s to %s gives %j", (from, to, expected) => {
    expect(monthsInRange(from, to)).toEqual(expected);
  });

  it("gives all twelve months, starting at the first month, for a range longer than a year", () => {
    expect(monthsInRange("2026-11-03", "2029-11-02")).toEqual([11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(monthsInRange("2026-11-03", "2027-11-03")).toHaveLength(12);
  });

  it("rejects an end before the start and malformed dates", () => {
    expect(() => monthsInRange("2027-01-01", "2026-12-31")).toThrow(RangeError);
    expect(() => monthsInRange("2026-13-01", "2027-01-01")).toThrow(RangeError);
    expect(() => monthsInRange("26-11-01", "2027-01-01")).toThrow(RangeError);
  });
});

describe("describeClimateForPrompt", () => {
  const winter = [11, 12, 1, 2];

  it("lists the given months in order with the real Hamburg normals", () => {
    const text = describeClimateForPrompt(HAMBURG, winter);
    const lines = text.split("\n");
    const rows = lines.filter((line) => /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\|/.test(line));
    expect(rows).toEqual([
      "Nov|8.2|2.9|5.7|61.1|16.9|51.4",
      "Dec|5.0|0.4|2.9|72.6|18.0|36.1",
      "Jan|4.2|-0.5|2.1|66.7|17.7|44.9",
      "Feb|5.2|-0.5|2.4|54.9|16.2|66.8",
    ]);
    expect(text).toContain("Destination: Hamburg, Germany");
    expect(text).toContain("WMO 1991–2020 normals, Hamburg-Fuhlsbüttel (WMO 10147)");
    expect(text).toContain("rain days (≥1 mm)");
  });

  it("adds the yearly line computed from all 12 months, and the notes verbatim", () => {
    const text = describeClimateForPrompt(HAMBURG, winter);
    expect(text).toContain(
      "Year (computed from the 12 months): tmax 13.6 / tmin 5.7 / tmean 9.7 °C, about 770 mm, 188 rain days, 1617 sunshine hours",
    );
    // The 12 rounded months add up to 770.4 mm; the notes state the spec's 770.5 mm,
    // so the computed line gives whole millimetres and never contradicts them.
    expect(text).not.toContain("770.4");
    expect(text).toContain("770.5 mm");
    expect(text).toContain(`Wind: ${HAMBURG_WIND_NOTES}`);
    expect(text).toContain(`Notes: ${HAMBURG.notes}`);
    expect(text).toContain(HAMBURG_EXTRA_NOTES);
    expect(text).toContain("≈ 7.5 h in December");
    expect(text).not.toContain("PLACEHOLDER");
  });

  it("shows unknown values as ?, skips the yearly line and flags a placeholder", () => {
    const text = describeClimateForPrompt(BOLOGNA, [1, 2, 7]);
    expect(text).toContain(PLACEHOLDER_LINE);
    expect(text).toContain("PLACEHOLDER DATA");
    expect(text.split("\n")).toEqual(expect.arrayContaining(["Jan|6.5|?|?|?|?|?", "Feb|?|?|?|?|?|?", "Jul|31.0|?|?|?|?|?"]));
    expect(text).not.toContain("Year (computed");
    expect(text).not.toContain("Wind:");
    expect(text).not.toMatch(/null|NaN|undefined/);
  });

  it("adds month notes on one line and is deterministic", () => {
    const months = HAMBURG.months.map((entry) =>
      entry.month === 12 ? { ...entry, notes: "Christmas markets;\nwindy  evenings" } : entry,
    );
    const text = describeClimateForPrompt({ ...HAMBURG, months }, winter);
    expect(text).toContain("Month notes: Dec: Christmas markets; windy evenings");
    expect(describeClimateForPrompt({ ...HAMBURG, months }, winter)).toBe(text);
  });

  it("keeps the arrival month first and rejects a month outside 1 to 12", () => {
    const text = describeClimateForPrompt(HAMBURG, [7, 8]);
    expect(text.indexOf("Jul|")).toBeLessThan(text.indexOf("Aug|"));
    expect(() => describeClimateForPrompt(HAMBURG, [13])).toThrow(RangeError);
  });

  it("heads the table as the stay's months unless another heading is given", () => {
    expect(describeClimateForPrompt(HAMBURG, [7, 8])).toContain(
      "\nMonthly normals for the stay, in order (arrival month first):\n",
    );
    const text = describeClimateForPrompt(HAMBURG, [1, 2], { heading: "Monthly normals, January to December:" });
    expect(text).toContain("\nMonthly normals, January to December:\n");
    expect(text).not.toContain("arrival month");
  });

  it("names the months in English abbreviations", () => {
    expect(MONTH_NAMES).toHaveLength(12);
    expect(MONTH_NAMES[0]).toBe("Jan");
    expect(MONTH_NAMES[11]).toBe("Dec");
  });
});
