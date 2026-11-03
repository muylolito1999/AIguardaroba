import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { HAMBURG } from "@/lib/climate/hamburg";
import { analysisParts, climateProfiles, items, type AnalysisPart } from "@/lib/db/schema";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";
import { runRelocationPart, startRelocation } from "@/server/services/relocation";

import { makeTestDb, type TestDb } from "../../../../../../../test/db";
import { TAGGED_ITEM_FIELDS } from "../../../../../../../test/factories";
import { createFakeAnthropic, fakeMessage } from "../../../../../../../test/fakes/anthropic";
import { fakeChunkReply } from "../../../../../../../test/relocation-fixtures";

// Wiring only: runRelocationPart has its own tests. No API key exists here,
// so the Anthropic getter throws CONFIG, which only a part that needs Claude
// reaches.

const ORIGIN = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
  getAnthropic: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));
vi.mock("@/lib/ai/client", () => ({ getAnthropic: mocks.getAnthropic }));

const route = await import("./route");

const RunSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    analysisId: z.string(),
    status: z.string(),
    parts: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string(), itemCount: z.number() })),
  }),
});

let testDb: TestDb;

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
    throw new AppError("CONFIG", "ANTHROPIC_API_KEY is required.");
  });
});

afterAll(async () => {
  await testDb.close();
});

async function startedRun(): Promise<{ analysisId: string; parts: AnalysisPart[] }> {
  const [profile] = await testDb.db.insert(climateProfiles).values(HAMBURG).returning();
  if (profile === undefined) throw new Error("no profile");
  await testDb.db.insert(items).values(
    Array.from({ length: 3 }, (_, index) => ({
      ...TAGGED_ITEM_FIELDS,
      status: "confirmed" as const,
      imageHash: String(index).repeat(64),
    })),
  );
  const started = await startRelocation(testDb.db, {
    climateProfileId: profile.id,
    dateFrom: "2026-11-03",
    dateTo: "2027-11-02",
    constraints: "",
    purchaseBudgetEur: null,
  });
  const parts = await testDb.db
    .select()
    .from(analysisParts)
    .where(eq(analysisParts.analysisId, started.analysisId))
    .orderBy(asc(analysisParts.kind), asc(analysisParts.partIndex));
  return { analysisId: started.analysisId, parts };
}

function call(id: string, partId: string, origin = ORIGIN, body?: string) {
  const request = new Request(`${ORIGIN}/api/analyses/${id}/parts/${partId}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  return route.POST(request, { params: Promise.resolve({ id, partId }) });
}

describe("POST /api/analyses/[id]/parts/[partId]", () => {
  it("allows the full 300 s, of which the service uses at most 270 s for Claude", () => {
    expect(route.maxDuration).toBe(300);
  });

  it("answers 404 for malformed or unknown ids", async () => {
    const { analysisId } = await startedRun();
    for (const [id, partId] of [
      ["not-a-uuid", randomUUID()],
      [analysisId, "part-1"],
      [analysisId, randomUUID()],
      [randomUUID(), randomUUID()],
    ] as const) {
      const response = await call(id, partId);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("answers a finished part with the run and never asks for the API key", async () => {
    const { analysisId, parts } = await startedRun();
    const chunk = parts[0];
    if (chunk === undefined) throw new Error("no chunk");
    const fake = createFakeAnthropic([
      fakeMessage({ json: fakeChunkReply(z.object({ aliases: z.array(z.string()) }).parse(chunk.input).aliases) }),
    ]);
    await runRelocationPart(testDb.db, analysisId, chunk.id, {
      anthropic: () => fake,
      deadlineAt: Date.now() + 60_000,
    });

    const response = await call(analysisId, chunk.id);

    expect(response.status).toBe(200);
    const body = RunSchema.parse(await response.json());
    expect(body.data.analysisId).toBe(analysisId);
    expect(body.data.parts.map((part) => [part.kind, part.status])).toEqual([
      ["chunk", "complete"],
      ["synthesis", "pending"],
    ]);
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("hides a missing key as CONFIG and leaves the part untouched", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { analysisId, parts } = await startedRun();
    const chunk = parts[0];
    if (chunk === undefined) throw new Error("no chunk");

    const response = await call(analysisId, chunk.id);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } });
    expect(mocks.getAnthropic).toHaveBeenCalledTimes(1);
    const [stored] = await testDb.db.select().from(analysisParts).where(eq(analysisParts.id, chunk.id));
    expect(stored).toMatchObject({ status: "pending", attempts: 0 });
    consoleError.mockRestore();
  });

  it("runs a part to its end when the browser has gone, as on Vercel (D-167)", async () => {
    const { analysisId, parts } = await startedRun();
    const chunk = parts[0];
    if (chunk === undefined) throw new Error("no chunk");
    const aliases = z.object({ aliases: z.array(z.string()) }).parse(chunk.input).aliases;
    const fake = createFakeAnthropic([fakeMessage({ json: fakeChunkReply(aliases), model: "claude-sonnet-5-5" })]);
    mocks.getAnthropic.mockImplementation(() => fake);
    // The tab was closed: the request's signal has already fired.
    const gone = new AbortController();
    gone.abort();
    const request = new Request(`${ORIGIN}/api/analyses/${analysisId}/parts/${chunk.id}`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
      signal: gone.signal,
    });

    const response = await route.POST(request, { params: Promise.resolve({ id: analysisId, partId: chunk.id }) });

    expect(response.status).toBe(200);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.hasSignal).toBe(true);
    const [stored] = await testDb.db.select().from(analysisParts).where(eq(analysisParts.id, chunk.id));
    expect(stored).toMatchObject({ status: "complete", attempts: 1, error: null });
  });

  it("answers 409 for the synthesis before the chunks are done", async () => {
    const { analysisId, parts } = await startedRun();
    const synthesis = parts.find((part) => part.kind === "synthesis");
    if (synthesis === undefined) throw new Error("no synthesis");
    const response = await call(analysisId, synthesis.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("answers a failed part as it is unless the body asks for a Retry", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { analysisId, parts } = await startedRun();
    const chunk = parts[0];
    if (chunk === undefined) throw new Error("no chunk");
    await testDb.db
      .update(analysisParts)
      .set({ status: "failed", attempts: 1, error: "Claude took too long to answer." })
      .where(eq(analysisParts.id, chunk.id));

    for (const body of [undefined, "{}", JSON.stringify({ retry: false })]) {
      const response = await call(analysisId, chunk.id, ORIGIN, body);
      expect(response.status).toBe(200);
      expect(RunSchema.parse(await response.json()).data.parts[0]).toMatchObject({ status: "failed" });
    }
    expect(mocks.getAnthropic).not.toHaveBeenCalled();

    // A Retry needs Claude; the key is missing here, so CONFIG and nothing changed.
    const retried = await call(analysisId, chunk.id, ORIGIN, JSON.stringify({ retry: true }));
    expect(retried.status).toBe(500);
    expect(mocks.getAnthropic).toHaveBeenCalledTimes(1);
    const [stored] = await testDb.db.select().from(analysisParts).where(eq(analysisParts.id, chunk.id));
    expect(stored).toMatchObject({ status: "failed", attempts: 1 });
    consoleError.mockRestore();
  });

  it("refuses a body with unknown keys or a non-boolean retry", async () => {
    const { analysisId, parts } = await startedRun();
    for (const body of [JSON.stringify({ retry: "yes" }), JSON.stringify({ force: true }), "[]"]) {
      const response = await call(analysisId, parts[0]?.id ?? "", ORIGIN, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request", async () => {
    const { analysisId, parts } = await startedRun();
    mocks.requireSession.mockClear();
    const response = await call(analysisId, parts[0]?.id ?? "", "https://evil.example");
    expect(response.status).toBe(403);
    expect(mocks.requireSession).not.toHaveBeenCalled();
  });
});
