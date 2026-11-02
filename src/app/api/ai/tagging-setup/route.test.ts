import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TaggingSetupSchema } from "@/components/add/tagging-setup-request";
import { resultSchema } from "@/lib/items/contracts";
import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../../../test/db";

// Wiring only: getTaggingSetup has its own tests.

const ORIGIN = "http://localhost:3000";

const mocks = vi.hoisted(() => ({ requireSession: vi.fn(), db: { current: undefined as unknown } }));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));

const route = await import("./route");

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await testDb.close();
});

/**
 * A fresh copy of the route. The env getters keep the first valid parse, so
 * an env override needs modules that have not read the settings yet.
 */
async function freshRoute(): Promise<typeof route> {
  vi.resetModules();
  return import("./route");
}

async function call(handler: typeof route = route) {
  const request = new Request(`${ORIGIN}/api/ai/tagging-setup`, { method: "GET" });
  return handler.GET(request, { params: Promise.resolve({}) });
}

describe("GET /api/ai/tagging-setup", () => {
  it("refuses without a session", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in to continue."));

    const response = await call();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  it("answers the setup as a Result the client schema accepts, never cached", async () => {
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const parsed = resultSchema(TaggingSetupSchema).parse(await response.json());
    expect(parsed).toMatchObject({
      ok: true,
      data: {
        model: { id: "claude-haiku-5-5", label: "Haiku 5.5" },
        budget: { budgetUsd: 20, remainingUsd: 20, resetsAt: expect.any(String) },
      },
    });
  });

  it("answers an unpriced CLAUDE_TAGGING_MODEL with a 500 and the safe CONFIG message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("CLAUDE_TAGGING_MODEL", "claude-unpriced-9");

    const response = await call(await freshRoute());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } });
    // The detail, which names the variable, stays in the server log.
    expect(consoleError).toHaveBeenCalled();
  });
});
