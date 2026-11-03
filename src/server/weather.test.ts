import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BOLOGNA } from "@/lib/climate/bologna";
import { HAMBURG } from "@/lib/climate/hamburg";
import { appSettings, climateProfiles, type ClimateProfile } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../test/db";
import { hamburgForecastResponse, makeWeatherSnapshot } from "../../test/outfit-fixtures";

// The cached forecast fetch, with a stubbed fetch (no network) and next/cache
// replaced by recorders: outside Next, 'use cache' is an inert string and
// cacheLife()/cacheTag() would throw for want of a cache scope.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("next/cache", () => ({ cacheLife: mocks.cacheLife, cacheTag: mocks.cacheTag }));

const { loadTodayWeather, WEATHER_CACHE_LIFE, WEATHER_FETCH_TIMEOUT_MS } = await import("./weather");

// 13:20 UTC is 14:20 in Rome and Berlin: Tuesday 3 November 2026 in both.
const NOW = new Date("2026-11-03T13:20:00.000Z");

let testDb: TestDb;
let bologna: ClimateProfile;
let hamburg: ClimateProfile;
const fetchMock = vi.fn<typeof fetch>();

function forecastFor(day: string, timezone: string) {
  const response = hamburgForecastResponse();
  response.timezone = timezone;
  response.daily.time = [day];
  return response;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function expectUpstream(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => {
      throw new Error("expected UPSTREAM");
    },
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code: "UPSTREAM", message: "Weather is unavailable right now." });
  return error as AppError;
}

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  mocks.cacheLife.mockReset();
  mocks.cacheTag.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const rows = await testDb.db.insert(climateProfiles).values([HAMBURG, BOLOGNA]).returning();
  const byslug = new Map(rows.map((row) => [row.slug, row]));
  const b = byslug.get("bologna");
  const h = byslug.get("hamburg");
  if (b === undefined || h === undefined) throw new Error("profiles missing");
  bologna = b;
  hamburg = h;
  await testDb.db.insert(appSettings).values({ id: 1, homeProfileId: bologna.id, defaultItemLocation: "bologna" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.close();
});

describe("loadTodayWeather", () => {
  it("fetches today's forecast for the home city from the public API and reduces it to a snapshot", async () => {
    fetchMock.mockResolvedValue(jsonResponse(forecastFor("2026-11-03", "Europe/Rome")));

    const result = await loadTodayWeather(testDb.db, { now: NOW });

    expect(result.profile).toMatchObject({ id: bologna.id, city: "Bologna", timezone: "Europe/Rome" });
    expect(result.today).toBe("2026-11-03");
    expect(result.weather).toMatchObject({
      date: "2026-11-03",
      timezone: "Europe/Rome",
      apparentMinC: 2.1,
      apparentMaxC: 7.6,
      precipProbMax: 80,
      windGustMaxKmh: 52.9,
      label: "Light rain",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.pathname).toBe("/v1/forecast");
    expect(url.searchParams.get("latitude")).toBe(String(BOLOGNA.lat));
    expect(url.searchParams.get("longitude")).toBe(String(BOLOGNA.lon));
    expect(url.searchParams.get("timezone")).toBe("Europe/Rome");
    expect(url.searchParams.get("forecast_days")).toBe("1");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("caches for about 30 minutes under the weather tag", async () => {
    fetchMock.mockResolvedValue(jsonResponse(forecastFor("2026-11-03", "Europe/Rome")));
    await loadTodayWeather(testDb.db, { now: NOW });

    expect(WEATHER_CACHE_LIFE).toEqual({ stale: 900, revalidate: 1800, expire: 3600 });
    expect(mocks.cacheLife).toHaveBeenCalledWith(WEATHER_CACHE_LIFE);
    expect(mocks.cacheTag).toHaveBeenCalledWith("weather");
  });

  it("follows the home city and its time zone for today's date", async () => {
    await testDb.db.update(appSettings).set({ homeProfileId: hamburg.id });
    // 23:30 UTC on 3 November is already 4 November in Berlin.
    fetchMock.mockResolvedValue(jsonResponse(forecastFor("2026-11-04", "Europe/Berlin")));

    const result = await loadTodayWeather(testDb.db, { now: new Date("2026-11-03T23:30:00.000Z") });

    expect(result.today).toBe("2026-11-04");
    expect(result.weather.date).toBe("2026-11-04");
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("latitude")).toBe(String(HAMBURG.lat));
    expect(url.searchParams.get("timezone")).toBe("Europe/Berlin");
  });

  it("checks the session before reading or fetching anything", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));
    await expect(loadTodayWeather(testDb.db, { now: NOW })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND without fetching when no home city is set", async () => {
    await testDb.db.update(appSettings).set({ homeProfileId: null });
    await expect(loadTodayWeather(testDb.db, { now: NOW })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Choose your home city in Settings first.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([500, 429, 404])("turns HTTP %i into UPSTREAM", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: true, reason: "nope" }, status));
    await expectUpstream(loadTodayWeather(testDb.db, { now: NOW }));
  });

  it("turns a network failure into UPSTREAM", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expectUpstream(loadTodayWeather(testDb.db, { now: NOW }));
  });

  it("turns a body that is not JSON into UPSTREAM", async () => {
    fetchMock.mockResolvedValue(new Response("<html>busy</html>", { status: 200 }));
    await expectUpstream(loadTodayWeather(testDb.db, { now: NOW }));
  });

  it("turns a schema mismatch, a null in today's values included, into UPSTREAM instead of partial weather", async () => {
    const missing = forecastFor("2026-11-03", "Europe/Rome") as unknown as { daily: Record<string, unknown> };
    missing.daily.apparent_temperature_min = [null];
    fetchMock.mockResolvedValue(jsonResponse(missing));
    await expectUpstream(loadTodayWeather(testDb.db, { now: NOW }));
  });

  it("refuses a forecast for another day than today in the home time zone", async () => {
    fetchMock.mockResolvedValue(jsonResponse(forecastFor("2026-11-02", "Europe/Rome")));
    const error = await expectUpstream(loadTodayWeather(testDb.db, { now: NOW }));
    expect(String((error.cause as Error).message)).toContain("2026-11-02 instead of 2026-11-03");
  });

  it("gives up after 8 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

    const pending = loadTodayWeather(testDb.db, { now: NOW });
    const settled = expectUpstream(pending);
    // vi.waitFor would advance the fake clock itself; setImmediate is not faked.
    for (let turn = 0; turn < 1_000 && fetchMock.mock.calls.length === 0; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WEATHER_FETCH_TIMEOUT_MS - 1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(WEATHER_FETCH_TIMEOUT_MS).toBe(8_000);
  });

  it("passes a plain Error from the cached function on as UPSTREAM, as production delivers it", async () => {
    // In production React hides the message of an error that leaves a cached
    // function; loadTodayWeather must not depend on it being an AppError.
    fetchMock.mockImplementation(() => {
      throw new Error("An error occurred in the Server Components render.");
    });
    await expectUpstream(loadTodayWeather(testDb.db, { now: NOW }));
  });
});

describe("the snapshot fixture", () => {
  it("matches what the shared fixture builder expects", async () => {
    fetchMock.mockResolvedValue(jsonResponse(forecastFor("2026-11-03", "Europe/Berlin")));
    await testDb.db.update(appSettings).set({ homeProfileId: hamburg.id });
    const { weather } = await loadTodayWeather(testDb.db, { now: NOW });
    expect({ ...weather, fetchedAt: "x" }).toEqual({ ...makeWeatherSnapshot(), fetchedAt: "x" });
  });
});
