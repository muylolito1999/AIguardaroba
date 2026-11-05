import "server-only";

import { and, asc, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { z } from "zod";

import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { appSettings, climateProfiles, items, outfitItems, outfits, wearLogs } from "@/lib/db/schema";
import { isUuid } from "@/lib/items/contracts";
import { AppError } from "@/lib/result";
import {
  calendarDayIn,
  LogWearInputSchema,
  noonOn,
  resolveWornOn,
  UndoWearInputSchema,
  WEAR_UNDO_WINDOW_MS,
  type LogWearInput,
  type UndoWearInput,
  type WearLogResultDto,
} from "@/lib/wear/contracts";

// Wear tracking: "+1 worn today" on an item, "Wore this today" on an outfit or
// a /today suggestion, and their Undo. items.wear_count and last_worn_at are
// what the wardrobe, the item page and the AI payloads read; wear_logs keeps
// the history behind them. Both change in one transaction, with the items
// locked in id order, so two taps (or two tabs) never count a wear twice and
// never deadlock each other.

/** The handle a transaction callback gets; it runs the same queries as Db. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type WearDeps = { now: Date };

/** One item's counts after a log or an undo. */
export type WearItemCounts = WearLogResultDto["items"][number];

export type UndoWearResultDto = {
  /** The wear_logs rows this call removed (an id already gone is left out). */
  undone: string[];
  /** Every item of the removed logs with its counts after the undo. */
  items: WearItemCounts[];
};

export type RecentWearDto = {
  id: string;
  /** YYYY-MM-DD. */
  wornOn: string;
  itemId: string | null;
  outfitId: string | null;
  /** null for a wear logged on the item alone, or when the outfit was deleted since. */
  outfitName: string | null;
  /** ISO 8601. */
  createdAt: string;
};

const RECENT_WEARS_MAX = 100;

/** Plain code-unit order: lowercase uuid strings sort the way Postgres orders the uuids. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function validationError(error: z.ZodError): AppError {
  return new AppError("VALIDATION", "Some fields are missing or invalid.", {
    issues: error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

/**
 * The home climate profile's IANA time zone: "today" and the noon that
 * last_worn_at records are that zone's. Without a home profile (its profile
 * was deleted) there is no day to log against, and guessing one would date
 * wears wrongly, so the owner is asked to pick one.
 */
async function homeTimeZone(db: Tx): Promise<string> {
  const [row] = await db
    .select({ timeZone: climateProfiles.timezone })
    .from(appSettings)
    .innerJoin(climateProfiles, eq(climateProfiles.id, appSettings.homeProfileId))
    .where(eq(appSettings.id, 1));
  if (row === undefined) {
    throw new AppError("VALIDATION", "Choose your home city in Settings first.", { reason: "no_home_profile" });
  }
  return row.timeZone;
}

/**
 * Locks the items in id order (every wear transaction takes them in the same
 * order, so concurrent ones queue instead of deadlocking) and checks them
 * before anything is written, in this order: each exists (NOT_FOUND), none is
 * archived (an archived item has left the wardrobe), and, with
 * `clothingOnly`, each is clothing. `clothingOnly` is set for a wear logged as
 * an outfit (a saved outfit, or a /today card sent with asOutfit): running
 * gear never counts as part of an outfit, so a saved outfit still holding a
 * piece moved to running gear is refused until it is swapped out (D-250). A
 * wear of items on their own ("+1 worn today") takes any collection.
 */
async function lockItems(
  tx: Tx,
  itemIds: readonly string[],
  { clothingOnly }: { clothingOnly: boolean },
): Promise<void> {
  const rows = await tx
    .select({ id: items.id, status: items.status, collection: items.collection })
    .from(items)
    .where(inArray(items.id, [...itemIds]))
    .orderBy(asc(items.id))
    .for("update");
  const found = new Map(rows.map((row) => [row.id, row]));
  const missing = itemIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError(
      "NOT_FOUND",
      missing.length === 1 ? "An item no longer exists." : "Some items no longer exist.",
      { itemIds: missing },
    );
  }
  const archived = itemIds.filter((id) => found.get(id)?.status === "archived");
  if (archived.length > 0) {
    throw new AppError("VALIDATION", "Archived items cannot be logged as worn.", { itemIds: archived });
  }
  if (clothingOnly) {
    // Positive form (D-248): only clothing passes, whatever collections exist.
    const notClothing = itemIds.filter((id) => found.get(id)?.collection !== "clothing");
    if (notClothing.length > 0) {
      throw new AppError("VALIDATION", "Running gear cannot be logged as part of an outfit. Swap it out first.", {
        itemIds: notClothing,
        reason: "not_clothing",
      });
    }
  }
}

async function countsOf(db: Tx, itemIds: readonly string[]): Promise<WearItemCounts[]> {
  if (itemIds.length === 0) return [];
  const rows = await db
    .select({ id: items.id, wearCount: items.wearCount, lastWornAt: items.lastWornAt })
    .from(items)
    .where(inArray(items.id, [...itemIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return itemIds.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined
      ? []
      : [{ id, wearCount: row.wearCount, lastWornAt: row.lastWornAt === null ? null : row.lastWornAt.toISOString() }];
  });
}

/**
 * The items an outfit holds, after checking it exists. FOR SHARE keeps the
 * outfit from being edited or deleted until the wear is logged.
 */
async function outfitItemIds(tx: Tx, outfitId: string): Promise<string[]> {
  const [outfit] = await tx.select({ id: outfits.id }).from(outfits).where(eq(outfits.id, outfitId)).for("share");
  if (outfit === undefined) {
    throw new AppError("NOT_FOUND", "That outfit no longer exists.", { outfitId });
  }
  const rows = await tx
    .select({ itemId: outfitItems.itemId })
    .from(outfitItems)
    .where(eq(outfitItems.outfitId, outfitId))
    .orderBy(asc(outfitItems.itemId));
  if (rows.length === 0) {
    throw new AppError("VALIDATION", "This outfit has no items left. Add some before logging a wear.", { outfitId });
  }
  return rows.map((row) => row.itemId);
}

/**
 * Logs a wear of some items, or of an outfit (one log per item, each carrying
 * the outfit id), on `wornOn` or today in the home time zone. Idempotent per
 * item, day and target: an item that already has a log for that day and the
 * same outfit (or the same "no outfit") is reported in alreadyLogged and not
 * counted again. Each new log adds one to its item's wear_count and moves
 * last_worn_at to noon of the worn day, never backwards. The logs' created_at
 * is `deps.now`, which the Undo window is measured from.
 *
 * A wear logged as an outfit (kind "outfit", or kind "items" with asOutfit
 * from a /today card not saved yet) takes clothing only: one running item
 * refuses the whole wear with VALIDATION, reason "not_clothing", and nothing
 * is written. Items logged on their own may be running gear (D-250).
 */
export async function logWear(db: Db, input: LogWearInput, deps: WearDeps): Promise<WearLogResultDto> {
  await requireSession();
  const parsed = LogWearInputSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error);
  const request = parsed.data;
  const { now } = deps;

  return db.transaction(async (tx) => {
    const timeZone = await homeTimeZone(tx);
    const wornOn = resolveWornOn(request.wornOn, calendarDayIn(timeZone, now));

    const outfitId = request.kind === "outfit" ? request.outfitId : null;
    const itemIds = request.kind === "outfit" ? await outfitItemIds(tx, request.outfitId) : request.itemIds;
    const clothingOnly = request.kind === "outfit" || (request.kind === "items" && request.asOutfit === true);
    await lockItems(tx, itemIds, { clothingOnly });

    // Read under the item locks, so a concurrent log of the same items has
    // either committed (and is seen here) or waits for this one.
    const existing = await tx
      .select({ itemId: wearLogs.itemId })
      .from(wearLogs)
      .where(
        and(
          inArray(wearLogs.itemId, itemIds),
          eq(wearLogs.wornOn, wornOn),
          outfitId === null ? isNull(wearLogs.outfitId) : eq(wearLogs.outfitId, outfitId),
        ),
      );
    const logged = new Set(existing.map((row) => row.itemId));
    const toLog = itemIds.filter((id) => !logged.has(id));

    const logIds: string[] = [];
    if (toLog.length > 0) {
      const inserted = await tx
        .insert(wearLogs)
        .values(
          toLog.map((itemId) => ({
            itemId,
            outfitId,
            wornOn,
            weatherSnapshot: request.weather ?? null,
            createdAt: now,
          })),
        )
        .returning({ id: wearLogs.id, itemId: wearLogs.itemId });
      // RETURNING order is not guaranteed; keep the request's order.
      const idByItem = new Map(inserted.map((row) => [row.itemId, row.id]));
      for (const itemId of toLog) {
        const id = idByItem.get(itemId);
        if (id !== undefined) logIds.push(id);
      }

      const wornAt = noonOn(wornOn, timeZone).toISOString();
      await tx
        .update(items)
        .set({
          wearCount: sql`${items.wearCount} + 1`,
          // GREATEST skips a null, so a first wear sets the date, and an
          // earlier day logged late never moves it backwards.
          lastWornAt: sql`GREATEST(${items.lastWornAt}, ${wornAt}::timestamptz)`,
          // A wear is not an edit: "Last changed" on the item page stays.
          updatedAt: sql`${items.updatedAt}`,
        })
        .where(inArray(items.id, toLog));
    }

    return {
      wornOn,
      logIds,
      items: await countsOf(tx, itemIds),
      alreadyLogged: itemIds.filter((id) => logged.has(id)),
      undoUntil: new Date(now.getTime() + WEAR_UNDO_WINDOW_MS).toISOString(),
    };
  });
}

/**
 * Removes wear logs created within the last WEAR_UNDO_WINDOW_MS (by
 * `deps.now`): each removed log takes one off its item's wear_count (never
 * below 0), and last_worn_at becomes noon of the item's latest remaining
 * logged day, or null when none is left. A log already gone (undone twice, or
 * its item deleted) is skipped; when none of them is left the call answers
 * NOT_FOUND. One log older than the window refuses the whole undo.
 */
export async function undoWear(db: Db, input: UndoWearInput, deps: WearDeps): Promise<UndoWearResultDto> {
  await requireSession();
  const parsed = UndoWearInputSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error);
  const { logIds } = parsed.data;
  const { now } = deps;

  return db.transaction(async (tx) => {
    const logs = await tx
      .select({ id: wearLogs.id, itemId: wearLogs.itemId, createdAt: wearLogs.createdAt })
      .from(wearLogs)
      .where(inArray(wearLogs.id, logIds));
    if (logs.length === 0) {
      throw new AppError("NOT_FOUND", "This wear was already undone.", { logIds });
    }
    const oldestAllowed = now.getTime() - WEAR_UNDO_WINDOW_MS;
    if (logs.some((log) => log.createdAt.getTime() < oldestAllowed)) {
      throw new AppError("VALIDATION", "A wear can only be undone within 10 minutes of logging it.", {
        reason: "undo_window_passed",
      });
    }

    const itemIds = [...new Set(logs.flatMap((log) => (log.itemId === null ? [] : [log.itemId])))].sort(byCodeUnit);
    if (itemIds.length > 0) {
      // Same lock order as logWear. Archived items may still be undone.
      await tx
        .select({ id: items.id })
        .from(items)
        .where(inArray(items.id, itemIds))
        .orderBy(asc(items.id))
        .for("update");
    }

    // A concurrent undo of the same logs may have committed while this one
    // waited for the locks; only what this delete removes is counted.
    const deleted = await tx
      .delete(wearLogs)
      .where(inArray(wearLogs.id, logs.map((log) => log.id)))
      .returning({ id: wearLogs.id, itemId: wearLogs.itemId });
    if (deleted.length === 0) {
      throw new AppError("NOT_FOUND", "This wear was already undone.", { logIds });
    }

    const removedPerItem = new Map<string, number>();
    for (const log of deleted) {
      if (log.itemId !== null) removedPerItem.set(log.itemId, (removedPerItem.get(log.itemId) ?? 0) + 1);
    }
    const touched = [...removedPerItem.keys()].sort(byCodeUnit);
    if (touched.length > 0) {
      const timeZone = await homeTimeZone(tx);
      const latest = await tx
        .select({ itemId: wearLogs.itemId, lastDay: max(wearLogs.wornOn) })
        .from(wearLogs)
        .where(inArray(wearLogs.itemId, touched))
        .groupBy(wearLogs.itemId);
      const lastDayByItem = new Map(latest.map((row) => [row.itemId, row.lastDay]));
      for (const itemId of touched) {
        const removed = removedPerItem.get(itemId) ?? 0;
        const lastDay = lastDayByItem.get(itemId) ?? null;
        await tx
          .update(items)
          .set({
            wearCount: sql`GREATEST(${items.wearCount} - ${removed}, 0)`,
            lastWornAt: lastDay === null ? null : noonOn(lastDay, timeZone),
            updatedAt: sql`${items.updatedAt}`,
          })
          .where(eq(items.id, itemId));
      }
    }

    return { undone: deleted.map((log) => log.id), items: await countsOf(tx, touched) };
  });
}

/**
 * The latest wears, newest day first, of one item or of everything, with the
 * outfit's name when the wear came from one. At most RECENT_WEARS_MAX rows.
 */
export async function listRecentWears(
  db: Db,
  options: { itemId?: string; limit: number },
): Promise<RecentWearDto[]> {
  await requireSession();
  if (options.itemId !== undefined && !isUuid(options.itemId)) {
    throw new AppError("VALIDATION", "Not a valid item id.", { itemId: options.itemId });
  }
  const limit = Math.max(1, Math.min(Math.trunc(options.limit), RECENT_WEARS_MAX));
  const rows = await db
    .select({
      id: wearLogs.id,
      wornOn: wearLogs.wornOn,
      itemId: wearLogs.itemId,
      outfitId: wearLogs.outfitId,
      outfitName: outfits.name,
      createdAt: wearLogs.createdAt,
    })
    .from(wearLogs)
    .leftJoin(outfits, eq(outfits.id, wearLogs.outfitId))
    .where(options.itemId === undefined ? undefined : eq(wearLogs.itemId, options.itemId))
    .orderBy(desc(wearLogs.wornOn), desc(wearLogs.createdAt), asc(wearLogs.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    wornOn: row.wornOn,
    itemId: row.itemId,
    outfitId: row.outfitId,
    outfitName: row.outfitName,
    createdAt: row.createdAt.toISOString(),
  }));
}
