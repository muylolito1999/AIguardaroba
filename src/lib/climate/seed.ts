import { and, eq, inArray, ne } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { appSettings, climateProfiles } from "@/lib/db/schema";

import { BOLOGNA } from "./bologna";
import { HAMBURG } from "./hamburg";
import { ClimateProfileInputSchema, type ClimateProfileInput } from "./types";

// Idempotent: running the seed again never duplicates rows. Hamburg is the
// spec's reference data, so a re-run restores it. Bologna belongs to the owner
// once created (the climate editor fills it in), so a re-run never overwrites
// it; only a missing Bologna row is inserted.

type OnExisting = "replace" | "keep";

export const SEED_PROFILES: ReadonlyArray<{ profile: ClimateProfileInput; onExisting: OnExisting }> = [
  { profile: HAMBURG, onExisting: "replace" },
  { profile: BOLOGNA, onExisting: "keep" },
];

export type ProfileSeedOutcome = "inserted" | "updated" | "kept";
export type AppSettingsSeedOutcome = "created" | "kept";

/** Upserts the seed profiles on slug and makes the seeded default (Hamburg) the only default. */
export async function seedClimateProfiles(db: Db): Promise<Record<string, ProfileSeedOutcome>> {
  const seeds = SEED_PROFILES.map(({ profile, onExisting }) => ({
    profile: ClimateProfileInputSchema.parse(profile),
    onExisting,
  }));
  const [defaultSeed, ...otherDefaults] = seeds.filter(({ profile }) => profile.isDefault);
  if (defaultSeed === undefined || otherDefaults.length > 0) {
    throw new Error("Exactly one seed climate profile must be the default.");
  }
  const defaultSlug = defaultSeed.profile.slug;

  // Statements run one after another: a transaction holds a single connection.
  return await db.transaction(async (tx) => {
    const existingRows = await tx
      .select({ slug: climateProfiles.slug })
      .from(climateProfiles)
      .where(
        inArray(
          climateProfiles.slug,
          seeds.map(({ profile }) => profile.slug),
        ),
      );
    const existing = new Set(existingRows.map((row) => row.slug));

    // The partial unique index allows one default, so clear any other first.
    await tx
      .update(climateProfiles)
      .set({ isDefault: false })
      .where(and(eq(climateProfiles.isDefault, true), ne(climateProfiles.slug, defaultSlug)));

    const outcomes: Record<string, ProfileSeedOutcome> = {};
    for (const { profile, onExisting } of seeds) {
      const { slug, ...fields } = profile;
      const insert = tx.insert(climateProfiles).values(profile);
      if (onExisting === "replace") {
        await insert.onConflictDoUpdate({
          target: climateProfiles.slug,
          set: { ...fields, updatedAt: new Date() },
        });
        outcomes[slug] = existing.has(slug) ? "updated" : "inserted";
      } else {
        await insert.onConflictDoNothing({ target: climateProfiles.slug });
        outcomes[slug] = existing.has(slug) ? "kept" : "inserted";
      }
    }
    return outcomes;
  });
}

/**
 * Creates the single app_settings row (home profile Bologna, new items located
 * in Bologna) unless it exists; an existing row holds the owner's choices and
 * is left alone.
 */
export async function ensureAppSettings(db: Db): Promise<AppSettingsSeedOutcome> {
  const [bologna] = await db
    .select({ id: climateProfiles.id })
    .from(climateProfiles)
    .where(eq(climateProfiles.slug, BOLOGNA.slug))
    .limit(1);
  if (bologna === undefined) {
    throw new Error(`Climate profile "${BOLOGNA.slug}" is missing; run seedClimateProfiles first.`);
  }

  const created = await db
    .insert(appSettings)
    .values({ id: 1, homeProfileId: bologna.id, defaultItemLocation: "bologna" })
    .onConflictDoNothing({ target: appSettings.id })
    .returning({ id: appSettings.id });
  return created.length > 0 ? "created" : "kept";
}

/** Everything `pnpm db:seed` writes, in order. */
export async function seedDatabase(
  db: Db,
): Promise<{ profiles: Record<string, ProfileSeedOutcome>; appSettings: AppSettingsSeedOutcome }> {
  const profiles = await seedClimateProfiles(db);
  const settings = await ensureAppSettings(db);
  return { profiles, appSettings: settings };
}
