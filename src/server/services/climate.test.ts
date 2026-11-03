import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BOLOGNA, BOLOGNA_COMPLETED_NOTES, BOLOGNA_MONTHS } from "@/lib/climate/bologna";
import { HAMBURG, HAMBURG_MONTHS } from "@/lib/climate/hamburg";
import { describeClimateForPrompt } from "@/lib/climate/range";
import { seedClimateProfiles } from "@/lib/climate/seed";
import type { ClimateMonth } from "@/lib/climate/types";
import { climateProfiles } from "@/lib/db/schema";
import { AppError } from "@/lib/result";

import { makeTestDb, type TestDb } from "../../../test/db";
import { listClimateProfiles, OWNER_ENTERED_SOURCE, setDefaultClimateProfile, updateClimateProfile } from "./climate";

const requireSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/dal", () => ({ requireSession }));

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await makeTestDb();
});

beforeEach(async () => {
  await testDb.truncateAll();
  await seedClimateProfiles(testDb.db);
  requireSession.mockReset();
  requireSession.mockResolvedValue({ sub: "owner", iat: 0, exp: 0 });
});

afterAll(async () => {
  await testDb.close();
});

async function profileId(slug: string): Promise<string> {
  const [row] = await testDb.db.select({ id: climateProfiles.id }).from(climateProfiles).where(eq(climateProfiles.slug, slug));
  if (row === undefined) throw new Error(`no profile ${slug}`);
  return row.id;
}

async function row(slug: string) {
  const [found] = await testDb.db.select().from(climateProfiles).where(eq(climateProfiles.slug, slug));
  if (found === undefined) throw new Error(`no profile ${slug}`);
  return found;
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError)) throw new Error(`expected an AppError, got ${String(error)}`);
  return error;
}

/** Every Bologna value filled in, plausible and ordered. */
function completeBologna(): ClimateMonth[] {
  return BOLOGNA_MONTHS.map((month, index) => ({
    ...month,
    tmax: month.tmax ?? 10 + index,
    tmin: 1 + index,
    tmean: 5 + index,
    precip_mm: 50,
    precip_days: 7,
    sunshine_h: 120,
  }));
}

describe("the session check", () => {
  it("runs first in every exported function, before anything is read or written", async () => {
    const hamburg = await profileId("hamburg");
    const bologna = await profileId("bologna");
    const before = await row("bologna");
    requireSession.mockRejectedValue(new AppError("UNAUTHENTICATED", "Sign in again."));

    expect((await appError(listClimateProfiles(testDb.db))).code).toBe("UNAUTHENTICATED");
    expect(
      (await appError(updateClimateProfile(testDb.db, { id: bologna, months: completeBologna(), windNotes: "", notes: "" })))
        .code,
    ).toBe("UNAUTHENTICATED");
    expect((await appError(setDefaultClimateProfile(testDb.db, bologna))).code).toBe("UNAUTHENTICATED");

    expect(requireSession).toHaveBeenCalledTimes(3);
    expect(await row("bologna")).toEqual(before);
    expect((await row("hamburg")).isDefault).toBe(true);
    expect(hamburg).not.toBe(bologna);
  });
});

describe("listClimateProfiles", () => {
  it("lists the default first, then by city, with the complete flag", async () => {
    const profiles = await listClimateProfiles(testDb.db);

    expect(profiles.map((profile) => [profile.slug, profile.isDefault, profile.isPlaceholder, profile.complete])).toEqual([
      ["hamburg", true, false, true],
      ["bologna", false, true, false],
    ]);
    expect(profiles[0]?.months).toEqual(HAMBURG_MONTHS);
  });

  it("orders by city when the default moves", async () => {
    await setDefaultClimateProfile(testDb.db, await profileId("bologna"));

    expect((await listClimateProfiles(testDb.db)).map((profile) => profile.slug)).toEqual(["bologna", "hamburg"]);
  });
});

describe("updateClimateProfile", () => {
  it("saves the months and both notes, with nulls for unknown values", async () => {
    const id = await profileId("bologna");
    const months = BOLOGNA_MONTHS.map((month) => (month.month === 3 ? { ...month, tmax: 15, precip_days: 6 } : month));

    const saved = await updateClimateProfile(testDb.db, { id, months, windNotes: "  Calm, foggy winters ", notes: "Owner notes" });

    expect(saved.months[2]).toMatchObject({ month: 3, tmax: 15, tmin: null, precip_days: 6 });
    expect(saved.windNotes).toBe("Calm, foggy winters");
    expect(saved.notes).toBe("Owner notes");
    expect((await row("bologna")).months[2]).toMatchObject({ tmax: 15, precip_days: 6 });
  });

  it("keeps the placeholder flag until every value is filled in, then clears it for good", async () => {
    const id = await profileId("bologna");
    const complete = completeBologna();
    const almost = complete.map((month) => (month.month === 12 ? { ...month, sunshine_h: null } : month));

    expect((await updateClimateProfile(testDb.db, { id, months: almost, windNotes: "", notes: "" })).isPlaceholder).toBe(true);

    const filled = await updateClimateProfile(testDb.db, { id, months: complete, windNotes: "", notes: "" });
    expect(filled).toMatchObject({ isPlaceholder: false, complete: true });

    // Clearing a value again leaves it unknown; it does not make the profile a placeholder again.
    const cleared = await updateClimateProfile(testDb.db, { id, months: almost, windNotes: "", notes: "" });
    expect(cleared).toMatchObject({ isPlaceholder: false, complete: false });
    expect((await row("bologna")).isPlaceholder).toBe(false);
  });

  it("stops calling Bologna a placeholder in its source and seeded notes once the save completes it (D-169)", async () => {
    const id = await profileId("bologna");
    const seeded = await row("bologna");
    expect(seeded).toMatchObject({ source: BOLOGNA.source, notes: BOLOGNA.notes });
    const complete = completeBologna();
    const almost = complete.map((month) => (month.month === 12 ? { ...month, sunshine_h: null } : month));

    await updateClimateProfile(testDb.db, { id, months: almost, windNotes: seeded.windNotes, notes: seeded.notes });
    expect(await row("bologna")).toMatchObject({ isPlaceholder: true, source: BOLOGNA.source, notes: BOLOGNA.notes });

    const saved = await updateClimateProfile(testDb.db, { id, months: complete, windNotes: seeded.windNotes, notes: seeded.notes });
    expect(saved).toMatchObject({ isPlaceholder: false, source: OWNER_ENTERED_SOURCE, notes: BOLOGNA_COMPLETED_NOTES });
    // What a Bologna run now tells Claude: the data as complete, with the owner's description kept.
    const text = describeClimateForPrompt(await row("bologna"), [11, 12, 1]);
    expect(text).not.toMatch(/placeholder/i);
    expect(text).toContain("cold foggy winters");

    // Later saves keep what the owner writes.
    const edited = await updateClimateProfile(testDb.db, { id, months: complete, windNotes: "", notes: "My own notes." });
    expect(edited).toMatchObject({ source: OWNER_ENTERED_SOURCE, notes: "My own notes." });
  });

  it("keeps notes the owner changed while completing Bologna, and never touches Hamburg's source", async () => {
    const id = await profileId("bologna");
    const saved = await updateClimateProfile(testDb.db, { id, months: completeBologna(), windNotes: "", notes: "Foggy." });
    expect(saved).toMatchObject({ source: OWNER_ENTERED_SOURCE, notes: "Foggy." });

    const hamburg = await updateClimateProfile(testDb.db, {
      id: await profileId("hamburg"),
      months: HAMBURG_MONTHS,
      windNotes: "",
      notes: "",
    });
    expect(hamburg.source).toBe(HAMBURG.source);
  });

  it("never makes a reference profile a placeholder", async () => {
    const id = await profileId("hamburg");
    const months = HAMBURG_MONTHS.map((month) => (month.month === 1 ? { ...month, sunshine_h: null } : month));

    const saved = await updateClimateProfile(testDb.db, { id, months, windNotes: "", notes: "" });

    expect(saved).toMatchObject({ isPlaceholder: false, complete: false });
  });

  it("rejects temperatures out of order, a missing month, out-of-range values and long notes", async () => {
    const id = await profileId("bologna");
    const before = await row("bologna");
    const swapped = BOLOGNA_MONTHS.map((month) => (month.month === 1 ? { ...month, tmin: 8, tmax: 6.5 } : month));
    const meanAbove = BOLOGNA_MONTHS.map((month) => (month.month === 2 ? { ...month, tmean: 9, tmax: 8 } : month));
    const tooManyDays = BOLOGNA_MONTHS.map((month) => (month.month === 4 ? { ...month, precip_days: 32 } : month));

    for (const update of [
      { id, months: swapped, windNotes: "", notes: "" },
      { id, months: meanAbove, windNotes: "", notes: "" },
      { id, months: BOLOGNA_MONTHS.slice(0, 11), windNotes: "", notes: "" },
      { id, months: [...BOLOGNA_MONTHS.slice(1), BOLOGNA_MONTHS[0] as ClimateMonth], windNotes: "", notes: "" },
      { id, months: tooManyDays, windNotes: "", notes: "" },
      { id, months: BOLOGNA_MONTHS, windNotes: "x".repeat(2001), notes: "" },
      { id, months: BOLOGNA_MONTHS, windNotes: "", notes: "x".repeat(2001) },
    ]) {
      const error = await appError(updateClimateProfile(testDb.db, update));
      expect(error.code).toBe("VALIDATION");
      expect(error.details?.issues).toBeInstanceOf(Array);
    }
    expect(await row("bologna")).toEqual(before);
  });

  it("accepts notes of exactly 2,000 characters", async () => {
    const id = await profileId("bologna");
    const saved = await updateClimateProfile(testDb.db, { id, months: BOLOGNA_MONTHS, windNotes: "w".repeat(2000), notes: "n".repeat(2000) });
    expect(saved.notes).toHaveLength(2000);
  });

  it("says NOT_FOUND for an unknown profile", async () => {
    const error = await appError(updateClimateProfile(testDb.db, { id: MISSING_ID, months: BOLOGNA_MONTHS, windNotes: "", notes: "" }));
    expect(error.code).toBe("NOT_FOUND");
  });
});

describe("setDefaultClimateProfile", () => {
  it("moves the single default flag in one step", async () => {
    const bologna = await profileId("bologna");

    const saved = await setDefaultClimateProfile(testDb.db, bologna);

    expect(saved).toMatchObject({ slug: "bologna", isDefault: true });
    const defaults = await testDb.db.select({ slug: climateProfiles.slug }).from(climateProfiles).where(eq(climateProfiles.isDefault, true));
    expect(defaults).toEqual([{ slug: "bologna" }]);

    await setDefaultClimateProfile(testDb.db, await profileId("hamburg"));
    expect((await row("hamburg")).isDefault).toBe(true);
    expect((await row("bologna")).isDefault).toBe(false);
  });

  it("changes nothing for the profile that already is the default", async () => {
    const before = await row("hamburg");
    const saved = await setDefaultClimateProfile(testDb.db, before.id);
    expect(saved.isDefault).toBe(true);
    expect(await row("hamburg")).toEqual(before);
  });

  it("says NOT_FOUND for an unknown or malformed id and keeps the default", async () => {
    expect((await appError(setDefaultClimateProfile(testDb.db, MISSING_ID))).code).toBe("NOT_FOUND");
    expect((await appError(setDefaultClimateProfile(testDb.db, "bologna"))).code).toBe("NOT_FOUND");
    expect((await row("hamburg")).isDefault).toBe(true);
  });
});

describe("the seed afterwards (D-057)", () => {
  it("restores Hamburg's values and default, and keeps the owner's Bologna", async () => {
    const hamburg = await profileId("hamburg");
    const bologna = await profileId("bologna");
    const editedHamburg = HAMBURG_MONTHS.map((month) => (month.month === 7 ? { ...month, tmax: 30 } : month));
    await updateClimateProfile(testDb.db, { id: hamburg, months: editedHamburg, windNotes: "edited", notes: "edited" });
    await updateClimateProfile(testDb.db, { id: bologna, months: completeBologna(), windNotes: "", notes: "mine" });
    await setDefaultClimateProfile(testDb.db, bologna);

    await seedClimateProfiles(testDb.db);

    const profiles = await listClimateProfiles(testDb.db);
    expect(profiles[0]).toMatchObject({ slug: "hamburg", isDefault: true, months: HAMBURG_MONTHS });
    expect(profiles[0]?.windNotes).not.toBe("edited");
    expect(profiles[1]).toMatchObject({ slug: "bologna", isDefault: false, isPlaceholder: false, notes: "mine" });
  });
});
