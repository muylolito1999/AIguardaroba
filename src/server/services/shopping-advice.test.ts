import { randomUUID } from "node:crypto";

import { asc, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnthropicLike } from "@/lib/ai/client";
import { toJsonSchemaFormat } from "@/lib/ai/json-schema";
import { HAMBURG } from "@/lib/climate/hamburg";
import type { Db } from "@/lib/db/client";
import {
  aiCalls,
  analyses,
  climateProfiles,
  shoppingListItems,
  type Item,
  type NewItem,
  type NewShoppingListItem,
} from "@/lib/db/schema";
import { makeGapKey, type RelocationGap } from "@/lib/relocation/schemas";
import { AppError } from "@/lib/result";
import {
  estimateShoppingAdviceUsd,
  SHOPPING_PROMPT_VERSION,
  SHOPPING_SYSTEM_PROMPT,
  ShoppingAdviceResultSchema,
  ShoppingAdviceWireSchema,
} from "@/lib/shopping/advice";
import {
  candidateFromShoppingRow,
  countOutfits,
  unlockCount,
  type ComboItem,
} from "@/lib/shopping/combinatorics";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeItem, TAGGED_ITEM_FIELDS } from "../../../test/factories";
import { createFakeAnthropic, fakeMessage, type FakeAnthropic } from "../../../test/fakes/anthropic";
import { fakeShoppingAdviceReply, HAMBURG_SCENARIOS } from "../../../test/outfit-fixtures";
import { makeRelocationResult } from "../../../test/relocation-fixtures";
import { addGapsToShoppingList } from "./relocation";
import {
  adviceBudget,
  getShoppingAdviceFlag,
  getShoppingAdviceState,
  runShoppingAdvice,
  SHOPPING_ADVICE_OFF_MESSAGE,
  type ShoppingAdviceDeps,
} from "./shopping-advice";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  flagsEnv: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/env")>()),
  flagsEnv: mocks.flagsEnv,
}));

// PGlite plus the scripted Anthropic fake (D-046): no network. The env is
// blank, so the advice uses Sonnet 5.5 and the monthly budget is the default
// $20. Each fake reply costs $0.01 (2,000 input and 600 output tokens at
// Sonnet rates).

const CALL_USD = 0.01;
const DEADLINE_MS = 110_000;

let testDb: TestDb;
let fake: FakeAnthropic;
let anthropic: ReturnType<typeof vi.fn<() => AnthropicLike>>;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  mocks.flagsEnv.mockReset();
  mocks.flagsEnv.mockReturnValue({ FEATURE_SHOPPING_AI: true });
  fake = createFakeAnthropic();
  anthropic = vi.fn(() => fake);
});

afterAll(async () => {
  await testDb.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deps(overrides: Partial<ShoppingAdviceDeps> = {}): ShoppingAdviceDeps {
  return {
    anthropic,
    deadlineAt: Date.now() + DEADLINE_MS,
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  };
}

function sonnet(json: unknown) {
  return fakeMessage({ json, model: "claude-sonnet-5-5" });
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

/** A database that fails the test on any use: proves a path reads nothing. */
function untouchableDb(): Db {
  return new Proxy({} as Db, {
    get(_target, property) {
      throw new Error(`the database was used (${String(property)})`);
    },
  });
}

function gap(index: number, fields: Omit<RelocationGap, "gap_key">): RelocationGap {
  return { gap_key: makeGapKey(index, fields), ...fields };
}

const SHELL_GAP = gap(0, {
  item_type: "Waterproof rain shell",
  category: "outerwear",
  why_needed: "17 rain days a month in winter.",
  specs: ["waterproof ≥10,000 mm", "hood"],
  priority: 1,
  quantity: 1,
  est_price_range_eur: { min: 120, max: 200 },
  buy_before_or_after_move: "before_move",
});
const BOOTS_GAP = gap(1, {
  item_type: "Waterproof leather boots",
  category: "shoes",
  why_needed: "Wet pavements most of the year.",
  specs: ["waterproof", "grippy sole"],
  priority: 1,
  quantity: 1,
  est_price_range_eur: { min: 100, max: 160 },
  buy_before_or_after_move: "either",
});
const MERINO_GAP = gap(2, {
  item_type: "Merino base layer top",
  category: "base_layer",
  why_needed: "Warmth under a shell without bulk.",
  specs: ["merino 200 g/m²"],
  priority: 2,
  quantity: 2,
  est_price_range_eur: { min: 40, max: 70 },
  buy_before_or_after_move: "after_move",
});

async function insertRelocation(
  options: { budget?: number | null; gaps?: RelocationGap[]; completedAt?: Date } = {},
): Promise<string> {
  const [row] = await testDb.db
    .insert(analyses)
    .values({
      kind: "relocation",
      status: "complete",
      model: "claude-sonnet-5-5",
      promptVersion: "reloc-v4",
      params: { purchaseBudgetEur: options.budget === undefined ? 600 : options.budget },
      result: makeRelocationResult([randomUUID()], { gaps: options.gaps ?? [SHELL_GAP, BOOTS_GAP, MERINO_GAP] }),
      completedAt: options.completedAt ?? new Date("2026-11-01T10:00:00Z"),
    })
    .returning({ id: analyses.id });
  if (row === undefined) throw new Error("no relocation row");
  return row.id;
}

async function insertRow(overrides: Partial<NewShoppingListItem>) {
  const [row] = await testDb.db
    .insert(shoppingListItems)
    .values({ itemType: "Something", ...overrides })
    .returning();
  if (row === undefined) throw new Error("no shopping row");
  return row;
}

async function insertWardrobeItem(overrides: Partial<NewItem>): Promise<Item> {
  return await makeItem(testDb.db, { ...TAGGED_ITEM_FIELDS, status: "confirmed", ...overrides });
}

type Fixture = {
  relocationId: string;
  shellRow: { id: string };
  scarfRow: { id: string };
  /** The items the counts must use, as ComboItems. */
  counted: ComboItem[];
};

/**
 * A wardrobe with items the counts use and items they must leave out, a
 * relocation run with three gaps (the shell on the list, the merino bought,
 * the boots not on the list), hand-added rows in every status, and Hamburg.
 * Purchase budget €600; bought: merino 2 × €40 + beanie €25 (max only) = €105,
 * gloves unpriced, so €495 is left.
 */
async function seed(): Promise<Fixture> {
  await testDb.db.insert(climateProfiles).values(HAMBURG);
  const relocationId = await insertRelocation();

  const kept = await Promise.all([
    insertWardrobeItem({ name: "Grey tee", category: "top", subcategory: "t-shirt", warmthLevel: 1, formality: "casual" }),
    insertWardrobeItem({ name: "Wool jumper", category: "top", subcategory: "jumper", warmthLevel: 3, formality: "casual" }),
    insertWardrobeItem({ name: "Jeans", category: "bottom", subcategory: "jeans", warmthLevel: 2, formality: "casual" }),
    insertWardrobeItem({ name: "Sneakers", category: "shoes", subcategory: "sneakers", warmthLevel: 1, formality: "casual" }),
    insertWardrobeItem({ name: "Wool coat", category: "outerwear", warmthLevel: 4, formality: "smart_casual" }),
    // Left behind on paper but already in Hamburg: counted.
    insertWardrobeItem({
      name: "Rubber boots",
      category: "shoes",
      subcategory: "boots",
      warmthLevel: 2,
      formality: "casual",
      waterproof: true,
      decision: "leave",
      location: "hamburg",
    }),
    insertWardrobeItem({ name: "Tagged chinos", status: "tagged", category: "bottom", warmthLevel: 2, formality: "smart_casual" }),
  ]);
  // Never counted: given away, left in Bologna, archived, untagged.
  await insertWardrobeItem({ name: "Old hoodie", category: "top", warmthLevel: 3, formality: "casual", decision: "donate" });
  await insertWardrobeItem({ name: "Linen trousers", category: "bottom", warmthLevel: 1, decision: "leave", location: "bologna" });
  await insertWardrobeItem({ name: "Archived shirt", category: "top", status: "archived" });
  await makeItem(testDb.db, { name: "Waiting photo" });

  const shellRow = await insertRow({
    analysisId: relocationId,
    gapKey: SHELL_GAP.gap_key,
    itemType: SHELL_GAP.item_type,
    category: "outerwear",
    priority: 1,
    specs: SHELL_GAP.specs,
    estPriceMinEur: 120,
    estPriceMaxEur: 200,
  });
  await insertRow({
    analysisId: relocationId,
    gapKey: MERINO_GAP.gap_key,
    itemType: MERINO_GAP.item_type,
    category: "base_layer",
    priority: 2,
    quantity: 2,
    status: "bought",
    estPriceMinEur: 40,
    estPriceMaxEur: 70,
  });
  const scarfRow = await insertRow({ itemType: "Wool scarf", category: "scarf", priority: 2 });
  await insertRow({ itemType: "Beanie", category: "hat_beanie", priority: 3, status: "bought", estPriceMaxEur: 25 });
  await insertRow({ itemType: "Gloves", category: "gloves", priority: 3, status: "bought" });
  await insertRow({ itemType: "Linen shirt", category: "top", priority: 3, status: "skipped", estPriceMinEur: 30 });

  const counted = kept.map((item) => {
    if (item.category === null) throw new Error("a kept item lost its category");
    return {
      id: item.id,
      category: item.category,
      warmthLevel: item.warmthLevel,
      formality: item.formality,
      waterproof: item.waterproof,
    };
  });
  return { relocationId, shellRow, scarfRow, counted };
}

async function adviceRows() {
  return await testDb.db.select().from(analyses).where(eq(analyses.kind, "shopping")).orderBy(asc(analyses.createdAt));
}

async function callRows(analysisId: string) {
  return await testDb.db.select().from(aiCalls).where(eq(aiCalls.analysisId, analysisId)).orderBy(asc(aiCalls.createdAt));
}

async function readyState() {
  const state = await getShoppingAdviceState(testDb.db);
  if (!state.enabled) throw new Error("expected the flag on");
  return state;
}

/** The instruction the fake received in its n-th request. */
function sentInstruction(index = 0): string {
  const content = fake.requests[index]?.params.messages[0]?.content;
  if (!Array.isArray(content)) throw new Error("no content blocks");
  const [block] = content;
  if (block?.type !== "text") throw new Error("no text block");
  return block.text;
}

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------

describe("with FEATURE_SHOPPING_AI off", () => {
  beforeEach(() => {
    mocks.flagsEnv.mockReturnValue({ FEATURE_SHOPPING_AI: false });
  });

  it("answers the state as disabled without touching the database", async () => {
    expect(await getShoppingAdviceState(untouchableDb())).toEqual({ enabled: false });
    expect(mocks.requireSession).toHaveBeenCalledTimes(1);
  });

  it("refuses a run with NOT_FOUND before any database read or Claude call", async () => {
    const error = await appError(runShoppingAdvice(untouchableDb(), deps(), { force: true }));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe(SHOPPING_ADVICE_OFF_MESSAGE);
    expect(anthropic).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });

  it("reports the flag as off", async () => {
    expect(await getShoppingAdviceFlag()).toEqual({ enabled: false });
  });
});

describe("the session check", () => {
  it("runs first, before the flag or the database", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));
    for (const call of [
      getShoppingAdviceState(untouchableDb()),
      runShoppingAdvice(untouchableDb(), deps()),
      getShoppingAdviceFlag(),
    ]) {
      expect((await appError(call)).code).toBe("UNAUTHENTICATED");
    }
    expect(mocks.flagsEnv).not.toHaveBeenCalled();
    expect(anthropic).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

describe("getShoppingAdviceState", () => {
  it("lists the open rows and the gaps not on the list, with unlock counts that match combinatorics", async () => {
    const fixture = await seed();
    const state = await readyState();

    expect(state.blocker).toBeNull();
    expect(state.climate).toEqual({ city: "Hamburg", country: "Germany" });
    // Priority first, list rows before gaps: the shell row (p1), the boots gap (p1), the scarf row (p2).
    expect(state.candidates.map((candidate) => [candidate.source, candidate.key])).toEqual([
      ["list", fixture.shellRow.id],
      ["gap", BOOTS_GAP.gap_key],
      ["list", fixture.scarfRow.id],
    ]);
    expect(state.candidates[1]?.relocationAnalysisId).toBe(fixture.relocationId);
    expect(state.omittedCandidates).toBe(0);

    expect(state.scenarios.map(({ key, label, tmeanC, rainy }) => ({ key, label, tmeanC, rainy }))).toEqual(
      HAMBURG_SCENARIOS,
    );
    for (const scenario of state.scenarios) {
      expect(scenario.outfitsNow).toBe(countOutfits(fixture.counted, scenario).count);
    }
    const sources = [
      { id: fixture.shellRow.id, itemType: SHELL_GAP.item_type, category: "outerwear" as const, specs: SHELL_GAP.specs },
      { id: BOOTS_GAP.gap_key, itemType: BOOTS_GAP.item_type, category: "shoes" as const, specs: BOOTS_GAP.specs },
      { id: fixture.scarfRow.id, itemType: "Wool scarf", category: "scarf" as const, specs: [] },
    ];
    state.candidates.forEach((candidate, index) => {
      const source = sources[index];
      if (source === undefined) throw new Error("no source");
      const combo = candidateFromShoppingRow(source);
      for (const scenario of HAMBURG_SCENARIOS) {
        expect(candidate.unlocks[scenario.key]).toBe(unlockCount(fixture.counted, combo, scenario));
      }
    });
    // The fixture is meaningful: the shell (warmth 2, waterproof) adds October outfits, the scarf is not counted.
    expect(state.candidates[0]?.unlocks.oct).toBeGreaterThan(0);
    expect(state.candidates[0]?.counted).toBe(true);
    expect(state.candidates[2]).toMatchObject({ counted: false, unlocks: { jan: 0, apr: 0, jul: 0, oct: 0 } });
  });

  it("computes the remaining budget from the run's budget minus the lowest estimates of bought rows", async () => {
    const fixture = await seed();
    const state = await readyState();
    expect(state.budget).toEqual({
      purchaseBudgetEur: 600,
      boughtMinimumEur: 105,
      unpricedBought: 1,
      remainingEur: 495,
      relocationAnalysisId: fixture.relocationId,
    });
    expect(state.estimateUsd).toBeGreaterThan(0);
    expect(state.model).toBe("claude-sonnet-5-5");
    expect(state.latest).toBeNull();
  });

  it("rounds the remaining budget down to whole euros and never below 0", () => {
    const row = (status: "bought" | "todo", min: number | null, max: number | null, quantity = 1) => ({
      status,
      estPriceMinEur: min,
      estPriceMaxEur: max,
      quantity,
    });
    const base = { latestAnalysisId: null };
    const list = (rows: ReturnType<typeof row>[], budget: number | null) =>
      adviceBudget({
        ...base,
        latestBudgetEur: budget,
        items: rows.map((entry, index) => ({
          id: `r${index}`,
          analysisId: null,
          itemType: "x",
          category: null,
          priority: 2,
          reason: "",
          specs: [],
          buyTiming: null,
          linkedItem: null,
          gapKey: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          ...entry,
        })),
      });
    expect(list([row("bought", 149.99, 200)], 600).remainingEur).toBe(450);
    expect(list([row("bought", 0.1, null), row("bought", 0.2, null)], 1).remainingEur).toBe(0);
    expect(list([row("bought", 700, null)], 600).remainingEur).toBe(0);
    expect(list([row("todo", 700, null)], 600).remainingEur).toBe(600);
    expect(list([row("bought", 10, null, 3)], null)).toMatchObject({ remainingEur: null, boughtMinimumEur: 30 });
  });

  it("subtracts only what was bought under the latest plan, not under an older one", async () => {
    await testDb.db.insert(climateProfiles).values(HAMBURG);
    // Plan A (€300): both its gaps bought, and a row added by hand and bought before plan B.
    const planA = await insertRelocation({ budget: 300, gaps: [SHELL_GAP, BOOTS_GAP], completedAt: new Date("2026-10-20T10:00:00Z") });
    await insertRow({ analysisId: planA, gapKey: SHELL_GAP.gap_key, itemType: SHELL_GAP.item_type, status: "bought", estPriceMinEur: 180 });
    await insertRow({ analysisId: planA, gapKey: BOOTS_GAP.gap_key, itemType: BOOTS_GAP.item_type, status: "bought", estPriceMinEur: 120 });
    await insertRow({ itemType: "Umbrella", status: "bought", estPriceMinEur: 25, createdAt: new Date("2026-10-25T10:00:00Z") });
    // Plan B, made afterwards with a fresh €150 for new purchases.
    const planB = await insertRelocation({ budget: 150, gaps: [MERINO_GAP], completedAt: new Date("2026-11-02T10:00:00Z") });

    const fresh = await readyState();
    expect(fresh.blocker).toBeNull();
    expect(fresh.budget).toEqual({
      purchaseBudgetEur: 150,
      boughtMinimumEur: 0,
      unpricedBought: 0,
      remainingEur: 150,
      relocationAnalysisId: planB,
    });

    // Bought under plan B: its own gap, and a row added by hand after it.
    await insertRow({ analysisId: planB, gapKey: MERINO_GAP.gap_key, itemType: MERINO_GAP.item_type, status: "bought", quantity: 2, estPriceMinEur: 40 });
    await insertRow({ itemType: "Gloves", status: "bought", estPriceMinEur: 30, createdAt: new Date("2026-11-02T12:00:00Z") });
    expect((await readyState()).budget).toMatchObject({ boughtMinimumEur: 110, remainingEur: 40 });
  });

  it("names what blocks a run: no candidates, no budget left, or no Hamburg profile", async () => {
    // No Hamburg profile.
    await insertRelocation();
    expect((await readyState()).blocker).toContain("Hamburg climate profile is missing");

    // Nothing to rank.
    await testDb.truncateAll();
    await testDb.db.insert(climateProfiles).values(HAMBURG);
    const blocked = await readyState();
    expect(blocked.blocker).toContain("Nothing to rank");
    expect(blocked.estimateUsd).toBeNull();

    // The budget is spent.
    await testDb.truncateAll();
    await testDb.db.insert(climateProfiles).values(HAMBURG);
    await insertRelocation({ budget: 100 });
    await insertRow({ itemType: "Parka", status: "bought", estPriceMinEur: 180 });
    expect((await readyState()).blocker).toContain("€100 purchase budget is used up");
  });

  it("refuses an incomplete climate profile instead of guessing its months", async () => {
    await testDb.db
      .insert(climateProfiles)
      .values({ ...HAMBURG, months: HAMBURG.months.map((month) => (month.month === 7 ? { ...month, tmean: null } : month)) });
    await insertRelocation();
    const state = await readyState();
    expect(state.blocker).toContain("July");
    expect(state.scenarios).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Running the advice
// ---------------------------------------------------------------------------

describe("runShoppingAdvice", () => {
  it("sends one low-effort request with the static system prompt and stores the advice with its cost", async () => {
    const fixture = await seed();
    const before = await readyState();
    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c2", "c1"], 150)));

    const run = await runShoppingAdvice(testDb.db, deps());

    expect(run.outcome).toBe("ran");
    expect(fake.remaining()).toBe(0);
    const [request] = fake.requests;
    expect(request?.method).toBe("create");
    expect(request?.params).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 6000,
      system: [{ type: "text", text: SHOPPING_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", format: toJsonSchemaFormat(ShoppingAdviceWireSchema) },
    });
    const instruction = sentInstruction();
    expect(instruction).toContain("€495 left for all purchases together.");
    expect(instruction).toMatch(/^c1\|outerwear\|Waterproof rain shell\|p1\|x1\|/m);
    expect(instruction).toMatch(/^c2\|shoes\|Waterproof leather boots\|p1\|x1\|€100-160\|gap\|/m);
    expect(instruction).toMatch(/^c3\|scarf\|Wool scarf\|p2\|x1\|\?\|list\|jan:0 apr:0 jul:0 oct:0\|\?$/m);
    expect(instruction).not.toContain(fixture.shellRow.id);

    const [row] = await adviceRows();
    if (row === undefined) throw new Error("no advice row");
    expect(row).toMatchObject({
      status: "complete",
      model: "claude-sonnet-5-5",
      effort: "low",
      promptVersion: SHOPPING_PROMPT_VERSION,
      error: null,
    });
    expect(row.estimatedCostUsd).toBeCloseTo(estimateShoppingAdviceUsd("claude-sonnet-5-5", instruction), 6);
    expect(row.estimatedCostUsd).toBeCloseTo(before.estimateUsd ?? -1, 6);
    const calls = await callRows(row.id);
    expect(calls.map((call) => [call.purpose, call.status])).toEqual([["shopping", "success"]]);
    expect(row.costUsd).toBeCloseTo(CALL_USD, 6);

    const result = ShoppingAdviceResultSchema.parse(row.result);
    expect(result.recommendations.map((entry) => [entry.rank, entry.key, entry.budget_eur])).toEqual([
      [1, BOOTS_GAP.gap_key, 150],
      [2, fixture.shellRow.id, 150],
    ]);
    expect(result.recommendations[0]?.unlocks).toEqual(before.candidates[1]?.unlocks);
    expect(result.recommendations[1]?.unlocks).toEqual(before.candidates[0]?.unlocks);
    expect(result.meta).toEqual({
      prompt_version: SHOPPING_PROMPT_VERSION,
      model: "claude-sonnet-5-5",
      effort: "low",
      candidate_count: 3,
      remaining_budget_eur: 495,
      scenarios: HAMBURG_SCENARIOS,
    });

    const latest = run.state.latest;
    expect(latest).toMatchObject({ analysisId: row.id, stale: false, remainingBudgetEur: 495 });
    expect(latest?.costUsd).toBeCloseTo(CALL_USD, 6);
    expect(latest?.recommendations.map((entry) => [entry.candidate.source, entry.onList, entry.rowStatus])).toEqual([
      ["gap", false, null],
      ["list", true, "todo"],
    ]);
    // The next read shows the same advice.
    expect((await readyState()).latest).toEqual(latest);
  });

  it("sends the climate of the whole year, never a stay that starts in January", async () => {
    await seed();
    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c1"])));

    await runShoppingAdvice(testDb.db, deps());

    const instruction = sentInstruction();
    expect(instruction).toContain("<climate>\nDestination: Hamburg, Germany\n");
    expect(instruction).toContain("\nMonthly normals, January to December:\n");
    expect(instruction).toMatch(/^Jan\|4\.2\|-0\.5\|2\.1\|/m);
    expect(instruction).not.toContain("arrival month");
    expect(instruction).not.toContain("for the stay");
  });

  it("retries an unknown key as invalid output, and stores the cost of both attempts", async () => {
    await seed();
    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c9"])), sonnet(fakeShoppingAdviceReply(["c1"])));

    await runShoppingAdvice(testDb.db, deps());

    const [row] = await adviceRows();
    if (row === undefined) throw new Error("no advice row");
    expect((await callRows(row.id)).map((call) => call.status)).toEqual(["invalid_output", "success"]);
    expect(row.costUsd).toBeCloseTo(2 * CALL_USD, 6);
    expect(ShoppingAdviceResultSchema.parse(row.result).recommendations).toHaveLength(1);
  });

  it("retries budgets that add up to more than what is left", async () => {
    await seed();
    // 3 × €200 = €600 > €495; then 3 × €150 = €450.
    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c1", "c2", "c3"], 200)), sonnet(fakeShoppingAdviceReply(["c1", "c2", "c3"], 150)));

    await runShoppingAdvice(testDb.db, deps());

    const [row] = await adviceRows();
    if (row === undefined) throw new Error("no advice row");
    expect((await callRows(row.id)).map((call) => call.status)).toEqual(["invalid_output", "success"]);
    const total = ShoppingAdviceResultSchema.parse(row.result).recommendations.reduce((sum, entry) => sum + entry.budget_eur, 0);
    expect(total).toBe(450);
  });

  it("marks the run failed with its cost when every attempt is invalid", async () => {
    await seed();
    const invalid = sonnet(fakeShoppingAdviceReply(["c1", "c1"]));
    fake.enqueue(invalid, sonnet(fakeShoppingAdviceReply(["c7"])), sonnet(fakeShoppingAdviceReply(["c1", "c2", "c3"], 400)));

    const error = await appError(runShoppingAdvice(testDb.db, deps()));

    expect(error.code).toBe("AI_INVALID_OUTPUT");
    const [row] = await adviceRows();
    expect(row).toMatchObject({ status: "failed", result: null });
    expect(row?.error).toBeTruthy();
    expect(row?.costUsd).toBeCloseTo(3 * CALL_USD, 6);
    expect((await readyState()).latest).toBeNull();
  });

  it("answers the latest advice again without a call when nothing changed, and calls again on force", async () => {
    await seed();
    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c1"])));
    const first = await runShoppingAdvice(testDb.db, deps());

    const again = await runShoppingAdvice(testDb.db, deps({ anthropic: vi.fn(() => fake) }));
    expect(again.outcome).toBe("reused");
    expect(again.state.latest?.analysisId).toBe(first.state.latest?.analysisId);
    expect(fake.requests).toHaveLength(1);

    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c2"])));
    const forced = await runShoppingAdvice(testDb.db, deps(), { force: true });
    expect(forced.outcome).toBe("ran");
    expect(fake.requests).toHaveLength(2);
    expect(await adviceRows()).toHaveLength(2);
    expect(forced.state.latest?.analysisId).not.toBe(first.state.latest?.analysisId);
  });

  it("marks the advice stale and runs again once the list changes", async () => {
    const fixture = await seed();
    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c2", "c1"])));
    await runShoppingAdvice(testDb.db, deps());

    // The boots gap goes on the list: it is now a list row, and the advice shows it as on the list.
    await addGapsToShoppingList(testDb.db, fixture.relocationId, [BOOTS_GAP.gap_key]);
    const state = await readyState();
    expect(state.latest?.stale).toBe(true);
    expect(state.latest?.recommendations[0]).toMatchObject({ onList: true, rowStatus: "todo" });
    expect(state.candidates.map((candidate) => candidate.source)).toEqual(["list", "list", "list"]);

    // A list row bought since shows as bought.
    await testDb.db.update(shoppingListItems).set({ status: "bought" }).where(eq(shoppingListItems.id, fixture.shellRow.id));
    expect((await readyState()).latest?.recommendations[1]).toMatchObject({ onList: true, rowStatus: "bought" });

    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c1"])));
    expect((await runShoppingAdvice(testDb.db, deps())).outcome).toBe("ran");
  });

  it("refuses with BUDGET_EXCEEDED before any call or row when the month's budget is spent", async () => {
    await seed();
    await testDb.db.insert(aiCalls).values({ model: "claude-haiku-5-5", purpose: "tagging", status: "success", costUsd: 20 });

    const error = await appError(runShoppingAdvice(testDb.db, deps()));

    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(anthropic).not.toHaveBeenCalled();
    const [advice] = await testDb.db.select({ n: count() }).from(analyses).where(eq(analyses.kind, "shopping"));
    expect(advice?.n).toBe(0);
  });

  it("refuses a blocked run with VALIDATION before any call", async () => {
    await testDb.db.insert(climateProfiles).values(HAMBURG);
    const error = await appError(runShoppingAdvice(testDb.db, deps()));
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("Nothing to rank");
    expect(anthropic).not.toHaveBeenCalled();
    expect(await adviceRows()).toHaveLength(0);
  });

  it("creates no row when the API key is missing", async () => {
    await seed();
    const missingKey = vi.fn((): AnthropicLike => {
      throw new AppError("CONFIG", "ANTHROPIC_API_KEY is required.");
    });

    const error = await appError(runShoppingAdvice(testDb.db, deps({ anthropic: missingKey })));

    expect(error.code).toBe("CONFIG");
    expect(await adviceRows()).toHaveLength(0);
  });
});

describe("a ranking already running", () => {
  /** The fake client, with every create() held until release(). */
  function heldClient(): { client: AnthropicLike; reached: () => number; release: () => void } {
    let reached = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: AnthropicLike = {
      messages: {
        create: async (params, options) => {
          reached += 1;
          await gate;
          return await fake.messages.create(params, options);
        },
        stream: fake.messages.stream.bind(fake.messages),
        batches: fake.messages.batches,
      },
    };
    return { client, reached: () => reached, release };
  }

  async function until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!condition()) throw new Error("the condition never held");
  }

  it("refuses a reload's request and a second tab's Run again with CONFLICT, so only one call is paid", async () => {
    await seed();
    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c1"])), sonnet(fakeShoppingAdviceReply(["c2"])), sonnet(fakeShoppingAdviceReply(["c3"])));
    const held = heldClient();
    const first = runShoppingAdvice(testDb.db, deps({ anthropic: () => held.client }));
    await until(() => held.reached() === 1);

    // Each later request either answers at once or reaches Claude and waits there with the first.
    let settled = 0;
    const outcome = (run: Promise<{ outcome: string }>) =>
      run
        .then(
          (result) => `ran ${result.outcome}`,
          (error: unknown) =>
            error instanceof AppError ? `${error.code} ${String(error.details?.reason)}` : `error ${String(error)}`,
        )
        .finally(() => {
          settled += 1;
        });
    const reload = outcome(runShoppingAdvice(testDb.db, deps({ anthropic: () => held.client })));
    const forced = outcome(runShoppingAdvice(testDb.db, deps({ anthropic: () => held.client }), { force: true }));
    await until(() => settled === 2 || held.reached() > 1);
    held.release();

    expect((await first).outcome).toBe("ran");
    expect([await reload, await forced]).toEqual(["CONFLICT running", "CONFLICT running"]);
    expect(held.reached()).toBe(1);
    expect(fake.requests).toHaveLength(1);
    expect((await adviceRows()).map((row) => row.status)).toEqual(["complete"]);
  });

  it("lets a new run start once a cut-off run's lease has passed", async () => {
    await seed();
    await testDb.db.insert(analyses).values({
      kind: "shopping",
      status: "running",
      model: "claude-sonnet-5-5",
      promptVersion: SHOPPING_PROMPT_VERSION,
      createdAt: new Date(Date.now() - 131_000),
    });
    fake.enqueue(sonnet(fakeShoppingAdviceReply(["c1"])));

    const run = await runShoppingAdvice(testDb.db, deps());

    expect(run.outcome).toBe("ran");
    expect(fake.requests).toHaveLength(1);
  });
});
