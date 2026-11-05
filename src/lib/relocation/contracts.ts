// The relocation feature's shared contract: constants, input schemas and the
// DTOs that services, actions, routes and the /relocate, /shopping and
// /settings/climate screens exchange. Client- and server-safe: value imports
// are zod and the enum lists only (type imports are erased), so client
// components can validate forms with the same schemas the actions apply.

import { z } from "zod";

import type { ClimateMonth } from "@/lib/climate/types";
import {
  ITEM_CATEGORIES,
  type AnalysisStatus,
  type ItemCategory,
  type ItemCollection,
  type ItemDecision,
  type ItemLocation,
  type ItemStatus,
  type PackingGroup,
  type PartStatus,
  type ShoppingStatus,
} from "@/lib/db/enums";
import type { RelocationAnalysis } from "@/lib/relocation/schemas";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** What the analysis may decide per item; items.decision adds "undecided" for the owner. */
export const RELOCATION_DECISIONS = ["bring", "leave", "donate", "sell"] as const;
export type RelocationDecision = (typeof RELOCATION_DECISIONS)[number];

/** When to buy a gap (D-027; design.md's after_move_in_hamburg is after_move). */
export const BUY_TIMINGS = ["before_move", "after_move", "either"] as const;
export type BuyTiming = (typeof BUY_TIMINGS)[number];

/** 1 = most important. Used by item decisions, gaps and the shopping list. */
export const RELOCATION_PRIORITIES = [1, 2, 3] as const;
export type RelocationPriority = (typeof RELOCATION_PRIORITIES)[number];

/** The effort levels CLAUDE_ANALYSIS_EFFORT accepts. */
export const RELOCATION_EFFORTS = ["low", "medium", "high"] as const;
export type RelocationEffort = (typeof RELOCATION_EFFORTS)[number];

export const MAX_CONSTRAINTS_CHARS = 2000;
/** Items per chunk call: keeps each Sonnet call well inside the 300 s function limit (D-025). */
export const MAX_ITEMS_PER_CHUNK = 70;
/** Tag confidences below this get an lc: marker in the item line (D-028). */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;
/** Upper limit of the purchase budget and of any price in euros. */
export const MAX_EUR = 100_000;
/** The longest date range the form accepts. */
export const MAX_RANGE_YEARS = 3;

// ---------------------------------------------------------------------------
// The destination
// ---------------------------------------------------------------------------

/** Item locations a climate profile can stand for (its slug); in_transit and unknown are not places. */
const DESTINATION_LOCATIONS = ["bologna", "hamburg"] as const satisfies readonly ItemLocation[];
export type DestinationLocation = (typeof DESTINATION_LOCATIONS)[number];

/** The item location that means "already at the destination" for a profile slug, or null for any other profile. */
export function destinationLocation(profileSlug: string): DestinationLocation | null {
  return DESTINATION_LOCATIONS.find((location) => location === profileSlug) ?? null;
}

/**
 * Whether an item is already at the run's destination ("there") or on its
 * way there ("in_transit"), relative to that destination (D-170). in_transit
 * means on the way to Hamburg, the move the app is built for, so it counts
 * only for a Hamburg run. Shared by the item lines, the computed warnings and
 * the Packing tab.
 */
export function placeAtDestination(
  location: ItemLocation,
  destination: DestinationLocation | null,
): "there" | "in_transit" | null {
  if (destination !== null && location === destination) return "there";
  if (location === "in_transit" && destination === "hamburg") return "in_transit";
  return null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a YYYY-MM-DD string that names a real calendar day; null otherwise. */
export function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 2027-02-29 over to March 1; a real day survives the round trip.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The calendar day `years` years after a YYYY-MM-DD date (Feb 29 rolls over to Mar 1). */
function addYears(value: string, years: number): string {
  const parsed = parseIsoDate(value);
  if (!parsed) throw new RangeError(`Not a valid date: ${value}`);
  return formatUtcDate(new Date(Date.UTC(parsed.year + years, parsed.month - 1, parsed.day)));
}

/** A real calendar day as YYYY-MM-DD. */
export const IsoDateSchema = z
  .string()
  .refine((value) => parseIsoDate(value) !== null, { error: "Use a real date in the form YYYY-MM-DD." });

/** The owner's calendar day in a time zone, as YYYY-MM-DD. */
function calendarDay(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/**
 * The form's default range: today and the same day 12 months later minus one
 * day (2026-11-03 to 2027-11-02). "Today" is the calendar day in Europe/Berlin
 * unless another zone is given, so a server render and the browser agree.
 */
export function defaultRelocationDates(
  today: Date,
  timeZone = "Europe/Berlin",
): { dateFrom: string; dateTo: string } {
  const { year, month, day } = calendarDay(today, timeZone);
  const from = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls an overflowing day forward, so Feb 29 + 12 months - 1 day is Feb 28.
  const to = new Date(Date.UTC(year + 1, month - 1, day) - 86_400_000);
  return { dateFrom: formatUtcDate(from), dateTo: formatUtcDate(to) };
}

// ---------------------------------------------------------------------------
// Run parameters
// ---------------------------------------------------------------------------

/**
 * Trims and collapses every run of whitespace (newlines included) to one
 * space. The prompt and the cache key both use this form, so constraints that
 * differ only in spacing are the same run.
 */
export function normalizeConstraints(constraints: string): string {
  return constraints.replace(/\s+/g, " ").trim();
}

/** The relocation form, stored as analyses.params. Strict: actions take it as input. */
export const RelocationParamsSchema = z
  .strictObject({
    climateProfileId: z.uuid({ error: "Choose a climate profile." }),
    dateFrom: IsoDateSchema,
    dateTo: IsoDateSchema,
    constraints: z
      .string()
      .trim()
      .max(MAX_CONSTRAINTS_CHARS, { error: `Keep the constraints under ${MAX_CONSTRAINTS_CHARS} characters.` }),
    /** null = no budget given. */
    purchaseBudgetEur: z
      .number()
      .int({ error: "Use whole euros." })
      .min(0)
      .max(MAX_EUR, { error: `The budget can be at most €${MAX_EUR.toLocaleString("en-US")}.` })
      .nullable(),
    includeOnlyConfirmed: z.boolean().default(true),
    /** The owner chose to run on a placeholder climate profile anyway. */
    acceptPlaceholder: z.boolean().default(false),
  })
  .superRefine((params, ctx) => {
    if (parseIsoDate(params.dateFrom) === null || parseIsoDate(params.dateTo) === null) return;
    if (params.dateTo < params.dateFrom) {
      ctx.addIssue({ code: "custom", path: ["dateTo"], message: "The end date must not be before the start date." });
    } else if (params.dateTo > addYears(params.dateFrom, MAX_RANGE_YEARS)) {
      ctx.addIssue({
        code: "custom",
        path: ["dateTo"],
        message: `The range can be at most ${MAX_RANGE_YEARS} years.`,
      });
    }
  });
export type RelocationParams = z.infer<typeof RelocationParamsSchema>;
/** What a form may send: the booleans have defaults. */
export type RelocationParamsInput = z.input<typeof RelocationParamsSchema>;

// ---------------------------------------------------------------------------
// Relocation DTOs
// ---------------------------------------------------------------------------

/** The pre-run estimate the form shows; refreshed on every form change. */
export type RelocationEstimateDto = {
  /** Items the snapshot holds (the run decides each). */
  itemCount: number;
  /**
   * Items left out and why (D-028). unconfirmed is 0 when tagged items are
   * included; running counts running gear, whatever its status (D-249).
   */
  excluded: { pending: number; archived: number; unconfirmed: number; running: number };
  chunkCount: number;
  /** Months of the range in order, the arrival month first. */
  months: number[];
  model: string;
  effort: RelocationEffort;
  usd: number;
  lowUsd: number;
  highUsd: number;
  /** The chosen climate profile is a placeholder. */
  placeholder: boolean;
  /** An identical completed run; the form offers it instead of a new one. */
  cached: { analysisId: string; completedAt: string } | null;
  /**
   * The synthesis would need more output than one part allows at this effort
   * (it lists every item that could be decided bring), so Run is refused (D-175).
   */
  tooLarge: boolean;
  budget: { monthToDateUsd: number; budgetUsd: number; remainingUsd: number; blocked: boolean };
};

export type StartRelocationResult = { kind: "cached"; analysisId: string } | { kind: "started"; analysisId: string };

export type RelocationPartDto = {
  id: string;
  kind: "chunk" | "synthesis";
  partIndex: number;
  status: PartStatus;
  /** Items in a chunk; every snapshot item for the synthesis. */
  itemCount: number;
  costUsd: number;
  attempts: number;
  error: string | null;
};

export type RelocationRunDto = {
  analysisId: string;
  status: AnalysisStatus;
  parts: RelocationPartDto[];
  estimatedCostUsd: number | null;
  costUsd: number;
};

export type RelocationListItemDto = {
  id: string;
  /** ISO 8601 timestamps. */
  createdAt: string;
  completedAt: string | null;
  status: AnalysisStatus;
  city: string | null;
  isPlaceholder: boolean;
  months: number[];
  itemCount: number;
  estimatedCostUsd: number | null;
  costUsd: number;
};

export type ThumbRef = { url: string; width: number; height: number };

export type RelocationItemRefDto = {
  id: string;
  name: string;
  category: ItemCategory | null;
  thumb: ThumbRef | null;
  /** The owner's items.decision now (an override shows here). */
  currentDecision: ItemDecision;
  /** null when the item no longer exists. */
  status: ItemStatus | null;
  /**
   * Where the item is now; null when it no longer exists. Items already at
   * the run's destination, or in transit on a Hamburg run
   * (placeAtDestination, D-170), need no packing, whatever the run decided.
   */
  location: ItemLocation | null;
  /**
   * The item's collection now; null when it no longer exists. "Apply AI
   * decisions" writes only to clothing, so an item moved to running gear
   * since the run is not counted as undecided for it (D-249).
   */
  collection: ItemCollection | null;
  /** false = deleted since the run; status "archived" = archived since. */
  exists: boolean;
};

export type PackingRowDto = {
  id: string;
  group: PackingGroup;
  label: string;
  /** null for an extra (free text) row. */
  itemId: string | null;
  packed: boolean;
  sortOrder: number;
};

export type RelocationViewDto = {
  id: string;
  createdAt: string;
  completedAt: string | null;
  status: AnalysisStatus;
  model: string;
  effort: RelocationEffort | null;
  promptVersion: string;
  estimatedCostUsd: number | null;
  costUsd: number;
  params: RelocationParams;
  months: number[];
  profile: { id: string; city: string; country: string; isPlaceholder: boolean } | null;
  /**
   * The item location that counts as already at the run's destination (D-170);
   * runs stored before it were all planned as moves to Hamburg.
   */
  destination: DestinationLocation | null;
  result: RelocationAnalysis;
  /** Every item the result names, keyed by item id. */
  items: Record<string, RelocationItemRefDto>;
  packing: PackingRowDto[];
  /** Gaps already on the shopping list for this analysis. */
  addedGapKeys: string[];
};

// ---------------------------------------------------------------------------
// Climate profiles
// ---------------------------------------------------------------------------

export type ClimateProfileDto = {
  id: string;
  slug: string;
  city: string;
  country: string;
  source: string;
  isDefault: boolean;
  isPlaceholder: boolean;
  /** Every value of every month is filled in. */
  complete: boolean;
  months: ClimateMonth[];
  windNotes: string;
  notes: string;
};

// ---------------------------------------------------------------------------
// Shopping list
// ---------------------------------------------------------------------------

export const SHOPPING_LIMITS = {
  itemTypeMax: 120,
  reasonMax: 500,
  specsMax: 10,
  specMax: 120,
  quantityMin: 1,
  quantityMax: 10,
} as const;

export type ShoppingItemDto = {
  id: string;
  analysisId: string | null;
  itemType: string;
  category: ItemCategory | null;
  priority: RelocationPriority;
  reason: string;
  specs: string[];
  quantity: number;
  estPriceMinEur: number | null;
  estPriceMaxEur: number | null;
  buyTiming: BuyTiming | null;
  status: ShoppingStatus;
  linkedItem: { id: string; name: string; thumb: ThumbRef | null } | null;
  gapKey: string | null;
  createdAt: string;
};

const priceEur = z.number().int({ error: "Use whole euros." }).min(0).max(MAX_EUR).nullable();

/** A manually added shopping list entry. Optional fields default to an empty entry. */
export const ShoppingItemInputSchema = z
  .strictObject({
    itemType: z.string().trim().min(1, { error: "Say what to buy." }).max(SHOPPING_LIMITS.itemTypeMax),
    category: z.enum(ITEM_CATEGORIES).nullable().default(null),
    priority: z.literal(RELOCATION_PRIORITIES).default(2),
    reason: z.string().trim().max(SHOPPING_LIMITS.reasonMax).default(""),
    specs: z
      .array(z.string().trim().min(1).max(SHOPPING_LIMITS.specMax))
      .max(SHOPPING_LIMITS.specsMax)
      .default([]),
    quantity: z.number().int().min(SHOPPING_LIMITS.quantityMin).max(SHOPPING_LIMITS.quantityMax).default(1),
    estPriceMinEur: priceEur.default(null),
    estPriceMaxEur: priceEur.default(null),
    buyTiming: z.enum(BUY_TIMINGS).nullable().default(null),
  })
  .superRefine((input, ctx) => {
    if (input.estPriceMinEur !== null && input.estPriceMaxEur !== null && input.estPriceMinEur > input.estPriceMaxEur) {
      ctx.addIssue({
        code: "custom",
        path: ["estPriceMaxEur"],
        message: "The highest price must not be below the lowest.",
      });
    }
  });
export type ShoppingItemInput = z.infer<typeof ShoppingItemInputSchema>;

export type ShoppingListDto = {
  items: ShoppingItemDto[];
  /** The purchase budget of the latest relocation run, to prefill /shopping. */
  latestBudgetEur: number | null;
  latestAnalysisId: string | null;
};
