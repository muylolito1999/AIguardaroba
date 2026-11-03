import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { HAMBURG } from "@/lib/climate/hamburg";
import { climateProfiles, items, type ClimateProfile } from "@/lib/db/schema";
import type { RelocationParamsInput } from "@/lib/relocation/contracts";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { TAGGED_ITEM_FIELDS } from "../../../test/factories";

// Wiring of the relocation actions: session check, strict input validation
// and the Result shape. The service behind them has its own tests; no action
// here calls Claude.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));

const actions = await import("./relocation");

let testDb: TestDb;
let hamburg: ClimateProfile;

beforeAll(async () => {
  testDb = await makeTestDb();
  mocks.db.current = testDb.db;
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  const [profile] = await testDb.db.insert(climateProfiles).values(HAMBURG).returning();
  if (profile === undefined) throw new Error("no profile");
  hamburg = profile;
});

afterAll(async () => {
  await testDb.close();
});

function params(overrides: Partial<RelocationParamsInput> = {}): RelocationParamsInput {
  return {
    climateProfileId: hamburg.id,
    dateFrom: "2026-11-03",
    dateTo: "2027-11-02",
    constraints: "Bike commute.",
    purchaseBudgetEur: 600,
    ...overrides,
  };
}

describe("relocation actions", () => {
  it("estimates without an API key and fills in the toggles' defaults", async () => {
    await testDb.db.insert(items).values({ ...TAGGED_ITEM_FIELDS, status: "confirmed", imageHash: "a".repeat(64) });
    const result = await actions.estimateRelocation(params());
    expect(result).toMatchObject({ ok: true, data: { itemCount: 1, chunkCount: 1, placeholder: false, cached: null } });
  });

  it("validates the form strictly", async () => {
    const invalid: unknown[] = [
      params({ dateFrom: "2026-02-30" }),
      params({ dateFrom: "2027-01-02", dateTo: "2027-01-01" }),
      params({ dateTo: "2030-01-01" }),
      params({ constraints: "x".repeat(2001) }),
      params({ purchaseBudgetEur: 12.5 }),
      params({ purchaseBudgetEur: -1 }),
      params({ climateProfileId: "hamburg" }),
      { ...params(), model: "claude-opus-5-5" },
    ];
    for (const input of invalid) {
      expect(await actions.estimateRelocation(input as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    expect(
      await actions.startRelocation({ params: params(), force: false, extra: true } as never),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("returns the service's own errors as results", async () => {
    expect(await actions.startRelocation({ params: params() })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", details: { reason: "no_items" } },
    });
    expect(await actions.applyAiDecisionsToUndecided({ analysisId: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await actions.setPackingItemPacked({ id: randomUUID(), packed: true })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await actions.deletePackingExtra({ id: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("rejects malformed mutation input before the service runs", async () => {
    const analysisId = randomUUID();
    const cases: Array<() => Promise<unknown>> = [
      () => actions.applyAiDecisionsToUndecided({ analysisId: "nope" }),
      () => actions.addGapsToShoppingList({ analysisId, gapKeys: [] }),
      () => actions.addGapsToShoppingList({ analysisId, gapKeys: ["x".repeat(81)] }),
      () => actions.setPackingItemPacked({ id: randomUUID(), packed: "yes" } as never),
      () => actions.addPackingExtra({ analysisId, group: "attic", label: "Box" } as never),
      () => actions.addPackingExtra({ analysisId, group: "suitcase", label: "   " }),
      () => actions.addPackingExtra({ analysisId, group: "suitcase", label: "x".repeat(121) }),
      () => actions.deletePackingExtra({ id: "row-1" }),
    ];
    for (const run of cases) {
      expect(await run()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
  });

  it("checks the session first", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Signed out."));
    const unauthenticated = { ok: false, error: { code: "UNAUTHENTICATED" } };
    expect(await actions.estimateRelocation(params())).toMatchObject(unauthenticated);
    expect(await actions.startRelocation({ params: params(), force: true })).toMatchObject(unauthenticated);
    expect(await actions.applyAiDecisionsToUndecided({ analysisId: randomUUID() })).toMatchObject(unauthenticated);
    expect(await actions.addGapsToShoppingList({ analysisId: randomUUID(), gapKeys: ["a"] })).toMatchObject(
      unauthenticated,
    );
    expect(await actions.setPackingItemPacked({ id: randomUUID(), packed: true })).toMatchObject(unauthenticated);
    expect(
      await actions.addPackingExtra({ analysisId: randomUUID(), group: "carry_on", label: "Passport" }),
    ).toMatchObject(unauthenticated);
    expect(await actions.deletePackingExtra({ id: randomUUID() })).toMatchObject(unauthenticated);
  });
});
