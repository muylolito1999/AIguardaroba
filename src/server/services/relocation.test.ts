import { randomUUID } from "node:crypto";

import { and, asc, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AnthropicLike, MessageStreamLike } from "@/lib/ai/client";
import { toJsonSchemaFormat } from "@/lib/ai/json-schema";
import { BOLOGNA } from "@/lib/climate/bologna";
import { HAMBURG } from "@/lib/climate/hamburg";
import { relations } from "@/lib/db/relations";
import {
  aiCalls,
  analyses,
  analysisParts,
  climateProfiles,
  items,
  packingChecklistItems,
  shoppingListItems,
  type AnalysisPart,
  type ClimateProfile,
  type Item,
  type NewItem,
} from "@/lib/db/schema";
import type { RelocationParamsInput } from "@/lib/relocation/contracts";
import { gapPosition } from "@/components/shopping/shopping-model";
import { RELOC_PROMPT_VERSION, RELOCATION_CALL_PARAMS, RELOCATION_SYSTEM_PROMPT } from "@/lib/relocation/prompts";
import { ChunkWireSchema, makeRelocationAnalysisSchema, SynthesisWireSchema } from "@/lib/relocation/schemas";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { makeImage, TAGGED_ITEM_FIELDS } from "../../../test/factories";
import {
  apiError,
  createFakeAnthropic,
  fakeMessage,
  type FakeAnthropic,
  type RecordedRequest,
} from "../../../test/fakes/anthropic";
import { cycleDecision, fakeChunkReply, fakeSynthesisReply } from "../../../test/relocation-fixtures";
import * as service from "./relocation";
import type { RelocationPartDeps } from "./relocation";
import { getShoppingList } from "./shopping";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

// PGlite plus the scripted Anthropic fake (D-046): no network. The env is
// blank here, so the run uses Sonnet 5.5 at medium effort and the monthly
// budget is the default $20. Each fake reply costs $0.01 (2,000 input and 600
// output tokens at Sonnet rates).

const CALL_USD = 0.01;
const PART_DEADLINE_MS = 270_000;

let testDb: TestDb;
let fake: FakeAnthropic;
let anthropic: ReturnType<typeof vi.fn<() => AnthropicLike>>;
let hamburg: ClimateProfile;
let bologna: ClimateProfile;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  fake = createFakeAnthropic();
  anthropic = vi.fn(() => fake);
  const profiles = await testDb.db.insert(climateProfiles).values([HAMBURG, BOLOGNA]).returning();
  const find = (slug: string) => {
    const profile = profiles.find((row) => row.slug === slug);
    if (profile === undefined) throw new Error(`no ${slug} profile`);
    return profile;
  };
  hamburg = find("hamburg");
  bologna = find("bologna");
});

afterAll(async () => {
  await testDb.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let itemSeq = 0;

/** Confirmed, fully tagged items named "Item N", created one second apart (so aliases follow insertion order). */
async function insertItems(total: number, make: (index: number) => Partial<NewItem> = () => ({})): Promise<Item[]> {
  const rows = Array.from({ length: total }, (_, index) => {
    itemSeq += 1;
    return {
      ...TAGGED_ITEM_FIELDS,
      status: "confirmed" as const,
      name: `Item ${itemSeq}`,
      imageHash: `${randomUUID()}${randomUUID()}`.replaceAll("-", "").slice(0, 64),
      createdAt: new Date(Date.UTC(2026, 0, 1) + itemSeq * 1000),
      ...make(index),
    };
  });
  return await testDb.db.insert(items).values(rows).returning();
}

function params(overrides: Partial<RelocationParamsInput> = {}): RelocationParamsInput {
  return {
    climateProfileId: hamburg.id,
    dateFrom: "2026-11-03",
    dateTo: "2027-11-02",
    constraints: "Bike commute, business-casual office. 2 x 23 kg suitcases plus 2 shipped boxes.",
    purchaseBudgetEur: 600,
    includeOnlyConfirmed: true,
    acceptPlaceholder: false,
    ...overrides,
  };
}

function sonnet(json: unknown) {
  return fakeMessage({ json, model: "claude-sonnet-5-5" });
}

function partDeps(overrides: Partial<RelocationPartDeps> = {}): RelocationPartDeps {
  return {
    anthropic,
    deadlineAt: Date.now() + PART_DEADLINE_MS,
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  };
}

async function start(overrides: Partial<RelocationParamsInput> = {}, force = false): Promise<string> {
  const started = await service.startRelocation(testDb.db, params(overrides), { force });
  expect(started.kind).toBe("started");
  return started.analysisId;
}

async function partsOf(analysisId: string): Promise<AnalysisPart[]> {
  return await testDb.db
    .select()
    .from(analysisParts)
    .where(eq(analysisParts.analysisId, analysisId))
    .orderBy(asc(analysisParts.kind), asc(analysisParts.partIndex));
}

async function partById(id: string): Promise<AnalysisPart> {
  const [part] = await testDb.db.select().from(analysisParts).where(eq(analysisParts.id, id));
  if (part === undefined) throw new Error(`part ${id} is gone`);
  return part;
}

function chunkAliases(part: AnalysisPart): string[] {
  return z.object({ aliases: z.array(z.string()) }).parse(part.input).aliases;
}

const SnapshotView = z.object({
  lines: z.array(z.object({ alias: z.string(), itemId: z.string(), text: z.string() })),
  aliasMap: z.record(z.string(), z.string()),
  names: z.record(z.string(), z.string()),
});

async function snapshotOf(analysisId: string) {
  const [row] = await testDb.db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (row === undefined) throw new Error(`analysis ${analysisId} is gone`);
  return SnapshotView.parse(row.inputSnapshot);
}

async function analysisRow(analysisId: string) {
  const [row] = await testDb.db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (row === undefined) throw new Error(`analysis ${analysisId} is gone`);
  return row;
}

async function onlyPart(analysisId: string, kind: "chunk" | "synthesis"): Promise<AnalysisPart> {
  const part = (await partsOf(analysisId)).find((candidate) => candidate.kind === kind);
  if (part === undefined) throw new Error(`no ${kind} part`);
  return part;
}

async function runChunks(analysisId: string): Promise<void> {
  for (const part of (await partsOf(analysisId)).filter((candidate) => candidate.kind === "chunk")) {
    fake.enqueue(sonnet(fakeChunkReply(chunkAliases(part))));
    await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps());
  }
}

/** Runs every chunk, then the synthesis with the fixture reply (overridable). */
async function runAll(analysisId: string, synthesis: Parameters<typeof fakeSynthesisReply>[1] = {}) {
  await runChunks(analysisId);
  const snapshot = await snapshotOf(analysisId);
  fake.enqueue(sonnet(fakeSynthesisReply(snapshot.lines.map((line) => line.alias), synthesis)));
  const part = await onlyPart(analysisId, "synthesis");
  return await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps());
}

/** The text blocks of a recorded request's user turn. */
function texts(request: RecordedRequest | undefined): string[] {
  const content = request?.params.messages[0]?.content;
  if (!Array.isArray(content)) throw new Error("expected content blocks");
  return content.map((block) => (block.type === "text" ? block.text : ""));
}

/** The aliases listed in an instruction's <items> block. */
function listedAliases(instruction: string | undefined): string[] {
  return (instruction ?? "")
    .split("\n")
    .filter((line) => /^i\d+\|/.test(line))
    .map((line) => line.split("|")[0] ?? "");
}

async function callRows(analysisId: string) {
  return await testDb.db.select().from(aiCalls).where(eq(aiCalls.analysisId, analysisId)).orderBy(asc(aiCalls.createdAt));
}

async function tableCount(table: typeof analyses | typeof analysisParts | typeof shoppingListItems) {
  const [row] = await testDb.db.select({ n: count() }).from(table);
  return row?.n ?? 0;
}

async function spendWholeBudget(): Promise<void> {
  await testDb.db
    .insert(aiCalls)
    .values({ model: "claude-haiku-5-5", purpose: "tagging", status: "success", costUsd: 20 });
}

/** A client whose streamed replies wait until release(): holds a part "running" for the concurrency test. */
function gated(inner: FakeAnthropic): { client: AnthropicLike; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: AnthropicLike = {
    messages: {
      ...inner.messages,
      stream(body, options): MessageStreamLike {
        const stream = inner.messages.stream(body, options);
        return {
          finalMessage: async () => {
            await gate;
            return await stream.finalMessage();
          },
          get request_id() {
            return stream.request_id;
          },
          on(event, listener) {
            stream.on(event, listener);
            return this;
          },
        };
      },
    },
  };
  return { client, release };
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!check()) throw new Error("waitUntil: condition not met");
}

// ---------------------------------------------------------------------------
// Estimate and start
// ---------------------------------------------------------------------------

describe("estimateRelocation", () => {
  it("counts the snapshot, prices the run and makes no call or write, without an API key", async () => {
    await insertItems(3);
    await insertItems(1, () => ({ status: "tagged" }));
    await insertItems(1, () => ({ status: "archived" }));
    await testDb.db.insert(items).values({ imageHash: "f".repeat(64) });

    const estimate = await service.estimateRelocation(testDb.db, params());

    expect(estimate).toMatchObject({
      itemCount: 3,
      excluded: { pending: 1, archived: 1, unconfirmed: 1 },
      chunkCount: 1,
      months: [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      model: "claude-sonnet-5-5",
      effort: "medium",
      placeholder: false,
      cached: null,
      budget: { monthToDateUsd: 0, budgetUsd: 20, remainingUsd: 20, blocked: false },
    });
    expect(estimate.usd).toBeGreaterThan(0);
    expect(estimate.lowUsd).toBeLessThan(estimate.usd);
    expect(estimate.highUsd).toBeGreaterThan(estimate.usd);
    expect(anthropic).not.toHaveBeenCalled();
    expect(await tableCount(analyses)).toBe(0);

    const withTagged = await service.estimateRelocation(testDb.db, params({ includeOnlyConfirmed: false }));
    expect(withTagged).toMatchObject({ itemCount: 4, excluded: { pending: 1, archived: 1, unconfirmed: 0 } });
  });

  it("leaves running gear out of the estimate and the run, counted once as running (D-249)", async () => {
    const clothing = await insertItems(2);
    await insertItems(4, (index) => ({
      collection: "running",
      status: (["confirmed", "tagged", "pending_tagging", "archived"] as const)[index] ?? "confirmed",
    }));

    for (const includeOnlyConfirmed of [true, false]) {
      const estimate = await service.estimateRelocation(testDb.db, params({ includeOnlyConfirmed }));
      expect(estimate).toMatchObject({
        itemCount: 2,
        excluded: { pending: 0, archived: 0, unconfirmed: 0, running: 4 },
      });
    }

    const snapshot = await snapshotOf(await start({ includeOnlyConfirmed: false }));
    const clothingIds = clothing.map((item) => item.id).sort();
    expect(snapshot.lines.map((line) => line.itemId).sort()).toEqual(clothingIds);
    expect(Object.keys(snapshot.names).sort()).toEqual(clothingIds);
  });

  it("flags a placeholder profile and a spent budget", async () => {
    await insertItems(2);
    await spendWholeBudget();
    const estimate = await service.estimateRelocation(testDb.db, params({ climateProfileId: bologna.id }));
    expect(estimate.placeholder).toBe(true);
    expect(estimate.budget).toMatchObject({ monthToDateUsd: 20, remainingUsd: 0, blocked: true });
  });

  it("answers NOT_FOUND for an unknown profile and VALIDATION for an inverted range", async () => {
    await expect(
      service.estimateRelocation(testDb.db, params({ climateProfileId: randomUUID() })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.estimateRelocation(testDb.db, params({ dateFrom: "2027-01-01", dateTo: "2026-12-31" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("startRelocation", () => {
  it("marks what is already at the run's own destination, not Hamburg, for a Bologna run (D-170)", async () => {
    const [inBologna, inHamburg, onTheWay] = await insertItems(3, (index) => ({
      location: (["bologna", "hamburg", "in_transit"] as const)[index] ?? "unknown",
    }));
    if (inBologna === undefined || inHamburg === undefined || onTheWay === undefined) throw new Error("no items");
    const analysisId = await start({ climateProfileId: bologna.id, acceptPlaceholder: true });

    const snapshot = await snapshotOf(analysisId);
    const lineOf = (id: string) => snapshot.lines.find((line) => line.itemId === id)?.text ?? "";
    expect(lineOf(inBologna.id).endsWith("|now:there")).toBe(true);
    expect(lineOf(inHamburg.id)).not.toContain("now:");
    expect(lineOf(onTheWay.id)).not.toContain("now:");
    const stored = z
      .object({ moved: z.array(z.string()), profile: z.object({ slug: z.string() }) })
      .parse((await analysisRow(analysisId)).inputSnapshot);
    expect(stored.moved).toEqual([inBologna.id]);
    expect(stored.profile.slug).toBe("bologna");

    // The same wardrobe planned for Hamburg marks the other two.
    const hamburgRun = await start({ includeOnlyConfirmed: true });
    const toHamburg = await snapshotOf(hamburgRun);
    const hamburgLine = (id: string) => toHamburg.lines.find((line) => line.itemId === id)?.text ?? "";
    expect(hamburgLine(inHamburg.id).endsWith("|now:there")).toBe(true);
    expect(hamburgLine(onTheWay.id).endsWith("|now:in_transit")).toBe(true);
    expect(hamburgLine(inBologna.id)).not.toContain("now:");
  });

  it("refuses a run whose synthesis would not fit its output cap, before anything is written (D-175)", async () => {
    // At medium effort the synthesis fits up to 3,133 items: (2,600 + 3 x 3,134) x 2 is over 24,000 tokens.
    for (let batch = 0; batch < 4; batch += 1) await insertItems(batch < 3 ? 1_000 : 134);
    const estimate = await service.estimateRelocation(testDb.db, params());
    expect(estimate).toMatchObject({ itemCount: 3_134, tooLarge: true });

    await expect(service.startRelocation(testDb.db, params())).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "too_many_items", itemCount: 3_134, effort: "medium" },
    });
    expect(await tableCount(analyses)).toBe(0);
    expect(await tableCount(analysisParts)).toBe(0);
    expect(fake.requests).toHaveLength(0);
  }, 60_000);

  it("stores the snapshot and creates one part per chunk plus the synthesis", async () => {
    await insertItems(40, () => ({ category: "outerwear" }));
    await insertItems(35, () => ({ category: "top", subcategory: "shirt" }));
    const estimate = await service.estimateRelocation(testDb.db, params());

    const analysisId = await start();

    const row = await analysisRow(analysisId);
    expect(row).toMatchObject({
      kind: "relocation",
      status: "running",
      climateProfileId: hamburg.id,
      dateFrom: "2026-11-03",
      dateTo: "2027-11-02",
      model: "claude-sonnet-5-5",
      effort: "medium",
      promptVersion: RELOC_PROMPT_VERSION,
      costUsd: 0,
    });
    expect(row.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(row.inputSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.estimatedCostUsd).toBeCloseTo(estimate.usd, 6);
    expect(row.params).toMatchObject({ purchaseBudgetEur: 600, includeOnlyConfirmed: true });

    const parts = await partsOf(analysisId);
    expect(parts.map((part) => [part.kind, part.partIndex, part.status, part.attempts])).toEqual([
      ["chunk", 0, "pending", 0],
      ["chunk", 1, "pending", 0],
      ["synthesis", 0, "pending", 0],
    ]);
    expect(parts.slice(0, 2).map((part) => chunkAliases(part).length)).toEqual([40, 35]);
    expect(parts[2]?.input).toEqual({});

    const snapshot = await snapshotOf(analysisId);
    expect(snapshot.lines).toHaveLength(75);
    expect(Object.keys(snapshot.aliasMap)).toHaveLength(75);

    const run = await service.getRelocationRun(testDb.db, analysisId);
    expect(run.parts.map((part) => part.itemCount)).toEqual([40, 35, 75]);
    expect(run).toMatchObject({ status: "running", costUsd: 0 });
    expect(anthropic).not.toHaveBeenCalled();
  });

  it("refuses a placeholder profile unless accepted, and an empty snapshot, writing nothing", async () => {
    await insertItems(1, () => ({ status: "tagged" }));
    await expect(service.startRelocation(testDb.db, params())).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "no_items" },
    });

    await insertItems(2);
    await expect(
      service.startRelocation(testDb.db, params({ climateProfileId: bologna.id })),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "placeholder_not_accepted" } });
    expect(await tableCount(analyses)).toBe(0);

    const accepted = await service.startRelocation(
      testDb.db,
      params({ climateProfileId: bologna.id, acceptPlaceholder: true }),
    );
    expect(accepted.kind).toBe("started");
  });

  it("says when only running gear stands in the way, keeping no_items and the other messages (D-249)", async () => {
    const onlyRunning =
      "Only running gear is in the wardrobe, which the analysis leaves out. Add or confirm some clothes first.";
    await insertItems(3, (index) => ({
      collection: "running",
      status: (["confirmed", "tagged", "archived"] as const)[index] ?? "confirmed",
    }));
    for (const includeOnlyConfirmed of [true, false]) {
      await expect(service.startRelocation(testDb.db, params({ includeOnlyConfirmed }))).rejects.toMatchObject({
        code: "VALIDATION",
        message: onlyRunning,
        details: { reason: "no_items", excluded: { pending: 0, archived: 0, unconfirmed: 0, running: 3 } },
      });
    }

    // A tagged clothing item: confirming it or including tagged items would help.
    const [clothing] = await insertItems(1, () => ({ status: "tagged" }));
    if (clothing === undefined) throw new Error("no item");
    await expect(service.startRelocation(testDb.db, params({ includeOnlyConfirmed: true }))).rejects.toMatchObject({
      code: "VALIDATION",
      message: "There are no confirmed items to analyse. Confirm some tagged items first, or include unconfirmed ones.",
      details: { reason: "no_items", excluded: { pending: 0, archived: 0, unconfirmed: 1, running: 3 } },
    });

    // A clothing item waiting for tags, with tagged items included.
    await testDb.db.update(items).set({ status: "pending_tagging" }).where(eq(items.id, clothing.id));
    await expect(service.startRelocation(testDb.db, params({ includeOnlyConfirmed: false }))).rejects.toMatchObject({
      code: "VALIDATION",
      message: "There are no tagged items to analyse. Add and tag some items first.",
      details: { reason: "no_items", excluded: { pending: 1, archived: 0, unconfirmed: 0, running: 3 } },
    });
    expect(await tableCount(analyses)).toBe(0);
  });

  it("is blocked by the budget without a call or a write", async () => {
    await insertItems(3);
    await spendWholeBudget();
    await expect(service.startRelocation(testDb.db, params())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await tableCount(analyses)).toBe(0);
    expect(await tableCount(analysisParts)).toBe(0);
    expect(anthropic).not.toHaveBeenCalled();
  });

  it("returns an identical finished run as cached, and force starts a new one", async () => {
    await insertItems(4);
    const first = await start();
    await runAll(first);

    const again = await service.startRelocation(testDb.db, params({ constraints: `  ${params().constraints}\n` }));
    expect(again).toEqual({ kind: "cached", analysisId: first });
    expect(await tableCount(analyses)).toBe(1);
    const estimate = await service.estimateRelocation(testDb.db, params());
    expect(estimate.cached?.analysisId).toBe(first);

    const forced = await service.startRelocation(testDb.db, params(), { force: true });
    expect(forced.kind).toBe("started");
    expect(forced.analysisId).not.toBe(first);
    expect(await tableCount(analyses)).toBe(2);

    // A changed item line is a different snapshot, so no cached answer.
    const [item] = await testDb.db.select().from(items).limit(1);
    if (item === undefined) throw new Error("no item");
    await testDb.db.update(items).set({ warmthLevel: 1 }).where(eq(items.id, item.id));
    expect((await service.startRelocation(testDb.db, params())).kind).toBe("started");
  });
});

// ---------------------------------------------------------------------------
// Chunk parts
// ---------------------------------------------------------------------------

describe("runRelocationPart: chunks", () => {
  it("keeps on the part the cost of a request cut off before it could record anything (D-168)", async () => {
    await insertItems(4);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    const aliases = chunkAliases(part);

    // Holder 1 pays for a reply that leaves one item out, then its repair call
    // hangs, as if the function were killed mid-call: it never writes back.
    const holder = new AbortController();
    fake.enqueue(sonnet(fakeChunkReply(aliases, { omit: [aliases[1] ?? ""] })), { kind: "hang" });
    const first = service
      .runRelocationPart(testDb.db, analysisId, part.id, partDeps({ signal: holder.signal }))
      .catch((error: unknown) => error);
    for (let wait = 0; wait < 400 && fake.requests.length < 2; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fake.requests).toHaveLength(2);
    // The paid first call is on the part already, while the holder still runs.
    expect((await partById(part.id)).costUsd).toBeCloseTo(CALL_USD, 6);

    // After the lease ran out, the page asks again and takes the part over.
    const later = Date.now() + service.PART_LEASE_MS + 1_000;
    fake.enqueue(sonnet(fakeChunkReply(aliases)));
    const run = await service.runRelocationPart(
      testDb.db,
      analysisId,
      part.id,
      partDeps({ now: () => later, deadlineAt: later + PART_DEADLINE_MS }),
    );
    expect(run.parts[0]?.status).toBe("complete");
    holder.abort();
    await first;

    const logged = await callRows(analysisId);
    const loggedSum = logged.reduce((sum, row) => sum + row.costUsd, 0);
    // Two paid replies (the holder's and the takeover's) plus the aborted repair at $0.
    expect(logged.map((row) => row.status).sort()).toEqual(["error", "success", "success"]);
    expect((await partById(part.id)).costUsd).toBeCloseTo(loggedSum, 6);
    expect((await partById(part.id)).costUsd).toBeCloseTo(2 * CALL_USD, 6);
  });

  it("stores on the part exactly the sum of its ai_calls rows, rounded as Postgres rounds them (D-178)", async () => {
    await insertItems(3);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    // $0.0643125 at Sonnet rates: the double sits just below the half, so
    // rounding it in JS gave $0.064312 while the ai_calls column stores $0.064313.
    fake.enqueue(
      fakeMessage({
        json: fakeChunkReply(chunkAliases(part)),
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 1_764, output_tokens: 6_017, cache_read_input_tokens: 6_145 },
      }),
    );

    await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps());

    const logged = await callRows(analysisId);
    expect(logged.map((row) => row.costUsd)).toEqual([0.064313]);
    expect((await partById(part.id)).costUsd).toBe(0.064313);
    expect((await service.getRelocationRun(testDb.db, analysisId)).parts[0]?.costUsd).toBe(0.064313);
  });

  it("ends a chunk at once when the reply hits the output cap: a doubled retry could not finish in time (D-164)", async () => {
    await insertItems(3);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    fake.enqueue(
      fakeMessage({ stopReason: "max_tokens", text: '{"decisions":[', model: "claude-sonnet-5-5" }),
      sonnet(fakeChunkReply(chunkAliases(part))),
    );

    await expect(service.runRelocationPart(testDb.db, analysisId, part.id, partDeps())).rejects.toMatchObject({
      code: "AI_INVALID_OUTPUT",
      message: "Claude's reply was cut off by the output limit.",
    });

    expect(fake.requests).toHaveLength(1);
    expect(fake.remaining()).toBe(1);
    expect((await callRows(analysisId)).map((row) => row.status)).toEqual(["max_tokens"]);
    expect(await partById(part.id)).toMatchObject({
      status: "failed",
      error: "Claude's reply was cut off by the output limit.",
      costUsd: CALL_USD,
    });
  });

  it("retries a chunk whose stream broke off and keeps that attempt's cost on the part (D-163)", async () => {
    await insertItems(3);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    fake.enqueue(
      { kind: "broken", usage: { input_tokens: 2_000, cache_creation_input_tokens: 1_000 } },
      sonnet(fakeChunkReply(chunkAliases(part))),
    );

    const run = await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps());

    expect(run.parts[0]?.status).toBe("complete");
    const logged = await callRows(analysisId);
    expect(logged.map((row) => [row.status, row.errorCode])).toEqual([
      ["error", "stream_interrupted"],
      ["success", null],
    ]);
    expect(logged[0]?.inputTokens).toBe(2_000);
    expect(logged[0]?.costUsd).toBeGreaterThan(0);
    expect((await partById(part.id)).costUsd).toBeCloseTo(
      logged.reduce((sum, row) => sum + row.costUsd, 0),
      6,
    );
  });

  it("streams a chunk with the cached prompt layout and stores its decisions", async () => {
    await insertItems(5);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    const aliases = chunkAliases(part);
    fake.enqueue(sonnet(fakeChunkReply(aliases)));

    const run = await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps());

    const [request] = fake.requests;
    expect(request?.method).toBe("stream");
    expect(request?.params).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: RELOCATION_CALL_PARAMS.chunk.maxTokens,
      system: [{ type: "text", text: RELOCATION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { format: toJsonSchemaFormat(ChunkWireSchema), effort: "medium" },
    });
    const content = request?.params.messages[0]?.content;
    expect(Array.isArray(content) && content[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    expect(texts(request)[0]).toContain("<climate>");
    expect(listedAliases(texts(request)[1])).toEqual(aliases);

    const stored = await partById(part.id);
    expect(stored).toMatchObject({ status: "complete", attempts: 1, error: null, costUsd: CALL_USD });
    expect(stored.result).toEqual({ decisions: fakeChunkReply(aliases).decisions, repairCalls: 0 });
    expect(run.parts[0]).toMatchObject({ status: "complete", itemCount: 5, costUsd: CALL_USD });
    expect(run.costUsd).toBeCloseTo(CALL_USD, 6);

    const calls = await callRows(analysisId);
    expect(calls.map((call) => [call.purpose, call.status, call.analysisId])).toEqual([
      ["relocation_chunk", "success", analysisId],
    ]);
  });

  it("makes exactly one repair call for missing aliases and then completes", async () => {
    await insertItems(5);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    const aliases = chunkAliases(part);
    fake.enqueue(
      sonnet(fakeChunkReply(aliases, { omit: ["i2", "i4"] })),
      sonnet(fakeChunkReply(["i2", "i4"])),
    );

    await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps());

    expect(fake.requests).toHaveLength(2);
    expect(listedAliases(texts(fake.requests[1])[1])).toEqual(["i2", "i4"]);
    expect(texts(fake.requests[1])[0]).toBe(texts(fake.requests[0])[0]);
    const stored = await partById(part.id);
    expect(stored.status).toBe("complete");
    const result = z
      .object({ decisions: z.array(z.object({ item: z.string() })), repairCalls: z.number() })
      .parse(stored.result);
    expect(result.decisions.map((entry) => entry.item)).toEqual(aliases);
    expect(result.repairCalls).toBe(1);
    expect(stored.costUsd).toBeCloseTo(2 * CALL_USD, 6);
    const calls = await callRows(analysisId);
    expect(calls.map((call) => [call.purpose, call.analysisId])).toEqual([
      ["relocation_chunk", analysisId],
      ["relocation_repair", analysisId],
    ]);
  });

  it("fails the part when the repair still leaves items out, keeps the decisions, and Retry repairs only the rest", async () => {
    await insertItems(5);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    const aliases = chunkAliases(part);
    fake.enqueue(sonnet(fakeChunkReply(aliases, { omit: ["i2"] })), sonnet({ decisions: [] }));

    await expect(service.runRelocationPart(testDb.db, analysisId, part.id, partDeps())).rejects.toMatchObject({
      code: "AI_INVALID_OUTPUT",
      details: { missing: 1 },
    });
    const failed = await partById(part.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/1 item of this part without a decision/);
    expect(failed.costUsd).toBeCloseTo(2 * CALL_USD, 6);
    expect((await analysisRow(analysisId)).status).toBe("running");

    fake.enqueue(sonnet(fakeChunkReply(["i2"])));
    await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps(), { retry: true });

    expect(fake.requests).toHaveLength(3);
    expect(listedAliases(texts(fake.requests[2])[1])).toEqual(["i2"]);
    const done = await partById(part.id);
    expect(done).toMatchObject({ status: "complete", attempts: 2, error: null });
    expect(done.costUsd).toBeCloseTo(3 * CALL_USD, 6);
    expect(done.result).toMatchObject({ repairCalls: 2 });
    const calls = await callRows(analysisId);
    expect(calls.map((call) => call.purpose)).toEqual(["relocation_chunk", "relocation_repair", "relocation_repair"]);
  });

  it("retries an unknown alias as invalid output", async () => {
    await insertItems(3);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    const aliases = chunkAliases(part);
    fake.enqueue(
      sonnet(
        fakeChunkReply(aliases, {
          extra: [{ item: "i99", decision: "bring", priority: 1, reason: "Not in this request." }],
        }),
      ),
      sonnet(fakeChunkReply(aliases)),
    );

    await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps());

    expect(fake.remaining()).toBe(0);
    const calls = await callRows(analysisId);
    expect(calls.map((call) => [call.purpose, call.status])).toEqual([
      ["relocation_chunk", "invalid_output"],
      ["relocation_chunk", "success"],
    ]);
    expect(await partById(part.id)).toMatchObject({ status: "complete", attempts: 1 });
  });

  it("answers CONFLICT for a part that is already running", async () => {
    await insertItems(3);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    fake.enqueue(sonnet(fakeChunkReply(chunkAliases(part))));
    const { client, release } = gated(fake);

    const first = service.runRelocationPart(testDb.db, analysisId, part.id, partDeps({ anthropic: () => client }));
    await waitUntil(() => fake.requests.length === 1);
    await expect(service.runRelocationPart(testDb.db, analysisId, part.id, partDeps())).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This part is already running.",
    });
    release();
    await first;

    expect(fake.requests).toHaveLength(1);
    expect(await partById(part.id)).toMatchObject({ status: "complete", attempts: 1 });
  });

  it("takes over a part whose run was cut off more than five minutes ago", async () => {
    await insertItems(3);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    await testDb.db
      .update(analysisParts)
      .set({ status: "running", startedAt: new Date(Date.now() - service.PART_LEASE_MS - 1_000), attempts: 1 })
      .where(eq(analysisParts.id, part.id));
    fake.enqueue(sonnet(fakeChunkReply(chunkAliases(part))));

    await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps());

    expect(await partById(part.id)).toMatchObject({ status: "complete", attempts: 2 });
  });

  it("returns a finished part unchanged without a call or the API key", async () => {
    await insertItems(3);
    const analysisId = await start();
    await runChunks(analysisId);
    const part = await onlyPart(analysisId, "chunk");
    const noKey = vi.fn((): AnthropicLike => {
      throw new AppError("CONFIG", "ANTHROPIC_API_KEY is required.");
    });

    const run = await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps({ anthropic: noKey }));

    expect(noKey).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(1);
    expect(run.parts[0]).toMatchObject({ status: "complete", attempts: 1 });
  });

  it("records a failed call on the part, keeps the analysis running and lets Retry succeed", async () => {
    await insertItems(3);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    fake.enqueue(apiError(400, { type: "invalid_request_error", message: "bad request" }));

    await expect(service.runRelocationPart(testDb.db, analysisId, part.id, partDeps())).rejects.toMatchObject({
      code: "AI_UNAVAILABLE",
    });
    const run = await service.getRelocationRun(testDb.db, analysisId);
    expect(run.status).toBe("running");
    expect(run.parts[0]).toMatchObject({ status: "failed", attempts: 1, costUsd: 0 });
    expect(run.parts[0]?.error).toEqual(expect.any(String));
    expect(run.parts[0]?.error).not.toContain("bad request");

    // Asked for again without a Retry (another tab that waited on it, a
    // reloaded page): answered as it is, with no key, budget check or call.
    anthropic.mockClear();
    const again = await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps());
    expect(again.parts[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(anthropic).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(1);

    fake.enqueue(sonnet(fakeChunkReply(chunkAliases(part))));
    const retried = await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps(), { retry: true });
    expect(retried.parts[0]).toMatchObject({ status: "complete", attempts: 2, error: null });
  });

  it("stores the cost of every paid attempt of a call that gave up, and adds a Retry's to it", async () => {
    await insertItems(3);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    const aliases = chunkAliases(part);
    const unknownAlias = () =>
      sonnet(fakeChunkReply(aliases, { extra: [{ item: "i99", decision: "bring", priority: 1, reason: "Not listed." }] }));
    fake.enqueue(unknownAlias(), unknownAlias(), unknownAlias());

    await expect(service.runRelocationPart(testDb.db, analysisId, part.id, partDeps())).rejects.toMatchObject({
      code: "AI_INVALID_OUTPUT",
    });
    const failed = await service.getRelocationRun(testDb.db, analysisId);
    expect(failed.parts[0]?.status).toBe("failed");
    expect(failed.parts[0]?.costUsd).toBeCloseTo(3 * CALL_USD, 6);
    expect(failed.costUsd).toBeCloseTo(3 * CALL_USD, 6);

    fake.enqueue(sonnet(fakeChunkReply(aliases)));
    const retried = await service.runRelocationPart(testDb.db, analysisId, part.id, partDeps(), { retry: true });
    expect(retried.parts[0]?.status).toBe("complete");
    expect(retried.parts[0]?.costUsd).toBeCloseTo(4 * CALL_USD, 6);
    expect(retried.costUsd).toBeCloseTo(4 * CALL_USD, 6);
  });

  it("stores the chunk call and every paid repair attempt when the repair gives up", async () => {
    await insertItems(4);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    const aliases = chunkAliases(part);
    const badRepair = () =>
      sonnet(fakeChunkReply(["i2"], { extra: [{ item: "i99", decision: "leave", priority: 2, reason: "Not listed." }] }));
    fake.enqueue(sonnet(fakeChunkReply(aliases, { omit: ["i2"] })), badRepair(), badRepair(), badRepair());

    await expect(service.runRelocationPart(testDb.db, analysisId, part.id, partDeps())).rejects.toMatchObject({
      code: "AI_INVALID_OUTPUT",
    });
    const stored = await partById(part.id);
    expect(stored.status).toBe("failed");
    expect(stored.costUsd).toBeCloseTo(4 * CALL_USD, 6);
    expect((await service.getRelocationRun(testDb.db, analysisId)).costUsd).toBeCloseTo(4 * CALL_USD, 6);
  });

  it("changes nothing when the key is missing or the budget is spent", async () => {
    await insertItems(3);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    const noKey = () => {
      throw new AppError("CONFIG", "ANTHROPIC_API_KEY is required.");
    };
    await expect(
      service.runRelocationPart(testDb.db, analysisId, part.id, partDeps({ anthropic: noKey })),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(await partById(part.id)).toMatchObject({ status: "pending", attempts: 0, error: null });

    await spendWholeBudget();
    await expect(service.runRelocationPart(testDb.db, analysisId, part.id, partDeps())).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
    expect(await partById(part.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(anthropic).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for a part of another analysis or a malformed id", async () => {
    await insertItems(3);
    const first = await start();
    const second = await start({}, true);
    const part = await onlyPart(first, "chunk");
    await expect(service.runRelocationPart(testDb.db, second, part.id, partDeps())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(service.runRelocationPart(testDb.db, first, "part-1", partDeps())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(service.runRelocationPart(testDb.db, randomUUID(), part.id, partDeps())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("uses the stored snapshot when an item changes mid-run", async () => {
    const [changed] = await insertItems(3);
    if (changed === undefined) throw new Error("no item");
    const analysisId = await start();
    const originalName = changed.name ?? "";
    await testDb.db
      .update(items)
      .set({ name: "Renamed red raincoat", warmthLevel: 1 })
      .where(eq(items.id, changed.id));

    await runAll(analysisId);

    for (const request of fake.requests) {
      expect(texts(request).join("\n")).not.toContain("Renamed red raincoat");
    }
    expect(texts(fake.requests[0])[1]).toContain(originalName);
    const labels = await testDb.db
      .select({ label: packingChecklistItems.label })
      .from(packingChecklistItems)
      .where(eq(packingChecklistItems.itemId, changed.id));
    expect(labels).toEqual([{ label: originalName }]);
  });
});

// ---------------------------------------------------------------------------
// Synthesis and finalize
// ---------------------------------------------------------------------------

describe("runRelocationPart: synthesis", () => {
  it("answers CONFLICT before every chunk is done, without a call", async () => {
    await insertItems(3);
    const analysisId = await start();
    const synthesis = await onlyPart(analysisId, "synthesis");
    await expect(
      service.runRelocationPart(testDb.db, analysisId, synthesis.id, partDeps()),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "chunks_incomplete" } });
    expect(anthropic).not.toHaveBeenCalled();
    expect(await partById(synthesis.id)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("finalizes: a valid result, the summed cost, packing rows, gap keys and computed warnings", async () => {
    const rows = await insertItems(6, (index) => (index === 5 ? { location: "hamburg" } : {}));
    const analysisId = await start({ purchaseBudgetEur: 100 });

    const run = await runAll(analysisId);

    const synthesisRequest = fake.requests[1];
    expect(synthesisRequest?.params).toMatchObject({
      max_tokens: 24_000,
      output_config: { format: toJsonSchemaFormat(SynthesisWireSchema), effort: "medium" },
    });
    expect(texts(synthesisRequest)[0]).toBe(texts(fake.requests[0])[0]);
    expect(texts(synthesisRequest)[1]).toContain("i1|bring|1");

    const row = await analysisRow(analysisId);
    expect(row.status).toBe("complete");
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.costUsd).toBeCloseTo(2 * CALL_USD, 6);
    expect(run).toMatchObject({ status: "complete" });
    expect(run.costUsd).toBeCloseTo(2 * CALL_USD, 6);
    expect(run.parts.every((part) => part.status === "complete")).toBe(true);

    const snapshot = await snapshotOf(analysisId);
    const ids = snapshot.lines.map((line) => line.itemId);
    expect(new Set(ids)).toEqual(new Set(rows.map((item) => item.id)));
    const result = makeRelocationAnalysisSchema(ids).parse(row.result);
    expect(result.items.map((item) => item.decision)).toEqual(ids.map((_, index) => cycleDecision(index)));
    expect(result.gaps.map((gap) => gap.gap_key)).toEqual([
      "g1-outerwear-waterproof-breathable-shell-jacket",
      "g2-shoes-insulated-waterproof-boots",
    ]);
    expect(result.meta).toMatchObject({
      prompt_version: RELOC_PROMPT_VERSION,
      model: "claude-sonnet-5-5",
      effort: "medium",
      item_count: 6,
      chunk_count: 1,
      climate_profile: { id: hamburg.id, city: "Hamburg", is_placeholder: false },
      purchase_budget_eur: 100,
      repair_calls: 0,
    });
    expect(result.meta.estimated_cost_usd).toBeCloseTo(row.estimatedCostUsd ?? -1, 6);

    const moved = rows[5]?.id;
    const computed = result.warnings.filter((warning) => warning.source === "computed");
    expect(computed.map((warning) => [warning.kind, warning.item_ids.length])).toEqual([
      ["over_budget", 0],
      ["packing", 1],
      ["packing", 3],
      ["packing", 1],
    ]);
    expect(computed[0]?.message).toBe(
      "The priority 1 and 2 purchases cost at least €210, more than the purchase budget of €100.",
    );
    expect(computed[1]?.message).toMatch(/^1 item in the layering systems is not marked bring/);
    expect(computed[3]?.item_ids).toEqual([moved]);
    expect(result.warnings.filter((warning) => warning.source === "ai")).toHaveLength(1);

    const packing = await testDb.db
      .select()
      .from(packingChecklistItems)
      .where(eq(packingChecklistItems.analysisId, analysisId));
    expect(packing).toHaveLength(7);
    const suitcase = packing
      .filter((entry) => entry.group === "suitcase")
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((entry) => [entry.label, entry.itemId, entry.sortOrder]);
    expect(suitcase).toEqual([
      [snapshot.names[ids[0] ?? ""], ids[0], 0],
      [snapshot.names[ids[4] ?? ""], ids[4], 1],
      ["Travel umbrella", null, 2],
    ]);
    expect(packing.every((entry) => entry.packed === false)).toBe(true);

    const synthesisPart = await onlyPart(analysisId, "synthesis");
    expect(synthesisPart).toMatchObject({ status: "complete", attempts: 1, error: null });
    expect(synthesisPart.costUsd).toBeCloseTo(CALL_USD, 6);
    const calls = await callRows(analysisId);
    expect(calls.map((call) => call.purpose)).toEqual(["relocation_chunk", "relocation_synthesis"]);
  });

  it("adds the placeholder warning when the owner accepted a placeholder profile", async () => {
    await insertItems(3);
    const analysisId = await start({ climateProfileId: bologna.id, acceptPlaceholder: true, purchaseBudgetEur: null });
    await runAll(analysisId);
    const view = await service.loadRelocationView(testDb.db, analysisId);
    expect(view.profile).toEqual({ id: bologna.id, city: "Bologna", country: "Italy", isPlaceholder: true });
    expect(view.result.warnings.map((warning) => warning.kind)).toContain("placeholder_climate");
    expect(view.result.warnings.map((warning) => warning.kind)).not.toContain("over_budget");
  });

  it("warns about bring items left out of the packing checklist and still completes", async () => {
    await insertItems(3);
    const analysisId = await start();
    await runAll(analysisId, {
      packing_checklist: [{ group: "suitcase", item_aliases: ["i1"], extras: [] }],
    });
    const view = await service.loadRelocationView(testDb.db, analysisId);
    const missing = view.result.warnings.find((warning) => warning.message.includes("missing from the packing checklist"));
    // i1 and i2 are bring (cycleDecision); i2 is not packed.
    expect(missing?.item_ids).toHaveLength(1);
    expect(view.packing.map((row) => row.group)).toEqual(["suitcase"]);
  });

  it("keeps an item listed twice in one packing group once", async () => {
    await insertItems(3);
    const analysisId = await start();
    await runAll(analysisId, {
      packing_checklist: [
        { group: "suitcase", item_aliases: ["i1", "i1", "i2"], extras: [] },
        { group: "wear_on_travel_day", item_aliases: ["i3"], extras: [] },
      ],
    });

    const view = await service.loadRelocationView(testDb.db, analysisId);
    const ids = (await snapshotOf(analysisId)).lines.map((line) => line.itemId);
    expect(view.result.packing_checklist[0]?.item_ids).toEqual(ids.slice(0, 2));
    expect(view.packing.filter((row) => row.group === "suitcase").map((row) => row.itemId)).toEqual(ids.slice(0, 2));
  });

  it("still finalizes when an item is deleted mid-run", async () => {
    const [gone] = await insertItems(4);
    if (gone === undefined) throw new Error("no item");
    const analysisId = await start();
    await testDb.db.delete(items).where(eq(items.id, gone.id));

    const run = await runAll(analysisId);

    expect(run.status).toBe("complete");
    const packing = await testDb.db
      .select()
      .from(packingChecklistItems)
      .where(eq(packingChecklistItems.analysisId, analysisId));
    // Four items packed by the fixture minus the deleted one, plus the extra.
    expect(packing).toHaveLength(4);
    expect(packing.some((entry) => entry.itemId === gone.id)).toBe(false);
    const view = await service.loadRelocationView(testDb.db, analysisId);
    expect(view.items[gone.id]).toMatchObject({
      exists: false,
      status: null,
      location: null,
      collection: null,
      name: gone.name,
      thumb: null,
      currentDecision: "undecided",
    });
  });

  it("fails the synthesis part and leaves the analysis running when every reply is invalid", async () => {
    await insertItems(3);
    const analysisId = await start();
    await runChunks(analysisId);
    const snapshot = await snapshotOf(analysisId);
    // A blank summary passes the wire schema but not the strict check, so
    // callStructured retries it until its attempts run out.
    fake.enqueue(
      ...Array.from({ length: 3 }, () =>
        sonnet(fakeSynthesisReply(snapshot.lines.map((line) => line.alias), { summary: "   " })),
      ),
    );
    const synthesis = await onlyPart(analysisId, "synthesis");

    await expect(
      service.runRelocationPart(testDb.db, analysisId, synthesis.id, partDeps()),
    ).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });

    const failed = await partById(synthesis.id);
    expect(failed.status).toBe("failed");
    // The three paid replies count, as they do in ai_calls.
    expect(failed.costUsd).toBeCloseTo(3 * CALL_USD, 6);
    expect(await analysisRow(analysisId)).toMatchObject({ status: "running", result: null });
    expect(await tableCount(analyses)).toBe(1);
    const [packed] = await testDb.db.select({ n: count() }).from(packingChecklistItems);
    expect(packed?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Result screen
// ---------------------------------------------------------------------------

describe("loadRelocationView", () => {
  it("answers NOT_FOUND for unknown ids and other kinds, and CONFLICT while running", async () => {
    await insertItems(2);
    await expect(service.loadRelocationView(testDb.db, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.loadRelocationView(testDb.db, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [other] = await testDb.db
      .insert(analyses)
      .values({ kind: "outfit_suggestion", model: "claude-sonnet-5-5", promptVersion: "x", status: "complete" })
      .returning();
    if (other === undefined) throw new Error("no analysis");
    await expect(service.loadRelocationView(testDb.db, other.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const running = await start();
    await expect(service.loadRelocationView(testDb.db, running)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "not_complete" },
    });
  });

  it("returns the result with current items, thumbs, ordered packing rows and added gaps", async () => {
    const rows = await insertItems(4);
    const first = rows[0];
    if (first === undefined) throw new Error("no item");
    await makeImage(testDb.db, first.id, { kind: "thumb", width: 256, height: 320 });
    const analysisId = await start();
    await runAll(analysisId);
    await testDb.db.update(items).set({ decision: "sell" }).where(eq(items.id, first.id));

    const view = await service.loadRelocationView(testDb.db, analysisId);

    expect(view).toMatchObject({
      id: analysisId,
      status: "complete",
      model: "claude-sonnet-5-5",
      effort: "medium",
      promptVersion: RELOC_PROMPT_VERSION,
      months: [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      profile: { id: hamburg.id, city: "Hamburg", country: "Germany", isPlaceholder: false },
      params: { purchaseBudgetEur: 600 },
      addedGapKeys: [],
    });
    expect(view.costUsd).toBeCloseTo(2 * CALL_USD, 6);
    expect(Object.keys(view.items)).toHaveLength(4);
    expect(view.items[first.id]).toMatchObject({
      exists: true,
      name: first.name,
      currentDecision: "sell",
      status: "confirmed",
      location: "bologna",
      thumb: { url: expect.stringContaining(first.id), width: 256, height: 320 },
    });
    expect(view.packing.map((row) => row.group)).toEqual([
      "suitcase",
      "suitcase",
      "carry_on",
      "ship_later",
      "wear_on_travel_day",
    ]);

    await service.addGapsToShoppingList(testDb.db, analysisId, [view.result.gaps[0]?.gap_key ?? ""]);
    const after = await service.loadRelocationView(testDb.db, analysisId);
    expect(after.addedGapKeys).toEqual([view.result.gaps[0]?.gap_key]);
  });

  it("carries each item's collection now: running for one moved since the run, null for a deleted one (D-249)", async () => {
    const rows = await insertItems(4);
    const analysisId = await start();
    await runAll(analysisId);
    const [moved, gone, ...kept] = rows;
    if (moved === undefined || gone === undefined) throw new Error("no items");
    await testDb.db.update(items).set({ collection: "running" }).where(eq(items.id, moved.id));
    await testDb.db.delete(items).where(eq(items.id, gone.id));

    const view = await service.loadRelocationView(testDb.db, analysisId);

    expect(view.items[moved.id]).toMatchObject({ exists: true, collection: "running" });
    expect(view.items[gone.id]).toMatchObject({ exists: false, collection: null });
    expect(kept).toHaveLength(2);
    for (const item of kept) expect(view.items[item.id]).toMatchObject({ exists: true, collection: "clothing" });
  });
});

describe("listRelocationAnalyses", () => {
  it("lists the newest runs first with city, months, item count and cost", async () => {
    await insertItems(3);
    const older = await start();
    await runAll(older);
    const newer = await start({ dateFrom: "2026-12-01", dateTo: "2027-02-28" }, true);

    const list = await service.listRelocationAnalyses(testDb.db);

    expect(list.map((entry) => entry.id)).toEqual([newer, older]);
    expect(list[0]).toMatchObject({ status: "running", city: "Hamburg", months: [12, 1, 2], itemCount: 3, costUsd: 0 });
    expect(list[1]).toMatchObject({ status: "complete", isPlaceholder: false, itemCount: 3 });
    expect(list[1]?.costUsd).toBeCloseTo(2 * CALL_USD, 6);
    expect(list[1]?.completedAt).toEqual(expect.any(String));
  });
});

describe("applyAiDecisionsToUndecided", () => {
  it("locks every candidate row in id order before its first update, so two applies cannot deadlock (D-166)", async () => {
    await insertItems(6);
    const analysisId = await start();
    await runAll(analysisId);
    const queries: string[] = [];
    const logged = drizzle({
      client: testDb.client,
      relations,
      logger: { logQuery: (query) => void queries.push(query) },
    });

    await service.applyAiDecisionsToUndecided(logged, analysisId);

    const lock = queries.findIndex(
      (query) => /^select .* from "items" /.test(query) && /order by "items"\."id" asc for no key update$/.test(query),
    );
    const firstUpdate = queries.findIndex((query) => query.startsWith('update "items"'));
    expect(lock).toBeGreaterThan(-1);
    expect(firstUpdate).toBeGreaterThan(lock);
  });

  it("writes AI decisions only to undecided, non-archived items", async () => {
    const rows = await insertItems(5);
    const analysisId = await start();
    await runAll(analysisId);
    const [ownerDecided, archived] = rows;
    if (ownerDecided === undefined || archived === undefined) throw new Error("no items");
    await testDb.db.update(items).set({ decision: "donate" }).where(eq(items.id, ownerDecided.id));
    await testDb.db.update(items).set({ status: "archived", archivedFrom: "confirmed" }).where(eq(items.id, archived.id));

    const applied = await service.applyAiDecisionsToUndecided(testDb.db, analysisId);

    expect(applied.updated).toBe(3);
    expect(new Set(applied.itemIds)).toEqual(new Set(rows.slice(2).map((item) => item.id)));
    const view = await service.loadRelocationView(testDb.db, analysisId);
    for (const entry of view.result.items) {
      const expected =
        entry.item_id === ownerDecided.id ? "donate" : entry.item_id === archived.id ? "undecided" : entry.decision;
      expect(view.items[entry.item_id]?.currentDecision).toBe(expected);
    }

    expect(await service.applyAiDecisionsToUndecided(testDb.db, analysisId)).toEqual({ updated: 0, itemIds: [] });
  });

  it("leaves an item moved to running gear after the run undecided (D-249)", async () => {
    const rows = await insertItems(4);
    const analysisId = await start();
    await runAll(analysisId);
    const [moved] = rows;
    if (moved === undefined) throw new Error("no items");
    await testDb.db.update(items).set({ collection: "running" }).where(eq(items.id, moved.id));

    const applied = await service.applyAiDecisionsToUndecided(testDb.db, analysisId);

    expect(applied.updated).toBe(3);
    expect(new Set(applied.itemIds)).toEqual(new Set(rows.slice(1).map((item) => item.id)));
    const view = await service.loadRelocationView(testDb.db, analysisId);
    expect(view.result.items.find((entry) => entry.item_id === moved.id)?.decision).toEqual(expect.any(String));
    expect(view.items[moved.id]?.currentDecision).toBe("undecided");
    for (const item of rows.slice(1)) {
      const decided = view.result.items.find((entry) => entry.item_id === item.id)?.decision;
      expect(view.items[item.id]?.currentDecision).toBe(decided);
    }
  });

  it("locks with exactly the predicate it updates with, running gear left out of both (D-166, D-249)", async () => {
    await insertItems(5);
    const analysisId = await start();
    await runAll(analysisId);
    const queries: string[] = [];
    const logged = drizzle({
      client: testDb.client,
      relations,
      logger: { logQuery: (query) => void queries.push(query) },
    });

    await service.applyAiDecisionsToUndecided(logged, analysisId);

    // Placeholders are numbered per query and the id lists differ in length; the rest must match.
    const normalise = (where: string) => where.replace(/\$\d+/g, "$").replace(/in \(\$(?:, \$)*\)/g, "in ($…)");
    const lockWheres = queries.flatMap((query) => {
      const match = /^select .* from "items" where (.*) order by "items"\."id" asc for no key update$/.exec(query);
      return match?.[1] === undefined ? [] : [normalise(match[1])];
    });
    const updateWheres = queries.flatMap((query) => {
      const match = /^update "items" set .*? where (.*) returning "id"$/.exec(query);
      return match?.[1] === undefined ? [] : [normalise(match[1])];
    });
    expect(lockWheres).toHaveLength(1);
    expect(updateWheres.length).toBeGreaterThan(0);
    for (const where of updateWheres) expect(where).toBe(lockWheres[0]);
    expect(lockWheres[0]).toContain('"items"."collection" = $');
  });

  it("refuses an unfinished run", async () => {
    await insertItems(2);
    const analysisId = await start();
    await expect(service.applyAiDecisionsToUndecided(testDb.db, analysisId)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("addGapsToShoppingList", () => {
  it("adds the chosen gaps once, mapping their fields, and rejects unknown keys", async () => {
    await insertItems(3);
    const analysisId = await start();
    await runAll(analysisId);
    const keys = ["g1-outerwear-waterproof-breathable-shell-jacket", "g2-shoes-insulated-waterproof-boots"];

    expect(await service.addGapsToShoppingList(testDb.db, analysisId, keys)).toEqual({ added: 2, alreadyThere: 0 });
    expect(await service.addGapsToShoppingList(testDb.db, analysisId, keys)).toEqual({ added: 0, alreadyThere: 2 });
    expect(await tableCount(shoppingListItems)).toBe(2);

    const [shell] = await testDb.db
      .select()
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.analysisId, analysisId), eq(shoppingListItems.gapKey, keys[0] ?? "")));
    expect(shell).toMatchObject({
      itemType: "Waterproof breathable shell jacket",
      category: "outerwear",
      priority: 1,
      reason: "16-18 rain days a month from October to January; daily cycling.",
      specs: ["Hood and taped seams", "At least 10,000 mm water column"],
      quantity: 1,
      estPriceMinEur: 120,
      estPriceMaxEur: 200,
      buyTiming: "before_move",
      status: "todo",
      linkedItemId: null,
    });

    await expect(
      service.addGapsToShoppingList(testDb.db, analysisId, [keys[0] ?? "", "outerwear-made-up"]),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { gapKeys: ["outerwear-made-up"] } });
    expect(await tableCount(shoppingListItems)).toBe(2);
  });

  it("keeps the synthesis's most-important-first order on the shopping list", async () => {
    await insertItems(3);
    const analysisId = await start();
    // Same priority, deliberately not in alphabetical order.
    const gap = (item_type: string, category: "outerwear" | "base_layer" | "gloves" | "other") => ({
      item_type,
      category,
      why_needed: "16-18 rain days a month from October to January.",
      specs: [],
      priority: 1 as const,
      quantity: 1,
      est_price_min_eur: 20,
      est_price_max_eur: 40,
      buy_timing: "before_move" as const,
    });
    const gaps = [
      gap("Waterproof shell jacket", "outerwear"),
      gap("Merino base layer", "base_layer"),
      gap("Windproof gloves", "gloves"),
      gap("Bike lights", "other"),
    ];
    await runAll(analysisId, { gaps });
    const view = await service.loadRelocationView(testDb.db, analysisId);
    const keys = view.result.gaps.map((entry) => entry.gap_key);
    expect(keys.map(gapPosition)).toEqual([1, 2, 3, 4]);

    await service.addGapsToShoppingList(testDb.db, analysisId, keys);

    const list = await getShoppingList(testDb.db);
    expect(list.items.map((item) => item.itemType)).toEqual(gaps.map((entry) => entry.item_type));
  });
});

describe("packing checklist", () => {
  async function finishedRun(): Promise<string> {
    await insertItems(3);
    const analysisId = await start();
    await runAll(analysisId);
    return analysisId;
  }

  it("ticks a row and answers NOT_FOUND for an unknown one", async () => {
    const analysisId = await finishedRun();
    const view = await service.loadRelocationView(testDb.db, analysisId);
    const row = view.packing.find((entry) => entry.itemId !== null);
    if (row === undefined) throw new Error("no item row");

    expect(await service.setPackingItemPacked(testDb.db, row.id, true)).toEqual({ ...row, packed: true });
    const reread = await service.loadRelocationView(testDb.db, analysisId);
    expect(reread.packing.find((entry) => entry.id === row.id)?.packed).toBe(true);
    await expect(service.setPackingItemPacked(testDb.db, randomUUID(), true)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("adds an extra at the end of its group and deletes only extras", async () => {
    const analysisId = await finishedRun();
    const extra = await service.addPackingExtra(testDb.db, analysisId, "suitcase", "  Bike   lights ");
    // The fixture packs i1 and the umbrella in the suitcase (sortOrder 0 and 1).
    expect(extra).toMatchObject({ group: "suitcase", label: "Bike lights", itemId: null, packed: false, sortOrder: 2 });
    const passport = await service.addPackingExtra(testDb.db, analysisId, "carry_on", "Passport");
    expect(passport.sortOrder).toBe(1);

    await expect(service.addPackingExtra(testDb.db, analysisId, "attic", "Box")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(service.addPackingExtra(testDb.db, analysisId, "suitcase", "   ")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(service.addPackingExtra(testDb.db, analysisId, "suitcase", "x".repeat(121))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(service.addPackingExtra(testDb.db, randomUUID(), "suitcase", "Box")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect(await service.deletePackingExtra(testDb.db, extra.id)).toEqual({ deleted: true });
    const view = await service.loadRelocationView(testDb.db, analysisId);
    const itemRow = view.packing.find((entry) => entry.itemId !== null);
    if (itemRow === undefined) throw new Error("no item row");
    await expect(service.deletePackingExtra(testDb.db, itemRow.id)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(service.deletePackingExtra(testDb.db, extra.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("session checks (D-013)", () => {
  it("every exported function checks the session before touching data", async () => {
    await insertItems(2);
    const analysisId = await start();
    const part = await onlyPart(analysisId, "chunk");
    requireSession.mockReset();
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again."));
    const db = testDb.db;
    const id = randomUUID();

    const calls: Array<[string, () => Promise<unknown>]> = [
      ["estimateRelocation", () => service.estimateRelocation(db, params())],
      ["startRelocation", () => service.startRelocation(db, params(), { force: true })],
      ["getRelocationRun", () => service.getRelocationRun(db, analysisId)],
      ["runRelocationPart", () => service.runRelocationPart(db, analysisId, part.id, partDeps())],
      ["loadRelocationView", () => service.loadRelocationView(db, analysisId)],
      ["listRelocationAnalyses", () => service.listRelocationAnalyses(db)],
      ["applyAiDecisionsToUndecided", () => service.applyAiDecisionsToUndecided(db, analysisId)],
      ["addGapsToShoppingList", () => service.addGapsToShoppingList(db, analysisId, ["x"])],
      ["setPackingItemPacked", () => service.setPackingItemPacked(db, id, true)],
      ["addPackingExtra", () => service.addPackingExtra(db, analysisId, "suitcase", "Box")],
      ["deletePackingExtra", () => service.deletePackingExtra(db, id)],
    ];
    const exported = Object.entries(service)
      .filter(([, value]) => typeof value === "function" && value.constructor.name === "AsyncFunction")
      .map(([name]) => name)
      .sort();
    expect(calls.map(([name]) => name).sort()).toEqual(exported);

    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
    expect(await tableCount(analyses)).toBe(1);
    expect(await partById(part.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(anthropic).not.toHaveBeenCalled();
  });
});
