import { describe, expect, it } from "vitest"

import {
  formatDayHeading,
  formatDegreeRange,
  formatDegrees,
  formatPrecipitation,
  formatRainChance,
  formatTimeIn,
  weatherKind,
} from "./format"

describe("today's formats", () => {
  it("names the day without a time zone shift", () => {
    expect(formatDayHeading("2026-11-03")).toBe("Tuesday 3 November")
    expect(formatDayHeading("2026-12-31")).toBe("Thursday 31 December")
  })

  it("prints whole degrees with a real minus sign and no minus zero", () => {
    expect(formatDegrees(9.4)).toBe("9 °C")
    expect(formatDegrees(-3.6)).toBe("−4 °C")
    expect(formatDegrees(-0.4)).toBe("0 °C")
    expect(formatDegreeRange(2.1, 7.6)).toBe("2 to 8 °C")
    expect(formatDegreeRange(-5.2, -0.6)).toBe("−5 to −1 °C")
    expect(formatDegreeRange(4.6, 5.4)).toBe("5 °C")
  })

  it("says when the rain chance is unknown, and prints rain in millimetres", () => {
    expect(formatRainChance(80)).toBe("80 % chance of rain")
    expect(formatRainChance(null)).toBe("Chance of rain unknown")
    expect(formatPrecipitation(0)).toBe("0 mm")
    expect(formatPrecipitation(3.44)).toBe("3.4 mm")
  })

  it("prints the time in the forecast's zone", () => {
    expect(formatTimeIn("2026-11-03T13:20:00.000Z", "Europe/Berlin")).toBe("14:20")
    expect(formatTimeIn("2026-07-03T13:20:00.000Z", "Europe/Rome")).toBe("15:20")
  })

  it("groups the WMO codes Open-Meteo sends for their icon", () => {
    expect([0, 1, 2, 3, 45, 48, 51, 57, 61, 67, 80, 82, 71, 77, 85, 86, 95, 99, 42].map(weatherKind)).toEqual([
      "clear",
      "clear",
      "partly",
      "cloudy",
      "fog",
      "fog",
      "drizzle",
      "drizzle",
      "rain",
      "rain",
      "rain",
      "rain",
      "snow",
      "snow",
      "snow",
      "snow",
      "thunder",
      "thunder",
      "unknown",
    ])
  })
})
