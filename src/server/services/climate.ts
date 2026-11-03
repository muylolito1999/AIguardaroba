import "server-only";

import { and, asc, desc, eq, ne } from "drizzle-orm";

import { ClimateProfileUpdateSchema, type ClimateProfileUpdate } from "@/components/climate/climate-model";
import { requireSession } from "@/lib/auth/dal";
import { BOLOGNA, BOLOGNA_COMPLETED_NOTES } from "@/lib/climate/bologna";
import { hasCompleteMonths } from "@/lib/climate/types";
import type { Db } from "@/lib/db/client";
import { climateProfiles, type ClimateProfile } from "@/lib/db/schema";
import { isUuid } from "@/lib/items/contracts";
import type { ClimateProfileDto } from "@/lib/relocation/contracts";
import { AppError } from "@/lib/result";

// The climate profiles behind /settings/climate and the relocation form.
//
// Seed interplay (D-057): `pnpm db:seed` restores Hamburg's reference values
// and makes Hamburg the only default on every run, and it never touches an
// existing Bologna row. Edits made here to Hamburg, and a different default,
// therefore last until the next seed; the editor says so.

function toDto(row: ClimateProfile): ClimateProfileDto {
  return {
    id: row.id,
    slug: row.slug,
    city: row.city,
    country: row.country,
    source: row.source,
    isDefault: row.isDefault,
    isPlaceholder: row.isPlaceholder,
    complete: hasCompleteMonths(row.months),
    months: row.months,
    windNotes: row.windNotes,
    notes: row.notes,
  };
}

function notFound(id: string): AppError {
  return new AppError("NOT_FOUND", "That climate profile no longer exists.", { profileId: id });
}

/** Every profile: the default first, then by city. */
export async function listClimateProfiles(db: Db): Promise<ClimateProfileDto[]> {
  await requireSession();
  const rows = await db
    .select()
    .from(climateProfiles)
    .orderBy(desc(climateProfiles.isDefault), asc(climateProfiles.city), asc(climateProfiles.slug));
  return rows.map(toDto);
}

/** The source of a placeholder profile once the owner has filled in every value (D-169). */
export const OWNER_ENTERED_SOURCE = "Monthly values entered by the owner in Settings, Climate profiles.";

/**
 * Saves the 12 months and both notes. A placeholder profile stops being one
 * once every value of every month is filled in; an edit never makes a profile
 * a placeholder again (clearing a value later leaves it unknown, not invented).
 * The save that clears the mark also replaces the placeholder source, and
 * Bologna's seeded notes if they are still as seeded, because both reach the
 * relocation prompt and would call the completed data a placeholder (D-169).
 */
export async function updateClimateProfile(db: Db, input: ClimateProfileUpdate): Promise<ClimateProfileDto> {
  await requireSession();
  // Validated again here: callers other than the action wrapper must not write unchecked months.
  const parsed = ClimateProfileUpdateSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION", "Some climate values are missing or invalid.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
    });
  }
  const { id, months, windNotes, notes } = parsed.data;

  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(climateProfiles).where(eq(climateProfiles.id, id)).for("update");
    if (row === undefined) throw notFound(id);
    const completesPlaceholder = row.isPlaceholder && hasCompleteMonths(months);
    const [updated] = await tx
      .update(climateProfiles)
      .set({
        months,
        windNotes,
        notes: completesPlaceholder && notes === BOLOGNA.notes ? BOLOGNA_COMPLETED_NOTES : notes,
        isPlaceholder: row.isPlaceholder && !completesPlaceholder,
        ...(completesPlaceholder ? { source: OWNER_ENTERED_SOURCE } : {}),
      })
      .where(eq(climateProfiles.id, id))
      .returning();
    if (updated === undefined) throw notFound(id);
    return toDto(updated);
  });
}

/**
 * Makes one profile the default the relocation form preselects. The partial
 * unique index allows a single default, so every other profile loses the flag
 * first, in the same transaction.
 */
export async function setDefaultClimateProfile(db: Db, id: string): Promise<ClimateProfileDto> {
  await requireSession();
  if (!isUuid(id)) throw notFound(id);

  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(climateProfiles).where(eq(climateProfiles.id, id)).for("update");
    if (row === undefined) throw notFound(id);
    if (row.isDefault) return toDto(row);
    await tx
      .update(climateProfiles)
      .set({ isDefault: false })
      .where(and(eq(climateProfiles.isDefault, true), ne(climateProfiles.id, id)));
    const [updated] = await tx
      .update(climateProfiles)
      .set({ isDefault: true })
      .where(eq(climateProfiles.id, id))
      .returning();
    if (updated === undefined) throw notFound(id);
    return toDto(updated);
  });
}
