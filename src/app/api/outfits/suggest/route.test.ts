import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { HAMBURG } from "@/lib/climate/hamburg";
import { aiCalls, analyses, appSettings, climateProfiles, items, type ClimateProfile } from "@/lib/db/schema";
import { buildSuggestionSnapshot, OUTFIT_PROMPT_VERSION } from "@/lib/outfits/suggestion";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";
import { calendarDayIn } from "@/lib/wear/contracts";

import { makeTestDb, type TestDb } from "../../../../../test/db";
import { createFakeAnthropic, fakeMessage } from "../../../../../test/fakes/anthropic";
import {
  fakeOutfitSuggestionReply,
  hamburgForecastResponse,
  makeOutfitSuggestionResult,
  makeOutfitWardrobe,
  makeWeatherSnapshot,
  type OutfitFixtureItem,
} from "../../../../../test/outfit-fixtures";

// Wiring of POST /api/outfits/suggest with the real service and forecast
// code: the Origin and body checks, the 120 s budget, and the answers without
// a home city, without weather and without an API key. Open-Meteo is a
// stubbed fetch and Claude a scripted fake: no network.

const ORIGIN = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
  getAnthropic: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));
vi.mock("@/lib/ai/client", () => ({ getAnthropic: mocks.getAnthropic }));
// Outside Next, cacheLife() and cacheTag() have no cache scope to write to.
vi.mock("next/cache", () => ({ cacheLife: () => undefined, cacheTag: () => undefined }));

const route = await import("./route");

const SuggestionAnswerSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    analysisId: z.string(),
    date: z.string(),
    outfits: z.array(z.object({ title: z.string(), items: z.array(z.object({ itemId: z.string() })) })),
  }),
});

let testDb: TestDb;
let hamburg: ClimateProfile;
let wardrobe: OutfitFixtureItem[];
const fetchMock = vi.fn<typeof fetch>();

function todayInHamburg(): string {
  return calendarDayIn("Europe/Berlin", new Date());
}

function forecastForToday(): Response {
  const body = hamburgForecastResponse();
  body.daily.time = [todayInHamburg()];
  return Response.json(body);
}

function call(body?: string, origin = ORIGIN) {
  const request = new Request(`${ORIGIN}/api/outfits/suggest`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  return route.POST(request, { params: Promise.resolve({}) });
}

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  mocks.getAnthropic.mockReset();
  mocks.getAnthropic.mockImplementation(() => {
    throw new AppError("CONFIG", "Invalid server configuration (ai): ANTHROPIC_API_KEY is not set.");
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => forecastForToday());
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const [profile] = await testDb.db.insert(climateProfiles).values(HAMBURG).returning();
  if (profile === undefined) throw new Error("no profile");
  hamburg = profile;
  await testDb.db.insert(appSettings).values({ id: 1, homeProfileId: hamburg.id, defaultItemLocation: "hamburg" });
  wardrobe = Object.values(makeOutfitWardrobe());
  await testDb.db.insert(items).values(
    wardrobe.map((item, index) => ({
      id: item.id,
      createdAt: new Date(item.createdAt),
      imageHash: String(index).padStart(64, "0"),
      status: item.status,
      location: item.location,
      name: item.name,
      category: item.category,
      subcategory: item.subcategory,
      colors: [...item.colors],
      materials: [...item.materials],
      warmthLevel: item.warmthLevel,
      waterproof: item.waterproof,
      windproof: item.windproof,
      insulated: item.insulated,
      breathable: item.breathable,
      seasons: [...item.seasons],
      formality: item.formality,
      condition: "good" as const,
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.close();
});

describe("POST /api/outfits/suggest", () => {
  it("allows 120 s, of which the service gives Claude at most 110 s", () => {
    expect(route.maxDuration).toBe(120);
  });

  it("refuses a cross-origin request before anything else", async () => {
    const response = await call("{}", "https://evil.example");
    expect(response.status).toBe(403);
    expect(mocks.requireSession).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again."));
    const response = await call("{}");
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{force"],
    ["an unknown key", JSON.stringify({ force: true, model: "claude-opus-5-5" })],
    ["a force that is not a boolean", JSON.stringify({ force: "yes" })],
    ["an array", "[]"],
  ])("refuses a body with %s", async (_label, body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("answers 404 without a home city, before the weather or Claude", async () => {
    await testDb.db.update(appSettings).set({ homeProfileId: null });
    const response = await call("{}");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Choose your home city in Settings first." },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("answers 502 when the weather is unavailable and never asks Claude", async () => {
    fetchMock.mockImplementation(async () => new Response("busy", { status: 503 }));
    const response = await call("{}");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM", message: "Weather is unavailable right now." },
    });
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("answers CONFIG without an API key, with the safe message and nothing logged or stored", async () => {
    const response = await call(); // An empty body counts as {}.
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } });
    expect(mocks.getAnthropic).toHaveBeenCalledTimes(1);
    expect(await testDb.db.select().from(aiCalls)).toHaveLength(0);
    expect(await testDb.db.select().from(analyses)).toHaveLength(0);
  });

  it("suggests three outfits with the key, then answers the stored ones without it", async () => {
    const weather = makeWeatherSnapshot({ date: todayInHamburg() });
    const rows = await testDb.db.select().from(items);
    const fake = createFakeAnthropic([fakeMessage({ json: fakeOutfitSuggestionReply(buildSuggestionSnapshot(rows, weather)) })]);
    mocks.getAnthropic.mockReturnValue(fake);

    const first = await call(JSON.stringify({ force: false }));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const body = SuggestionAnswerSchema.parse(await first.json());
    expect(body.data.date).toBe(todayInHamburg());
    expect(body.data.outfits).toHaveLength(3);
    expect(fake.requests).toHaveLength(1);

    mocks.getAnthropic.mockReset();
    const second = await call("{}");
    expect(second.status).toBe(200);
    expect(SuggestionAnswerSchema.parse(await second.json()).data.analysisId).toBe(body.data.analysisId);
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("asks Claude again with force", async () => {
    const result = makeOutfitSuggestionResult(wardrobe, makeWeatherSnapshot({ date: todayInHamburg() }));
    await testDb.db.insert(analyses).values({
      kind: "outfit_suggestion",
      status: "complete",
      climateProfileId: hamburg.id,
      dateFrom: result.weather.date,
      dateTo: result.weather.date,
      model: "claude-sonnet-5-5",
      effort: "low",
      promptVersion: OUTFIT_PROMPT_VERSION,
      result,
      completedAt: new Date(),
    });

    // force goes past the stored suggestion to the key, which is missing here.
    const response = await call(JSON.stringify({ force: true }));
    expect(response.status).toBe(500);
    expect(mocks.getAnthropic).toHaveBeenCalledTimes(1);
  });
});
