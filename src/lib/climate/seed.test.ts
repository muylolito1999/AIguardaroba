import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appSettings, climateProfiles } from "@/lib/db/schema";

import { makeTestDb, type TestDb } from "../../../test/db";
import { BOLOGNA, BOLOGNA_MONTHS } from "./bologna";
import { HAMBURG } from "./hamburg";
import { ensureAppSettings, seedClimateProfiles, seedDatabase } from "./seed";

let t: TestDb;

beforeAll(async () => {
  t = await makeTestDb();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.truncateAll();
});

async function profileBySlug(slug: string) {
  const [row] = await t.db.select().from(climateProfiles).where(eq(climateProfiles.slug, slug));
  if (row === undefined) throw new Error(`profile ${slug} not found`);
  return row;
}

describe("seedDatabase", () => {
  it("is idempotent: two runs leave 2 profiles and 1 settings row", async () => {
    expect(await seedDatabase(t.db)).toEqual({
      profiles: { hamburg: "inserted", bologna: "inserted" },
      appSettings: "created",
    });
    expect(await seedDatabase(t.db)).toEqual({
      profiles: { hamburg: "updated", bologna: "kept" },
      appSettings: "kept",
    });

    expect(await t.db.select().from(climateProfiles)).toHaveLength(2);
    expect(await t.db.select().from(appSettings)).toHaveLength(1);
  });

  it("makes Hamburg the only default profile", async () => {
    await seedDatabase(t.db);
    await seedDatabase(t.db);

    const defaults = await t.db.select().from(climateProfiles).where(eq(climateProfiles.isDefault, true));
    expect(defaults.map((row) => row.slug)).toEqual(["hamburg"]);
  });

  it("stores Hamburg exactly as the seed data", async () => {
    await seedDatabase(t.db);
    const hamburg = await profileBySlug("hamburg");
    expect(hamburg).toMatchObject({
      city: HAMBURG.city,
      lat: 53.633,
      lon: 9.988,
      timezone: "Europe/Berlin",
      source: HAMBURG.source,
      notes: HAMBURG.notes,
      windNotes: HAMBURG.windNotes,
      isPlaceholder: false,
    });
    expect(hamburg.months).toEqual(HAMBURG.months);
  });

  it("stores Bologna as a placeholder with only January and July highs", async () => {
    await seedDatabase(t.db);
    const bologna = await profileBySlug("bologna");
    expect(bologna).toMatchObject({
      lat: 44.49,
      lon: 11.34,
      timezone: "Europe/Rome",
      isPlaceholder: true,
      isDefault: false,
    });
    expect(bologna.notes).toContain("hot humid summers");
    expect(bologna.notes).toContain("cold foggy winters");
    expect(bologna.notes).toContain("far fewer rainy days");

    expect(bologna.months).toHaveLength(12);
    for (const month of bologna.months) {
      const expectedTmax = month.month === 1 ? 6.5 : month.month === 7 ? 31 : null;
      expect(month, `month ${month.month}`).toEqual({
        month: month.month,
        tmax: expectedTmax,
        tmin: null,
        tmean: null,
        precip_mm: null,
        precip_days: null,
        sunshine_h: null,
        notes: null,
      });
    }
  });

  it("points the settings row at Bologna with Bologna as the default item location", async () => {
    await seedDatabase(t.db);
    const bologna = await profileBySlug("bologna");
    const [settings] = await t.db.select().from(appSettings);
    expect(settings).toMatchObject({ id: 1, homeProfileId: bologna.id, defaultItemLocation: "bologna" });
  });
});

describe("re-seeding after the owner edits", () => {
  it("keeps the owner's Bologna values and settings, and restores Hamburg", async () => {
    await seedDatabase(t.db);
    const hamburg = await profileBySlug("hamburg");

    const filled = BOLOGNA_MONTHS.map((month) => ({ ...month, tmin: 1, tmean: 3, tmax: month.tmax ?? 10 }));
    await t.db
      .update(climateProfiles)
      .set({ months: filled, notes: "owner notes" })
      .where(eq(climateProfiles.slug, BOLOGNA.slug));
    await t.db
      .update(climateProfiles)
      .set({ notes: "edited", windNotes: "" })
      .where(eq(climateProfiles.slug, HAMBURG.slug));
    await t.db.update(appSettings).set({ homeProfileId: hamburg.id, defaultItemLocation: "hamburg" });

    await seedDatabase(t.db);

    const bologna = await profileBySlug("bologna");
    expect(bologna.months).toEqual(filled);
    expect(bologna.notes).toBe("owner notes");
    expect((await profileBySlug("hamburg")).notes).toBe(HAMBURG.notes);
    const [settings] = await t.db.select().from(appSettings);
    expect(settings).toMatchObject({ homeProfileId: hamburg.id, defaultItemLocation: "hamburg" });
  });

  it("moves the default back to Hamburg if another profile took it", async () => {
    await seedDatabase(t.db);
    await t.db.update(climateProfiles).set({ isDefault: false }).where(eq(climateProfiles.slug, "hamburg"));
    await t.db.update(climateProfiles).set({ isDefault: true }).where(eq(climateProfiles.slug, "bologna"));

    await seedClimateProfiles(t.db);

    const defaults = await t.db.select().from(climateProfiles).where(eq(climateProfiles.isDefault, true));
    expect(defaults.map((row) => row.slug)).toEqual(["hamburg"]);
  });
});

describe("ensureAppSettings", () => {
  it("fails loudly when the Bologna profile is missing", async () => {
    await expect(ensureAppSettings(t.db)).rejects.toThrow(/bologna/);
    expect(await t.db.select().from(appSettings)).toEqual([]);
  });
});
