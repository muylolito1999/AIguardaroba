import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ShoppingAdviceRunSchema } from "@/components/shopping/advice-model";
import { HAMBURG } from "@/lib/climate/hamburg";
import { analyses, climateProfiles } from "@/lib/db/schema";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";
import { SHOPPING_ADVICE_OFF_MESSAGE } from "@/server/services/shopping-advice";

import { makeTestDb, type TestDb } from "../../../../../test/db";
import { createFakeAnthropic, fakeMessage, type FakeAnthropic } from "../../../../../test/fakes/anthropic";
import { fakeShoppingAdviceReply } from "../../../../../test/outfit-fixtures";
import { makeRelocationResult } from "../../../../../test/relocation-fixtures";

// Wiring only: runShoppingAdvice has its own tests. The flag is mocked; with
// it off the route must answer 404 before it reads the body, the database or
// the API key.

const ORIGIN = "http://localhost:3000";
const URL_PATH = `${ORIGIN}/api/shopping/advice`;

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  flagsEnv: vi.fn(),
  getDb: vi.fn(),
  getAnthropic: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/ai/client", () => ({ getAnthropic: mocks.getAnthropic }));
vi.mock("@/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/env")>()),
  flagsEnv: mocks.flagsEnv,
}));

const route = await import("./route");

const ErrorSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) });
const RunAnswerSchema = z.object({ ok: z.literal(true), data: ShoppingAdviceRunSchema });

let testDb: TestDb;
let fake: FakeAnthropic;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  mocks.flagsEnv.mockReset();
  mocks.flagsEnv.mockReturnValue({ FEATURE_SHOPPING_AI: true });
  mocks.getDb.mockReset();
  mocks.getDb.mockReturnValue(testDb.db);
  fake = createFakeAnthropic();
  mocks.getAnthropic.mockReset();
  mocks.getAnthropic.mockReturnValue(fake);
});

afterAll(async () => {
  await testDb.close();
});

function post(body: string | undefined, headers: Record<string, string> = { origin: ORIGIN }): Promise<Response> {
  return route.POST(
    new Request(URL_PATH, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }),
    { params: Promise.resolve({}) },
  );
}

/** Hamburg, a finished relocation run with one gap and a €600 budget: one candidate to rank. */
async function seedOneCandidate(): Promise<void> {
  await testDb.db.insert(climateProfiles).values(HAMBURG);
  const result = makeRelocationResult([randomUUID()]);
  await testDb.db.insert(analyses).values({
    kind: "relocation",
    status: "complete",
    model: "claude-sonnet-5-5",
    promptVersion: "reloc-v4",
    params: { purchaseBudgetEur: 600 },
    result: { ...result, gaps: result.gaps.slice(0, 1) },
    completedAt: new Date("2026-11-01T10:00:00Z"),
  });
}

describe("POST /api/shopping/advice", () => {
  it("answers 404 with FEATURE_SHOPPING_AI off, before reading the body, the database or the key", async () => {
    mocks.flagsEnv.mockReturnValue({ FEATURE_SHOPPING_AI: false });

    for (const body of ["{}", '{"force":true}', "not json", '{"unexpected":1}']) {
      const response = await post(body);
      expect(response.status).toBe(404);
      const answer = ErrorSchema.parse(await response.json());
      expect(answer.error).toEqual({ code: "NOT_FOUND", message: SHOPPING_ADVICE_OFF_MESSAGE });
    }
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request and a missing session first", async () => {
    expect((await post("{}", { origin: "https://evil.example" })).status).toBe(403);

    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Your session has ended. Sign in again."));
    expect((await post("{}")).status).toBe(401);
    expect(mocks.flagsEnv).not.toHaveBeenCalled();
  });

  it("validates the body once the flag is on", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post('{"force":"yes"}')).status).toBe(400);
    expect((await post('{"other":true}')).status).toBe(400);
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("ranks the candidates and answers the new state; an empty body counts as {}", async () => {
    await seedOneCandidate();
    fake.enqueue(fakeMessage({ json: fakeShoppingAdviceReply(["c1"]), model: "claude-sonnet-5-5" }));

    const response = await post(undefined);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const answer = RunAnswerSchema.parse(await response.json());
    expect(answer.data.outcome).toBe("ran");
    expect(answer.data.state.latest?.recommendations).toHaveLength(1);
    expect(fake.remaining()).toBe(0);

    // Unchanged inputs: the stored advice comes back without a call; force calls again.
    const reused = RunAnswerSchema.parse(await (await post("{}")).json());
    expect(reused.data.outcome).toBe("reused");
    fake.enqueue(fakeMessage({ json: fakeShoppingAdviceReply(["c1"]), model: "claude-sonnet-5-5" }));
    const forced = RunAnswerSchema.parse(await (await post('{"force":true}')).json());
    expect(forced.data.outcome).toBe("ran");
    expect(fake.requests).toHaveLength(2);
  });

  it("answers VALIDATION when there is nothing to rank", async () => {
    await testDb.db.insert(climateProfiles).values(HAMBURG);

    const response = await post("{}");

    expect(response.status).toBe(400);
    expect(ErrorSchema.parse(await response.json()).error.code).toBe("VALIDATION");
    expect(mocks.getAnthropic).not.toHaveBeenCalled();
  });

  it("hides the details of a missing API key (D-053)", async () => {
    await seedOneCandidate();
    mocks.getAnthropic.mockImplementation(() => {
      throw new AppError("CONFIG", "ANTHROPIC_API_KEY is required.");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post("{}");

    expect(response.status).toBe(500);
    expect(ErrorSchema.parse(await response.json()).error).toEqual({ code: "CONFIG", message: CONFIG_ERROR_MESSAGE });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    expect(await testDb.db.select().from(analyses).where(eq(analyses.kind, "shopping"))).toEqual([]);
  });
});
