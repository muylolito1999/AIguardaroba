import { randomUUID } from "node:crypto";

import type { PGlite, QueryOptions, Results, Transaction } from "@electric-sql/pglite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnthropicLike } from "@/lib/ai/client";
import { BOLOGNA } from "@/lib/climate/bologna";
import { HAMBURG } from "@/lib/climate/hamburg";
import type { Db } from "@/lib/db/client";
import { relations } from "@/lib/db/relations";
import {
  aiCalls,
  analyses,
  appSettings,
  climateProfiles,
  items,
  outfitItems,
  outfits,
  wearLogs,
  type ClimateProfile,
  type Item,
} from "@/lib/db/schema";
import {
  buildSuggestionSnapshot,
  isEligibleForToday,
  OUTFIT_PROMPT_VERSION,
  type OutfitSuggestionResult,
  type OutfitSuggestionWire,
  type SuggestionSnapshot,
} from "@/lib/outfits/suggestion";
import { AppError } from "@/lib/result";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";
import type { TodayWeather } from "@/server/weather";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage } from "../../../test/factories";
import { createFakeAnthropic, fakeMessage, type FakeAnthropic } from "../../../test/fakes/anthropic";
import {
  fakeOutfitSuggestionReply,
  makeOutfitItem,
  makeOutfitSuggestionResult,
  makeOutfitWardrobe,
  OUTFIT_TEMPLATES,
  type OutfitFixtureItem,
  type OutfitTemplateKey,
} from "../../../test/outfit-fixtures";

// PGlite plus the scripted Claude (no network): which items reach the prompt,
// when a suggestion is reused, forced, blocked or retried, what is stored and
// what Save makes of it. The forecast comes from a mock of src/server/weather,
// whose cached fetch has its own tests.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  loadTodayWeather: vi.fn(),
  /** Holds the holdOn-th budget check (from 1) until `hold` settles, to interleave two requests. */
  budgetGate: { calls: 0, holdOn: 0, hold: null as Promise<void> | null, reached: false },
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/server/weather", () => ({ loadTodayWeather: mocks.loadTodayWeather }));
vi.mock("@/lib/ai/budget", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/budget")>();
  return {
    ...original,
    assertWithinBudget: async (...args: Parameters<typeof original.assertWithinBudget>) => {
      const gate = mocks.budgetGate;
      gate.calls += 1;
      if (gate.hold !== null && gate.calls === gate.holdOn) {
        gate.reached = true;
        await gate.hold;
      }
      return await original.assertWithinBudget(...args);
    },
  };
});

const { getTodaySuggestion, quoteOutfitSuggestion, saveSuggestedOutfit, suggestOutfits } = await import(
  "./outfit-suggestions"
);
const { logWear, undoWear } = await import("./wear");
const { getOutfit } = await import("./outfits");
const { makeWeatherSnapshot } = await import("../../../test/outfit-fixtures");

// 14:20 in Hamburg on Tuesday 3 November 2026, the fixture forecast's day.
const NOW = new Date("2026-11-03T13:20:00.000Z");
const DEADLINE = NOW.getTime() + 110_000;

let testDb: TestDb;
let hamburg: ClimateProfile;
let bologna: ClimateProfile;
let weather: WeatherSnapshot;

function today(profile: ClimateProfile = hamburg, snapshot: WeatherSnapshot = weather): TodayWeather {
  return {
    profile: {
      id: profile.id,
      slug: profile.slug,
      city: profile.city,
      country: profile.country,
      lat: profile.lat,
      lon: profile.lon,
      timezone: profile.timezone,
    },
    today: snapshot.date,
    weather: snapshot,
  };
}

/** Inserts fixture items with their ids and fields; returns the rows. */
async function insertItems(fixtures: readonly OutfitFixtureItem[]): Promise<Item[]> {
  const rows = await testDb.db
    .insert(items)
    .values(
      fixtures.map((item) => ({
        id: item.id,
        createdAt: item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt),
        imageHash: (randomUUID() + randomUUID()).replaceAll("-", "").slice(0, 64),
        status: item.status,
        location: item.location,
        decision: item.decision,
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
        condition: item.condition ?? "good",
        wearCount: item.wearCount,
        lastWornAt: item.lastWornAt === null ? null : new Date(item.lastWornAt),
      })),
    )
    .returning();
  return rows;
}

/** The complete Hamburg wardrobe, at home and confirmed. */
async function insertWardrobe(
  overrides: Partial<Record<OutfitTemplateKey, Partial<OutfitFixtureItem>>> = {},
): Promise<Record<OutfitTemplateKey, OutfitFixtureItem>> {
  const wardrobe = makeOutfitWardrobe(overrides);
  await insertItems(Object.values(wardrobe));
  return wardrobe;
}

/** The snapshot the service builds: the eligible rows as they are in the database now. */
async function serviceSnapshot(home: "hamburg" | "bologna" = "hamburg"): Promise<SuggestionSnapshot> {
  const rows = await testDb.db.select().from(items);
  return buildSuggestionSnapshot(
    rows.filter((row) => isEligibleForToday(row, home)),
    weather,
  );
}

async function validReply(): Promise<OutfitSuggestionWire> {
  return fakeOutfitSuggestionReply(await serviceSnapshot());
}

function deps(fake: FakeAnthropic, extra: { anthropic?: () => AnthropicLike } = {}) {
  return {
    anthropic: extra.anthropic ?? (() => fake),
    deadlineAt: DEADLINE,
    now: () => NOW.getTime(),
    random: () => 0,
    sleep: async () => undefined,
  };
}

/** Sends one statement of a hooked transaction as it was. */
type RunStatement = () => Promise<Results<unknown>>;
type StatementHook = (
  statement: { text: string; params: readonly unknown[] },
  tx: Transaction,
  run: RunStatement,
) => Promise<Results<unknown>>;

/**
 * A database on the test PGlite whose transactions hand every statement to
 * `hook`, with the transaction's own connection: a test can then read Save's
 * SQL in order, or change rows at an exact point between two statements, as
 * another request committing at that moment would. PGlite runs one
 * transaction at a time, so it cannot interleave two requests by itself.
 */
function hookedDb(client: PGlite, hook: StatementHook): Db {
  // PGlite keeps its state in private fields, so its methods must run on the real object.
  const bound = (target: object, property: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  };
  const hookedTx = (tx: Transaction): Transaction =>
    new Proxy(tx, {
      get(target, property) {
        if (property !== "query") return bound(target, property);
        return (text: string, params?: unknown[], options?: QueryOptions) =>
          hook({ text, params: params ?? [] }, target, () => target.query(text, params, options));
      },
    });
  const hookedClient = new Proxy(client, {
    get(target, property) {
      if (property !== "transaction") return bound(target, property);
      return <T>(callback: (tx: Transaction) => Promise<T>) => target.transaction((tx) => callback(hookedTx(tx)));
    },
  });
  return drizzle({ client: hookedClient, relations });
}

function instructionOf(fake: FakeAnthropic, call = 0): string {
  const content = fake.requests[call]?.params.messages[0]?.content;
  if (!Array.isArray(content)) throw new Error("no request content");
  const block = content[0];
  if (block === undefined || block.type !== "text") throw new Error("no text block");
  return block.text;
}

async function suggestionRows() {
  return testDb.db.select().from(analyses).where(eq(analyses.kind, "outfit_suggestion"));
}

async function callRows() {
  return testDb.db.select().from(aiCalls);
}

/** Stores a complete suggestion for these items, as if Claude had answered. */
async function storeSuggestion(
  fixtures: readonly OutfitFixtureItem[],
  options: { profile?: ClimateProfile; snapshot?: WeatherSnapshot; status?: "complete" | "failed"; completedAt?: Date } = {},
): Promise<{ id: string; result: OutfitSuggestionResult }> {
  const snapshot = options.snapshot ?? weather;
  const result = makeOutfitSuggestionResult(fixtures, snapshot);
  const [row] = await testDb.db
    .insert(analyses)
    .values({
      kind: "outfit_suggestion",
      status: options.status ?? "complete",
      climateProfileId: (options.profile ?? hamburg).id,
      dateFrom: snapshot.date,
      dateTo: snapshot.date,
      params: {},
      model: "claude-sonnet-5-5",
      effort: "low",
      promptVersion: OUTFIT_PROMPT_VERSION,
      result,
      costUsd: 0.04,
      completedAt: options.completedAt ?? NOW,
    })
    .returning({ id: analyses.id });
  if (row === undefined) throw new Error("no analysis");
  return { id: row.id, result };
}

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const rows = await testDb.db.insert(climateProfiles).values([HAMBURG, BOLOGNA]).returning();
  const h = rows.find((row) => row.slug === "hamburg");
  const b = rows.find((row) => row.slug === "bologna");
  if (h === undefined || b === undefined) throw new Error("profiles missing");
  hamburg = h;
  bologna = b;
  await testDb.db.insert(appSettings).values({ id: 1, homeProfileId: hamburg.id, defaultItemLocation: "hamburg" });
  weather = makeWeatherSnapshot();
  mocks.budgetGate.calls = 0;
  mocks.budgetGate.holdOn = 0;
  mocks.budgetGate.hold = null;
  mocks.budgetGate.reached = false;
  mocks.loadTodayWeather.mockReset();
  mocks.loadTodayWeather.mockImplementation(async () => today());
});

afterAll(async () => {
  await testDb.close();
});

describe("suggestOutfits", () => {
  it("lists only the items at home or of unknown location that are tagged or confirmed and not leaving", async () => {
    const wardrobe = await insertWardrobe();
    const top = OUTFIT_TEMPLATES.oxford;
    const extras = [
      makeOutfitItem({ ...top, name: "Unknown-place cardigan", location: "unknown", seasons: [...top.seasons], colors: [...top.colors], materials: [...top.materials] }),
      makeOutfitItem({ ...top, name: "Tagged only polo", status: "tagged", seasons: [...top.seasons], colors: [...top.colors], materials: [...top.materials] }),
      makeOutfitItem({ ...top, name: "Bologna linen shirt", location: "bologna", seasons: [...top.seasons], colors: [...top.colors], materials: [...top.materials] }),
      makeOutfitItem({ ...top, name: "Shipping flannel", location: "in_transit", seasons: [...top.seasons], colors: [...top.colors], materials: [...top.materials] }),
      makeOutfitItem({ ...top, name: "Donated polo", decision: "donate", seasons: [...top.seasons], colors: [...top.colors], materials: [...top.materials] }),
      makeOutfitItem({ ...top, name: "Sold hoodie", decision: "sell", seasons: [...top.seasons], colors: [...top.colors], materials: [...top.materials] }),
      makeOutfitItem({ ...top, name: "Archived blazer", status: "archived", seasons: [...top.seasons], colors: [...top.colors], materials: [...top.materials] }),
      makeOutfitItem({ ...top, name: "Odd umbrella", category: "other", seasons: [...top.seasons], colors: [...top.colors], materials: [...top.materials] }),
    ];
    await insertItems(extras);
    await testDb.db.insert(items).values({ imageHash: "p".repeat(64), status: "pending_tagging", name: "Pending tee", category: "top" });
    const fake = createFakeAnthropic([fakeMessage({ json: await validReply(), model: "claude-sonnet-5-5" })]);

    const suggestion = await suggestOutfits(testDb.db, deps(fake));

    expect(suggestion.outfits).toHaveLength(3);
    const text = instructionOf(fake);
    for (const name of [wardrobe.shell.name, wardrobe.tee.name, "Unknown-place cardigan", "Tagged only polo"]) {
      expect(text).toContain(name);
    }
    for (const name of [
      "Bologna linen shirt",
      "Shipping flannel",
      "Donated polo",
      "Sold hoodie",
      "Archived blazer",
      "Odd umbrella",
      "Pending tee",
    ]) {
      expect(text).not.toContain(name);
    }
    expect(text).toContain('<items count="19">');
    expect(text).toContain('<weather place="Hamburg, Germany">');
    const request = fake.requests[0]?.params;
    expect(request?.model).toBe("claude-sonnet-5-5");
    expect(request?.output_config?.effort).toBe("low");
    expect(request?.max_tokens).toBe(8000);
  });

  it("stores the result with the model, effort, prompt version, estimate and the cost of the call", async () => {
    await insertWardrobe();
    const fake = createFakeAnthropic([fakeMessage({ json: await validReply(), model: "claude-sonnet-5-5" })]);

    const suggestion = await suggestOutfits(testDb.db, deps(fake));

    const [row] = await suggestionRows();
    expect(row).toMatchObject({
      id: suggestion.analysisId,
      status: "complete",
      climateProfileId: hamburg.id,
      dateFrom: "2026-11-03",
      dateTo: "2026-11-03",
      model: "claude-sonnet-5-5",
      effort: "low",
      promptVersion: OUTFIT_PROMPT_VERSION,
      error: null,
    });
    expect(row?.estimatedCostUsd).toBeGreaterThan(0);
    expect(row?.completedAt?.toISOString()).toBe(NOW.toISOString());
    const calls = await callRows();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "outfit_suggestion", status: "success", analysisId: suggestion.analysisId });
    expect(row?.costUsd).toBeCloseTo(calls[0]?.costUsd ?? -1, 6);
    expect(suggestion.costUsd).toBeCloseTo(row?.costUsd ?? -1, 6);

    // The stored result names items by id and keeps the forecast it was made for.
    const result = row?.result as OutfitSuggestionResult;
    expect(result.weather).toEqual(weather);
    expect(result.meta).toEqual({
      prompt_version: OUTFIT_PROMPT_VERSION,
      model: "claude-sonnet-5-5",
      effort: "low",
      item_count: 17,
      dropped_count: 0,
    });
    const known = new Set((await testDb.db.select({ id: items.id }).from(items)).map((item) => item.id));
    for (const outfit of result.outfits) for (const entry of outfit.items) expect(known.has(entry.itemId)).toBe(true);

    // The answer is the page's DTO: names, slots in order, nothing saved or worn yet.
    expect(suggestion.date).toBe("2026-11-03");
    expect(suggestion.profileId).toBe(hamburg.id);
    expect(suggestion.itemCount).toBe(17);
    const [first] = suggestion.outfits;
    expect(first).toMatchObject({ index: 0, available: true, savedOutfitId: null, wornToday: false });
    expect(first?.items.every((item) => item.exists && item.name.length > 0)).toBe(true);
  });

  it("answers today's stored suggestion without a call when nothing changed", async () => {
    await insertWardrobe();
    const fake = createFakeAnthropic([fakeMessage({ json: await validReply() })]);
    const first = await suggestOutfits(testDb.db, deps(fake));

    const anthropic = vi.fn(() => fake);
    const second = await suggestOutfits(testDb.db, deps(fake, { anthropic }));

    expect(second.analysisId).toBe(first.analysisId);
    expect(fake.requests).toHaveLength(1);
    expect(anthropic).not.toHaveBeenCalled();
    expect(await callRows()).toHaveLength(1);
    expect(await suggestionRows()).toHaveLength(1);
  });

  it("makes a new call with force, and the new one becomes today's", async () => {
    await insertWardrobe();
    const reply = await validReply();
    const fake = createFakeAnthropic([fakeMessage({ json: reply }), fakeMessage({ json: reply })]);
    const first = await suggestOutfits(testDb.db, deps(fake));

    const forced = await suggestOutfits(testDb.db, { ...deps(fake), now: () => NOW.getTime() + 60_000 }, { force: true });

    expect(forced.analysisId).not.toBe(first.analysisId);
    expect(fake.requests).toHaveLength(2);
    expect(await suggestionRows()).toHaveLength(2);
    expect((await getTodaySuggestion(testDb.db, { now: NOW }))?.analysisId).toBe(forced.analysisId);
  });

  it("calls again without force once the items changed", async () => {
    const wardrobe = await insertWardrobe();
    const fake = createFakeAnthropic([fakeMessage({ json: await validReply() })]);
    const first = await suggestOutfits(testDb.db, deps(fake));

    // A wear changes the item lines (worn:N, last:), so the stored suggestion no longer matches.
    await testDb.db.update(items).set({ wearCount: 1, lastWornAt: NOW }).where(eq(items.id, wardrobe.tee.id));
    fake.enqueue(fakeMessage({ json: await validReply() }));
    const second = await suggestOutfits(testDb.db, deps(fake));

    expect(second.analysisId).not.toBe(first.analysisId);
    expect(fake.requests).toHaveLength(2);
  });

  it("makes no call and writes nothing when the budget is used up", async () => {
    await insertWardrobe();
    await testDb.db.insert(aiCalls).values({ model: "claude-sonnet-5-5", purpose: "relocation_chunk", status: "success", costUsd: 25, createdAt: NOW });
    const fake = createFakeAnthropic([fakeMessage({ json: await validReply() })]);
    const anthropic = vi.fn(() => fake);

    await expect(suggestOutfits(testDb.db, deps(fake, { anthropic }))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    expect(anthropic).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
    expect(await suggestionRows()).toHaveLength(0);
    expect(await callRows()).toHaveLength(1);
  });

  it("stops with CONFIG before writing anything when there is no API key", async () => {
    await insertWardrobe();
    const anthropic = vi.fn((): FakeAnthropic => {
      throw new AppError("CONFIG", "Invalid server configuration (ai): ANTHROPIC_API_KEY is not set.");
    });

    await expect(suggestOutfits(testDb.db, deps(createFakeAnthropic(), { anthropic }))).rejects.toMatchObject({
      code: "CONFIG",
    });

    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(await suggestionRows()).toHaveLength(0);
    expect(await callRows()).toHaveLength(0);
  });

  it("refuses before any paid call when the items cannot make three different outfits", async () => {
    const one = makeOutfitWardrobe();
    await insertItems([one.tee, one.jeans, one.boots]);
    const anthropic = vi.fn(() => createFakeAnthropic());

    await expect(suggestOutfits(testDb.db, deps(createFakeAnthropic(), { anthropic }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(anthropic).not.toHaveBeenCalled();
    expect(await suggestionRows()).toHaveLength(0);
  });

  it("never suggests without weather: the forecast's error is passed on and nothing is called", async () => {
    await insertWardrobe();
    mocks.loadTodayWeather.mockRejectedValue(new AppError("UPSTREAM", "Weather is unavailable right now."));
    const anthropic = vi.fn(() => createFakeAnthropic());

    await expect(suggestOutfits(testDb.db, deps(createFakeAnthropic(), { anthropic }))).rejects.toMatchObject({
      code: "UPSTREAM",
      message: "Weather is unavailable right now.",
    });
    expect(anthropic).not.toHaveBeenCalled();
  });

  it("answers the suggestion another request stored meanwhile instead of paying for it again", async () => {
    await insertWardrobe();
    const reply = await validReply();
    const fake = createFakeAnthropic([fakeMessage({ json: reply }), fakeMessage({ json: reply })]);
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAtClaude = false;
    // The first request waits inside its Claude call.
    const client: AnthropicLike = {
      messages: {
        create: async (params, options) => {
          if (!firstAtClaude) {
            firstAtClaude = true;
            await firstHeld;
          }
          return await fake.messages.create(params, options);
        },
        stream: fake.messages.stream.bind(fake.messages),
        batches: fake.messages.batches,
      },
    };
    const until = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      if (!condition()) throw new Error("the condition never held");
    };

    const first = suggestOutfits(testDb.db, deps(fake, { anthropic: () => client }));
    await until(() => firstAtClaude);
    // The second finds nothing stored yet and is held in its budget check, the step before the run lock.
    let releaseSecond: () => void = () => undefined;
    mocks.budgetGate.hold = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    mocks.budgetGate.holdOn = 2;
    const second = suggestOutfits(testDb.db, deps(fake, { anthropic: () => client }));
    await until(() => mocks.budgetGate.reached);
    releaseFirst();
    const stored = await first;
    releaseSecond();
    const answered = await second;

    expect(answered.analysisId).toBe(stored.analysisId);
    expect(fake.requests).toHaveLength(1);
    expect(await suggestionRows()).toHaveLength(1);
    expect(await callRows()).toHaveLength(1);
  });

  it("refuses with CONFLICT while another suggestion runs, but not after a cut-off one's lease", async () => {
    await insertWardrobe();
    const running = {
      kind: "outfit_suggestion" as const,
      status: "running" as const,
      climateProfileId: hamburg.id,
      model: "claude-sonnet-5-5",
      promptVersion: OUTFIT_PROMPT_VERSION,
    };
    // created_at is compared with the database's clock.
    await testDb.db.insert(analyses).values({ ...running, createdAt: new Date() });
    const fake = createFakeAnthropic([fakeMessage({ json: await validReply() })]);

    await expect(suggestOutfits(testDb.db, deps(fake))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.requests).toHaveLength(0);

    await testDb.db.update(analyses).set({ createdAt: new Date(Date.now() - 10 * 60_000) });
    const suggestion = await suggestOutfits(testDb.db, deps(fake));
    expect(suggestion.outfits).toHaveLength(3);
  });

  it("retries a reply that names an unknown alias, and stores the cost of both attempts", async () => {
    await insertWardrobe();
    const good = await validReply();
    const bad = structuredClone(good);
    const entry = bad.outfits[0]?.items[0];
    if (entry === undefined) throw new Error("no entry");
    entry.item = "i999";
    const fake = createFakeAnthropic([fakeMessage({ json: bad }), fakeMessage({ json: good })]);

    const suggestion = await suggestOutfits(testDb.db, deps(fake));

    expect(fake.requests).toHaveLength(2);
    const calls = await callRows();
    expect(calls.map((call) => call.status).sort()).toEqual(["invalid_output", "success"]);
    const [row] = await suggestionRows();
    const total = calls.reduce((sum, call) => sum + call.costUsd, 0);
    expect(row?.costUsd).toBeCloseTo(total, 6);
    expect(suggestion.costUsd).toBeCloseTo(total, 6);
  });

  it("retries a reply whose outfit breaks the slot rules", async () => {
    await insertWardrobe();
    const snapshot = await serviceSnapshot();
    const good = fakeOutfitSuggestionReply(snapshot);
    const bad = structuredClone(good);
    const first = bad.outfits[0];
    if (first === undefined) throw new Error("no outfit");
    // No bottom with a top.
    first.items = first.items.filter((entry) => entry.slot !== "bottom");
    const fake = createFakeAnthropic([fakeMessage({ json: bad }), fakeMessage({ json: good })]);

    await suggestOutfits(testDb.db, deps(fake));

    expect(fake.requests).toHaveLength(2);
    const [invalid] = (await callRows()).filter((call) => call.status === "invalid_output");
    expect(invalid?.errorMessage).toContain("missing_bottom");
  });

  it("marks the suggestion failed with every paid attempt's cost when no reply passes", async () => {
    await insertWardrobe();
    const bad = await validReply();
    bad.outfits = bad.outfits.slice(0, 2);
    const fake = createFakeAnthropic([fakeMessage({ json: bad }), fakeMessage({ json: bad }), fakeMessage({ json: bad })]);

    await expect(suggestOutfits(testDb.db, deps(fake))).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });

    const [row] = await suggestionRows();
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("Claude's reply did not match the expected format.");
    const calls = await callRows();
    expect(calls).toHaveLength(3);
    expect(row?.costUsd).toBeCloseTo(
      calls.reduce((sum, call) => sum + call.costUsd, 0),
      6,
    );
    expect(await getTodaySuggestion(testDb.db, { now: NOW })).toBeNull();
  });
});

describe("quoteOutfitSuggestion", () => {
  it("prices a call for today's items without an API key and says whether three outfits are possible", async () => {
    await insertWardrobe();
    const quote = await quoteOutfitSuggestion(testDb.db, today());
    expect(quote).toMatchObject({ model: "claude-sonnet-5-5", itemCount: 17, droppedCount: 0, canSuggest: true });
    expect(quote.estimateUsd).toBeGreaterThan(0);
    expect(quote.estimateUsd).toBeLessThan(0.2);
  });

  it("follows the home city's items", async () => {
    await insertWardrobe();
    const quote = await quoteOutfitSuggestion(testDb.db, today(bologna, makeWeatherSnapshot({ timezone: "Europe/Rome" })));
    expect(quote).toMatchObject({ itemCount: 0, canSuggest: false });
  });
});

describe("getTodaySuggestion", () => {
  it("is null without a suggestion for today, or without a home city", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    expect(await getTodaySuggestion(testDb.db, { now: NOW })).toBeNull();

    await storeSuggestion(Object.values(wardrobe), { snapshot: makeWeatherSnapshot({ date: "2026-11-02" }) });
    await storeSuggestion(Object.values(wardrobe), { profile: bologna });
    await storeSuggestion(Object.values(wardrobe), { status: "failed" });
    expect(await getTodaySuggestion(testDb.db, { now: NOW })).toBeNull();

    await storeSuggestion(Object.values(wardrobe));
    await testDb.db.update(appSettings).set({ homeProfileId: null });
    expect(await getTodaySuggestion(testDb.db, { now: NOW })).toBeNull();
  });

  it("answers the newest complete one with the items as they are now", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    await storeSuggestion(Object.values(wardrobe), { completedAt: new Date(NOW.getTime() - 60_000) });
    const newest = await storeSuggestion(Object.values(wardrobe));
    const firstItems = newest.result.outfits[0]?.items ?? [];
    const firstItem = firstItems[0];
    if (firstItem === undefined) throw new Error("no item");
    await makeImage(testDb.db, firstItem.itemId, { kind: "thumb", blobUrl: "https://example.invalid/thumb.webp" });

    const suggestion = await getTodaySuggestion(testDb.db, { now: NOW });

    expect(suggestion?.analysisId).toBe(newest.id);
    expect(suggestion?.profileId).toBe(hamburg.id);
    expect(suggestion?.outfits).toHaveLength(3);
    const first = suggestion?.outfits[0];
    expect(first?.items.find((item) => item.itemId === firstItem.itemId)?.thumbUrl).toBe(
      "https://example.invalid/thumb.webp",
    );
    expect(first).toMatchObject({ available: true, wornToday: false, savedOutfitId: null });
  });

  it("marks outfits with an archived or deleted item unavailable, and outfits worn today", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    const { result } = await storeSuggestion(Object.values(wardrobe));
    const sets = result.outfits.map((outfit) => outfit.items.map((entry) => entry.itemId));
    /** An item only outfit `index` uses, so changing it touches that outfit alone. */
    const onlyIn = (index: number): string => {
      const others = new Set(sets.filter((_, other) => other !== index).flat());
      const id = sets[index]?.find((itemId) => !others.has(itemId));
      if (id === undefined) throw new Error(`outfit ${index} has no item of its own`);
      return id;
    };
    const archived = onlyIn(1);
    const deleted = onlyIn(2);
    await testDb.db.update(items).set({ status: "archived" }).where(eq(items.id, archived));
    await testDb.db.delete(items).where(eq(items.id, deleted));
    await testDb.db
      .insert(wearLogs)
      .values((sets[0] ?? []).map((itemId) => ({ itemId, wornOn: "2026-11-03", createdAt: NOW })));

    const suggestion = await getTodaySuggestion(testDb.db, { now: NOW });

    expect(suggestion?.outfits.map((outfit) => outfit.available)).toEqual([true, false, false]);
    expect(suggestion?.outfits[1]?.items.find((item) => item.itemId === archived)).toMatchObject({
      exists: true,
      status: "archived",
    });
    expect(suggestion?.outfits[2]?.items.find((item) => item.itemId === deleted)).toMatchObject({
      exists: false,
      status: null,
      category: null,
      name: "No longer in your wardrobe",
    });
    expect(suggestion?.outfits.map((outfit) => outfit.wornToday)).toEqual([true, false, false]);
  });
});

describe("saveSuggestedOutfit", () => {
  it("saves an outfit of source ai with the title, the why, rain_ok and the feels-like range, once", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    const { id, result } = await storeSuggestion(Object.values(wardrobe));
    const suggested = result.outfits[0];
    if (suggested === undefined) throw new Error("no outfit");

    const saved = await saveSuggestedOutfit(testDb.db, { analysisId: id, index: 0 });

    expect(saved).toMatchObject({ analysisId: id, index: 0, alreadySaved: false });
    const [outfit] = await testDb.db.select().from(outfits).where(eq(outfits.id, saved.outfitId));
    expect(outfit).toMatchObject({
      name: suggested.title,
      source: "ai",
      aiReasoning: suggested.why,
      rainOk: suggested.rain_ok,
      weatherMinC: 2.1,
      weatherMaxC: 7.6,
      occasion: null,
      rating: null,
    });
    const rows = await testDb.db.select().from(outfitItems).where(eq(outfitItems.outfitId, saved.outfitId));
    expect(rows.map((row) => `${row.slot}:${row.itemId}`).sort()).toEqual(
      suggested.items.map((entry) => `${entry.slot}:${entry.itemId}`).sort(),
    );

    // Saving it again answers the same outfit.
    const again = await saveSuggestedOutfit(testDb.db, { analysisId: id, index: 0 });
    expect(again).toEqual({ analysisId: id, index: 0, outfitId: saved.outfitId, alreadySaved: true });
    expect(await testDb.db.select({ id: outfits.id }).from(outfits)).toHaveLength(1);
    expect((await getTodaySuggestion(testDb.db, { now: NOW }))?.outfits[0]?.savedOutfitId).toBe(saved.outfitId);

    // Once that outfit is deleted, Save makes a new one.
    await testDb.db.delete(outfits).where(eq(outfits.id, saved.outfitId));
    expect((await getTodaySuggestion(testDb.db, { now: NOW }))?.outfits[0]?.savedOutfitId).toBeNull();
    const third = await saveSuggestedOutfit(testDb.db, { analysisId: id, index: 0 });
    expect(third.alreadySaved).toBe(false);
    expect(third.outfitId).not.toBe(saved.outfitId);
  });

  it("moves the card's wear of that day to the saved outfit, so wearing the outfit again counts nothing twice", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    const { id, result } = await storeSuggestion(Object.values(wardrobe));
    const itemIds = result.outfits[0]?.items.map((entry) => entry.itemId) ?? [];
    const wearCounts = async () =>
      (await testDb.db.select({ wearCount: items.wearCount }).from(items).where(inArray(items.id, itemIds))).map(
        (row) => row.wearCount,
      );

    // "Wore this today" on the card, then Save.
    const card = await logWear(testDb.db, { kind: "items", itemIds, weather }, { now: NOW });
    expect(card.logIds).toHaveLength(itemIds.length);
    const saved = await saveSuggestedOutfit(testDb.db, { analysisId: id, index: 0 });
    expect(await getOutfit(testDb.db, saved.outfitId)).toMatchObject({ timesWorn: 1, lastWornOn: "2026-11-03" });

    // "Wore this today" on the saved outfit's page: already logged, nothing counted again.
    const again = await logWear(testDb.db, { kind: "outfit", outfitId: saved.outfitId }, { now: new Date(NOW.getTime() + 60_000) });
    expect(again.logIds).toEqual([]);
    expect([...again.alreadyLogged].sort()).toEqual([...itemIds].sort());
    expect(await wearCounts()).toEqual(itemIds.map(() => 1));
    expect(await testDb.db.select().from(wearLogs)).toHaveLength(itemIds.length);

    // The card's Undo still takes the wear back, from the outfit too.
    await undoWear(testDb.db, { logIds: card.logIds }, { now: new Date(NOW.getTime() + 120_000) });
    expect(await wearCounts()).toEqual(itemIds.map(() => 0));
    expect(await getOutfit(testDb.db, saved.outfitId)).toMatchObject({ timesWorn: 0, lastWornOn: null });
  });

  it("attaches nothing when only some of the outfit's items were logged that day", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    const { id, result } = await storeSuggestion(Object.values(wardrobe));
    const first = result.outfits[0]?.items[0]?.itemId;
    if (first === undefined) throw new Error("no item");
    // "+1 worn today" on one item's page is a wear of its own.
    await logWear(testDb.db, { kind: "items", itemIds: [first] }, { now: NOW });

    const saved = await saveSuggestedOutfit(testDb.db, { analysisId: id, index: 0 });

    expect(await getOutfit(testDb.db, saved.outfitId)).toMatchObject({ timesWorn: 0 });
    const [log] = await testDb.db.select().from(wearLogs);
    expect(log?.outfitId).toBeNull();
  });

  it("locks the outfit's items for update, in id order, before saveOutfit's share locks and the log read (D-236)", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    const { id, result } = await storeSuggestion(Object.values(wardrobe));
    const itemIds = result.outfits[0]?.items.map((entry) => entry.itemId) ?? [];
    await logWear(testDb.db, { kind: "items", itemIds, weather }, { now: NOW });
    const statements: { text: string; params: readonly unknown[] }[] = [];
    const traced = hookedDb(testDb.client, async (statement, _tx, run) => {
      statements.push(statement);
      return await run();
    });

    const saved = await saveSuggestedOutfit(traced, { analysisId: id, index: 0 });

    const first = (pattern: RegExp) => statements.findIndex((statement) => pattern.test(statement.text));
    const itemLock = first(/^select .* from "items" .*order by "items"\."id" asc for update$/);
    expect(itemLock).toBeGreaterThanOrEqual(0);
    expect([...(statements[itemLock]?.params ?? [])].sort()).toEqual([...itemIds].sort());
    expect(itemLock).toBeLessThan(first(/ from "items" .* for share$/));
    expect(itemLock).toBeLessThan(first(/^insert into "outfits"/));
    expect(itemLock).toBeLessThan(first(/^select .* from "wear_logs" /));
    expect(itemLock).toBeLessThan(first(/^update "wear_logs"/));
    expect(await getOutfit(testDb.db, saved.outfitId)).toMatchObject({ timesWorn: 1 });
  });

  it("moves no log and refuses with CONFLICT when one changed between the read and the move (D-236)", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    const { id, result } = await storeSuggestion(Object.values(wardrobe));
    const itemIds = result.outfits[0]?.items.map((entry) => entry.itemId) ?? [];
    const card = await logWear(testDb.db, { kind: "items", itemIds, weather }, { now: NOW });
    const [taken] = card.logIds;
    if (taken === undefined) throw new Error("no log");
    const [other] = await testDb.db.insert(outfits).values({ name: "Saved from another suggestion" }).returning();
    if (other === undefined) throw new Error("no outfit");

    // What a writer that skipped the item locks could do between Save's read
    // of the day's logs and its UPDATE: take one log for another outfit, or
    // remove it.
    const meanwhile: Record<string, (tx: Transaction) => Promise<unknown>> = {
      "taken by another outfit": (tx) => tx.query("update wear_logs set outfit_id = $1 where id = $2", [other.id, taken]),
      undone: (tx) => tx.query("delete from wear_logs where id = $1", [taken]),
    };
    for (const [label, change] of Object.entries(meanwhile)) {
      const seen: { moved: Results<unknown> | null } = { moved: null };
      const interleaved = hookedDb(testDb.client, async (statement, tx, run) => {
        if (seen.moved !== null || !statement.text.startsWith('update "wear_logs"')) return await run();
        await change(tx);
        seen.moved = await run();
        return seen.moved;
      });

      await expect(saveSuggestedOutfit(interleaved, { analysisId: id, index: 0 }), label).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "wear_changed" },
      });

      // The UPDATE left that log alone; the error rolled the rest and the outfit back.
      expect(seen.moved, label).not.toBeNull();
      expect(JSON.stringify(seen.moved?.rows), label).not.toContain(taken);
      expect(seen.moved?.affectedRows, label).toBe(itemIds.length - 1);
      expect((await testDb.db.select({ id: outfits.id }).from(outfits)).map((row) => row.id), label).toEqual([other.id]);
      const logs = await testDb.db.select().from(wearLogs);
      expect(logs.map((log) => log.outfitId), label).toEqual(itemIds.map(() => null));
    }

    // Unchanged, the same Save moves the whole wear.
    const saved = await saveSuggestedOutfit(testDb.db, { analysisId: id, index: 0 });
    expect(await getOutfit(testDb.db, saved.outfitId)).toMatchObject({ timesWorn: 1 });
  });

  it("refuses with CONFLICT when an item was archived or deleted since, and saves nothing", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    const { id, result } = await storeSuggestion(Object.values(wardrobe));
    const top = result.outfits[0]?.items.find((entry) => entry.slot === "top")?.itemId;
    const shoes = result.outfits[1]?.items.find((entry) => entry.slot === "shoes")?.itemId;
    if (top === undefined || shoes === undefined) throw new Error("items");
    await testDb.db.update(items).set({ status: "archived" }).where(eq(items.id, top));

    await expect(saveSuggestedOutfit(testDb.db, { analysisId: id, index: 0 })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { outfitIssues: [expect.objectContaining({ code: "archived_item", itemId: top })] },
    });

    await testDb.db.delete(items).where(eq(items.id, shoes));
    await expect(saveSuggestedOutfit(testDb.db, { analysisId: id, index: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await testDb.db.select({ id: outfits.id }).from(outfits)).toHaveLength(0);
  });

  it("answers NOT_FOUND for an unknown suggestion, another kind, an unfinished one or an index out of range", async () => {
    const wardrobe = makeOutfitWardrobe();
    await insertItems(Object.values(wardrobe));
    const { id } = await storeSuggestion(Object.values(wardrobe));
    const [relocation] = await testDb.db
      .insert(analyses)
      .values({ kind: "relocation", status: "complete", model: "claude-sonnet-5-5", promptVersion: "reloc-v4" })
      .returning({ id: analyses.id });
    const failed = await storeSuggestion(Object.values(wardrobe), { status: "failed" });

    for (const input of [
      { analysisId: randomUUID(), index: 0 },
      { analysisId: "not-a-uuid", index: 0 },
      { analysisId: relocation?.id ?? "", index: 0 },
      { analysisId: failed.id, index: 0 },
      { analysisId: id, index: 3 },
      { analysisId: id, index: -1 },
    ]) {
      await expect(saveSuggestedOutfit(testDb.db, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("checks the session first", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));
    await expect(saveSuggestedOutfit(testDb.db, { analysisId: randomUUID(), index: 0 })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(getTodaySuggestion(testDb.db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(suggestOutfits(testDb.db, deps(createFakeAnthropic()))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(mocks.loadTodayWeather).not.toHaveBeenCalled();
  });
});

describe("stored params", () => {
  it("keeps force and the saved outfits on the row", async () => {
    await insertWardrobe();
    const fake = createFakeAnthropic([fakeMessage({ json: await validReply() })]);
    const suggestion = await suggestOutfits(testDb.db, deps(fake), { force: true });
    const saved = await saveSuggestedOutfit(testDb.db, { analysisId: suggestion.analysisId, index: 2 });
    const [row] = await testDb.db
      .select({ params: analyses.params })
      .from(analyses)
      .where(and(eq(analyses.id, suggestion.analysisId), sql`true`));
    expect(row?.params).toEqual({ force: true, savedOutfitIds: [null, null, saved.outfitId] });
  });
});
