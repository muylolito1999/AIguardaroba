import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BOLOGNA } from "@/lib/climate/bologna";
import { HAMBURG } from "@/lib/climate/hamburg";
import { ensureAppSettings } from "@/lib/climate/seed";
import { appSettings, climateProfiles, type ClimateProfile } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";

// Wiring of the Home city action: session check, strict input and the
// Result shape. The service has its own tests.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: { current: undefined as unknown },
}));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db.current }));

const { setHomeProfile } = await import("./settings");

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
  const rows = await testDb.db.insert(climateProfiles).values([HAMBURG, BOLOGNA]).returning();
  const h = rows.find((row) => row.slug === "hamburg");
  if (h === undefined) throw new Error("no Hamburg");
  hamburg = h;
  await ensureAppSettings(testDb.db);
});

afterAll(async () => {
  await testDb.close();
});

describe("setHomeProfile action", () => {
  it("saves the home city and answers the settings", async () => {
    const result = await setHomeProfile({ profileId: hamburg.id });
    expect(result).toMatchObject({ ok: true, data: { homeProfileId: hamburg.id } });
    const [row] = await testDb.db.select().from(appSettings);
    expect(row?.homeProfileId).toBe(hamburg.id);
  });

  it("validates its input strictly", async () => {
    for (const input of [{ profileId: "hamburg" }, { profileId: hamburg.id, extra: true }, {}]) {
      const result = await setHomeProfile(input as { profileId: string });
      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
  });

  it("answers NOT_FOUND for an unknown profile", async () => {
    expect(await setHomeProfile({ profileId: randomUUID() })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("answers UNAUTHENTICATED without a session and changes nothing", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));
    expect(await setHomeProfile({ profileId: hamburg.id })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
    const [row] = await testDb.db.select().from(appSettings);
    expect(row?.homeProfileId).not.toBe(hamburg.id);
  });
});
