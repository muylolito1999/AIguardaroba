// Today's forecast from Open-Meteo (D-039): the request URL, the zod schema of
// the fields we use, and their reduction to the WeatherSnapshot that /today
// shows, the outfit prompt reads and wear logs keep. Pure and client-safe: no
// fetch, env or Node APIs. src/server/weather.ts does the cached fetch.
// Variable names follow https://open-meteo.com/en/docs (checked 2026-11-03).

import { z } from "zod";

import { IsoDateSchema } from "@/lib/relocation/contracts";
import { AppError } from "@/lib/result";

export const OPEN_METEO_DEFAULT_BASE_URL = "https://api.open-meteo.com";

/** The licence asks for this credit wherever the data is shown (D-039). */
export const OPEN_METEO_ATTRIBUTION = { text: "Weather data by Open-Meteo.com", href: "https://open-meteo.com/" } as const;

export const WEATHER_UNAVAILABLE_MESSAGE = "Weather is unavailable right now.";

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** Exactly the variables toWeatherSnapshot reads. */
export const OPEN_METEO_VARIABLES = {
  daily: [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "apparent_temperature_max",
    "apparent_temperature_min",
    "precipitation_sum",
    "precipitation_probability_max",
    "wind_gusts_10m_max",
  ],
  hourly: ["precipitation_probability"],
  current: ["temperature_2m"],
} as const;

export type ForecastLocation = { lat: number; lon: number; timezone: string };

/**
 * The /v1/forecast URL for today at a place: one forecast day whose daily
 * boundaries follow the given IANA time zone, °C and km/h. A path on the base
 * URL is kept (a local stub may serve under one).
 */
export function buildForecastUrl(baseUrl: string, location: ForecastLocation): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new RangeError("The Open-Meteo base URL must use http or https.");
  }
  const { lat, lon, timezone } = location;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError("Latitude must be between -90 and 90.");
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new RangeError("Longitude must be between -180 and 180.");
  if (timezone.trim() === "") throw new RangeError("A time zone is required.");

  const url = new URL(`${base.origin}${base.pathname.replace(/\/+$/, "")}/v1/forecast`);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("timezone", timezone);
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "kmh");
  url.searchParams.set("daily", OPEN_METEO_VARIABLES.daily.join(","));
  url.searchParams.set("hourly", OPEN_METEO_VARIABLES.hourly.join(","));
  url.searchParams.set("current", OPEN_METEO_VARIABLES.current.join(","));
  return url;
}

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

/** One value per forecast day; today is the first. Open-Meteo sends null for missing data, which fails here. */
const daily = <T extends z.ZodType>(value: T) => z.array(value).min(1);

/**
 * The fields of a forecast response that toWeatherSnapshot uses. Unknown keys
 * are dropped. Today's temperatures, precipitation, gusts and weather code
 * must be numbers; only the current temperature and the probabilities may be
 * null, since the snapshot can say those are unknown.
 */
export const OpenMeteoForecastSchema = z.object({
  timezone: z.string().min(1),
  current: z.object({
    time: z.string(),
    temperature_2m: z.number().nullable(),
  }),
  hourly: z
    .object({
      time: z.array(z.string()),
      precipitation_probability: z.array(z.number().min(0).max(100).nullable()),
    })
    .refine((hourly) => hourly.time.length === hourly.precipitation_probability.length, {
      error: "hourly arrays differ in length",
    }),
  daily: z.object({
    time: daily(IsoDateSchema),
    weather_code: daily(z.number().int().min(0)),
    temperature_2m_max: daily(z.number()),
    temperature_2m_min: daily(z.number()),
    apparent_temperature_max: daily(z.number()),
    apparent_temperature_min: daily(z.number()),
    precipitation_sum: daily(z.number().min(0)),
    precipitation_probability_max: daily(z.number().min(0).max(100).nullable()),
    wind_gusts_10m_max: daily(z.number().min(0)),
  }),
});
export type OpenMeteoForecast = z.infer<typeof OpenMeteoForecastSchema>;

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

const celsius = z.number().min(-90).max(60);

/** Today's weather as the app keeps it (wear_logs.weather_snapshot, the suggestion result). */
export const WeatherSnapshotSchema = z
  .strictObject({
    /** The forecast day, YYYY-MM-DD in `timezone`. */
    date: IsoDateSchema,
    timezone: z.string().min(1).max(64),
    currentC: celsius.nullable(),
    tminC: celsius,
    tmaxC: celsius,
    apparentMinC: celsius,
    apparentMaxC: celsius,
    precipSumMm: z.number().min(0).max(2000),
    /** Percent; the higher of the daily and the hourly maximum. */
    precipProbMax: z.number().min(0).max(100).nullable(),
    windGustMaxKmh: z.number().min(0).max(500),
    /** WMO 4677 code; Open-Meteo's daily code is the day's most severe. */
    weatherCode: z.number().int().min(0).max(99),
    label: z.string().min(1).max(60),
    /** ISO 8601 timestamp of the fetch. */
    fetchedAt: z.iso.datetime(),
  })
  .refine((snapshot) => snapshot.tminC <= snapshot.tmaxC && snapshot.apparentMinC <= snapshot.apparentMaxC, {
    error: "The minimum is above the maximum.",
  });
export type WeatherSnapshot = z.infer<typeof WeatherSnapshotSchema>;

function upstreamError(cause: unknown): AppError {
  return new AppError("UPSTREAM", WEATHER_UNAVAILABLE_MESSAGE, undefined, { cause });
}

/** The highest number in a list that may hold nulls; null when there is none. */
function maxOf(values: ReadonlyArray<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (typeof value === "number" && (max === null || value > max)) max = value;
  }
  return max;
}

/**
 * Reduces a forecast response to today's snapshot: the first daily entry, the
 * current temperature, and the precipitation probability as the higher of the
 * daily maximum and the highest hourly value. A response that does not match
 * the schema (or whose minimum is above its maximum) throws AppError UPSTREAM
 * "Weather is unavailable right now." with the zod error as its cause: the app
 * never shows or uses partial weather.
 */
export function toWeatherSnapshot(response: unknown, fetchedAt: Date): WeatherSnapshot {
  const parsed = OpenMeteoForecastSchema.safeParse(response);
  if (!parsed.success) throw upstreamError(parsed.error);
  const { timezone, current, hourly, daily: day } = parsed.data;

  const first = <T>(values: readonly T[]): T => {
    const [value] = values;
    if (value === undefined) throw upstreamError(new Error("A daily array is empty."));
    return value;
  };
  const weatherCode = first(day.weather_code);
  const candidate = {
    date: first(day.time),
    timezone,
    currentC: current.temperature_2m,
    tminC: first(day.temperature_2m_min),
    tmaxC: first(day.temperature_2m_max),
    apparentMinC: first(day.apparent_temperature_min),
    apparentMaxC: first(day.apparent_temperature_max),
    precipSumMm: first(day.precipitation_sum),
    precipProbMax: maxOf([first(day.precipitation_probability_max), ...hourly.precipitation_probability]),
    windGustMaxKmh: first(day.wind_gusts_10m_max),
    weatherCode,
    label: wmoCodeLabel(weatherCode),
    fetchedAt: fetchedAt.toISOString(),
  };
  const snapshot = WeatherSnapshotSchema.safeParse(candidate);
  if (!snapshot.success) throw upstreamError(snapshot.error);
  return snapshot.data;
}

// ---------------------------------------------------------------------------
// Labels and prompt text
// ---------------------------------------------------------------------------

/** The WMO 4677 codes Open-Meteo reports (its docs list 97 too). */
const WMO_LABELS: Readonly<Record<number, string>> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  97: "Heavy thunderstorm",
  99: "Thunderstorm with heavy hail",
};

/** Codes inside a family that Open-Meteo does not use get the family's plain label. */
const WMO_FAMILIES: ReadonlyArray<{ from: number; to: number; label: string }> = [
  { from: 51, to: 55, label: "Drizzle" },
  { from: 61, to: 65, label: "Rain" },
  { from: 71, to: 75, label: "Snow" },
  { from: 95, to: 99, label: "Thunderstorm" },
];

/** A short English label for a WMO weather code; "Unknown" for anything else. */
export function wmoCodeLabel(code: number): string {
  if (!Number.isInteger(code)) return "Unknown";
  const exact = WMO_LABELS[code];
  if (exact !== undefined) return exact;
  return WMO_FAMILIES.find((family) => code >= family.from && code <= family.to)?.label ?? "Unknown";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function oneDecimal(value: number): string {
  // Avoids "-0.0" for values that round to zero.
  const rounded = Math.round(value * 10) / 10;
  return (rounded === 0 ? 0 : rounded).toFixed(1);
}

function weekdayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const index = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return WEEKDAYS[index] ?? "";
}

/** The snapshot as compact lines for the outfit prompt. */
export function describeWeatherForPrompt(snapshot: WeatherSnapshot): string {
  const now = snapshot.currentC === null ? "" : `, now ${oneDecimal(snapshot.currentC)} °C`;
  const chance = snapshot.precipProbMax === null ? "chance unknown" : `chance up to ${Math.round(snapshot.precipProbMax)} %`;
  return [
    `Date: ${weekdayOf(snapshot.date)} ${snapshot.date} (${snapshot.timezone})`,
    `Conditions: ${snapshot.label} (WMO ${snapshot.weatherCode})`,
    `Air temperature: ${oneDecimal(snapshot.tminC)} to ${oneDecimal(snapshot.tmaxC)} °C${now}`,
    `Feels like: ${oneDecimal(snapshot.apparentMinC)} to ${oneDecimal(snapshot.apparentMaxC)} °C`,
    `Precipitation: ${oneDecimal(snapshot.precipSumMm)} mm, ${chance}`,
    `Wind gusts: up to ${Math.round(snapshot.windGustMaxKmh)} km/h`,
  ].join("\n");
}
