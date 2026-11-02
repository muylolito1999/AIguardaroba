// Wardrobe filters as they live in the URL. The /wardrobe page parses its
// searchParams with parseItemFilters, the filter controls write changes back
// with serializeItemFilters and router.replace, and the query service turns the
// parsed object into SQL. The URL is the only filter state, so the back button,
// reloads and shared links all restore the same view.
//
// Client components import this module, so it must stay free of
// `server-only`, env access and the database client.
//
// Query semantics the service implements: values within one field are
// alternatives (category=shoes&category=scarf matches either), and fields
// combine with AND. warmthMin and warmthMax are inclusive bounds on
// warmth_level, so setting either one leaves out items without a warmth.

import {
  FORMALITIES,
  ITEM_CATEGORIES,
  ITEM_CONDITIONS,
  ITEM_DECISIONS,
  ITEM_LOCATIONS,
  ITEM_STATUSES,
  SEASONS,
  type Formality,
  type ItemCategory,
  type ItemCondition,
  type ItemDecision,
  type ItemLocation,
  type ItemStatus,
  type Season,
} from "@/lib/db/enums";
import { TAG_LIMITS, WARMTH_LEVELS, type WarmthLevel } from "@/lib/items/contracts";

export const ITEM_SORTS = ["created_desc", "created_asc", "warmth_desc", "warmth_asc", "wear_desc"] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];
export const DEFAULT_SORT: ItemSort = "created_desc";

/** Archived items stay hidden unless the URL asks for them. */
export const DEFAULT_STATUSES = ["pending_tagging", "tagged", "confirmed"] as const satisfies readonly ItemStatus[];

export const ITEM_FILTER_LIMITS = {
  /** Characters of search text kept; the search input uses it as maxLength. */
  qMax: 100,
  /** Colours kept from the URL. */
  colorsMax: 10,
  /** A longer colour cannot match a stored one (TAG_LIMITS.listEntryMax). */
  colorMax: TAG_LIMITS.listEntryMax,
} as const;

export type ItemFilters = {
  /** Trimmed search text; '' means no search. */
  q: string;
  category: ItemCategory[];
  season: Season[];
  warmthMin: WarmthLevel | null;
  warmthMax: WarmthLevel | null;
  waterproof: boolean | null;
  windproof: boolean | null;
  /** Lowercased, trimmed, unique and sorted. */
  color: string[];
  formality: Formality[];
  condition: ItemCondition[];
  location: ItemLocation[];
  decision: ItemDecision[];
  /** Never empty: DEFAULT_STATUSES when the URL names none. */
  status: ItemStatus[];
  sort: ItemSort;
};

/** URL parameter names, in the order serializeItemFilters writes them. */
export const ITEM_FILTER_PARAMS = [
  "q",
  "category",
  "season",
  "warmthMin",
  "warmthMax",
  "waterproof",
  "windproof",
  "color",
  "formality",
  "condition",
  "location",
  "decision",
  "status",
  "sort",
] as const satisfies readonly (keyof ItemFilters)[];
export type ItemFilterParam = (typeof ITEM_FILTER_PARAMS)[number];

export const DEFAULT_ITEM_FILTERS: Readonly<ItemFilters> = Object.freeze({
  q: "",
  category: [],
  season: [],
  warmthMin: null,
  warmthMax: null,
  waterproof: null,
  windproof: null,
  color: [],
  formality: [],
  condition: [],
  location: [],
  decision: [],
  status: [...DEFAULT_STATUSES],
  sort: DEFAULT_SORT,
});

export type ItemFiltersInput = URLSearchParams | Record<string, string | string[] | undefined>;

function valuesOf(input: ItemFiltersInput, key: string): string[] {
  // A record value is never a function, so this tells the two shapes apart
  // without instanceof (ReadonlyURLSearchParams from useSearchParams extends
  // URLSearchParams, but a check across realms would still miss it).
  if (typeof input.getAll === "function") return (input as URLSearchParams).getAll(key);
  const value = (input as Record<string, string | string[] | undefined>)[key];
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

/** The valid values present, deduplicated, in the enum's order. */
function pickEnum<const T extends string>(allowed: readonly T[], values: readonly string[]): T[] {
  const present = new Set(values);
  return allowed.filter((value) => present.has(value));
}

function parseWarmth(values: readonly string[]): WarmthLevel | null {
  const first = values[0];
  if (first === undefined || !/^[1-5]$/.test(first)) return null;
  const level = Number(first);
  return WARMTH_LEVELS.find((candidate) => candidate === level) ?? null;
}

function parseBoolean(values: readonly string[]): boolean | null {
  const first = values[0];
  if (first === "true") return true;
  if (first === "false") return false;
  return null;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Postgres text cannot hold U+0000 (it rejects the whole query), and no
 * control can type one, so a NUL in a crafted URL is dropped like any other
 * invalid value instead of failing the page.
 */
function withoutNul(text: string): string {
  return text.replaceAll("\u0000", "");
}

/** Trims and caps search text without splitting a surrogate pair at the cut. */
export function normalizeSearchText(raw: string): string {
  let text = withoutNul(raw).trim();
  if (text.length > ITEM_FILTER_LIMITS.qMax) {
    text = text.slice(0, ITEM_FILTER_LIMITS.qMax);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    text = text.trim();
  }
  return text;
}

/** Lowercases, trims, drops blanks and over-long entries, deduplicates, sorts and caps colours. */
export function normalizeColors(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const color = withoutNul(value).trim().toLowerCase();
    if (color !== "" && color.length <= ITEM_FILTER_LIMITS.colorMax) unique.add(color);
  }
  return [...unique].sort(compareCodeUnits).slice(0, ITEM_FILTER_LIMITS.colorsMax);
}

/**
 * Reads filters from URLSearchParams (useSearchParams) or a Next searchParams
 * record. Never throws: unknown keys are ignored, invalid values dropped,
 * a reversed warmth range swapped and defaults applied.
 */
export function parseItemFilters(input: ItemFiltersInput): ItemFilters {
  let warmthMin = parseWarmth(valuesOf(input, "warmthMin"));
  let warmthMax = parseWarmth(valuesOf(input, "warmthMax"));
  if (warmthMin !== null && warmthMax !== null && warmthMin > warmthMax) {
    [warmthMin, warmthMax] = [warmthMax, warmthMin];
  }

  const status = pickEnum(ITEM_STATUSES, valuesOf(input, "status"));
  const sort = valuesOf(input, "sort")[0];

  return {
    q: normalizeSearchText(valuesOf(input, "q")[0] ?? ""),
    category: pickEnum(ITEM_CATEGORIES, valuesOf(input, "category")),
    season: pickEnum(SEASONS, valuesOf(input, "season")),
    warmthMin,
    warmthMax,
    waterproof: parseBoolean(valuesOf(input, "waterproof")),
    windproof: parseBoolean(valuesOf(input, "windproof")),
    color: normalizeColors(valuesOf(input, "color")),
    formality: pickEnum(FORMALITIES, valuesOf(input, "formality")),
    condition: pickEnum(ITEM_CONDITIONS, valuesOf(input, "condition")),
    location: pickEnum(ITEM_LOCATIONS, valuesOf(input, "location")),
    decision: pickEnum(ITEM_DECISIONS, valuesOf(input, "decision")),
    status: status.length > 0 ? status : [...DEFAULT_STATUSES],
    sort: ITEM_SORTS.find((candidate) => candidate === sort) ?? DEFAULT_SORT,
  };
}

/**
 * The Untagged chip's view: only items waiting for tags, with no category
 * chosen (D-108). An item waiting for tags has no category, so no category
 * chip can show it.
 */
export function isUntaggedView(filters: Pick<ItemFilters, "category" | "status">): boolean {
  return filters.category.length === 0 && filters.status.length === 1 && filters.status[0] === "pending_tagging";
}

/**
 * The statuses the list shows after pressing All or a category chip: leaving
 * the Untagged view goes back to the default ones, any other status choice is
 * kept. The chips' counts use the same rule, so each badge shows what pressing
 * its chip gives.
 */
export function statusesAfterChip(filters: Pick<ItemFilters, "category" | "status">): ItemStatus[] {
  return isUntaggedView(filters) ? [...DEFAULT_STATUSES] : [...filters.status];
}

/** True when the statuses are exactly the default set (in any order). */
export function isDefaultStatuses(statuses: readonly ItemStatus[]): boolean {
  const present = new Set(statuses);
  return present.size === DEFAULT_STATUSES.length && DEFAULT_STATUSES.every((status) => present.has(status));
}

/**
 * Writes filters as URL parameters, leaving out defaults, in the order of
 * ITEM_FILTER_PARAMS. Input that did not come from parseItemFilters is
 * normalised the same way first, so equal filters always give the same string.
 * An empty status list counts as the default.
 */
export function serializeItemFilters(filters: ItemFilters): URLSearchParams {
  const params = new URLSearchParams();
  const appendAll = (key: ItemFilterParam, values: readonly string[]) => {
    for (const value of values) params.append(key, value);
  };

  const q = normalizeSearchText(filters.q);
  if (q !== "") params.append("q", q);
  appendAll("category", pickEnum(ITEM_CATEGORIES, filters.category));
  appendAll("season", pickEnum(SEASONS, filters.season));

  let { warmthMin, warmthMax } = filters;
  if (warmthMin !== null && warmthMax !== null && warmthMin > warmthMax) {
    [warmthMin, warmthMax] = [warmthMax, warmthMin];
  }
  if (warmthMin !== null) params.append("warmthMin", String(warmthMin));
  if (warmthMax !== null) params.append("warmthMax", String(warmthMax));

  if (filters.waterproof !== null) params.append("waterproof", String(filters.waterproof));
  if (filters.windproof !== null) params.append("windproof", String(filters.windproof));
  appendAll("color", normalizeColors(filters.color));
  appendAll("formality", pickEnum(FORMALITIES, filters.formality));
  appendAll("condition", pickEnum(ITEM_CONDITIONS, filters.condition));
  appendAll("location", pickEnum(ITEM_LOCATIONS, filters.location));
  appendAll("decision", pickEnum(ITEM_DECISIONS, filters.decision));

  const status = pickEnum(ITEM_STATUSES, filters.status);
  if (status.length > 0 && !isDefaultStatuses(status)) appendAll("status", status);
  if (filters.sort !== DEFAULT_SORT) params.append("sort", filters.sort);
  return params;
}

/**
 * The canonical query string of the filters ('' for the defaults). Equal
 * filters give equal keys, so it serves as a Suspense key and as a cheap
 * "did anything change" check before router.replace.
 */
export function itemFiltersKey(filters: ItemFilters): string {
  return serializeItemFilters(filters).toString();
}

/**
 * Filters set in the Filters panel, counted once per field (the warmth range
 * counts once). q and category are left out: they have their own controls.
 */
export function activeFilterCount(filters: ItemFilters): number {
  const active = [
    filters.season.length > 0,
    filters.warmthMin !== null || filters.warmthMax !== null,
    filters.waterproof !== null,
    filters.windproof !== null,
    filters.color.length > 0,
    filters.formality.length > 0,
    filters.condition.length > 0,
    filters.location.length > 0,
    filters.decision.length > 0,
    filters.status.length > 0 && !isDefaultStatuses(filters.status),
  ];
  return active.filter(Boolean).length;
}

/** True when anything narrows the list beyond the defaults; the sort order does not count. */
export function hasActiveFilters(filters: ItemFilters): boolean {
  return normalizeSearchText(filters.q) !== "" || filters.category.length > 0 || activeFilterCount(filters) > 0;
}
