import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/result";
import {
  buildForecastUrl,
  describeWeatherForPrompt,
  OPEN_METEO_ATTRIBUTION,
  OPEN_METEO_DEFAULT_BASE_URL,
  OPEN_METEO_VARIABLES,
  OpenMeteoForecastSchema,
  toWeatherSnapshot,
  WEATHER_UNAVAILABLE_MESSAGE,
  WeatherSnapshotSchema,
  wmoCodeLabel,
} from "@/lib/weather/open-meteo";

import { hamburgForecastResponse, makeWeatherSnapshot } from "../../../test/outfit-fixtures";

const FETCHED_AT = new Date("2026-11-03T13:20:00.000Z");

/** Runs toWeatherSnapshot on the fixture after `change` edits a copy of it. */
function snapshotWith(change: (response: ReturnType<typeof hamburgForecastResponse>) => unknown) {
  const response = hamburgForecastResponse();
  const changed = change(response) ?? response;
  return () => toWeatherSnapshot(changed, FETCHED_AT);
}

function expectUpstream(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppError);
  expect(thrown).toMatchObject({ code: "UPSTREAM", message: WEATHER_UNAVAILABLE_MESSAGE });
}

describe("buildForecastUrl", () => {
  const hamburg = { lat: 53.633, lon: 9.988, timezone: "Europe/Berlin" };

  it("asks /v1/forecast for one day in the place's time zone, °C and km/h, and only the variables used", () => {
    const url = buildForecastUrl(OPEN_METEO_DEFAULT_BASE_URL, hamburg);
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.pathname).toBe("/v1/forecast");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: "53.633",
      longitude: "9.988",
      timezone: "Europe/Berlin",
      forecast_days: "1",
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      daily:
        "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min," +
        "precipitation_sum,precipitation_probability_max,wind_gusts_10m_max",
      hourly: "precipitation_probability",
      current: "temperature_2m",
    });
  });

  it("requests exactly the fields the schema reads", () => {
    const shape = OpenMeteoForecastSchema.shape;
    expect([...OPEN_METEO_VARIABLES.daily].sort()).toEqual(Object.keys(shape.daily.shape).filter((key) => key !== "time").sort());
    expect([...OPEN_METEO_VARIABLES.current]).toEqual(["temperature_2m"]);
    expect([...OPEN_METEO_VARIABLES.hourly]).toEqual(["precipitation_probability"]);
  });

  it("keeps a stub's path and port and drops a trailing slash", () => {
    expect(buildForecastUrl("http://127.0.0.1:4010/", hamburg).href).toMatch(/^http:\/\/127\.0\.0\.1:4010\/v1\/forecast\?/);
    expect(buildForecastUrl("http://localhost:4010/meteo/", hamburg).pathname).toBe("/meteo/v1/forecast");
  });

  it("encodes the time zone", () => {
    expect(buildForecastUrl(OPEN_METEO_DEFAULT_BASE_URL, { ...hamburg, timezone: "Europe/Rome" }).search).toContain(
      "timezone=Europe%2FRome",
    );
  });

  it.each([
    ["a non-http base URL", "ftp://example.com", hamburg],
    ["a latitude out of range", OPEN_METEO_DEFAULT_BASE_URL, { ...hamburg, lat: 91 }],
    ["a longitude out of range", OPEN_METEO_DEFAULT_BASE_URL, { ...hamburg, lon: -181 }],
    ["a NaN latitude", OPEN_METEO_DEFAULT_BASE_URL, { ...hamburg, lat: Number.NaN }],
    ["an empty time zone", OPEN_METEO_DEFAULT_BASE_URL, { ...hamburg, timezone: " " }],
  ])("rejects %s", (_label, base, location) => {
    expect(() => buildForecastUrl(base, location)).toThrow(RangeError);
  });

  it("rejects a base URL that does not parse", () => {
    expect(() => buildForecastUrl("not a url", hamburg)).toThrow(TypeError);
  });
});

describe("toWeatherSnapshot", () => {
  it("reduces the Hamburg fixture to today's snapshot", () => {
    const snapshot = toWeatherSnapshot(hamburgForecastResponse(), FETCHED_AT);
    expect(snapshot).toEqual(makeWeatherSnapshot());
    expect(WeatherSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("takes the precipitation probability as the higher of the hourly and daily maximum", () => {
    // The fixture's hourly peak (80) is above its daily value (78).
    const response = hamburgForecastResponse();
    expect(Math.max(...response.hourly.precipitation_probability)).toBe(80);
    expect(response.daily.precipitation_probability_max[0]).toBe(78);
    expect(toWeatherSnapshot(response, FETCHED_AT).precipProbMax).toBe(80);

    const dailyHigher = snapshotWith((r) => {
      r.daily.precipitation_probability_max = [95];
    });
    expect(dailyHigher().precipProbMax).toBe(95);
  });

  it("skips null probabilities, and is null only when every one is null", () => {
    const someNull = hamburgForecastResponse() as unknown as {
      daily: { precipitation_probability_max: (number | null)[] };
      hourly: { precipitation_probability: (number | null)[] };
    };
    someNull.daily.precipitation_probability_max = [null];
    someNull.hourly.precipitation_probability = someNull.hourly.precipitation_probability.map((value, index) =>
      index === 3 ? 61 : index % 2 === 0 ? null : (value ?? 0) / 10,
    );
    expect(toWeatherSnapshot(someNull, FETCHED_AT).precipProbMax).toBe(61);

    someNull.hourly.precipitation_probability = someNull.hourly.precipitation_probability.map(() => null);
    expect(toWeatherSnapshot(someNull, FETCHED_AT).precipProbMax).toBeNull();
  });

  it("allows an unknown current temperature", () => {
    const run = snapshotWith((r) => {
      (r.current as { temperature_2m: number | null }).temperature_2m = null;
    });
    expect(run().currentC).toBeNull();
  });

  it("uses the first day when more are returned, and its label", () => {
    const run = snapshotWith((r) => {
      r.daily = {
        ...r.daily,
        time: ["2026-11-03", "2026-11-04"],
        weather_code: [81, 3],
        temperature_2m_max: [10.8, 12],
      };
    });
    expect(run()).toMatchObject({ date: "2026-11-03", weatherCode: 81, label: "Rain showers", tmaxC: 10.8 });
  });

  it.each([
    ["a missing daily block", (r: Record<string, unknown>) => ({ ...r, daily: undefined })],
    ["a missing current block", (r: Record<string, unknown>) => ({ ...r, current: undefined })],
    ["an empty daily array", (r: Record<string, unknown>) => ({ ...r, daily: { ...(r.daily as object), time: [] } })],
    ["a null daily maximum", (r: Record<string, unknown>) => ({ ...r, daily: { ...(r.daily as object), temperature_2m_max: [null] } })],
    ["a string temperature", (r: Record<string, unknown>) => ({ ...r, daily: { ...(r.daily as object), temperature_2m_min: ["5.9"] } })],
    ["a malformed date", (r: Record<string, unknown>) => ({ ...r, daily: { ...(r.daily as object), time: ["03/11/2026"] } })],
    ["a negative gust", (r: Record<string, unknown>) => ({ ...r, daily: { ...(r.daily as object), wind_gusts_10m_max: [-1] } })],
    ["a probability above 100", (r: Record<string, unknown>) => ({ ...r, daily: { ...(r.daily as object), precipitation_probability_max: [101] } })],
    ["a fractional weather code", (r: Record<string, unknown>) => ({ ...r, daily: { ...(r.daily as object), weather_code: [61.5] } })],
    ["a minimum above the maximum", (r: Record<string, unknown>) => ({ ...r, daily: { ...(r.daily as object), temperature_2m_min: [11] } })],
    [
      "hourly arrays of different lengths",
      (r: Record<string, unknown>) => ({ ...r, hourly: { ...(r.hourly as object), time: ["2026-11-03T00:00"] } }),
    ],
    ["an error body", () => ({ error: true, reason: "Cannot initialize WeatherVariable from invalid String value" })],
    ["no body", () => null],
  ])("throws UPSTREAM for %s", (_label, change) => {
    expectUpstream(() => toWeatherSnapshot(change(hamburgForecastResponse() as unknown as Record<string, unknown>), FETCHED_AT));
  });

  it("keeps the zod error as the cause for the server log, not in the message", () => {
    try {
      toWeatherSnapshot({ timezone: "Europe/Berlin" }, FETCHED_AT);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).cause).toBeDefined();
      expect((error as AppError).details).toBeUndefined();
    }
  });
});

describe("WeatherSnapshotSchema", () => {
  it("rejects unknown keys and reversed ranges", () => {
    expect(WeatherSnapshotSchema.safeParse({ ...makeWeatherSnapshot(), extra: 1 }).success).toBe(false);
    expect(WeatherSnapshotSchema.safeParse(makeWeatherSnapshot({ apparentMinC: 9, apparentMaxC: 8 })).success).toBe(false);
    expect(WeatherSnapshotSchema.safeParse(makeWeatherSnapshot({ fetchedAt: "yesterday" })).success).toBe(false);
  });
});

describe("wmoCodeLabel", () => {
  it.each([
    [0, "Clear sky"],
    [1, "Mainly clear"],
    [2, "Partly cloudy"],
    [3, "Overcast"],
    [45, "Fog"],
    [48, "Freezing fog"],
    [61, "Light rain"],
    [65, "Heavy rain"],
    [67, "Freezing rain"],
    [71, "Light snow"],
    [77, "Snow grains"],
    [85, "Light snow showers"],
    [86, "Heavy snow showers"],
    [95, "Thunderstorm"],
    [96, "Thunderstorm with hail"],
    [97, "Heavy thunderstorm"],
    [99, "Thunderstorm with heavy hail"],
  ])("labels %i as %s", (code, label) => {
    expect(wmoCodeLabel(code)).toBe(label);
  });

  it("labels every code from 51 to 57 as drizzle", () => {
    for (let code = 51; code <= 57; code += 1) expect(wmoCodeLabel(code), String(code)).toMatch(/drizzle/i);
    expect(wmoCodeLabel(56)).toBe("Light freezing drizzle");
  });

  it("labels 80 to 82 as rain showers", () => {
    expect([80, 81, 82].map(wmoCodeLabel)).toEqual(["Light rain showers", "Rain showers", "Violent rain showers"]);
  });

  it("labels every code from 95 to 99 as a thunderstorm", () => {
    for (let code = 95; code <= 99; code += 1) expect(wmoCodeLabel(code)).toMatch(/thunderstorm/i);
  });

  it.each([4, 44, 50, 58, 60, 68, 79, 83, 87, 94, 100, -1, 1.5, Number.NaN])("labels %s as Unknown", (code) => {
    expect(wmoCodeLabel(code)).toBe("Unknown");
  });
});

describe("describeWeatherForPrompt", () => {
  it("gives the day, conditions, temperatures, rain and gusts in compact lines", () => {
    expect(describeWeatherForPrompt(makeWeatherSnapshot())).toBe(
      [
        "Date: Tuesday 2026-11-03 (Europe/Berlin)",
        "Conditions: Light rain (WMO 61)",
        "Air temperature: 5.9 to 10.8 °C, now 9.4 °C",
        "Feels like: 2.1 to 7.6 °C",
        "Precipitation: 3.4 mm, chance up to 80 %",
        "Wind gusts: up to 53 km/h",
      ].join("\n"),
    );
  });

  it("says what is unknown instead of inventing it", () => {
    const text = describeWeatherForPrompt(makeWeatherSnapshot({ currentC: null, precipProbMax: null, apparentMinC: -0.04 }));
    expect(text).toContain("Air temperature: 5.9 to 10.8 °C\n");
    expect(text).toContain("chance unknown");
    expect(text).toContain("Feels like: 0.0 to 7.6 °C");
  });
});

describe("attribution", () => {
  it("credits Open-Meteo as its licence asks (D-039)", () => {
    expect(OPEN_METEO_ATTRIBUTION).toEqual({ text: "Weather data by Open-Meteo.com", href: "https://open-meteo.com/" });
  });
});
