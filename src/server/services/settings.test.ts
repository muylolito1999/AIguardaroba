import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BOLOGNA } from "@/lib/climate/bologna";
import { HAMBURG } from "@/lib/climate/hamburg";
import { ensureAppSettings } from "@/lib/climate/seed";
import { appSettings, climateProfiles, type ClimateProfile } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";

const mocks = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ requireSession: mocks.requireSession }));

const { getAppSettings, getHomeCitySettings, getHomeProfile, setHomeProfile } = await import("./settings");

let testDb: TestDb;
let hamburg: ClimateProfile;
let bologna: ClimateProfile;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  mocks.requireSession.mockReset();
  mocks.requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
  const rows = await testDb.db.insert(climateProfiles).values([HAMBURG, BOLOGNA]).returning();
  const h = rows.find((row) => row.slug === "hamburg");
  const b = rows.find((row) => row.slug === "bologna");
  if (h === undefined || b === undefined) throw new Error("profiles missing");
  hamburg = h;
  bologna = b;
});

afterAll(async () => {
  await testDb.close();
});

describe("settings", () => {
  it("reads the seeded home city (Bologna) with what /today needs", async () => {
    await ensureAppSettings(testDb.db);
    expect(await getAppSettings(testDb.db)).toEqual({
      homeProfile: {
        id: bologna.id,
        slug: "bologna",
        city: "Bologna",
        country: "Italy",
        lat: BOLOGNA.lat,
        lon: BOLOGNA.lon,
        timezone: "Europe/Rome",
      },
      defaultItemLocation: "bologna",
    });
    expect((await getHomeProfile(testDb.db))?.id).toBe(bologna.id);
  });

  it("reads no home city when the row is missing or its profile was deleted", async () => {
    expect(await getAppSettings(testDb.db)).toEqual({ homeProfile: null, defaultItemLocation: null });
    await ensureAppSettings(testDb.db);
    // Deleting the profile sets the reference to null (ON DELETE SET NULL).
    await testDb.db.delete(climateProfiles).where(eq(climateProfiles.id, bologna.id));
    expect(await getHomeProfile(testDb.db)).toBeNull();
  });

  it("lists Bologna and Hamburg as the cities that can be home, by city", async () => {
    await ensureAppSettings(testDb.db);
    await testDb.db.insert(climateProfiles).values({ ...HAMBURG, slug: "oslo", city: "Oslo", country: "Norway", isDefault: false });
    expect(await getHomeCitySettings(testDb.db)).toEqual({
      homeProfileId: bologna.id,
      options: [
        { id: bologna.id, slug: "bologna", city: "Bologna", country: "Italy" },
        { id: hamburg.id, slug: "hamburg", city: "Hamburg", country: "Germany" },
      ],
    });
  });

  it("changes the home city and keeps the other settings", async () => {
    await ensureAppSettings(testDb.db);
    await testDb.db.update(appSettings).set({ defaultItemLocation: "hamburg" });

    const result = await setHomeProfile(testDb.db, hamburg.id);

    expect(result.homeProfileId).toBe(hamburg.id);
    expect(await getAppSettings(testDb.db)).toMatchObject({
      homeProfile: { id: hamburg.id, timezone: "Europe/Berlin" },
      defaultItemLocation: "hamburg",
    });
  });

  it("answers CONFIG on a database that was never seeded, and invents no settings row", async () => {
    await expect(setHomeProfile(testDb.db, hamburg.id)).rejects.toMatchObject({
      code: "CONFIG",
      message: expect.stringContaining("pnpm db:seed"),
    });
    expect(await testDb.db.select().from(appSettings)).toEqual([]);
  });

  it("refuses an unknown profile and one that cannot be home", async () => {
    await ensureAppSettings(testDb.db);
    for (const id of [randomUUID(), "not-a-uuid"]) {
      await expect(setHomeProfile(testDb.db, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const [oslo] = await testDb.db
      .insert(climateProfiles)
      .values({ ...HAMBURG, slug: "oslo", city: "Oslo", country: "Norway", isDefault: false })
      .returning();
    await expect(setHomeProfile(testDb.db, oslo?.id ?? "")).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Oslo cannot be the home city. Choose Bologna or Hamburg.",
    });
    expect((await getHomeProfile(testDb.db))?.id).toBe(bologna.id);
  });

  it("checks the session first", async () => {
    mocks.requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));
    await expect(getAppSettings(testDb.db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(getHomeCitySettings(testDb.db)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(setHomeProfile(testDb.db, hamburg.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await testDb.db.select().from(appSettings)).toEqual([]);
  });
});
