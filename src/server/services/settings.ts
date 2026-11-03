import "server-only";

import { asc, eq } from "drizzle-orm";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import type { ItemLocation } from "@/lib/db/enums";
import { appSettings, climateProfiles, type ClimateProfile } from "@/lib/db/schema";
import { isUuid } from "@/lib/items/contracts";
import { destinationLocation } from "@/lib/relocation/contracts";
import { AppError } from "@/lib/result";

// The single app_settings row (id 1): the home city /today shows the weather
// and suggests outfits for, and where new items start out. The seed creates
// the row with Bologna as home (ensureAppSettings); Settings, Home city
// changes it. Only Bologna and Hamburg can be home: an item's location names
// one of those two, and /today offers only the items at home.

/** What /today needs of the home city: where it is and its time zone. */
export type HomeProfileDto = {
  id: string;
  slug: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  /** IANA zone; "today" and the forecast day follow it. */
  timezone: string;
};

export type AppSettingsDto = {
  /** null when no home city is set (the row is missing or its profile was deleted). */
  homeProfile: HomeProfileDto | null;
  /** null only when the settings row is missing (a database `pnpm db:seed` never ran against). */
  defaultItemLocation: ItemLocation | null;
};

export type HomeCityOptionDto = { id: string; slug: string; city: string; country: string };

/** Settings, Home city: the current choice and the cities that can be home. */
export type HomeCitySettingsDto = {
  homeProfileId: string | null;
  options: HomeCityOptionDto[];
};

/** Shown wherever a home city is needed and none is set. */
export const NO_HOME_CITY_MESSAGE = "Choose your home city in Settings first.";

function toHomeProfile(row: ClimateProfile): HomeProfileDto {
  return {
    id: row.id,
    slug: row.slug,
    city: row.city,
    country: row.country,
    lat: row.lat,
    lon: row.lon,
    timezone: row.timezone,
  };
}

/** The settings row with its home profile. A missing row reads as no home city and no location. */
export async function getAppSettings(db: Db): Promise<AppSettingsDto> {
  await requireSession();
  const [row] = await db
    .select({ settings: appSettings, profile: climateProfiles })
    .from(appSettings)
    .leftJoin(climateProfiles, eq(climateProfiles.id, appSettings.homeProfileId))
    .where(eq(appSettings.id, 1));
  return {
    homeProfile: row?.profile ? toHomeProfile(row.profile) : null,
    defaultItemLocation: row?.settings.defaultItemLocation ?? null,
  };
}

/** The home city, or null when none is set. */
export async function getHomeProfile(db: Db): Promise<HomeProfileDto | null> {
  await requireSession();
  return (await getAppSettings(db)).homeProfile;
}

/** The current home city and the profiles that can be one (Bologna and Hamburg), by city. */
export async function getHomeCitySettings(db: Db): Promise<HomeCitySettingsDto> {
  await requireSession();
  const [settings, profiles] = await Promise.all([
    getAppSettings(db),
    db.select().from(climateProfiles).orderBy(asc(climateProfiles.city), asc(climateProfiles.slug)),
  ]);
  return {
    homeProfileId: settings.homeProfile?.id ?? null,
    options: profiles
      .filter((profile) => destinationLocation(profile.slug) !== null)
      .map((profile) => ({ id: profile.id, slug: profile.slug, city: profile.city, country: profile.country })),
  };
}

/**
 * Makes a climate profile the home city. NOT_FOUND for an unknown profile;
 * VALIDATION for one that cannot be home (only Bologna and Hamburg can);
 * CONFIG when the settings row is missing, as for uploads: the seed creates
 * it, with the location new items start in, which this does not invent.
 */
export async function setHomeProfile(db: Db, profileId: string): Promise<HomeCitySettingsDto> {
  await requireSession();
  const notFound = new AppError("NOT_FOUND", "That city no longer exists.", { profileId });
  if (!isUuid(profileId)) throw notFound;
  const [profile] = await db
    .select({ id: climateProfiles.id, slug: climateProfiles.slug, city: climateProfiles.city })
    .from(climateProfiles)
    .where(eq(climateProfiles.id, profileId));
  if (profile === undefined) throw notFound;
  if (destinationLocation(profile.slug) === null) {
    throw new AppError("VALIDATION", `${profile.city} cannot be the home city. Choose Bologna or Hamburg.`, {
      profileId,
    });
  }

  const updated = await db
    .update(appSettings)
    .set({ homeProfileId: profile.id })
    .where(eq(appSettings.id, 1))
    .returning({ id: appSettings.id });
  if (updated.length === 0) {
    throw new AppError("CONFIG", "The app_settings row is missing. Run `pnpm db:seed` against this database.");
  }
  return await getHomeCitySettings(db);
}
