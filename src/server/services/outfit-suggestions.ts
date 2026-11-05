import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import type {
  SavedSuggestionDto,
  SuggestedOutfitDto,
  SuggestionQuoteDto,
  TodaySuggestionDto,
} from "@/components/today/today-model";
import { aiSettingsEnv } from "@/env";
import { assertWithinBudget } from "@/lib/ai/budget";
import { callStructured } from "@/lib/ai/call";
import type { AnthropicLike } from "@/lib/ai/client";
import type { PricedModelId } from "@/lib/ai/models";
import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { analyses, appSettings, itemImages, items, outfits, wearLogs, type Analysis, type Item } from "@/lib/db/schema";
import { isUuid } from "@/lib/items/contracts";
import { itemDisplayName } from "@/lib/items/wardrobe";
import { outfitItemProblem, sortBySlot, type OutfitItemDto } from "@/lib/outfits/contracts";
import {
  buildSuggestionInstruction,
  buildSuggestionSnapshot,
  canSuggestOutfits,
  estimateOutfitSuggestionUsd,
  homeLocationOf,
  isEligibleForToday,
  makeOutfitSuggestionStrictSchema,
  OUTFIT_CALL_PARAMS,
  OUTFIT_PROMPT_VERSION,
  OUTFIT_SUGGESTION_COUNT,
  OUTFIT_SYSTEM_PROMPT,
  OutfitSuggestionResultSchema,
  OutfitSuggestionWireSchema,
  toCheckItems,
  type HomeLocation,
  type OutfitSuggestionResult,
  type SuggestionSnapshot,
} from "@/lib/outfits/suggestion";
import { canonicalJson, sha256Hex } from "@/lib/relocation/payload";
import { AppError, CONFIG_ERROR_MESSAGE, INTERNAL_ERROR_MESSAGE } from "@/lib/result";
import { calendarDayIn } from "@/lib/wear/contracts";
import type { WeatherSnapshot } from "@/lib/weather/open-meteo";
import { saveOutfit } from "@/server/services/outfits";
import { getHomeProfile, type HomeProfileDto } from "@/server/services/settings";
import { loadTodayWeather, type TodayWeather } from "@/server/weather";

// The /today outfit suggestions (D-038, D-039): three outfits from the items at
// home for today's forecast, chosen by Claude (MODELS.outfits) and stored as an
// analyses row of kind outfit_suggestion, then saved as outfits or logged as
// worn from the page.
//
// A suggestion costs money, so it is made only when asked and never twice by
// accident:
// - Without `force`, a request whose items, forecast day, prompt version,
//   model and home city match a stored suggestion of today answers that one
//   and calls nobody (a second click, a second tab, a page that showed
//   "Suggest outfits" before another tab made one).
// - A request is refused with CONFLICT while another one runs (its analyses
//   row is "running" and younger than the route can live), so two tabs never
//   pay for two calls at once.
// - It is refused before any paid call when the items cannot make three
//   different valid outfits, when the budget would be passed, or when the API
//   key is missing (CONFIG; nothing is written then).

/** A "running" suggestion younger than this blocks another: the route stops at 120 s, plus a margin. */
export const SUGGESTION_LEASE_MS = 130_000;
/** Longest error text stored on a failed suggestion. */
const MAX_ERROR_LENGTH = 300;

export type SuggestOutfitsDeps = {
  /** Called only once a paid call is about to be made (D-064): a reused suggestion needs no API key. */
  anthropic: () => AnthropicLike;
  /** Epoch ms by which the Claude call must be done; the route passes its start plus OUTFIT_DEADLINE_MS. */
  deadlineAt: number;
  /** Epoch ms; defaults to Date.now. */
  now?: () => number;
  /** The model; defaults to MODELS.outfits (CLAUDE_OUTFIT_MODEL, else the analysis model). */
  model?: PricedModelId;
  /** Backoff jitter and waits between attempts; tests pass instant ones. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type SuggestOutfitsOptions = { force?: boolean };

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

/** analyses.params of a suggestion: whether it was forced, and the outfit Save made from each one. */
const SuggestionParamsSchema = z.object({
  force: z.boolean().optional(),
  savedOutfitIds: z.array(z.uuid().nullable()).length(OUTFIT_SUGGESTION_COUNT).optional(),
});
type SuggestionParams = { force: boolean; savedOutfitIds: (string | null)[] };

function noSaves(): (string | null)[] {
  return Array.from({ length: OUTFIT_SUGGESTION_COUNT }, () => null);
}

function unreadable(what: string, analysisId: string, cause: unknown): AppError {
  return new AppError("INTERNAL", `The stored ${what} of outfit suggestion ${analysisId} cannot be read.`, undefined, {
    cause,
  });
}

function readParams(row: Pick<Analysis, "id" | "params">): SuggestionParams {
  const parsed = SuggestionParamsSchema.safeParse(row.params);
  if (!parsed.success) throw unreadable("settings", row.id, parsed.error);
  // A row without saves recorded (params {}) has had nothing saved from it.
  return { force: parsed.data.force ?? false, savedOutfitIds: parsed.data.savedOutfitIds ?? noSaves() };
}

function readResult(row: Pick<Analysis, "id" | "result">): OutfitSuggestionResult {
  const parsed = OutfitSuggestionResultSchema.safeParse(row.result);
  if (!parsed.success) throw unreadable("result", row.id, parsed.error);
  return parsed.data;
}

function suggestionNotFound(analysisId: string): AppError {
  return new AppError("NOT_FOUND", "That outfit suggestion no longer exists. Suggest outfits again.", { analysisId });
}

// ---------------------------------------------------------------------------
// The DTO
// ---------------------------------------------------------------------------

type ItemNow = {
  id: string;
  name: string | null;
  subcategory: string | null;
  category: Item["category"];
  status: Item["status"];
  collection: Item["collection"];
  wearCount: number;
  thumbUrl: string | null;
};

const GONE_NAME = "No longer in your wardrobe";

/** The suggestion with its items as they are now, what was saved from it and what was worn today. */
async function toTodaySuggestion(db: Db, row: Analysis, today: string): Promise<TodaySuggestionDto> {
  const result = readResult(row);
  const params = readParams(row);
  const itemIds = [...new Set(result.outfits.flatMap((outfit) => outfit.items.map((entry) => entry.itemId)))];
  const savedIds = params.savedOutfitIds.filter((id): id is string => id !== null);

  const [itemRows, wornRows, savedRows] = await Promise.all([
    itemIds.length === 0
      ? Promise.resolve<ItemNow[]>([])
      : db
          .select({
            id: items.id,
            name: items.name,
            subcategory: items.subcategory,
            category: items.category,
            status: items.status,
            collection: items.collection,
            wearCount: items.wearCount,
            thumbUrl: itemImages.blobUrl,
          })
          .from(items)
          // (item_id, kind) is unique, so the join adds at most one row per item.
          .leftJoin(itemImages, and(eq(itemImages.itemId, items.id), eq(itemImages.kind, "thumb")))
          .where(inArray(items.id, itemIds)),
    itemIds.length === 0
      ? Promise.resolve([])
      : db
          .selectDistinct({ itemId: wearLogs.itemId })
          .from(wearLogs)
          .where(and(eq(wearLogs.wornOn, today), inArray(wearLogs.itemId, itemIds))),
    savedIds.length === 0
      ? Promise.resolve([])
      : db.select({ id: outfits.id }).from(outfits).where(inArray(outfits.id, savedIds)),
  ]);
  const byId = new Map(itemRows.map((item) => [item.id, item]));
  const worn = new Set(wornRows.map((wear) => wear.itemId));
  const saved = new Set(savedRows.map((outfit) => outfit.id));

  const outfitDtos: SuggestedOutfitDto[] = result.outfits.map((outfit, index) => {
    const entries: OutfitItemDto[] = sortBySlot(outfit.items).map(({ slot, itemId }) => {
      const item = byId.get(itemId);
      if (item === undefined) {
        return {
          itemId,
          slot,
          name: GONE_NAME,
          category: null,
          thumbUrl: null,
          status: null,
          collection: null,
          wearCount: 0,
          exists: false,
        };
      }
      return {
        itemId,
        slot,
        name: itemDisplayName(item),
        category: item.category,
        thumbUrl: item.thumbUrl,
        status: item.status,
        collection: item.collection,
        wearCount: item.wearCount,
        exists: true,
      };
    });
    const savedOutfitId = params.savedOutfitIds[index] ?? null;
    return {
      index,
      title: outfit.title,
      why: outfit.why,
      rainOk: outfit.rain_ok,
      items: entries,
      // The rule the cards show: deleted, archived or moved out of clothing (D-250).
      available: entries.every((entry) => outfitItemProblem(entry) === null),
      savedOutfitId: savedOutfitId !== null && saved.has(savedOutfitId) ? savedOutfitId : null,
      wornToday: entries.length > 0 && entries.every((entry) => worn.has(entry.itemId)),
    };
  });

  return {
    analysisId: row.id,
    createdAt: row.createdAt.toISOString(),
    profileId: row.climateProfileId,
    date: result.weather.date,
    weather: result.weather,
    model: row.model,
    costUsd: row.costUsd,
    itemCount: result.meta.item_count,
    droppedCount: result.meta.dropped_count,
    outfits: outfitDtos,
  };
}

/** The newest complete suggestion for a home city and forecast day, optionally with one cache key. */
async function latestComplete(
  db: Db,
  profileId: string,
  day: string,
  cacheKey?: string,
): Promise<Analysis | undefined> {
  const [row] = await db
    .select()
    .from(analyses)
    .where(
      and(
        eq(analyses.kind, "outfit_suggestion"),
        eq(analyses.status, "complete"),
        eq(analyses.climateProfileId, profileId),
        eq(analyses.dateFrom, day),
        cacheKey === undefined ? undefined : eq(analyses.cacheKey, cacheKey),
      ),
    )
    // DESC alone would put a row without completed_at first.
    .orderBy(sql`${analyses.completedAt} DESC NULLS LAST`, desc(analyses.createdAt))
    .limit(1);
  return row;
}

/**
 * Today's suggestion for the home city: the newest complete one whose
 * forecast day is today in the home time zone. null when there is none or no
 * home city is set.
 */
export async function getTodaySuggestion(db: Db, options: { now?: Date } = {}): Promise<TodaySuggestionDto | null> {
  await requireSession();
  const profile = await getHomeProfile(db);
  if (profile === null) return null;
  const today = calendarDayIn(profile.timezone, options.now ?? new Date());
  const row = await latestComplete(db, profile.id, today);
  return row === undefined ? null : await toTodaySuggestion(db, row, today);
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

type Prepared = {
  profile: HomeProfileDto;
  today: string;
  weather: WeatherSnapshot;
  model: PricedModelId;
  items: Item[];
  snapshot: SuggestionSnapshot;
  estimateUsd: number;
  cacheKey: string;
};

/**
 * The items Claude may use today: clothing (D-249), tagged or confirmed, at
 * home or of unknown location, not on their way out. They feed both the item
 * lines and the strict check, so running gear is left out here, not later.
 */
async function eligibleItems(db: Db, home: HomeLocation): Promise<Item[]> {
  const rows = await db
    .select()
    .from(items)
    .where(
      and(
        eq(items.collection, "clothing"),
        inArray(items.status, ["tagged", "confirmed"]),
        inArray(items.location, [home, "unknown"]),
        notInArray(items.decision, ["donate", "sell"]),
        isNotNull(items.category),
      ),
    )
    .orderBy(asc(items.createdAt), asc(items.id));
  // isEligibleForToday is the rule; the query only narrows the read.
  return rows.filter((item) => isEligibleForToday(item, home));
}

function placeOf(profile: Pick<HomeProfileDto, "city" | "country">): string {
  return `${profile.city}, ${profile.country}`;
}

/**
 * Everything a suggestion for today depends on. The cache key covers the item
 * lines (wear counts included), the forecast day, the prompt version, the
 * model and the home city: a stored suggestion with the same key would be
 * asked for with the very same request.
 */
async function prepare(db: Db, today: TodayWeather, model: PricedModelId): Promise<Prepared> {
  const { profile, weather } = today;
  const home = homeLocationOf(profile.slug);
  const eligible = await eligibleItems(db, home);
  const snapshot = buildSuggestionSnapshot(eligible, weather);
  const cacheKey = sha256Hex(
    canonicalJson({
      prompt: OUTFIT_PROMPT_VERSION,
      model,
      profile: profile.id,
      day: weather.date,
      lines: snapshot.snapshotHash,
    }),
  );
  return {
    profile,
    today: today.today,
    weather,
    model,
    items: eligible,
    snapshot,
    estimateUsd: estimateOutfitSuggestionUsd(model, snapshot.lines),
    cacheKey,
  };
}

function defaultModel(): PricedModelId {
  return aiSettingsEnv().models.outfits;
}

/** What "Suggest outfits" would cost for today's forecast, for the button's description. Needs no API key. */
export async function quoteOutfitSuggestion(
  db: Db,
  today: TodayWeather,
  options: { model?: PricedModelId } = {},
): Promise<SuggestionQuoteDto> {
  await requireSession();
  const prepared = await prepare(db, today, options.model ?? defaultModel());
  return {
    model: prepared.model,
    estimateUsd: prepared.estimateUsd,
    itemCount: prepared.snapshot.itemCount,
    droppedCount: prepared.snapshot.droppedCount,
    canSuggest: canSuggestOutfits(prepared.snapshot),
  };
}

function tooFewItems(city: string): AppError {
  return new AppError(
    "VALIDATION",
    `Three different outfits need at least two tops or dresses, and a bottom for each top, among the tagged items in ${city} or of unknown location. Tag or confirm more items first.`,
  );
}

/**
 * Adds one paid attempt's cost to the suggestion as soon as callStructured
 * logged it, as the relocation parts do (D-168, D-178): a request cut off
 * before it could finish still leaves its spend on the row. A failed write
 * only goes to the log; the attempt is in ai_calls either way.
 */
async function addSuggestionCost(db: Db, analysisId: string, usd: number): Promise<void> {
  if (usd === 0) return;
  const text = String(usd);
  try {
    await db
      .update(analyses)
      .set({ costUsd: sql`${analyses.costUsd} + round(${text}::numeric, 6)` })
      .where(eq(analyses.id, analysisId));
  } catch (error) {
    console.error(`[outfit-suggestions] could not add $${text} to the cost of ${analysisId}:`, error);
  }
}

const LEASE_INTERVAL = sql.raw(`interval '${Math.ceil(SUGGESTION_LEASE_MS / 1000)} seconds'`);

/**
 * Inserts the "running" row the call is linked to, or refuses with CONFLICT
 * while another suggestion runs. The settings row is locked for the checks
 * and the insert, so two requests cannot both pass them. Without `force`,
 * a suggestion with the same cache key that another request stored after
 * this one's first look is answered instead of paying again (D-221). The
 * running check comes first: under Read Committed a run that completes
 * between the two reads then shows as complete.
 */
async function startRun(
  db: Db,
  prepared: Prepared,
  force: boolean,
): Promise<{ analysisId: string } | { stored: Analysis }> {
  return await db.transaction(async (tx) => {
    await tx.select({ id: appSettings.id }).from(appSettings).where(eq(appSettings.id, 1)).for("update");
    const [running] = await tx
      .select({ id: analyses.id })
      .from(analyses)
      .where(
        and(
          eq(analyses.kind, "outfit_suggestion"),
          eq(analyses.status, "running"),
          sql`${analyses.createdAt} > now() - ${LEASE_INTERVAL}`,
        ),
      )
      .limit(1);
    if (running !== undefined) {
      throw new AppError("CONFLICT", "Outfits are already being suggested in another tab or window. Try again in a minute.", {
        reason: "running",
      });
    }
    if (!force) {
      const stored = await latestComplete(tx, prepared.profile.id, prepared.weather.date, prepared.cacheKey);
      if (stored !== undefined) return { stored };
    }
    const [row] = await tx
      .insert(analyses)
      .values({
        kind: "outfit_suggestion",
        status: "running",
        climateProfileId: prepared.profile.id,
        dateFrom: prepared.weather.date,
        dateTo: prepared.weather.date,
        params: { force, savedOutfitIds: noSaves() },
        model: prepared.model,
        effort: OUTFIT_CALL_PARAMS.effort,
        promptVersion: OUTFIT_PROMPT_VERSION,
        inputSnapshotHash: prepared.snapshot.snapshotHash,
        cacheKey: prepared.cacheKey,
        estimatedCostUsd: prepared.estimateUsd,
      })
      .returning({ id: analyses.id });
    if (row === undefined) throw new Error("startRun: insert returned no row");
    return { analysisId: row.id };
  });
}

function storedError(error: unknown): string {
  const message =
    error instanceof AppError ? (error.code === "CONFIG" ? CONFIG_ERROR_MESSAGE : error.message) : INTERNAL_ERROR_MESSAGE;
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}

async function markFailed(db: Db, analysisId: string, error: unknown): Promise<void> {
  try {
    await db.update(analyses).set({ status: "failed", error: storedError(error) }).where(eq(analyses.id, analysisId));
  } catch (writeError) {
    // The caller rethrows the call's own error; this one only goes to the log.
    console.error(`[outfit-suggestions] could not record the failure of ${analysisId}:`, writeError);
  }
}

async function loadRow(db: Db, analysisId: string): Promise<Analysis> {
  const [row] = await db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (row === undefined) throw suggestionNotFound(analysisId);
  return row;
}

/**
 * Suggests three outfits for today in the home city and stores them (see the
 * top of the file for when nothing is paid). In order: today's forecast
 * (UPSTREAM when it cannot be read: never outfits without weather), the
 * eligible items, the three-outfit check (VALIDATION), the stored suggestion
 * when `force` is not set, the budget (BUDGET_EXCEEDED), the API key
 * (CONFIG), the running check (CONFLICT) and the stored suggestion once more
 * under the lock, then one Claude call at effort low
 * with the strict check, which retries unknown aliases and invalid outfits.
 * A failed call marks the row failed, with every paid attempt's cost on it,
 * and is rethrown.
 */
export async function suggestOutfits(
  db: Db,
  deps: SuggestOutfitsDeps,
  options: SuggestOutfitsOptions = {},
): Promise<TodaySuggestionDto> {
  await requireSession();
  const now = deps.now ?? Date.now;
  const force = options.force === true;

  const today = await loadTodayWeather(db, { now: new Date(now()) });
  const prepared = await prepare(db, today, deps.model ?? defaultModel());
  if (!canSuggestOutfits(prepared.snapshot)) throw tooFewItems(prepared.profile.city);

  if (!force) {
    const stored = await latestComplete(db, prepared.profile.id, prepared.weather.date, prepared.cacheKey);
    if (stored !== undefined) return await toTodaySuggestion(db, stored, prepared.today);
  }

  await assertWithinBudget(db, { estimateUsd: prepared.estimateUsd, now: new Date(now()) });
  const anthropic = deps.anthropic();
  const start = await startRun(db, prepared, force);
  if ("stored" in start) return await toTodaySuggestion(db, start.stored, prepared.today);
  const { analysisId } = start;

  try {
    const call = await callStructured({
      model: prepared.model,
      system: OUTFIT_SYSTEM_PROMPT,
      content: [
        {
          type: "text",
          text: buildSuggestionInstruction({
            weather: prepared.weather,
            place: placeOf(prepared.profile),
            lines: prepared.snapshot.lines,
          }),
        },
      ],
      wire: OutfitSuggestionWireSchema,
      strict: makeOutfitSuggestionStrictSchema(prepared.snapshot, toCheckItems(prepared.items)),
      effort: OUTFIT_CALL_PARAMS.effort,
      maxTokens: OUTFIT_CALL_PARAMS.maxTokens,
      maxTokensCeiling: OUTFIT_CALL_PARAMS.maxTokensCeiling,
      purpose: OUTFIT_CALL_PARAMS.purpose,
      deps: {
        db,
        anthropic,
        now,
        ...(deps.random === undefined ? {} : { random: deps.random }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      },
      deadlineAt: deps.deadlineAt,
      links: { analysisId },
      onAttemptCost: (usd) => addSuggestionCost(db, analysisId, usd),
    });

    const result = OutfitSuggestionResultSchema.parse({
      outfits: call.data.outfits,
      weather: prepared.weather,
      meta: {
        prompt_version: OUTFIT_PROMPT_VERSION,
        model: prepared.model,
        effort: OUTFIT_CALL_PARAMS.effort,
        item_count: prepared.snapshot.itemCount,
        dropped_count: prepared.snapshot.droppedCount,
      },
    } satisfies OutfitSuggestionResult);
    await db
      .update(analyses)
      .set({ status: "complete", result, completedAt: new Date(now()) })
      .where(eq(analyses.id, analysisId));
  } catch (error) {
    await markFailed(db, analysisId, error);
    throw error;
  }

  return await toTodaySuggestion(db, await loadRow(db, analysisId), prepared.today);
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/** A feels-like temperature as the outfit's weather range stores it, or null outside the builder's limits. */
function rangeValue(value: number): number | null {
  const rounded = Math.round(value * 10) / 10;
  return rounded >= -40 && rounded <= 50 ? rounded : null;
}

/**
 * Locks the outfit's items FOR UPDATE in id order, the order logWear and
 * undoWear take them in (D-196), so a Save, a wear and an Undo of shared
 * items queue instead of deadlocking. Two Saves of different suggestions
 * that share items queue as well, so the second reads the day's logs only
 * after the first has moved them (D-236); saveOutfit's FOR SHARE locks alone
 * let both read the same logs, and the second took them from the first.
 * Taken before saveOutfit, whose share locks this transaction then already
 * holds: two Saves that each held a share lock and then asked for the update
 * lock would wait for each other. A missing or archived item, or one moved to
 * running gear, is left to saveOutfit's check, which answers CONFLICT.
 */
async function lockOutfitItems(tx: Db, itemIds: readonly string[]): Promise<void> {
  await tx
    .select({ id: items.id })
    .from(items)
    .where(inArray(items.id, [...new Set(itemIds)]))
    .orderBy(asc(items.id))
    .for("update");
}

/**
 * When "Wore this today" on the card logged every item of the outfit with no
 * outfit on the suggestion's day, those logs become the new outfit's: the
 * outfit then reads "Worn once", and its own "Wore this today" answers
 * "Already logged" instead of counting the same wear again (D-208, D-222).
 * When only some items have such a log, they came from presses of "+1 worn
 * today", a target of their own (D-196), or another saved suggestion took
 * the shared ones first, and nothing is attached. Counts, last worn dates
 * and log ids stay, so the card's Undo still works.
 *
 * Runs under lockOutfitItems' locks, so no other request can move, undo or
 * add a log of these items before this transaction ends. The UPDATE still
 * requires each log to be as it was read (no outfit, that item and day) and
 * refuses the whole Save with CONFLICT when one is not: moving only the rest
 * would attach a wear that no longer covers every item (D-236).
 */
async function attachCardWear(
  tx: Db,
  outfitId: string,
  itemIds: readonly string[],
  day: string,
): Promise<void> {
  const loose = await tx
    .select({ id: wearLogs.id, itemId: wearLogs.itemId })
    .from(wearLogs)
    .where(and(inArray(wearLogs.itemId, [...itemIds]), eq(wearLogs.wornOn, day), isNull(wearLogs.outfitId)));
  const logged = new Set(loose.map((log) => log.itemId));
  if (!itemIds.every((id) => logged.has(id))) return;
  const moved = await tx
    .update(wearLogs)
    .set({ outfitId })
    .where(
      and(
        inArray(wearLogs.id, loose.map((log) => log.id)),
        inArray(wearLogs.itemId, [...itemIds]),
        eq(wearLogs.wornOn, day),
        isNull(wearLogs.outfitId),
      ),
    )
    .returning({ id: wearLogs.id });
  if (moved.length !== loose.length) {
    throw new AppError(
      "CONFLICT",
      "The wear logged for this outfit changed while it was being saved. Save it again.",
      { reason: "wear_changed" },
    );
  }
}

/**
 * Saves one suggested outfit as an outfit of source "ai": the title as its
 * name, the why as Claude's reason, rain_ok, and the feels-like range it was
 * chosen for. A wear the card logged that day moves to the new outfit (see
 * attachCardWear). Saving the same one again answers the outfit it made,
 * while that outfit exists, instead of a copy. CONFLICT when an item was
 * deleted, archived or moved to running gear since (D-250); NOT_FOUND for an
 * unknown suggestion or index.
 */
export async function saveSuggestedOutfit(
  db: Db,
  input: { analysisId: string; index: number },
): Promise<SavedSuggestionDto> {
  await requireSession();
  const { analysisId, index } = input;
  if (!isUuid(analysisId) || !Number.isInteger(index) || index < 0 || index >= OUTFIT_SUGGESTION_COUNT) {
    throw suggestionNotFound(analysisId);
  }

  return await db.transaction(async (tx) => {
    // Locked, so two Saves of the same outfit make one outfit.
    const [row] = await tx
      .select()
      .from(analyses)
      .where(and(eq(analyses.id, analysisId), eq(analyses.kind, "outfit_suggestion")))
      .for("update");
    if (row === undefined || row.status !== "complete") throw suggestionNotFound(analysisId);
    const result = readResult(row);
    const params = readParams(row);
    const outfit = result.outfits[index];
    if (outfit === undefined) throw suggestionNotFound(analysisId);

    const savedId = params.savedOutfitIds[index] ?? null;
    if (savedId !== null) {
      const [existing] = await tx.select({ id: outfits.id }).from(outfits).where(eq(outfits.id, savedId));
      if (existing !== undefined) return { analysisId, index, outfitId: existing.id, alreadySaved: true };
    }

    const itemIds = outfit.items.map((entry) => entry.itemId);
    await lockOutfitItems(tx, itemIds);

    let outfitId: string;
    try {
      const created = await saveOutfit(
        tx,
        {
          name: outfit.title,
          occasion: "",
          weatherMinC: rangeValue(result.weather.apparentMinC),
          weatherMaxC: rangeValue(result.weather.apparentMaxC),
          rainOk: outfit.rain_ok,
          rating: null,
          notes: "",
          items: outfit.items,
        },
        undefined,
        { source: "ai", aiReasoning: outfit.why },
      );
      outfitId = created.id;
    } catch (error) {
      // saveOutfit runs validateOutfit on the items as they are now.
      if (error instanceof AppError && error.code === "VALIDATION" && error.details?.outfitIssues !== undefined) {
        throw new AppError(
          "CONFLICT",
          "An item of this outfit was deleted, archived or moved to running gear since it was suggested, so it cannot be saved. Suggest outfits again.",
          { outfitIssues: error.details.outfitIssues },
        );
      }
      throw error;
    }

    await attachCardWear(tx, outfitId, itemIds, result.weather.date);

    const savedOutfitIds = [...params.savedOutfitIds];
    savedOutfitIds[index] = outfitId;
    await tx
      .update(analyses)
      .set({ params: { force: params.force, savedOutfitIds } })
      .where(eq(analyses.id, analysisId));
    return { analysisId, index, outfitId, alreadySaved: false };
  });
}
