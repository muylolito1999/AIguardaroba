import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import { weatherEnv } from "@/env";
import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { AppError } from "@/lib/result";
import { calendarDayIn } from "@/lib/wear/contracts";
import {
  buildForecastUrl,
  toWeatherSnapshot,
  WEATHER_UNAVAILABLE_MESSAGE,
  type WeatherSnapshot,
} from "@/lib/weather/open-meteo";
import { getHomeProfile, NO_HOME_CITY_MESSAGE, type HomeProfileDto } from "@/server/services/settings";

// Today's forecast for the home city (D-039): /today shows it and the outfit
// suggestion dresses for it. Open-Meteo is free and keyless but rate-limits
// per IP, and Vercel's IPs are shared, so the fetch is cached in a
// 'use cache' function for about 30 minutes. That function reads no cookies,
// env or database: loadTodayWeather checks the session and passes it only
// public values. A failure is never cached (Next stores only an entry whose
// function returned) and is never replaced by invented weather: it is an
// UPSTREAM error the page and the suggestion route show as such.

/** One slow request must not hold a page or the suggestion route for long. */
export const WEATHER_FETCH_TIMEOUT_MS = 8_000;

/**
 * Stale 15 minutes in the browser's router cache, refreshed in the background
 * after 30 minutes, gone after an hour without a request.
 */
export const WEATHER_CACHE_LIFE = { stale: 900, revalidate: 1800, expire: 3600 } as const;

/** Lets a Server Action or route invalidate every cached forecast (revalidateTag). */
export const WEATHER_CACHE_TAG = "weather";

export type TodayWeather = {
  profile: HomeProfileDto;
  /** YYYY-MM-DD in the home time zone. */
  today: string;
  weather: WeatherSnapshot;
};

function unavailable(cause: unknown): AppError {
  return new AppError("UPSTREAM", WEATHER_UNAVAILABLE_MESSAGE, undefined, { cause });
}

/**
 * The forecast for one place and day, cached per argument set. `day` is
 * today in `timezone`: it is part of the cache key, so a forecast fetched
 * before midnight is not served as the next day's, and an answer for another
 * day is refused. Every failure (network, timeout, non-200, a body that does
 * not match the schema) throws UPSTREAM "Weather is unavailable right now.".
 */
async function fetchForecast(
  baseUrl: string,
  lat: number,
  lon: number,
  timezone: string,
  day: string,
): Promise<WeatherSnapshot> {
  "use cache";
  cacheLife(WEATHER_CACHE_LIFE);
  cacheTag(WEATHER_CACHE_TAG);

  const url = buildForecastUrl(baseUrl, { lat, lon, timezone });
  // A timer rather than AbortSignal.timeout(), so tests can drive it with fake timers.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    } catch (error) {
      throw unavailable(error);
    }
    if (!response.ok) throw unavailable(new Error(`Open-Meteo answered HTTP ${response.status}.`));
    let body: unknown;
    try {
      // The abort signal also covers reading the body.
      body = await response.json();
    } catch (error) {
      throw unavailable(error);
    }
    const snapshot = toWeatherSnapshot(body, new Date());
    if (snapshot.date !== day) {
      throw unavailable(new Error(`Open-Meteo sent the forecast for ${snapshot.date} instead of ${day}.`));
    }
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Today's forecast for the home city, with the profile and today's date in
 * its time zone. NOT_FOUND when no home city is set; UPSTREAM when the
 * weather cannot be read. An error leaving a cached function reaches the
 * caller as a plain Error in production (React hides its message), so
 * anything that is not one of Next's own control-flow errors becomes UPSTREAM
 * here; Next logs the original on the server.
 */
export async function loadTodayWeather(db: Db, options: { now?: Date } = {}): Promise<TodayWeather> {
  await requireSession();
  const profile = await getHomeProfile(db);
  if (profile === null) throw new AppError("NOT_FOUND", NO_HOME_CITY_MESSAGE);
  const today = calendarDayIn(profile.timezone, options.now ?? new Date());
  const { OPEN_METEO_BASE_URL } = weatherEnv();
  try {
    const weather = await fetchForecast(OPEN_METEO_BASE_URL, profile.lat, profile.lon, profile.timezone, today);
    return { profile, today, weather };
  } catch (error) {
    unstable_rethrow(error);
    console.warn(`[weather] no forecast for ${profile.city} on ${today}:`, error);
    throw error instanceof AppError && error.code === "UPSTREAM" ? error : unavailable(error);
  }
}
