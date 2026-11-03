import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/result";
import {
  calendarDayIn,
  LogWearInputSchema,
  MAX_WEAR_ITEMS,
  noonOn,
  resolveWornOn,
  UndoWearInputSchema,
  WEAR_UNDO_WINDOW_MS,
} from "@/lib/wear/contracts";

import { makeWeatherSnapshot } from "../../../test/outfit-fixtures";

const ids = (count: number) => Array.from({ length: count }, () => randomUUID());

describe("LogWearInputSchema", () => {
  it("accepts items or an outfit, with an optional day and weather", () => {
    const itemIds = ids(2);
    expect(LogWearInputSchema.parse({ kind: "items", itemIds })).toEqual({ kind: "items", itemIds });
    const outfitId = randomUUID();
    const weather = makeWeatherSnapshot();
    expect(LogWearInputSchema.parse({ kind: "outfit", outfitId, wornOn: "2026-11-02", weather })).toEqual({
      kind: "outfit",
      outfitId,
      wornOn: "2026-11-02",
      weather,
    });
    expect(LogWearInputSchema.parse({ kind: "items", itemIds, weather: null }).weather).toBeNull();
  });

  it(`accepts 1 to ${MAX_WEAR_ITEMS} distinct items`, () => {
    expect(LogWearInputSchema.safeParse({ kind: "items", itemIds: ids(MAX_WEAR_ITEMS) }).success).toBe(true);
  });

  it.each([
    ["no items", { kind: "items", itemIds: [] }],
    ["13 items", { kind: "items", itemIds: ids(13) }],
    ["a repeated item", { kind: "items", itemIds: (() => { const [a = ""] = ids(1); return [a, a]; })() }],
    ["a non-uuid item", { kind: "items", itemIds: ["i1"] }],
    ["a non-uuid outfit", { kind: "outfit", outfitId: "x" }],
    ["items under the outfit kind", { kind: "outfit", itemIds: ids(1) }],
    ["an unknown kind", { kind: "look", itemIds: ids(1) }],
    ["an impossible day", { kind: "items", itemIds: ids(1), wornOn: "2026-02-30" }],
    ["a timestamp as the day", { kind: "items", itemIds: ids(1), wornOn: "2026-11-03T10:00:00Z" }],
    ["malformed weather", { kind: "items", itemIds: ids(1), weather: { date: "2026-11-03" } }],
    ["an unknown key", { kind: "items", itemIds: ids(1), note: "x" }],
  ])("rejects %s", (_label, input) => {
    expect(LogWearInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("UndoWearInputSchema", () => {
  it("takes 1 to 12 distinct log ids", () => {
    expect(UndoWearInputSchema.safeParse({ logIds: ids(1) }).success).toBe(true);
    expect(UndoWearInputSchema.safeParse({ logIds: ids(12) }).success).toBe(true);
    expect(UndoWearInputSchema.safeParse({ logIds: [] }).success).toBe(false);
    expect(UndoWearInputSchema.safeParse({ logIds: ids(13) }).success).toBe(false);
    const [id = ""] = ids(1);
    expect(UndoWearInputSchema.safeParse({ logIds: [id, id] }).success).toBe(false);
  });
});

describe("WEAR_UNDO_WINDOW_MS", () => {
  it("is ten minutes", () => {
    expect(WEAR_UNDO_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});

describe("calendarDayIn", () => {
  it("gives the calendar day in the zone, not in UTC", () => {
    // 23:30 UTC on 3 November is already 4 November in Berlin and Rome (UTC+1).
    const lateUtc = new Date("2026-11-03T23:30:00Z");
    expect(calendarDayIn("Europe/Berlin", lateUtc)).toBe("2026-11-04");
    expect(calendarDayIn("Europe/Rome", lateUtc)).toBe("2026-11-04");
    expect(calendarDayIn("UTC", lateUtc)).toBe("2026-11-03");
    expect(calendarDayIn("America/New_York", lateUtc)).toBe("2026-11-03");
  });

  it("follows summer time", () => {
    // 22:30 UTC on 30 June is 00:30 on 1 July in Berlin (UTC+2).
    expect(calendarDayIn("Europe/Berlin", new Date("2026-06-30T22:30:00Z"))).toBe("2026-07-01");
    expect(calendarDayIn("Europe/Berlin", new Date("2026-06-30T21:30:00Z"))).toBe("2026-06-30");
  });

  it("rejects an unknown zone", () => {
    expect(() => calendarDayIn("Mars/Olympus", new Date())).toThrow(RangeError);
  });
});

describe("noonOn", () => {
  it.each([
    ["2026-11-03", "Europe/Berlin", "2026-11-03T11:00:00.000Z"],
    ["2026-07-01", "Europe/Berlin", "2026-07-01T10:00:00.000Z"],
    ["2026-07-01", "Europe/Rome", "2026-07-01T10:00:00.000Z"],
    ["2026-03-29", "Europe/Berlin", "2026-03-29T10:00:00.000Z"],
    ["2026-10-25", "Europe/Berlin", "2026-10-25T11:00:00.000Z"],
    ["2026-11-03", "UTC", "2026-11-03T12:00:00.000Z"],
    ["2026-11-03", "America/New_York", "2026-11-03T17:00:00.000Z"],
  ])("is noon on %s in %s", (date, zone, expected) => {
    const instant = noonOn(date, zone);
    expect(instant.toISOString()).toBe(expected);
    expect(calendarDayIn(zone, instant)).toBe(date);
    expect(calendarDayIn("UTC", instant)).toBe(date);
  });

  it("rejects an invalid date", () => {
    expect(() => noonOn("2026-02-30", "Europe/Berlin")).toThrow(RangeError);
  });
});

describe("resolveWornOn", () => {
  it("defaults to today and accepts today or an earlier day", () => {
    expect(resolveWornOn(undefined, "2026-11-03")).toBe("2026-11-03");
    expect(resolveWornOn("2026-11-03", "2026-11-03")).toBe("2026-11-03");
    expect(resolveWornOn("2025-12-31", "2026-11-03")).toBe("2025-12-31");
  });

  it("refuses a future day with VALIDATION", () => {
    expect(() => resolveWornOn("2026-11-04", "2026-11-03")).toThrow(AppError);
    try {
      resolveWornOn("2027-01-01", "2026-11-03");
    } catch (error) {
      expect(error).toMatchObject({ code: "VALIDATION", message: "A wear cannot be logged for a future day." });
    }
  });
});
