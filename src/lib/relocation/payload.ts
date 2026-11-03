// The wardrobe as the relocation prompt sees it (D-025, D-028): one compact,
// pipe-separated line per item under a short alias (i1..iN), a legend, a
// summary, and a hash that changes exactly when a line changes.
// Pure (node:crypto only): no `server-only` and no database, so unit tests and
// the Playwright seeds can import it. Never import it from a client component.

import { createHash } from "node:crypto";

import {
  ITEM_CATEGORIES,
  SEASONS,
  type Formality,
  type ItemCategory,
  type ItemCondition,
  type ItemLocation,
  type ItemStatus,
} from "@/lib/db/enums";
import {
  LOW_CONFIDENCE_THRESHOLD,
  placeAtDestination,
  type DestinationLocation,
} from "@/lib/relocation/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The item fields a line is built from. A drizzle `Item` row fits as is. */
export type SnapshotItemInput = {
  id: string;
  createdAt: Date | string;
  name: string | null;
  category: ItemCategory | null;
  subcategory: string | null;
  colors: readonly string[];
  materials: readonly string[];
  materialGuess: string | null;
  warmthLevel: number | null;
  waterproof: boolean | null;
  windproof: boolean | null;
  insulated: boolean | null;
  breathable: boolean | null;
  seasons: readonly string[];
  formality: Formality | null;
  condition: ItemCondition | null;
  status: ItemStatus;
  location: ItemLocation;
  aiConfidence: Readonly<Record<string, number>> | null;
  userEditedFields: readonly string[];
};

export type SnapshotLine = {
  /** i1..iN, dense, in snapshot order. */
  alias: string;
  itemId: string;
  category: ItemCategory | null;
  subcategory: string | null;
  /** The full line, starting with the alias. */
  text: string;
};

export type WarmthLevelKey = 1 | 2 | 3 | 4 | 5;

export type WardrobeSummary = {
  itemCount: number;
  byCategory: Record<ItemCategory, number>;
  warmth: Record<WarmthLevelKey, number>;
  waterproof: number;
  windproof: number;
  insulated: number;
  /** Included items still in status tagged (only when includeOnlyConfirmed is off). */
  unconfirmed: number;
  /** Included items already at the run's destination or on their way there (D-170). */
  alreadyMoved: number;
};

export type SnapshotExclusions = { pending: number; archived: number; unconfirmed: number };

export type RelocationSnapshot = {
  lines: SnapshotLine[];
  legend: string;
  /** alias -> item uuid. */
  aliasMap: Record<string, string>;
  summary: WardrobeSummary;
  summaryText: string;
  snapshotHash: string;
  excluded: SnapshotExclusions;
};

// ---------------------------------------------------------------------------
// Hashing helpers (shared with chunks.ts)
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every level, so equal data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new TypeError(`canonicalJson cannot encode a ${typeof value}.`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("canonicalJson needs finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

/**
 * Caps on free-text values in a line, in characters. Chosen so the longest
 * possible line (every field at its cap, every lc: code, now:in_transit and a
 * five-digit alias) stays under 100 estimated tokens; payload.test.ts checks it.
 */
export const LINE_LIMITS = {
  name: 40,
  subcategory: 20,
  /** One colour or material. */
  listEntry: 20,
  colors: 3,
  colorsTotal: 26,
  materials: 3,
  materialsTotal: 30,
} as const;

/**
 * The confidence keys that reach a line (brand does not), with the short code
 * the lc: marker uses for each. The codes echo the line's own notation (w, wp,
 * wd, ins) and keep a fully marked line short; the legend explains them.
 */
export const LOW_CONFIDENCE_CODES = {
  category: "cat",
  colors: "col",
  materials: "mat",
  warmth_level: "w",
  waterproof: "wp",
  windproof: "wd",
  insulated: "ins",
  formality: "form",
  condition: "cond",
} as const;
export type LowConfidenceField = keyof typeof LOW_CONFIDENCE_CODES;
const LOW_CONFIDENCE_FIELDS = Object.keys(LOW_CONFIDENCE_CODES) as LowConfidenceField[];

// C0 and C1 control characters (tab, CR and LF included), DEL, and the Unicode
// line and paragraph separators: anything that could end or split a line.
const CONTROL = /[\p{Cc}\u2028\u2029]/gu;

/**
 * Makes a free-text value safe for a line: the field separator, line breaks,
 * tabs and other control characters become spaces (plus any `extra`
 * separators), runs of spaces collapse, and the result is trimmed and capped
 * at `max` characters. An empty result is "?".
 */
export function sanitizeLineValue(value: string | null | undefined, max: number, extra: readonly string[] = []): string {
  if (value === null || value === undefined) return "?";
  let text = value.replace(CONTROL, " ").replaceAll("|", " ");
  for (const separator of extra) text = text.replaceAll(separator, " ");
  text = text.replace(/\s+/g, " ").trim();
  // Cut by code points so an emoji is never split into a lone surrogate.
  const chars = Array.from(text);
  if (chars.length > max) text = chars.slice(0, max).join("").trimEnd();
  return text === "" ? "?" : text;
}

/**
 * A list field: each entry sanitised (its separator removed too), empties
 * dropped, at most `limit` entries, and trailing entries dropped while the
 * joined text is longer than `total` (the first entry is cut to fit instead).
 */
function listValue(values: readonly string[], limit: number, total: number, separator: string): string {
  const entries = values
    .map((entry) => sanitizeLineValue(entry, LINE_LIMITS.listEntry, [separator]))
    .filter((entry) => entry !== "?")
    .slice(0, limit);
  while (entries.length > 1 && entries.join(separator).length > total) entries.pop();
  if (entries.length === 0) return "?";
  return entries.length === 1 ? sanitizeLineValue(entries[0], total) : entries.join(separator);
}

function flag(value: boolean | null): string {
  return value === null ? "?" : value ? "1" : "0";
}

/**
 * Seasons in calendar order (winter first), so reordering the stored list
 * changes nothing; "all" when the item suits all four. Values outside SEASONS
 * cannot be stored (items_seasons_check) and are ignored.
 */
function seasonsValue(seasons: readonly string[]): string {
  const known = SEASONS.filter((season) => seasons.includes(season));
  if (known.length === SEASONS.length) return "all";
  return known.length === 0 ? "?" : known.join(",");
}

/** Unedited fields whose tag confidence is below the threshold (D-028), in a fixed order. */
export function lowConfidenceFields(
  item: Pick<SnapshotItemInput, "aiConfidence" | "userEditedFields">,
): LowConfidenceField[] {
  const confidence = item.aiConfidence;
  if (confidence === null) return [];
  return LOW_CONFIDENCE_FIELDS.filter((field) => {
    const score = confidence[field];
    return (
      typeof score === "number" &&
      Number.isFinite(score) &&
      score < LOW_CONFIDENCE_THRESHOLD &&
      !item.userEditedFields.includes(field)
    );
  });
}

/**
 * The line without its alias; the snapshot hash covers exactly this text.
 * `destination` is the item location of the run's climate profile: an item
 * there is marked now:there, one on its way there now:in_transit (D-170).
 */
export function itemLineBody(item: SnapshotItemInput, destination: DestinationLocation | null): string {
  // The materials list when tagging gave one; otherwise the free-text guess.
  const materials =
    item.materials.length > 0
      ? listValue(item.materials, LINE_LIMITS.materials, LINE_LIMITS.materialsTotal, ";")
      : sanitizeLineValue(item.materialGuess, LINE_LIMITS.materialsTotal, [";"]);
  const fields = [
    `${item.category ?? "?"}/${sanitizeLineValue(item.subcategory, LINE_LIMITS.subcategory)}`,
    listValue(item.colors, LINE_LIMITS.colors, LINE_LIMITS.colorsTotal, ","),
    materials,
    `w${item.warmthLevel ?? "?"}`,
    `wp${flag(item.waterproof)} wd${flag(item.windproof)} ins${flag(item.insulated)} br${flag(item.breathable)}`,
    seasonsValue(item.seasons),
    item.formality ?? "?",
    item.condition ?? "?",
    item.status,
    sanitizeLineValue(item.name, LINE_LIMITS.name),
  ];
  const lowConfidence = lowConfidenceFields(item);
  if (lowConfidence.length > 0) {
    fields.push(`lc:${lowConfidence.map((field) => LOW_CONFIDENCE_CODES[field]).join(",")}`);
  }
  const place = placeAtDestination(item.location, destination);
  if (place !== null) fields.push(`now:${place}`);
  return fields.join("|");
}

// ---------------------------------------------------------------------------
// Legend and summary
// ---------------------------------------------------------------------------

/** Explains each field of a line once; part of the shared prompt context. */
export const SNAPSHOT_LEGEND = [
  "Each item is one line of |-separated fields:",
  "alias|category/subcategory|colours (dominant first)|materials (main first)|warmth|weather flags|seasons|formality|condition|tag status|name",
  "- alias: the item's id in this request, such as i12.",
  "- warmth: w1 summer weight, w2 light layer, w3 mid layer, w4 warm, w5 heavy winter.",
  "- weather flags: wp waterproof, wd windproof, ins insulated, br breathable; 1 yes, 0 no.",
  "- seasons: the seasons the item suits; all = all four.",
  "- formality: athletic, casual, smart_casual, business or formal. condition: new, good, worn or needs_repair.",
  "- tag status: confirmed = checked by the owner; tagged = AI tags the owner has not checked yet.",
  "- Optional fields after the name: lc:<codes> = tags the automatic tagging was unsure about, so they may be wrong " +
    "(cat category, col colours, mat materials, w warmth, wp waterproof, wd windproof, ins insulated, form formality, cond condition); " +
    "now:there = already at the destination; now:in_transit = already on its way there.",
  "- ? = unknown. Long names and lists are shortened.",
].join("\n");

function emptySummary(): WardrobeSummary {
  return {
    itemCount: 0,
    byCategory: Object.fromEntries(ITEM_CATEGORIES.map((category) => [category, 0])) as Record<ItemCategory, number>,
    warmth: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    waterproof: 0,
    windproof: 0,
    insulated: 0,
    unconfirmed: 0,
    alreadyMoved: 0,
  };
}

function isWarmthKey(value: number | null): value is WarmthLevelKey {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/** Counts over the included items, as compact text for the prompt. Zero counts stay: they show gaps. */
export function summaryToText(summary: WardrobeSummary): string {
  const categories = ITEM_CATEGORIES.map((category) => `${category} ${summary.byCategory[category]}`).join(", ");
  const warmth = ([1, 2, 3, 4, 5] as const).map((level) => `w${level} ${summary.warmth[level]}`).join(", ");
  const lines = [
    `Items in this analysis: ${summary.itemCount}.`,
    `By category: ${categories}.`,
    `By warmth: ${warmth}.`,
    `Waterproof ${summary.waterproof}, windproof ${summary.windproof}, insulated ${summary.insulated}.`,
  ];
  if (summary.unconfirmed > 0) lines.push(`Not yet confirmed by the owner: ${summary.unconfirmed}.`);
  if (summary.alreadyMoved > 0) lines.push(`Already at the destination or on its way there: ${summary.alreadyMoved}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

const CATEGORY_RANK = new Map<string, number>(ITEM_CATEGORIES.map((category, index) => [category, index]));

function timeOf(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid createdAt: ${String(value)}`);
  return ms;
}

/** Category (enum order, null last), then creation time, then id: the alias order. */
function compareItems(a: SnapshotItemInput, b: SnapshotItemInput): number {
  const rank = (item: SnapshotItemInput) =>
    item.category === null ? ITEM_CATEGORIES.length : (CATEGORY_RANK.get(item.category) ?? ITEM_CATEGORIES.length);
  return rank(a) - rank(b) || timeOf(a.createdAt) - timeOf(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Builds the run's snapshot. Confirmed items are always included and tagged
 * ones only when includeOnlyConfirmed is false (their line says "tagged");
 * pending_tagging and archived items are always left out and counted (D-028).
 * `destination` is the item location of the run's climate profile (D-170).
 */
export function buildSnapshot(
  items: readonly SnapshotItemInput[],
  options: { includeOnlyConfirmed: boolean; destination: DestinationLocation | null },
): RelocationSnapshot {
  const excluded: SnapshotExclusions = { pending: 0, archived: 0, unconfirmed: 0 };
  const included: SnapshotItemInput[] = [];
  for (const item of items) {
    if (item.status === "pending_tagging") excluded.pending += 1;
    else if (item.status === "archived") excluded.archived += 1;
    else if (item.status === "tagged" && options.includeOnlyConfirmed) excluded.unconfirmed += 1;
    else included.push(item);
  }
  included.sort(compareItems);

  const summary = emptySummary();
  const lines: SnapshotLine[] = [];
  const aliasMap: Record<string, string> = {};
  const hashed: Array<[string, string]> = [];
  included.forEach((item, index) => {
    const alias = `i${index + 1}`;
    const body = itemLineBody(item, options.destination);
    lines.push({ alias, itemId: item.id, category: item.category, subcategory: item.subcategory, text: `${alias}|${body}` });
    aliasMap[alias] = item.id;
    hashed.push([item.id, body]);

    summary.itemCount += 1;
    if (item.category !== null) summary.byCategory[item.category] += 1;
    if (isWarmthKey(item.warmthLevel)) summary.warmth[item.warmthLevel] += 1;
    if (item.waterproof === true) summary.waterproof += 1;
    if (item.windproof === true) summary.windproof += 1;
    if (item.insulated === true) summary.insulated += 1;
    if (item.status === "tagged") summary.unconfirmed += 1;
    if (placeAtDestination(item.location, options.destination) !== null) summary.alreadyMoved += 1;
  });

  return {
    lines,
    legend: SNAPSHOT_LEGEND,
    aliasMap,
    summary,
    summaryText: summaryToText(summary),
    snapshotHash: sha256Hex(canonicalJson(hashed)),
    excluded,
  };
}
