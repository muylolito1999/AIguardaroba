// Daily outfit suggestions (D-038, D-039): which items Claude may use, the
// item lines under aliases, the wire and strict schemas, the prompt and the
// estimate. Every request has two parts:
// 1. OUTFIT_SYSTEM_PROMPT: fixed text that carries the cache breakpoint.
// 2. buildSuggestionInstruction(): today's weather, the item lines, the task.
// suggestion.test.ts pins the system prompt's sha256 and one over the
// instruction template and the wire schema per OUTFIT_PROMPT_VERSION: an edit
// to either must bump the version, which the service's reuse check compares.
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
  validateOutfit,
  type OutfitCheckItem,
  type OutfitEntry,
} from "@/lib/outfits/contracts";
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

export const OUTFIT_PROMPT_VERSION = "outfit-v2";

/** Lines per request: about 45 estimated tokens each, so at most about 18K input tokens. */
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

/** The fields a suggestion line is built from. A drizzle `Item` row fits as is. */
export type SuggestionItemInput = SnapshotItemInput & {
  wearCount: number;
  lastWornAt: Date | string | null;
};

export type SuggestionLine = {
  /** i1..iN, dense, in snapshot order. */
  alias: string;
  itemId: string;
  category: ItemCategory;
  /** The full line, starting with the alias. */
  text: string;
};

export type SuggestionSnapshot = {
  lines: SuggestionLine[];
  /** alias -> item uuid. */
  byAlias: ReadonlyMap<string, string>;
  /** item uuid -> alias. */
  aliasOfId: ReadonlyMap<string, string>;
  itemCount: number;
  /** Items left out because there were more than MAX_SUGGESTION_ITEMS. */
  droppedCount: number;
  /** Changes exactly when a line, its alias or the set of items changes (wear counts included). */
  snapshotHash: string;
};

/** Categories in the order the lines list them: by slot, the main pieces first. */
const LINE_CATEGORY_ORDER: readonly ItemCategory[] = SLOT_ORDER.flatMap((slot) => SLOT_CATEGORIES[slot]);
const CATEGORY_RANK = new Map<ItemCategory, number>(LINE_CATEGORY_ORDER.map((category, index) => [category, index]));

function timeOf(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid timestamp: ${String(value)}`);
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

/** Northern-hemisphere season of a YYYY-MM-DD date (both home cities are in Europe). */
function seasonOf(date: string): "winter" | "spring" | "summer" | "autumn" {
  const month = Number(date.slice(5, 7));
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "autumn";
}

/** The warmth level (1 to 5) an item would ideally have on a day that feels like `feelsLikeC`. */
export function idealWarmth(feelsLikeC: number): number {
  if (feelsLikeC >= 22) return 1;
  if (feelsLikeC >= 16) return 2;
  if (feelsLikeC >= 10) return 3;
  if (feelsLikeC >= 3) return 4;
  return 5;
}

/** Rain gear counts from this chance of precipitation (percent), or from this much rain (mm). */
export const RAINY_DAY = { probability: 50, sumMm: 2 } as const;

export function isRainyDay(weather: Pick<WeatherSnapshot, "precipProbMax" | "precipSumMm">): boolean {
  return (weather.precipProbMax ?? 0) >= RAINY_DAY.probability || weather.precipSumMm >= RAINY_DAY.sumMm;
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
 * The request's item lines. Pass the items isEligibleForToday accepts; an
 * item no slot can hold, or one that is not clothing (D-249), is skipped all
 * the same. Each line is the relocation line (with no destination marker,
 * D-170) plus worn:N and last:YYYY-MM-DD (the calendar day in the forecast's
 * time zone) or last:never, so Claude can prefer rested items. The collection
 * is not part of a line, so the lines and hashes of clothing are unchanged
 * (D-248). Aliases i1..iN follow the category order of the slots, and within a
 * category the most recently worn come last. Over MAX_SUGGESTION_ITEMS, the
 * items least suited to the weather are left out (weatherFitScore) and counted.
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
  kept.forEach((item, index) => {
    const alias = `i${index + 1}`;
    const lastWorn = timeOf(item.lastWornAt);
    const last = lastWorn === null ? "never" : calendarDayIn(weather.timezone, new Date(lastWorn));
    const text = `${alias}|${itemLineBody(item, null)}|worn:${item.wearCount}|last:${last}`;
    lines.push({ alias, itemId: item.id, category: item.category, text });
    byAlias.set(alias, item.id);
    aliasOfId.set(item.id, alias);
  });

  return {
    lines,
    byAlias,
    aliasOfId,
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

function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i += 1) result = (result * (n - i)) / (i + 1);
  return result;
}

/**
 * The number of different item sets that pass validateOutfit with these
 * lines: (top x bottom or dress with or without a bottom) x (each single slot
 * empty or filled) x (0 to MAX_ACCESSORIES accessories).
 */
export function countPossibleOutfits(lines: readonly Pick<SuggestionLine, "category">[]): number {
  const count = (categories: readonly ItemCategory[]) => lines.filter((line) => categories.includes(line.category)).length;
  const bottoms = count(["bottom"]);
  const bases = count(["top"]) * bottoms + count(["dress"]) * (bottoms + 1);
  const singles = (["outerwear", "base_layer", "shoes", "hat", "gloves", "scarf"] as const).reduce(
    (product, slot) => product * (count(SLOT_CATEGORIES[slot]) + 1),
    1,
  );
  const accessories = count(SLOT_CATEGORIES.accessory);
  let accessorySets = 0;
  for (let k = 0; k <= Math.min(MAX_ACCESSORIES, accessories); k += 1) accessorySets += choose(accessories, k);
  return bases * singles * accessorySets;
}

/**
 * Whether three different valid outfits exist, so the strict check can pass.
 * The service checks this before paying for a call that could never succeed.
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
              "Exactly one item in top (a top or a dress); a bottom unless the top is a dress.",
          ),
        why: z
          .string()
          .describe(`Why the outfit suits today's weather, citing the numbers, at most ${S.whyMax} characters.`),
        rain_ok: z.boolean().describe("true only when the outfit keeps the wearer dry in rain."),
      }),
    )
    .describe(`Exactly ${OUTFIT_SUGGESTION_COUNT} outfits; no two with the same items.`),
});
export type OutfitSuggestionWire = z.infer<typeof OutfitSuggestionWireSchema>;

/** The checked reply: the outfits with item uuids instead of aliases. */
export type OutfitSuggestionStrict = { outfits: SuggestedOutfit[] };

const requiredText = (max: number) => z.string().trim().min(1).max(max);

/** Compared case-insensitively: the grammar does not guarantee enum casing (D-165). */
const looseSlot = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(OUTFIT_SLOTS));

/**
 * The strict check of a reply (D-144): exactly OUTFIT_SUGGESTION_COUNT
 * outfits; title and why within their limits; every alias one of this
 * request's; each outfit passes validateOutfit once its aliases are mapped to
 * item ids; no two outfits with the same set of items. A failure is invalid
 * output, which callStructured retries. The parsed value names items by uuid.
 */
export function makeOutfitSuggestionStrictSchema(
  snapshot: Pick<SuggestionSnapshot, "byAlias">,
  checkItems: ReadonlyMap<string, OutfitCheckItem>,
): z.ZodType<OutfitSuggestionStrict> {
  const idOf = (alias: string): string | undefined => snapshot.byAlias.get(alias);
  const aliasOf = new Map([...snapshot.byAlias].map(([alias, itemId]) => [itemId, alias]));
  const toEntries = (items: readonly { slot: OutfitEntry["slot"]; item: string }[]): OutfitEntry[] =>
    items.flatMap((entry) => {
      const itemId = idOf(entry.item);
      return itemId === undefined ? [] : [{ slot: entry.slot, itemId }];
    });

  return z
    .strictObject({
      outfits: z
        .array(
          z.strictObject({
            title: requiredText(S.titleMax),
            items: z.array(
              z.strictObject({
                slot: looseSlot,
                item: z.string().transform((value) => value.trim().toLowerCase()),
              }),
            ),
            why: requiredText(S.whyMax),
            rain_ok: z.boolean(),
          }),
        )
        .length(OUTFIT_SUGGESTION_COUNT),
    })
    .superRefine((reply, ctx) => {
      const seenSets = new Map<string, number>();
      reply.outfits.forEach((outfit, index) => {
        let aliasesKnown = true;
        outfit.items.forEach((entry, entryIndex) => {
          if (idOf(entry.item) === undefined) {
            aliasesKnown = false;
            ctx.addIssue({
              code: "custom",
              path: ["outfits", index, "items", entryIndex, "item"],
              message: `Unknown alias ${entry.item}.`,
            });
          }
        });
        if (!aliasesKnown) return;

        const entries = toEntries(outfit.items);
        const check = validateOutfit(entries, checkItems);
        if (!check.ok) {
          for (const issue of check.issues) {
            // The log names the alias Claude wrote, not the uuid it stands for.
            const alias = issue.itemId === undefined ? undefined : aliasOf.get(issue.itemId);
            ctx.addIssue({
              code: "custom",
              path: ["outfits", index, "items"],
              message: `${issue.code}${alias === undefined ? "" : ` (${alias})`}: ${issue.message}`,
            });
          }
        }

        const key = [...new Set(entries.map((entry) => entry.itemId))].sort().join(",");
        const previous = seenSets.get(key);
        if (previous !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["outfits", index, "items"],
            message: `Outfit ${index + 1} uses the same items as outfit ${previous + 1}.`,
          });
        } else {
          seenSets.set(key, index);
        }
      });
    })
    .transform((reply) => ({
      outfits: reply.outfits.map((outfit) => ({
        title: outfit.title,
        why: outfit.why,
        rain_ok: outfit.rain_ok,
        items: toEntries(outfit.items),
      })),
    }));
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export const OUTFIT_SYSTEM_PROMPT = `You are a practical personal stylist inside a wardrobe app. Each morning the owner asks what to wear today. You get today's forecast for the owner's city and the clothes they own and have at hand, as compact lines under short aliases. You answer with exactly ${OUTFIT_SUGGESTION_COUNT} outfits built only from those items, in the required JSON format. The owner sees each outfit as a card and can save it or log it as worn, so every outfit must be complete and wearable exactly as listed.

DRESSING FOR THE WEATHER
Dress for how the day feels, not for the air temperature alone. The feels-like (apparent) temperature already includes wind and humidity: its low end describes the morning and evening commute, its high end the warmest hours.
- Feels-like bands, as a guide:
  below 0 °C, freezing: a warm or insulated outer layer over a mid layer, a base layer when there is one, hat, gloves and scarf, warm closed shoes.
  0 to 5 °C, cold: a warm coat, or a shell over a knit or fleece, plus hat and gloves.
  5 to 10 °C, chilly: a jacket over a long-sleeved top or a light knit; a scarf helps in wind.
  10 to 15 °C, cool: a light jacket or a knit, in layers that come off during the day.
  15 to 20 °C, mild: a light layer for the morning and evening, or none.
  above 20 °C, warm: light, breathable clothes; no outerwear unless it rains.
- A wide range (more than about 8 °C between the low and the high) calls for layers that come off: dress for the low end and choose an outer layer that is easy to carry.
- Rain: a ${RAINY_DAY.probability} % or higher chance of precipitation, or ${RAINY_DAY.sumMm} mm or more in the day, calls for rain gear: a waterproof outer layer, ideally with a hood, and waterproof shoes when the wardrobe has them. Below that, a layer that sheds a shower is enough.
- Wind: gusts of about 40 km/h or more make it feel colder and wreck umbrellas, so prefer windproof outer layers and a hat that stays on; 60 km/h or more is stormy.
- Snow or freezing rain: warm, waterproof shoes with grip.

BUILDING AN OUTFIT
- Slots: outerwear, base_layer, top, bottom, shoes, hat, gloves, scarf and accessory. Each slot takes one item, except accessory, which takes up to ${MAX_ACCESSORIES}.
- The slot must match the item's category: outerwear in outerwear, base_layer in base_layer, top and dress in top, bottom in bottom, shoes in shoes, hat_beanie in hat, gloves in gloves, scarf in scarf, accessory and bag in accessory.
- Every outfit has exactly one item in the top slot. With a top, add a bottom. A dress goes in the top slot and needs no bottom; a bottom with it is optional.
- Always add shoes when the wardrobe has any. Add outerwear, a base layer, hat, gloves and scarf only when the weather calls for them.
- A base layer is worn under the top: thermal or merino underwear for cold days.
- Keep formality consistent: pieces within one step of each other on the scale athletic, casual, smart_casual, business, formal.
- Combine colours that work together; a neutral base with one accent is a safe choice.
- An item appears at most once in an outfit. No two outfits may use exactly the same items. Whenever the wardrobe allows it, make the outfits real alternatives, such as a warmer and a lighter option or a smarter and a more casual one, rather than one outfit with a single item swapped.
- rain_ok: true only when the outfit would keep the owner dry in rain, with a waterproof outer layer or at least waterproof shoes and a layer that sheds a shower; otherwise false.

WEAR HISTORY
Each line ends with worn:N, how many times the item was logged as worn (one day can count more than once), and last:, the day it was last worn, or never. Prefer items that have rested: avoid the pieces worn in the last day or two, and bring in items worn rarely or never when they suit the weather. The weather comes first: never pick an unsuitable item only because it has rested.

ITEM LINES
Each item is one line of |-separated fields:
alias|category/subcategory|colours (dominant first)|materials (main first)|warmth|weather flags|seasons|formality|condition|tag status|name|optional lc:codes|worn:N|last:day
- alias: the item's id in this request, such as i12. Use only the aliases listed. Never invent items, aliases or attributes.
- warmth: w1 summer weight, w2 light layer, w3 mid layer, w4 warm, w5 heavy winter.
- weather flags: wp waterproof, wd windproof, ins insulated, br breathable; 1 yes, 0 no.
- seasons: the seasons the item suits; all = all four.
- condition: new, good, worn or needs_repair; leave needs_repair items out when there is an alternative.
- tag status: confirmed = checked by the owner; tagged = automatic tags the owner has not checked yet.
- lc: lists tags the automatic tagging was unsure about (cat category, col colours, mat materials, w warmth, wp waterproof, wd windproof, ins insulated, form formality, cond condition). They may be wrong, so lean on the name and the other fields.
- ? = unknown. Long names and lists are shortened.

WRITING
- title: a short, specific name, at most ${S.titleMax} characters, such as "Navy layers for a drizzly commute".
- why: at most ${S.whyMax} characters. Say why the outfit suits today, citing the numbers that matter (feels-like temperatures, rain chance, gusts), and mention a rested item when that is why you chose it. No aliases in the text.
- Plain English and metric units. Every field of the format is required.`;

type LineLike = { text: string };

function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (rounded === 0 ? 0 : rounded).toFixed(1);
}

/**
 * The user turn: today's weather, the item lines (before the task, as for long
 * inputs) and the task with today's key numbers. `place` is the home city,
 * such as "Hamburg, Germany".
 */
export function buildSuggestionInstruction(input: {
  weather: WeatherSnapshot;
  place: string;
  lines: readonly LineLike[];
}): string {
  const { weather, lines } = input;
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
    `Suggest exactly ${OUTFIT_SUGGESTION_COUNT} different outfits for today in ${place}, using only the items above.`,
    `- Dress for a feels-like range of ${oneDecimal(weather.apparentMinC)} to ${oneDecimal(weather.apparentMaxC)} °C, ` +
      `${rain}, and gusts up to ${Math.round(weather.windGustMaxKmh)} km/h.`,
    `- Each outfit: exactly one item in top (a top or a dress), a bottom unless that item is a dress, shoes, ` +
      `and only the layers and accessories the weather calls for; at most ${MAX_ACCESSORIES} accessories.`,
    "- Prefer items that have rested (a low worn: count, an old or never last:) when they suit the weather.",
    `- title: at most ${S.titleMax} characters. why: at most ${S.whyMax} characters.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Request parameters and estimate
// ---------------------------------------------------------------------------

/**
 * Effort low: picking three outfits from a few hundred lines needs little
 * deliberation, and low keeps a daily call cheap and well inside the route's
 * 110 s deadline. The cap is what Sonnet writes in about 75 s at the slowest
 * assumed speed (110 tokens per second); the ceiling equals it, so a
 * max_tokens stop is not retried with a doubled cap that could not finish (D-164).
 */
export const OUTFIT_CALL_PARAMS = {
  purpose: "outfit_suggestion",
  effort: "low",
  maxTokens: 8000,
  maxTokensCeiling: 8000,
} as const;

/** The route's deadline for the whole call, from the start of the request. */
export const OUTFIT_DEADLINE_MS = 110_000;

/**
 * Assumptions behind the estimate, to be replaced by measured values after the
 * first live run: three outfits of about 300 visible tokens each, about 1,500
 * thinking tokens at effort low, and the structured-output format's own
 * system text (the 400 tokens the other estimates use). No cache read is
 * assumed: the system prompt is cached only for 5 minutes.
 */
export const OUTFIT_ESTIMATE = {
  formatOverheadTokens: 400,
  visibleOutputTokens: 900,
  thinkingTokens: 1_500,
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

/** Input tokens of one suggestion request: system prompt, instruction and format overhead. */
export function estimateOutfitInputTokens(lines: readonly LineLike[]): number {
  return (
    estimateTextTokens(OUTFIT_SYSTEM_PROMPT) +
    estimateTextTokens(buildSuggestionInstruction({ weather: ESTIMATE_WEATHER, place: "Hamburg, Germany", lines })) +
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
