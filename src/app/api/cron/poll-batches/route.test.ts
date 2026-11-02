import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError, CONFIG_ERROR_MESSAGE } from "@/lib/result";

// Wiring and authentication only: runBatchPoll has its own tests.

const SECRET = "fake-cron-secret-0123456789";
const SUMMARY = { batches: 1, processed: 3, tagged: 2, failed: 1, pending: 0, errors: [] };

const mocks = vi.hoisted(() => ({
  cronEnv: vi.fn(),
  runBatchPoll: vi.fn(),
  getDb: vi.fn(() => ({ fake: "db" })),
  getAnthropic: vi.fn(),
}));
vi.mock("@/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/env")>()),
  cronEnv: mocks.cronEnv,
}));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/ai/client", () => ({ getAnthropic: mocks.getAnthropic }));
vi.mock("@/server/services/batches", () => ({ runBatchPoll: mocks.runBatchPoll }));

const route = await import("./route");

beforeEach(() => {
  mocks.cronEnv.mockReset();
  mocks.cronEnv.mockReturnValue({ CRON_SECRET: SECRET });
  mocks.runBatchPoll.mockReset();
  mocks.runBatchPoll.mockResolvedValue(SUMMARY);
});

function call(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return route.GET(new Request("http://localhost:3000/api/cron/poll-batches", { headers }));
}

describe("GET /api/cron/poll-batches", () => {
  it("allows the Hobby maximum of 300 s for applying results", () => {
    expect(route.maxDuration).toBe(300);
  });

  it.each([
    ["no Authorization header", undefined],
    ["a wrong secret", "Bearer not-the-secret-at-all"],
    ["the secret without the Bearer scheme", SECRET],
    ["a secret with a prefix of the right one", `Bearer ${SECRET.slice(0, -1)}`],
  ])("answers 401 for %s without polling", async (_label, header) => {
    const response = await call(header);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Missing or wrong cron secret." },
    });
    expect(mocks.runBatchPoll).not.toHaveBeenCalled();
  });

  it("polls with the right secret and returns the summary", async () => {
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: SUMMARY });
    expect(mocks.runBatchPoll).toHaveBeenCalledWith({
      db: { fake: "db" },
      anthropic: mocks.getAnthropic,
      // A hung Batches API must not hold the function until its 300 s limit.
      requestTimeoutMs: 60_000,
    });
  });

  it("answers 500 without detail when CRON_SECRET is not configured", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.cronEnv.mockImplementation(() => {
      throw new AppError("CONFIG", "Invalid server configuration (cron): CRON_SECRET is required.", {
        variables: ["CRON_SECRET"],
      });
    });

    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: { code: "CONFIG", message: CONFIG_ERROR_MESSAGE } });
    expect(mocks.runBatchPoll).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("answers with the first batch failure's status and keeps the counts of the batches that were applied", async () => {
    const failure = { code: "AI_TIMEOUT", message: "Batch msgbatch_x could not be checked: Claude did not answer in time." };
    const summary = { ...SUMMARY, pending: 1, errors: [failure, { code: "AI_UNAVAILABLE", message: "Overloaded." }] };
    mocks.runBatchPoll.mockResolvedValueOnce(summary);

    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(504);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, error: failure, data: summary });
  });

  it("passes a polling failure on with its status", async () => {
    mocks.runBatchPoll.mockRejectedValueOnce(new AppError("AI_UNAVAILABLE", "Claude is overloaded right now."));
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "AI_UNAVAILABLE" } });
  });
});
