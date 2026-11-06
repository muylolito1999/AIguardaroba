// Daily outfit suggestions (D-038, D-039, D-256, D-257): which items Claude
// may use, the item lines under aliases, the style directions and history the
// prompt names, the wire schema and the strict adapter that turns Claude's
// candidates into the outfits the owner sees, the prompt and the estimate.
// Every request has two parts:
// 1. OUTFIT_SYSTEM_PROMPT: fixed text that carries the cache breakpoint.
// 2. buildSuggestionInstruction(): today's weather, the item lines, recent and
//    liked outfits, one style direction per candidate, and the task.
// Claude proposes OUTFIT_CANDIDATE_COUNT candidates; the style library
// (src/lib/outfits/style) checks, repairs, scores and picks
// OUTFIT_SUGGESTION_COUNT of them. suggestion.test.ts pins the system prompt's
// sha256 and one over the instruction template (direction briefs included)
// and the wire schema per OUTFIT_PROMPT_VERSION: an edit to either must bump
// the version, which the service's reuse check compares.
// Pure, but not client-safe: it holds the prompt, hashes with node:crypto and
// prices with the server's model table. Client code imports the stored result
// schema from suggestion-result.ts and types only from here (D-156).

import { z } from "zod";

import { computeCostUsd, estimateTextTokens } from "@/lib/ai/cost";
import type { PricedModelId } from "@/lib/ai/models";
import {
  OUTFIT_SLOTS,
  type ItemCategory,
  type ItemCollection,
  type ItemDecision,
  type ItemLocation,
  type ItemStatus,
} from "@/lib/db/enums";
import {
  MAX_ACCESSORIES,
  SLOT_CATEGORIES,
  SLOT_ORDER,
  slotForCategory,
  type OutfitCheckItem,
} from "@/lib/outfits/contracts";
import { patternClass } from "@/lib/outfits/style/color";
import { assignDirections, DIRECTION_LABELS, directionLabel, wardrobeProfile } from "@/lib/outfits/style/directions";
import { footwearKind, layerRole } from "@/lib/outfits/style/layering";
import { seedFrom } from "@/lib/outfits/style/random";
import { selectSuggestions } from "@/lib/outfits/style/select";
import {
  DIRECTION_KEYS,
  isDirectionKey,
  type Candidate,
  type DirectionKey,
  type DropReason,
  type FootwearKind,
  type HistoryEntry,
  type LayerRole,
  type SelectionReport,
  type StyleItem,
  type TasteEntry,
  type VarietyHistory,
} from "@/lib/outfits/style/types";
import { idealWarmth, isRainyDay, RAINY_DAY, seasonOf } from "@/lib/outfits/style/weather";
import { OUTFIT_SUGGESTION_COUNT, SUGGESTION_LIMITS, type SuggestedOutfit } from "@/lib/outfits/suggestion-result";
import { destinationLocation } from "@/lib/relocation/contracts";
import { canonicalJson, itemLineBody, sanitizeLineValue, sha256Hex, type SnapshotItemInput } from "@/lib/relocation/payload";
import { AppError } from "@/lib/result";
import { calendarDayIn } from "@/lib/wear/contracts";
import { describeWeatherForPrompt, type WeatherSnapshot } from "@/lib/weather/open-meteo";

export {
  OUTFIT_SUGGESTION_COUNT,
  OutfitSuggestionResultSchema,
  SUGGESTION_LIMITS,
  type OutfitSuggestionResult,
  type SuggestedOutfit,
} from "@/lib/outfits/suggestion-result";
// The weather helpers moved to the client-safe style library (D-256); they are
// re-exported so existing importers keep working.
export { idealWarmth, isRainyDay, RAINY_DAY } from "@/lib/outfits/style/weather";

export const OUTFIT_PROMPT_VERSION = "outfit-v3";

/** Candidate outfits Claude proposes, one per style direction; the selection keeps OUTFIT_SUGGESTION_COUNT of them. */
export const OUTFIT_CANDIDATE_COUNT = 5;

/** Lines per request: about 50 estimated tokens each with the style fields, so at most about 20K input tokens. */
export const MAX_SUGGESTION_ITEMS = 400;

/** When items must be dropped, each category keeps at least this many of its best-suited ones first. */
export const MIN_KEPT_PER_CATEGORY = 10;

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** The places a home profile can stand for; only Bologna and Hamburg exist. */
export type HomeLocation = "bologna" | "hamburg";

/** The item location of the home climate profile. Any other profile is refused with VALIDATION. */
export function homeLocationOf(profileSlug: string): HomeLocation {
  const location = destinationLocation(profileSlug);
  if (location === null) {
    throw new AppError("VALIDATION", "Choose Bologna or Hamburg as the home city in Settings.", { profileSlug });
  }
  return location;
}

export type EligibilityFields = {
  status: ItemStatus;
  location: ItemLocation;
  decision: ItemDecision;
  category: ItemCategory | null;
  collection: ItemCollection;
};

/**
 * Whether Claude may put an item in today's outfits: clothing (running gear
 * and any later collection are left out, D-249), tagged or confirmed (never
 * pending or archived), at home or of unknown location, not on its way out
 * (donate or sell), and of a category some slot takes (not null, not "other",
 * which no outfit can hold).
 */
export function isEligibleForToday(item: EligibilityFields, homeLocation: HomeLocation): boolean {
  return (
    // The positive form (D-248): a collection added later is left out by default.
    item.collection === "clothing" &&
    (item.status === "tagged" || item.status === "confirmed") &&
    (item.location === homeLocation || item.location === "unknown") &&
    item.decision !== "donate" &&
    item.decision !== "sell" &&
    item.category !== null &&
    slotForCategory(item.category) !== null
  );
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** The fields a suggestion line and its style item are built from. A drizzle `Item` row fits as is. */
export type SuggestionItemInput = SnapshotItemInput & {
  /** Lowercase #rrggbb, parallel to colors; may be shorter or empty. */
  colorHex: readonly string[];
  pattern: string | null;
  fit: string | null;
  wearCount: number;
  lastWornAt: Date | string | null;
};

export type SuggestionLine = {
  /** i1..iN, dense, in snapshot order. */
  alias: string;
  itemId: string;
  category: ItemCategory;
  /** A top's layer role (layerRole); null for anything that is not a top. */
  role: LayerRole | null;
  /** A shoe's kind (footwearKind); null for anything that is not shoes. */
  feet: FootwearKind | null;
  /** The full line, starting with the alias. */
  text: string;
};

export type SuggestionSnapshot = {
  lines: SuggestionLine[];
  /** alias -> item uuid. */
  byAlias: ReadonlyMap<string, string>;
  /** item uuid -> alias. */
  aliasOfId: ReadonlyMap<string, string>;
  /** Every listed item as the style library reads it, by item uuid. */
  styleItems: ReadonlyMap<string, StyleItem>;
  itemCount: number;
  /** Items left out because there were more than MAX_SUGGESTION_ITEMS. */
  droppedCount: number;
  /** Changes exactly when a line, its alias or the set of items changes (wear counts included). */
  snapshotHash: string;
};

/** Caps on the free-text style fields a line adds, in characters. */
const STYLE_LINE_LIMITS = { pattern: 20, fit: 16 } as const;

/** Categories in the order the lines list them: by slot, the main pieces first. */
const LINE_CATEGORY_ORDER: readonly ItemCategory[] = [...new Set(SLOT_ORDER.flatMap((slot) => SLOT_CATEGORIES[slot]))];
const CATEGORY_RANK = new Map<ItemCategory, number>(LINE_CATEGORY_ORDER.map((category, index) => [category, index]));

const DAY_MS = 86_400_000;

function timeOf(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid timestamp: ${String(value)}`);
  return ms;
}

/** Midnight UTC of a YYYY-MM-DD day, in ms. */
function dayStart(day: string): number {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid day: ${day}`);
  return ms;
}

/** Never worn first, then the longest rested; ties by creation time and id. */
function compareRested(a: SuggestionItemInput, b: SuggestionItemInput): number {
  const lastA = timeOf(a.lastWornAt);
  const lastB = timeOf(b.lastWornAt);
  if (lastA !== lastB) {
    if (lastA === null) return -1;
    if (lastB === null) return 1;
    return lastA - lastB;
  }
  return (timeOf(a.createdAt) ?? 0) - (timeOf(b.createdAt) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Category in line order, then most recently worn last within it: the alias order. */
function compareLineOrder(a: SuggestionItemInput, b: SuggestionItemInput): number {
  const rank = (item: SuggestionItemInput) =>
    item.category === null ? LINE_CATEGORY_ORDER.length : (CATEGORY_RANK.get(item.category) ?? LINE_CATEGORY_ORDER.length);
  return rank(a) - rank(b) || compareRested(a, b);
}

/**
 * How badly an item suits today's weather; lower is better. Used only to
 * choose which items to leave out of a wardrobe of more than
 * MAX_SUGGESTION_ITEMS: the distance between the item's warmth and the ideal
 * for the mean feels-like temperature (an unknown warmth counts as 2), plus 1
 * when its seasons leave out today's season, minus 1 for waterproof outerwear
 * or shoes on a rainy day. Deterministic, never sent to Claude.
 */
export function weatherFitScore(
  item: Pick<SuggestionItemInput, "warmthLevel" | "seasons" | "category" | "waterproof">,
  weather: WeatherSnapshot,
): number {
  const ideal = idealWarmth((weather.apparentMinC + weather.apparentMaxC) / 2);
  const distance = item.warmthLevel === null ? 2 : Math.abs(item.warmthLevel - ideal);
  const offSeason = item.seasons.length > 0 && !item.seasons.includes(seasonOf(weather.date)) ? 1 : 0;
  const rainGear =
    isRainyDay(weather) && item.waterproof === true && (item.category === "outerwear" || item.category === "shoes") ? 1 : 0;
  return distance + offSeason - rainGear;
}

/**
 * At most MAX_SUGGESTION_ITEMS items: each category first keeps its
 * MIN_KEPT_PER_CATEGORY best-suited items (so no slot is emptied), then the
 * remaining places go to the best-suited items overall. Ties go to the
 * longest rested item, then the oldest, then the id.
 */
function keepBestSuited<T extends SuggestionItemInput>(items: readonly T[], weather: WeatherSnapshot): T[] {
  if (items.length <= MAX_SUGGESTION_ITEMS) return [...items];
  const scored = items
    .map((item) => ({ item, score: weatherFitScore(item, weather) }))
    .sort((a, b) => a.score - b.score || compareRested(a.item, b.item));
  const kept = new Set<T>();
  const perCategory = new Map<ItemCategory | null, number>();
  for (const { item } of scored) {
    const count = perCategory.get(item.category) ?? 0;
    if (count < MIN_KEPT_PER_CATEGORY) {
      kept.add(item);
      perCategory.set(item.category, count + 1);
    }
  }
  for (const { item } of scored) {
    if (kept.size >= MAX_SUGGESTION_ITEMS) break;
    kept.add(item);
  }
  return [...kept];
}

type SlottedItem = SuggestionItemInput & { category: ItemCategory };

/**
 * An item an outfit can hold: clothing (D-249), of a category some slot takes
 * (not null and not "other").
 */
function isOutfitPiece(item: SuggestionItemInput): item is SlottedItem {
  return item.collection === "clothing" && item.category !== null && slotForCategory(item.category) !== null;
}

/**
 * The style fields a line adds after the relocation body, only where they
 * say something: lay: for every top (its layerRole), feet: for every pair of
 * shoes (its footwearKind), pat: for any pattern that is not plain (whatever
 * patternClass does not read as solid, a pattern it cannot place such as
 * jacquard included, as the prompt's "when it is not plain" says), fit: for a
 * known cut.
 */
function styleSuffix(item: SlottedItem, role: LayerRole | null, feet: FootwearKind | null): string {
  const fields: string[] = [];
  if (role !== null) fields.push(`lay:${role}`);
  if (feet !== null) fields.push(`feet:${feet}`);
  if (patternClass(item.pattern) !== "solid") {
    const pattern = sanitizeLineValue(item.pattern, STYLE_LINE_LIMITS.pattern);
    if (pattern !== "?") fields.push(`pat:${pattern}`);
  }
  const fit = item.fit === null ? "?" : sanitizeLineValue(item.fit, STYLE_LINE_LIMITS.fit);
  if (fit !== "?") fields.push(`fit:${fit}`);
  return fields.map((field) => `|${field}`).join("");
}

/**
 * What the style library reads of a listed item. daysSinceWorn counts whole
 * calendar days from the last-worn day (in the forecast's time zone) to the
 * forecast's date, 0 for today and never below 0; null when never worn.
 */
function toStyleItem(item: SlottedItem, lastWornDay: string | null, forecastDay: string): StyleItem {
  return {
    id: item.id,
    category: item.category,
    subcategory: item.subcategory,
    name: item.name,
    colors: [...item.colors],
    colorHex: [...item.colorHex],
    pattern: item.pattern,
    fit: item.fit,
    materials: [...item.materials],
    formality: item.formality,
    warmthLevel: item.warmthLevel,
    waterproof: item.waterproof,
    windproof: item.windproof,
    insulated: item.insulated,
    seasons: [...item.seasons],
    condition: item.condition,
    wearCount: item.wearCount,
    daysSinceWorn:
      lastWornDay === null ? null : Math.max(0, Math.round((dayStart(forecastDay) - dayStart(lastWornDay)) / DAY_MS)),
  };
}

/**
 * The request's item lines. Pass the items isEligibleForToday accepts; an
 * item no slot can hold, or one that is not clothing (D-249), is skipped all
 * the same. Each line is the relocation line (with no destination marker,
 * D-170), then the style fields (styleSuffix: lay:, feet:, pat:, fit:), then
 * worn:N and last:YYYY-MM-DD (the calendar day in the forecast's time zone)
 * or last:never, so Claude can prefer rested items. The collection is not part
 * of a line (D-248). Aliases i1..iN follow the category order of the slots,
 * and within a category the most recently worn come last. Over
 * MAX_SUGGESTION_ITEMS, the items least suited to the weather are left out
 * (weatherFitScore) and counted. styleItems holds every listed item for the
 * selection (toStyleItem).
 */
export function buildSuggestionSnapshot(
  items: readonly SuggestionItemInput[],
  weather: WeatherSnapshot,
): SuggestionSnapshot {
  const usable = items.filter(isOutfitPiece);
  const kept = keepBestSuited(usable, weather).sort(compareLineOrder);

  const lines: SuggestionLine[] = [];
  const byAlias = new Map<string, string>();
  const aliasOfId = new Map<string, string>();
  const styleItems = new Map<string, StyleItem>();
  kept.forEach((item, index) => {
    const alias = `i${index + 1}`;
    const lastWorn = timeOf(item.lastWornAt);
    const lastDay = lastWorn === null ? null : calendarDayIn(weather.timezone, new Date(lastWorn));
    const role = layerRole(item);
    const feet = footwearKind(item);
    const text =
      `${alias}|${itemLineBody(item, null)}${styleSuffix(item, role, feet)}` +
      `|worn:${item.wearCount}|last:${lastDay ?? "never"}`;
    lines.push({ alias, itemId: item.id, category: item.category, role, feet, text });
    byAlias.set(alias, item.id);
    aliasOfId.set(item.id, alias);
    styleItems.set(item.id, toStyleItem(item, lastDay, weather.date));
  });

  return {
    lines,
    byAlias,
    aliasOfId,
    styleItems,
    itemCount: lines.length,
    droppedCount: usable.length - kept.length,
    snapshotHash: sha256Hex(canonicalJson(lines.map((line) => [line.itemId, line.text]))),
  };
}

/** The check items validateOutfit needs, keyed by id. */
export function toCheckItems(items: readonly OutfitCheckItem[]): ReadonlyMap<string, OutfitCheckItem> {
  return new Map(
    items.map((item) => [
      item.id,
      { id: item.id, category: item.category, status: item.status, collection: item.collection },
    ]),
  );
}

/** A line as the count reads it; a top without a role counts as either. */
export type CountableLine = Pick<SuggestionLine, "category"> & { role?: LayerRole | null };

/**
 * The number of distinct core combinations the selection can keep (the
 * canonical count, D-256): the selection drops an outfit whose core pieces
 * (outerwear, mid layer, top, bottom, shoes; CORE_SLOTS) repeat an earlier
 * one's, so only those pieces make another outfit. With Tb tops whose role is
 * base or either, Tm tops whose role is mid, B bottoms, D dresses, S shoes
 * and O outerwear:
 * - torso = Tb + Tb x Tm when Tb > 0 (a base top alone, or under a mid layer),
 *   else Tm (a knit or hoodie stays alone in the top slot only when the
 *   wardrobe has no base top to put under it);
 * - total = (torso x B + D x (Tm + 1) x (B + 1)) x max(S, 1) x (O + 1).
 * A dress takes a mid layer or none and a bottom or none. Shoes are added
 * whenever the wardrobe has any, so they multiply by S, not S + 1. Base
 * layers, hats, gloves, scarves, socks and accessories count as 1: another
 * one does not make another outfit. Layer pairs the check also lets through
 * (a blazer over a knit, an open shirt over a tee, an unplaced top as a mid
 * layer, a knit alone over a thermal base layer) are not counted: this is the
 * floor the service checks before paying.
 */
export function countPossibleOutfits(lines: readonly CountableLine[]): number {
  const count = (categories: readonly ItemCategory[]) => lines.filter((line) => categories.includes(line.category)).length;
  const tops = lines.filter((line) => line.category === "top");
  const midTops = tops.filter((line) => line.role === "mid").length;
  const baseTops = tops.length - midTops;
  const bottoms = count(["bottom"]);
  const torso = baseTops > 0 ? baseTops + baseTops * midTops : midTops;
  const bases = torso * bottoms + count(["dress"]) * (midTops + 1) * (bottoms + 1);
  return bases * Math.max(count(["shoes"]), 1) * (count(SLOT_CATEGORIES.outerwear) + 1);
}

/**
 * Whether OUTFIT_SUGGESTION_COUNT outfits with different core pieces exist
 * (countPossibleOutfits), so the selection can pass. The service checks this
 * before paying for a call that could never succeed.
 */
export function canSuggestOutfits(snapshot: Pick<SuggestionSnapshot, "lines">): boolean {
  return countPossibleOutfits(snapshot.lines) >= OUTFIT_SUGGESTION_COUNT;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const S = SUGGESTION_LIMITS;

/** What Claude writes: items by alias, every key required, limits stated in the descriptions (D-018, D-038). */
export const OutfitSuggestionWireSchema = z.strictObject({
  outfits: z
    .array(
      z.strictObject({
        direction: z.enum(DIRECTION_KEYS).describe("The key <directions> assigns to this outfit."),
        title: z.string().describe(`A short, specific name for the outfit, at most ${S.titleMax} characters.`),
        items: z
          .array(
            z.strictObject({
              slot: z.enum(OUTFIT_SLOTS),
              item: z.string().describe("The item's alias exactly as listed, e.g. i12."),
            }),
          )
          .describe(
            `The items worn together: one per slot, except up to ${MAX_ACCESSORIES} in accessory. ` +
              "Exactly one item in top (a top or a dress); a bottom unless the top is a dress; " +
              "a mid layer goes over the top; socks with closed shoes.",
          ),
        why: z
          .string()
          .describe(
            `Why the outfit works today: its colour story or key pairing and the weather numbers, at most ${S.whyMax} characters.`,
          ),
        rain_ok: z.boolean().describe("true only when the outfit keeps the wearer dry in rain."),
      }),
    )
    .describe(
      `Exactly ${OUTFIT_CANDIDATE_COUNT} outfits, one for each direction in <directions>, in that order; no two with the same items.`,
    ),
});
export type OutfitSuggestionWire = z.infer<typeof OutfitSuggestionWireSchema>;

/** The checked reply: the outfits the selection kept, with item uuids instead of aliases, and how it went. */
export type OutfitSuggestionStrict = { outfits: SuggestedOutfit[]; report: SelectionReport };

/** The most candidates a reply may hold before it is rejected as a whole. */
export const MAX_REPLY_CANDIDATES = 8;

const requiredText = (max: number) => z.string().trim().min(1).max(max);

/** Compared case-insensitively: the grammar does not guarantee enum casing (D-165). */
const looseSlot = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(OUTFIT_SLOTS));

/** Any string; a known direction key (after trimming and folding case) or null. */
const looseDirection = z.string().transform((value): DirectionKey | null => {
  const key = value.trim().toLowerCase();
  return isDirectionKey(key) ? key : null;
});

/** One candidate as the wire schema shapes it, checked on its own so a bad one is dropped, not the reply. */
const CandidateSchema = z.strictObject({
  direction: looseDirection,
  title: requiredText(S.titleMax),
  items: z.array(
    z.strictObject({
      slot: looseSlot,
      item: z.string().transform((value) => value.trim().toLowerCase()),
    }),
  ),
  why: requiredText(S.whyMax),
  rain_ok: z.boolean(),
});

/** The order drop reasons are named in when their counts tie: the pipeline's own order (select.ts). */
const DROP_ORDER: readonly DropReason[] = ["malformed", "unknown_alias", "invalid_outfit", "layering", "duplicate"];

/** At most this many per-candidate notes go into a rejection message. */
const MAX_DROP_NOTES = 3;

/** "2 of 5 candidates usable, 3 needed: 2 malformed, 1 layering (outfit 4: unknown alias i999)". */
function describeRejection(report: SelectionReport, notes: readonly string[]): string {
  const noun = report.received === 1 ? "candidate" : "candidates";
  const drops = DROP_ORDER.flatMap((reason) => {
    const count = report.dropped[reason] ?? 0;
    return count > 0 ? [{ reason, count }] : [];
  })
    .sort((a, b) => b.count - a.count || DROP_ORDER.indexOf(a.reason) - DROP_ORDER.indexOf(b.reason))
    .map(({ reason, count }) => `${count} ${reason}`);
  const head = `${report.usable} of ${report.received} ${noun} usable, ${OUTFIT_SUGGESTION_COUNT} needed`;
  const body = drops.length === 0 ? head : `${head}: ${drops.join(", ")}`;
  const shown = notes.slice(0, MAX_DROP_NOTES);
  return shown.length === 0 ? body : `${body} (${shown.join("; ")})`;
}

function mergeDrops(
  own: Partial<Record<DropReason, number>>,
  selection: Partial<Record<DropReason, number>>,
): Partial<Record<DropReason, number>> {
  const merged: Partial<Record<DropReason, number>> = {};
  for (const reason of DROP_ORDER) {
    const count = (own[reason] ?? 0) + (selection[reason] ?? 0);
    if (count > 0) merged[reason] = count;
  }
  return merged;
}

/**
 * The strict adapter of a reply (D-144, D-256): the reply must be an object
 * of 1 to MAX_REPLY_CANDIDATES outfits; each candidate is then checked on its
 * own. A candidate that does not fit the wire shape (title and why trimmed
 * within their limits, a slot of any case, rain_ok a boolean) is dropped as
 * malformed, one naming an alias this request did not list as unknown_alias;
 * a direction that is not a known key becomes null. The rest go to
 * selectSuggestions with the snapshot's style items, today's weather and the
 * variety history, which checks, repairs, scores and picks
 * OUTFIT_SUGGESTION_COUNT of them. Too few usable candidates is invalid
 * output, which callStructured retries; its message names the counts. The
 * parsed value names items by uuid, in slot order, with the selection's
 * report (received counts every candidate of the reply, dropped sums the
 * drops made here and in the selection).
 */
export function makeOutfitSuggestionStrictSchema(
  snapshot: Pick<SuggestionSnapshot, "byAlias" | "styleItems">,
  checkItems: ReadonlyMap<string, OutfitCheckItem>,
  selection: { weather: WeatherSnapshot; history: VarietyHistory },
): z.ZodType<OutfitSuggestionStrict> {
  return z
    .strictObject({ outfits: z.array(z.unknown()).min(1).max(MAX_REPLY_CANDIDATES) })
    .transform((reply, ctx): OutfitSuggestionStrict => {
      const dropped: Partial<Record<DropReason, number>> = {};
      const notes: string[] = [];
      const candidates: Candidate[] = [];
      reply.outfits.forEach((raw, index) => {
        const parsed = CandidateSchema.safeParse(raw);
        if (!parsed.success) {
          dropped.malformed = (dropped.malformed ?? 0) + 1;
          const [issue] = parsed.error.issues;
          const where = issue === undefined ? "" : `${issue.path.map(String).join(".") || "<root>"}: `;
          notes.push(`outfit ${index + 1}: ${where}${issue?.message ?? "malformed"}`);
          return;
        }
        const { direction, title, why, rain_ok: rainOk, items } = parsed.data;
        const unknown = items.find((entry) => !snapshot.byAlias.has(entry.item));
        if (unknown !== undefined) {
          dropped.unknown_alias = (dropped.unknown_alias ?? 0) + 1;
          notes.push(`outfit ${index + 1}: unknown alias ${unknown.item}`);
          return;
        }
        candidates.push({
          index,
          direction,
          title,
          why,
          rain_ok: rainOk,
          entries: items.map((entry) => ({ slot: entry.slot, itemId: snapshot.byAlias.get(entry.item) ?? "" })),
        });
      });

      const result = selectSuggestions(candidates, {
        items: snapshot.styleItems,
        weather: selection.weather,
        history: selection.history,
        checkItems,
        count: OUTFIT_SUGGESTION_COUNT,
      });
      const report: SelectionReport = {
        ...result.report,
        received: reply.outfits.length,
        dropped: mergeDrops(dropped, result.report.dropped),
      };
      if (!result.ok) {
        ctx.addIssue({ code: "custom", message: describeRejection(report, notes) });
        return z.NEVER;
      }
      return {
        outfits: result.outfits.map((pick) => ({
          title: pick.title,
          why: pick.why,
          rain_ok: pick.rain_ok,
          items: pick.entries.map((entry) => ({ slot: entry.slot, itemId: entry.itemId })),
          ...(pick.direction === null ? {} : { direction: pick.direction }),
        })),
        report,
      };
    });
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export const OUTFIT_SYSTEM_PROMPT = `You are an experienced personal stylist inside a wardrobe app. Each morning the owner asks what to wear today. You get today's forecast for the owner's city, the clothes they own and have at hand as compact lines under short aliases, what they have worn and been offered lately, and one style direction for each outfit. You answer with exactly ${OUTFIT_CANDIDATE_COUNT} outfits built only from those items, in the required JSON format. The app checks them and shows the owner the best ${OUTFIT_SUGGESTION_COUNT}, each as a card they can save or log as worn, so every outfit must be complete, wearable exactly as listed and worth wearing on its own.

HOW A STYLIST WORKS
Build each outfit around one idea: a colour story, a key piece or a silhouette, never a random pick per slot. Start from the anchor its direction suggests (a coat, a knit, a pair of trousers, a dress), then choose every other piece to support it. An outfit should look intentional from head to toe: the pieces agree on formality, the colours relate, the proportions balance, and the shoes finish the look instead of merely filling the slot.

DRESSING FOR THE WEATHER
Dress for how the day feels, not for the air temperature alone. The feels-like (apparent) temperature already includes wind and humidity: its low end describes the morning and evening commute, its high end the warmest hours.
- Feels-like bands, as a guide:
  below 0 °C, freezing: a warm or insulated outer layer over a mid layer, a base layer when there is one, hat, gloves and scarf, warm closed shoes.
  0 to 5 °C, cold: a warm coat, or a shell over a knit or fleece, plus hat and gloves.
  5 to 10 °C, chilly: a jacket over a knit or a long-sleeved top; a scarf helps in wind.
  10 to 15 °C, cool: a light jacket, or a knit over a shirt or tee, in layers that come off during the day.
  15 to 20 °C, mild: a light layer for the morning and evening, or none.
  above 20 °C, warm: light, breathable clothes; no outerwear unless it rains.
- A wide range (more than about 8 °C between the low and the high) calls for layers that come off: dress for the low end and choose an outer layer that is easy to carry.
- Rain: a ${RAINY_DAY.probability} % or higher chance of precipitation, or ${RAINY_DAY.sumMm} mm or more in the day, calls for rain gear: a waterproof outer layer, ideally with a hood, and waterproof shoes when the wardrobe has them. Below that, a layer that sheds a shower is enough.
- Wind: gusts of about 40 km/h or more make it feel colder and wreck umbrellas, so prefer windproof outer layers and a hat that stays on; 60 km/h or more is stormy.
- Snow or freezing rain: warm, waterproof shoes with grip.

BUILDING AN OUTFIT
- Slots: outerwear, mid_layer, base_layer, top, bottom, socks, shoes, hat, gloves, scarf and accessory. Each slot takes one item, except accessory, which takes up to ${MAX_ACCESSORIES}.
- The slot must match the item's category: outerwear in outerwear, top in mid_layer, base_layer in base_layer, top and dress in top, bottom in bottom, socks in socks, shoes in shoes, hat_beanie in hat, gloves in gloves, scarf in scarf, accessory and bag in accessory.
- Every outfit has exactly one item in the top slot. With a top, add a bottom. A dress goes in the top slot and needs no bottom; a bottom with it is optional, and tights or leggings under it go in base_layer.
- Always add shoes when the wardrobe has any. Add outerwear, a mid layer, a base layer, hat, gloves and scarf when the weather or the look calls for them.

LAYERING
Dress from the skin outwards: base_layer (thermals, under everything on cold days), top (the piece against the body that shows: a t-shirt, long-sleeve tee, polo, shirt or blouse), mid_layer (a knit, cardigan, hoodie, sweatshirt, fleece, overshirt or blazer worn over the top) and outerwear (a coat, jacket or shell).
- A hoodie, sweatshirt, sweater, cardigan, fleece or blazer is a mid layer: put it in mid_layer over a t-shirt, shirt or other base top in top. Nobody wears a hoodie or a wool sweater on bare skin, so leave a knit alone in the top slot only when the wardrobe has no t-shirts or shirts.
- Classic pairings: a shirt collar under a crew-neck knit, a plain tee under a hoodie or cardigan, an open shirt or overshirt over a t-shirt, a blazer over a shirt or a fine knit.
- Never put a t-shirt over another top, or one mid layer over another; the one exception is a blazer over a fine knit.
- The lay: field gives each top's role: base (worn underneath), mid (worn over a top) or either.
- Layers make an outfit adaptable: on a day with a wide range, a knit or cardigan that comes off beats one heavy piece.

FEET
- Closed shoes (trainers, boots, derbies, brogues) always get socks when the wardrobe has any: add a pair in the socks slot. Match them to the shoes and the day: dress socks with smart shoes, sports socks with trainers, wool socks on cold days, in a colour that tones with the trousers or the shoes.
- Never put socks with sandals or slides. Loafers, espadrilles and ballet flats can go without socks on warm days; with long trousers on a cool day, add socks.
- The feet: field gives each shoe's kind: closed, sockless or open.

COLOUR
- Give each outfit a colour story you could name: tonal (shades of one colour), neutrals with one accent, neighbouring colours (navy and teal, rust and mustard), or one deliberate contrast.
- Neutrals (black, white, grey, navy, denim, beige, camel, brown, olive, cream) are the base: two or three of them carry an outfit, and one accent colour lifts it. Keep to about three colours across the visible pieces, neutrals included.
- Repeat a colour once: a scarf that picks up the shirt, shoes that match the bag. That echo is what makes an outfit look put together.
- Balance light and dark: a light top over dark trousers, or the reverse, reads cleaner than one flat mid-tone, unless the look is deliberately tonal.
- Earth tones (camel, rust, olive, brown, cream) go together; cool colours (navy, grey, icy blue, burgundy) go together; bridge the two through a neutral.
- Keep leathers in one family where you can: brown shoes with a brown belt or bag, black with black.
- Avoid two strong colours that compete, such as bright red with bright green or orange with purple, unless the direction asks for it.

PATTERN, TEXTURE AND PROPORTION
- At most one bold pattern (stripes, checks, florals, graphics) per outfit, set against plain pieces that share one of its colours. Textures (cable knit, corduroy, tweed, suede, ribbing, denim) add depth without noise; two or three of them make a neutral outfit look rich.
- Balance the silhouette: a relaxed or oversized top with slimmer or straight trousers, a fitted top with wider trousers; avoid baggy on baggy and tight on tight unless the look is built on it. The fit: field gives the cut when it is known.
- Match weights: a chunky knit wants sturdy trousers and shoes; a fine shirt wants lighter ones.

FORMALITY
- Keep formality consistent: pieces within one step of each other on the scale athletic, casual, smart_casual, business, formal. Clean leather trainers with jeans and a blazer is a modern smart-casual look; running shoes with wool trousers is not.
- Athletic pieces belong to sporty looks, not with tailoring.
- Accessories with restraint: a bag, a belt or a cap that serves the look or the weather; never add accessories only because there is room.

VARIETY
- The ${OUTFIT_CANDIDATE_COUNT} outfits must be real alternatives, each following its own style direction: change the anchor piece, the colour story and the silhouette, not just one item. Spread the wardrobe: do not build every outfit on the same coat, the same jeans or the same shoes when others suit the day. No two outfits may use exactly the same items.
- <recent>, when present, lists outfits suggested or worn in the last days, newest first, by today's aliases. Do not repeat their core (the same top, mid layer, bottom, outerwear and shoes together); one shared piece in a new combination is fine.
- <liked>, when present, lists outfits the owner saved or rated highly, and <disliked> those rated low: lean towards the colours, pieces and formality of the liked ones and away from the disliked ones, without copying a liked outfit outright.
- The weather comes first: never pick an unsuitable item only for variety.

STYLE DIRECTIONS
<directions> assigns one direction to each outfit, in order. Make it the outfit's guiding idea and set the outfit's direction field to its key. When the wardrobe cannot fully deliver a direction, build the closest honest version rather than breaking the weather or layering rules.

WEAR HISTORY
Each line ends with worn:N, how many times the item was logged as worn (one day can count more than once), and last:, the day it was last worn, or never. Prefer items that have rested: avoid the pieces worn in the last day or two, and bring in items worn rarely or never when they suit the weather. The weather comes first: never pick an unsuitable item only because it has rested.

ITEM LINES
Each item is one line of |-separated fields:
alias|category/subcategory|colours (dominant first)|materials (main first)|warmth|weather flags|seasons|formality|condition|tag status|name|optional lc:codes|optional lay:, feet:, pat: and fit:|worn:N|last:day
- alias: the item's id in this request, such as i12. Use only the aliases listed. Never invent items, aliases or attributes.
- warmth: w1 summer weight, w2 light layer, w3 mid layer, w4 warm, w5 heavy winter.
- weather flags: wp waterproof, wd windproof, ins insulated, br breathable; 1 yes, 0 no.
- seasons: the seasons the item suits; all = all four.
- condition: new, good, worn or needs_repair; leave needs_repair items out when there is an alternative.
- tag status: confirmed = checked by the owner; tagged = automatic tags the owner has not checked yet.
- lc: lists tags the automatic tagging was unsure about (cat category, col colours, mat materials, w warmth, wp waterproof, wd windproof, ins insulated, form formality, cond condition). They may be wrong, so lean on the name and the other fields.
- lay: a top's layer role (base, mid or either). feet: a shoe's kind (closed, sockless or open). pat: the pattern, when it is not plain. fit: the cut, such as slim, regular, relaxed or oversized.
- ? = unknown. Long names and lists are shortened.

WRITING
- direction: the key <directions> assigns to the outfit.
- title: a short, specific name, at most ${S.titleMax} characters, such as "Navy layers for a drizzly commute" or "Camel and cream with a rust accent".
- why: at most ${S.whyMax} characters. Say why the outfit works today: name its colour story or key pairing, and cite the weather numbers that matter (feels-like temperatures, rain chance, gusts). Mention a rested item when that is why you chose it. No aliases in the text.
- rain_ok: true only when the outfit would keep the owner dry in rain, with a waterproof outer layer or at least waterproof shoes and a layer that sheds a shower; otherwise false.
- Plain English and metric units. Every field of the format is required.`;

/**
 * One line per style direction, in the instruction's <directions> block after
 * the key and its label (DIRECTION_LABELS). Part of the pinned templates.
 */
export const DIRECTION_BRIEFS: Readonly<Record<DirectionKey, string>> = {
  tonal_neutrals: "two or three neutrals in close shades (greys, navy, camel, cream), made interesting by texture rather than colour.",
  dark_monochrome: "black, charcoal and deep navy from head to toe, with one texture or a lighter shoe so it never looks flat.",
  light_and_airy: "pale and white pieces in breathable fabrics with an easy silhouette, for a warm day.",
  neutral_with_accent: "a calm neutral base built around one colourful piece, its colour echoed once at most.",
  smart_collar: "a collared shirt as the focus, with smart trousers or dark denim and leather or minimal shoes.",
  knit_layers: "a knit or cardigan over a shirt or tee, the collar or hem showing, relaxed but tidy.",
  elevated_denim: "jeans dressed up with a shirt, a fine knit or a blazer, and proper shoes or clean leather trainers.",
  earth_tones: "camel, olive, rust, brown and cream together: a warm, natural palette.",
  preppy_layers: "a shirt under a knit, chinos or smart trousers, and loafers or derbies.",
  sporty_clean: "a sweatshirt or hoodie over a tee, clean trainers and simple lines: athletic but neat.",
  texture_play: "mostly plain colours carried by contrasting textures such as wool, corduroy, suede, denim and knit.",
  sharp_tailoring: "a blazer or tailored layer with smart trousers and leather shoes: polished and structured.",
  pattern_anchor: "one patterned piece as the star, everything else plain and taken from its colours.",
  weather_ready: "built around the best protection for today's rain, wind or cold, still coordinated in colour.",
  cosy_winter: "warm layers, a chunky or soft knit, wool and insulated pieces, with scarf, hat and gloves when the day calls for them.",
  dress_led: "a dress as the anchor, layered for the weather with tights, a knit or a jacket as needed.",
  classic_balanced: "a timeless, well-proportioned combination of the wardrobe's best basics.",
};

// ---------------------------------------------------------------------------
// Variety
// ---------------------------------------------------------------------------

/** What the instruction says about directions and the past (D-257). */
export type VarietyPrompt = {
  /** One direction per candidate, in order. */
  directions: readonly DirectionKey[];
  /** Outfits suggested or worn lately, newest first, by today's aliases. */
  recent: readonly { label: string; aliases: readonly string[] }[];
  liked: readonly { note: string; aliases: readonly string[] }[];
  disliked: readonly { note: string; aliases: readonly string[] }[];
};

/** How much history the instruction names: entries per block and aliases per entry. */
export const VARIETY_LIMITS = { suggested: 12, worn: 10, liked: 8, disliked: 4, aliasesPerLine: 9 } as const;

/** An outfit known by fewer of today's aliases than this says too little to name. */
const MIN_HISTORY_ALIASES = 2;

/** "today", "yesterday", "3 days ago". */
function ageLabel(ageDays: number): string {
  const days = Math.max(0, Math.floor(ageDays));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function wornText(times: number): string | null {
  if (times <= 0) return null;
  if (times === 1) return "worn once";
  if (times === 2) return "worn twice";
  return `worn ${times} times`;
}

/** "today, suggested (Knit layers)", "yesterday, worn", "3 days ago, suggested": a suggestion names its direction's label when the key is known. */
function recentLabel(ageDays: number, kind: "suggested" | "worn", direction: string | null): string {
  const head = `${ageLabel(ageDays)}, ${kind}`;
  const style = directionLabel(direction);
  return style === null ? head : `${head} (${style})`;
}

/** Who made a saved outfit: the owner in the builder, or Claude in a suggestion the owner saved. */
const TASTE_SOURCE: Readonly<Record<TasteEntry["source"], string>> = {
  user: "built by the owner",
  ai: "saved suggestion",
};

/** "built by the owner, rated 5, worn 3 times", "saved suggestion, worn twice", "saved suggestion, rated 1". */
function tasteNote(entry: TasteEntry): string {
  const parts = [TASTE_SOURCE[entry.source]];
  if (entry.rating !== null) parts.push(`rated ${entry.rating}`);
  const worn = wornText(entry.timesWorn);
  if (worn !== null) parts.push(worn);
  return parts.join(", ");
}

/**
 * Today's aliases of a past outfit: ids not listed today are dropped, the
 * rest in line order (by slot category), at most VARIETY_LIMITS.aliasesPerLine;
 * null when fewer than MIN_HISTORY_ALIASES are left.
 */
function aliasesOf(
  itemIds: readonly string[],
  aliasOfId: ReadonlyMap<string, string>,
  rank: ReadonlyMap<string, number>,
): string[] | null {
  const known = itemIds.flatMap((id) => {
    const alias = aliasOfId.get(id);
    return alias === undefined ? [] : [alias];
  });
  const aliases = [...new Set(known)].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  return aliases.length < MIN_HISTORY_ALIASES ? null : aliases.slice(0, VARIETY_LIMITS.aliasesPerLine);
}

/** A past outfit as <recent> names it; `outfit` (day, kind and aliases, without the direction) tells repeats apart. */
type Aged = { ageDays: number; outfit: string; label: string; aliases: string[] };

/** The newest `limit` entries that still name enough of today's items, newest first (stable). */
function agedEntries(
  entries: readonly (HistoryEntry & { direction?: string | null })[],
  kind: "suggested" | "worn",
  limit: number,
  toAliases: (itemIds: readonly string[]) => string[] | null,
): Aged[] {
  const mapped = entries.flatMap((entry): Aged[] => {
    const aliases = toAliases(entry.itemIds);
    if (aliases === null) return [];
    return [
      {
        ageDays: entry.ageDays,
        outfit: `${ageLabel(entry.ageDays)}|${kind}|${aliases.join(" ")}`,
        label: recentLabel(entry.ageDays, kind, entry.direction ?? null),
        aliases,
      },
    ];
  });
  return mapped.sort((a, b) => a.ageDays - b.ageDays).slice(0, limit);
}

/**
 * What one request says about variety. directions: OUTFIT_CANDIDATE_COUNT
 * style directions for the wardrobe's profile and today's weather, drawn with
 * a seed of the day, the home city and history.runIndex, so "Suggest again"
 * rotates them, and weighted away from today's and yesterday's directions
 * (assignDirections). recent: up to VARIETY_LIMITS.suggested suggested and
 * VARIETY_LIMITS.worn worn outfits, newest first (suggested before worn on
 * the same day; the same outfit suggested twice on one day is named once,
 * with the newer run's direction), labelled "today, suggested (Knit
 * layers)", "yesterday, worn" or "3 days ago, suggested": a suggestion names
 * its direction's label (DIRECTION_LABELS) when the stored key is known.
 * liked and disliked: up to VARIETY_LIMITS.liked and .disliked saved outfits
 * in the history's order, with a note on who made it, its rating and its
 * wears, such as "built by the owner, rated 5, worn 3 times" or "saved
 * suggestion, rated 4". Every outfit is named by today's aliases (see
 * aliasesOf); one that names fewer than two of today's items is left out.
 * Deterministic.
 */
export function planVariety(input: {
  snapshot: SuggestionSnapshot;
  weather: WeatherSnapshot;
  history: VarietyHistory;
  profileId: string;
}): VarietyPrompt {
  const { snapshot, weather, history, profileId } = input;
  const directions = assignDirections({
    profile: wardrobeProfile(snapshot.styleItems.values()),
    weather,
    seed: seedFrom(`${weather.date}|${profileId}|${history.runIndex}`),
    recent: history.recentDirections,
    count: OUTFIT_CANDIDATE_COUNT,
  });

  const rank = new Map(snapshot.lines.map((line, index) => [line.alias, index]));
  const toAliases = (itemIds: readonly string[]) => aliasesOf(itemIds, snapshot.aliasOfId, rank);

  const seen = new Set<string>();
  const recent = [
    ...agedEntries(history.suggested, "suggested", VARIETY_LIMITS.suggested, toAliases),
    ...agedEntries(history.worn, "worn", VARIETY_LIMITS.worn, toAliases),
  ]
    .sort((a, b) => a.ageDays - b.ageDays)
    .filter((entry) => {
      if (seen.has(entry.outfit)) return false;
      seen.add(entry.outfit);
      return true;
    })
    .map(({ label, aliases }) => ({ label, aliases }));

  const taste = (entries: readonly TasteEntry[], limit: number) =>
    entries
      .flatMap((entry) => {
        const aliases = toAliases(entry.itemIds);
        return aliases === null ? [] : [{ note: tasteNote(entry), aliases }];
      })
      .slice(0, limit);

  return {
    directions,
    recent,
    liked: taste(history.liked, VARIETY_LIMITS.liked),
    disliked: taste(history.disliked, VARIETY_LIMITS.disliked),
  };
}

// ---------------------------------------------------------------------------
// The instruction
// ---------------------------------------------------------------------------

type LineLike = { text: string };

function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (rounded === 0 ? 0 : rounded).toFixed(1);
}

/** A tagged block and the blank line after it; nothing when there are no rows. */
function block(tag: string, rows: readonly string[]): string[] {
  return rows.length === 0 ? [] : [`<${tag}>`, ...rows, `</${tag}>`, ""];
}

/** "Outfit 2: knit_layers (Knit layers): a knit or cardigan over a shirt or tee, ..." */
function directionRow(key: DirectionKey, index: number): string {
  return `Outfit ${index + 1}: ${key} (${DIRECTION_LABELS[key]}): ${DIRECTION_BRIEFS[key]}`;
}

/**
 * The user turn: today's weather, the item lines (before the task, as for long
 * inputs), the recent, liked and disliked outfits (each block left out when
 * empty), one style direction per candidate, and the task with today's key
 * numbers. `place` is the home city, such as "Hamburg, Germany"; `variety`
 * comes from planVariety.
 */
export function buildSuggestionInstruction(input: {
  weather: WeatherSnapshot;
  place: string;
  lines: readonly LineLike[];
  variety: VarietyPrompt;
}): string {
  const { weather, lines, variety } = input;
  const place = sanitizeLineValue(input.place, 80, ["<", ">", '"']);
  const rain =
    weather.precipProbMax === null
      ? `${oneDecimal(weather.precipSumMm)} mm of precipitation (chance unknown)`
      : `${oneDecimal(weather.precipSumMm)} mm of precipitation with a chance of up to ${Math.round(weather.precipProbMax)} %`;
  return [
    `<weather place="${place}">`,
    describeWeatherForPrompt(weather),
    "</weather>",
    "",
    `<items count="${lines.length}">`,
    ...lines.map((line) => line.text),
    "</items>",
    "",
    ...block("recent", variety.recent.map((entry) => `- ${entry.label}: ${entry.aliases.join(" ")}`)),
    ...block("liked", variety.liked.map((entry) => `- ${entry.note}: ${entry.aliases.join(" ")}`)),
    ...block("disliked", variety.disliked.map((entry) => `- ${entry.note}: ${entry.aliases.join(" ")}`)),
    ...block("directions", variety.directions.map(directionRow)),
    `Suggest exactly ${OUTFIT_CANDIDATE_COUNT} different outfits for today in ${place}, using only the items above, ` +
      "one for each direction in <directions>, in that order.",
    `- Dress for a feels-like range of ${oneDecimal(weather.apparentMinC)} to ${oneDecimal(weather.apparentMaxC)} °C, ` +
      `${rain}, and gusts up to ${Math.round(weather.windGustMaxKmh)} km/h.`,
    `- Each outfit: exactly one item in top (a top or a dress), a bottom unless that item is a dress, shoes, ` +
      "socks with closed shoes, a mid layer over the top when the look or the weather wants one, " +
      `and only the layers and accessories the weather calls for; at most ${MAX_ACCESSORIES} accessories.`,
    "- Prefer items that have rested (a low worn: count, an old or never last:) when they suit the weather.",
    `- title: at most ${S.titleMax} characters. why: at most ${S.whyMax} characters.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Request parameters and estimate
// ---------------------------------------------------------------------------

/** The route's deadline for the whole call, from the start of the request. */
export const OUTFIT_DEADLINE_MS = 110_000;

/** The slowest output speed assumed for the outfit model, in tokens per second. */
export const SLOWEST_TOKENS_PER_SECOND = 110;

/** Time kept for the request to reach the model and the first token to arrive, before the reply is written. */
export const FIRST_TOKEN_MARGIN_MS = 30_000;

/** What the model writes at SLOWEST_TOKENS_PER_SECOND between the first token and the deadline: 8,800. */
const OUTFIT_MAX_TOKENS = Math.floor(((OUTFIT_DEADLINE_MS - FIRST_TOKEN_MARGIN_MS) / 1000) * SLOWEST_TOKENS_PER_SECOND);

/**
 * Effort medium (D-258): five candidates, each built around a style
 * direction with layers, socks and a colour story, need more deliberation
 * than three plain outfits did at low. The cap is what the model writes
 * between FIRST_TOKEN_MARGIN_MS and the route's deadline at the slowest
 * assumed speed (OUTFIT_MAX_TOKENS); the ceiling equals it, so a max_tokens
 * stop is not retried with a doubled cap that could not finish (D-164).
 * After a long first reply there may be no time left to retry at all, which
 * is why the strict adapter drops bad candidates instead of failing the
 * whole reply.
 */
export const OUTFIT_CALL_PARAMS = {
  purpose: "outfit_suggestion",
  effort: "medium",
  maxTokens: OUTFIT_MAX_TOKENS,
  maxTokensCeiling: OUTFIT_MAX_TOKENS,
} as const;

/**
 * Assumptions behind the estimate, to be replaced by measured values after the
 * first live runs: five candidates of about 300 visible tokens each, about
 * 5,000 thinking tokens at effort medium, the structured-output format's own
 * system text (the 400 tokens the other estimates use) and up to 1,200 tokens
 * of recent, liked and disliked outfits (VARIETY_LIMITS, with every line at
 * its longest label or note: about 1,100). No cache read is assumed: the
 * system prompt is cached only for 5 minutes.
 */
export const OUTFIT_ESTIMATE = {
  formatOverheadTokens: 400,
  visibleOutputTokens: 1_500,
  thinkingTokens: 5_000,
  varietyTokens: 1_200,
} as const;

/** A fixed forecast with full-length numbers, so the estimate depends only on the lines. */
const ESTIMATE_WEATHER: WeatherSnapshot = {
  date: "2026-11-03",
  timezone: "Europe/Berlin",
  currentC: -10.5,
  tminC: -12.5,
  tmaxC: -10.5,
  apparentMinC: -18.5,
  apparentMaxC: -14.5,
  precipSumMm: 12.5,
  precipProbMax: 100,
  windGustMaxKmh: 100,
  weatherCode: 86,
  label: "Heavy snow showers",
  fetchedAt: "2026-11-03T06:00:00.000Z",
};

/** The directions with the longest rows, so the estimate covers any draw; the history is added as varietyTokens. */
const ESTIMATE_VARIETY: VarietyPrompt = {
  directions: [...DIRECTION_KEYS]
    .sort((a, b) => directionRow(b, 0).length - directionRow(a, 0).length || DIRECTION_KEYS.indexOf(a) - DIRECTION_KEYS.indexOf(b))
    .slice(0, OUTFIT_CANDIDATE_COUNT),
  recent: [],
  liked: [],
  disliked: [],
};

/** Input tokens of one suggestion request: system prompt, instruction with its directions, history and format overhead. */
export function estimateOutfitInputTokens(lines: readonly LineLike[]): number {
  const instruction = buildSuggestionInstruction({
    weather: ESTIMATE_WEATHER,
    place: "Hamburg, Germany",
    lines,
    variety: ESTIMATE_VARIETY,
  });
  return (
    estimateTextTokens(OUTFIT_SYSTEM_PROMPT) +
    estimateTextTokens(instruction) +
    OUTFIT_ESTIMATE.varietyTokens +
    OUTFIT_ESTIMATE.formatOverheadTokens
  );
}

/** Estimated USD of one suggestion call at standard rates. */
export function estimateOutfitSuggestionUsd(model: PricedModelId, lines: readonly LineLike[]): number {
  return computeCostUsd(model, {
    input_tokens: estimateOutfitInputTokens(lines),
    output_tokens: OUTFIT_ESTIMATE.visibleOutputTokens + OUTFIT_ESTIMATE.thinkingTokens,
  });
}
