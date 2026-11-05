import "server-only";

import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { aiSettingsEnv } from "@/env";
import { assertWithinBudget, getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget";
import { callStructured, type CallStructuredResult } from "@/lib/ai/call";
import type { AnthropicLike } from "@/lib/ai/client";
import { computeCostUsd } from "@/lib/ai/cost";
import { isPricedModel, type PricedModelId } from "@/lib/ai/models";
import { requireSession } from "@/lib/auth/dal";
import { describeClimateForPrompt, monthsInRange } from "@/lib/climate/range";
import type { Db } from "@/lib/db/client";
import { ITEM_CATEGORIES, PACKING_GROUPS, type AiPurpose } from "@/lib/db/enums";
import {
  aiCalls,
  analyses,
  analysisParts,
  climateProfiles,
  itemImages,
  items,
  packingChecklistItems,
  shoppingListItems,
  type Analysis,
  type AnalysisPart,
  type ClimateProfile,
  type PackingChecklistItem,
} from "@/lib/db/schema";
import { isUuid } from "@/lib/items/contracts";
import { itemDisplayName } from "@/lib/items/wardrobe";
import { planChunks, relocationCacheKey, type RelocationChunk } from "@/lib/relocation/chunks";
import {
  destinationLocation,
  placeAtDestination,
  RELOCATION_EFFORTS,
  RelocationParamsSchema,
  type PackingRowDto,
  type RelocationDecision,
  type RelocationEffort,
  type RelocationEstimateDto,
  type RelocationItemRefDto,
  type RelocationListItemDto,
  type RelocationParams,
  type RelocationParamsInput,
  type RelocationPartDto,
  type RelocationRunDto,
  type RelocationViewDto,
  type StartRelocationResult,
} from "@/lib/relocation/contracts";
import {
  estimateChunkInputTokens,
  estimateRelocationCost,
  estimateSynthesisInputTokens,
  RELOCATION_ESTIMATE,
  synthesisFitsOutputCap,
  synthesisOutputTokens,
  withThinkingAllowance,
  type RelocationCostEstimate,
} from "@/lib/relocation/estimate";
import { buildSnapshot, type RelocationSnapshot } from "@/lib/relocation/payload";
import {
  buildChunkInstruction,
  buildRepairInstruction,
  buildSharedContext,
  buildSynthesisInstruction,
  formatDecisionLine,
  RELOC_PROMPT_VERSION,
  RELOCATION_CALL_PARAMS,
  RELOCATION_SYSTEM_PROMPT,
} from "@/lib/relocation/prompts";
import {
  ChunkWireSchema,
  makeChunkStrictSchema,
  makeGapKey,
  makeRelocationAnalysisSchema,
  makeSynthesisStrictSchema,
  priorityGapsMinimumEur,
  RelocationAnalysisSchema,
  SynthesisWireSchema,
  type ChunkDecision,
  type RelocationAnalysis,
  type RelocationWarning,
  type SynthesisWire,
} from "@/lib/relocation/schemas";
import { AppError, CONFIG_ERROR_MESSAGE, INTERNAL_ERROR_MESSAGE } from "@/lib/result";

// The relocation analysis (D-025 to D-029): estimate, start, the resumable
// parts the browser runs (category chunks, then one synthesis that finalizes
// the run), and the reads and mutations of the result screen.
//
// A run reads the database once, at start. Everything a part needs (the item
// lines, the alias map, the climate text, the chunk plan, display names) is
// stored in analyses.input_snapshot, so items edited, archived or deleted
// mid-run cannot change what the run decides, and every part sends a
// byte-identical shared context that parallel chunks can read from the cache.

// ---------------------------------------------------------------------------
// Constants and stored shapes
// ---------------------------------------------------------------------------

/**
 * A running part counts as taken for this long. The part route stops calling
 * Claude at 270 s and the function ends at 300 s, so a part still "running"
 * after 5 minutes was cut off and Retry may take it again.
 */
export const PART_LEASE_MS = 5 * 60_000;
/** Analyses listed under the form. */
export const RELOCATION_LIST_LIMIT = 20;
/** Longest packing extra label (matches the synthesis extras limit). */
export const MAX_PACKING_LABEL = 120;
/** Longest error text stored on a part; the progress list shows it in a line or two. */
export const MAX_PART_ERROR_LENGTH = 300;

const StoredLineSchema = z.object({
  alias: z.string(),
  itemId: z.string(),
  category: z.enum(ITEM_CATEGORIES).nullable(),
  subcategory: z.string().nullable(),
  text: z.string(),
});

const StoredSnapshotSchema = z.object({
  lines: z.array(StoredLineSchema),
  legend: z.string(),
  /** alias -> item id. */
  aliasMap: z.record(z.string(), z.string()),
  summaryText: z.string(),
  climateText: z.string(),
  /** Months in range order, arrival first. */
  months: z.array(z.number().int().min(1).max(12)),
  chunks: z.array(
    z.object({ index: z.number().int().min(0), aliases: z.array(z.string()), categories: z.array(z.string()) }),
  ),
  /** item id -> display name at start: packing labels, and the name of an item deleted since. */
  names: z.record(z.string(), z.string()),
  /** Item ids already at the run's destination or on their way there at start (never packed, D-170). */
  moved: z.array(z.string()),
  /**
   * The climate profile as the run used it. Its slug names the destination
   * (D-170); runs stored before that have none and were planned for Hamburg.
   */
  profile: z.object({
    id: z.string(),
    city: z.string(),
    country: z.string(),
    isPlaceholder: z.boolean(),
    slug: z.string().optional(),
  }),
});

/** analyses.input_snapshot of a relocation run. Exported as a type for e2e seeds that insert runs. */
export type RelocationInputSnapshot = z.infer<typeof StoredSnapshotSchema>;

const ChunkPartInputSchema = z.object({ aliases: z.array(z.string()).min(1) });

const ChunkPartResultSchema = z.object({
  decisions: ChunkWireSchema.shape.decisions,
  /** Repair calls made for this chunk so far (one per run of the part). */
  repairCalls: z.number().int().min(0),
});

/**
 * analysis_parts.result of a chunk. A failed part keeps the decisions it got,
 * so Retry asks only for the missing items.
 */
export type ChunkPartResult = z.infer<typeof ChunkPartResultSchema>;

const EffortSchema = z.enum(RELOCATION_EFFORTS);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function analysisNotFound(analysisId: string): AppError {
  return new AppError("NOT_FOUND", "That relocation analysis does not exist.", { analysisId });
}

function partNotFound(partId: string): AppError {
  return new AppError("NOT_FOUND", "That part of the analysis does not exist.", { partId });
}

function unreadable(what: string, cause?: unknown): AppError {
  return new AppError("INTERNAL", `The stored ${what} could not be read.`, undefined, { cause });
}

function notComplete(analysisId: string, status: string): AppError {
  return new AppError("CONFLICT", "This analysis has not finished yet.", {
    analysisId,
    status,
    reason: "not_complete",
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What a failed part stores and shows: CONFIG and unexpected errors stay generic (D-053). */
export function partErrorMessage(error: unknown): string {
  if (!(error instanceof AppError) || error.code === "INTERNAL") return INTERNAL_ERROR_MESSAGE;
  if (error.code === "CONFIG") return CONFIG_ERROR_MESSAGE;
  return truncate(error.message, MAX_PART_ERROR_LENGTH);
}

function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 5).map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

function parseParams(input: RelocationParamsInput): RelocationParams {
  const parsed = RelocationParamsSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION", "Some fields are missing or invalid.", { issues: zodIssues(parsed.error) });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Planning a run (shared by the estimate and the start)
// ---------------------------------------------------------------------------

type RunPlan = {
  params: RelocationParams;
  profile: ClimateProfile;
  snapshot: RelocationSnapshot;
  months: number[];
  climateText: string;
  chunks: RelocationChunk[];
  sharedContext: string;
  model: PricedModelId;
  effort: RelocationEffort;
  cost: RelocationCostEstimate;
  cacheKey: string;
  names: Record<string, string>;
  moved: string[];
  /** The synthesis would not fit its output cap at this effort (D-175). */
  tooLarge: boolean;
};

/** Model and effort without the API key (D-064), so the estimate works before the key exists. */
function analysisSettings(): { model: PricedModelId; effort: RelocationEffort } {
  const settings = aiSettingsEnv();
  return { model: settings.models.analysis, effort: settings.CLAUDE_ANALYSIS_EFFORT };
}

function linesFor<L extends { alias: string }>(aliases: readonly string[], byAlias: ReadonlyMap<string, L>): L[] {
  return aliases.map((alias) => {
    const line = byAlias.get(alias);
    if (line === undefined) throw new AppError("INTERNAL", `The run has no item line for ${alias}.`);
    return line;
  });
}

function sharedContextOf(input: {
  climateText: string;
  months: readonly number[];
  params: Pick<RelocationParams, "constraints" | "purchaseBudgetEur">;
  summaryText: string;
  legend: string;
}): string {
  return buildSharedContext({
    climateText: input.climateText,
    months: input.months,
    constraints: input.params.constraints,
    purchaseBudgetEur: input.params.purchaseBudgetEur,
    summaryText: input.summaryText,
    legend: input.legend,
  });
}

async function planRun(db: Db, params: RelocationParams): Promise<RunPlan> {
  const { model, effort } = analysisSettings();
  // Every item, archived ones and running gear included, so the form can say how many were left out (D-249).
  const [[profile], rows] = await Promise.all([
    db.select().from(climateProfiles).where(eq(climateProfiles.id, params.climateProfileId)),
    db
      .select({
        id: items.id,
        createdAt: items.createdAt,
        name: items.name,
        category: items.category,
        subcategory: items.subcategory,
        colors: items.colors,
        materials: items.materials,
        materialGuess: items.materialGuess,
        warmthLevel: items.warmthLevel,
        waterproof: items.waterproof,
        windproof: items.windproof,
        insulated: items.insulated,
        breathable: items.breathable,
        seasons: items.seasons,
        formality: items.formality,
        condition: items.condition,
        status: items.status,
        location: items.location,
        collection: items.collection,
        aiConfidence: items.aiConfidence,
        userEditedFields: items.userEditedFields,
      })
      .from(items),
  ]);
  if (profile === undefined) {
    throw new AppError("NOT_FOUND", "That climate profile no longer exists. Choose another one.", {
      climateProfileId: params.climateProfileId,
    });
  }

  const destination = destinationLocation(profile.slug);
  const snapshot = buildSnapshot(rows, { includeOnlyConfirmed: params.includeOnlyConfirmed, destination });
  const months = monthsInRange(params.dateFrom, params.dateTo);
  const climateText = describeClimateForPrompt(profile, months);
  const chunks = planChunks(snapshot.lines);
  const sharedContext = sharedContextOf({
    climateText,
    months,
    params,
    summaryText: snapshot.summaryText,
    legend: snapshot.legend,
  });

  const byAlias = new Map(snapshot.lines.map((line) => [line.alias, line]));
  const cost = estimateRelocationCost({
    model,
    effort,
    chunkInputTokens: chunks.map((chunk) => estimateChunkInputTokens(sharedContext, linesFor(chunk.aliases, byAlias))),
    synthesisInputTokens: snapshot.lines.length === 0 ? 0 : estimateSynthesisInputTokens(sharedContext, snapshot.lines),
    itemCount: snapshot.lines.length,
  });
  const cacheKey = relocationCacheKey({
    promptVersion: RELOC_PROMPT_VERSION,
    model,
    effort,
    snapshotHash: snapshot.snapshotHash,
    climateText,
    months,
    constraints: params.constraints,
    purchaseBudgetEur: params.purchaseBudgetEur,
    includeOnlyConfirmed: params.includeOnlyConfirmed,
  });

  const included = new Set(snapshot.lines.map((line) => line.itemId));
  const names: Record<string, string> = {};
  const moved: string[] = [];
  for (const row of rows) {
    if (!included.has(row.id)) continue;
    names[row.id] = itemDisplayName(row);
    if (placeAtDestination(row.location, destination) !== null) moved.push(row.id);
  }

  return {
    params,
    profile,
    snapshot,
    months,
    climateText,
    chunks,
    sharedContext,
    model,
    effort,
    cost,
    cacheKey,
    names,
    moved,
    tooLarge: !synthesisFitsOutputCap(snapshot.lines.length, effort),
  };
}

/** The newest complete relocation run with this cache key (D-028). */
async function findCachedRun(db: Db, cacheKey: string): Promise<{ analysisId: string; completedAt: string } | null> {
  const [row] = await db
    .select({ id: analyses.id, completedAt: analyses.completedAt, createdAt: analyses.createdAt })
    .from(analyses)
    .where(and(eq(analyses.kind, "relocation"), eq(analyses.status, "complete"), eq(analyses.cacheKey, cacheKey)))
    .orderBy(desc(analyses.completedAt), desc(analyses.createdAt))
    .limit(1);
  if (row === undefined) return null;
  return { analysisId: row.id, completedAt: (row.completedAt ?? row.createdAt).toISOString() };
}

function micros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** The budget line of the estimate; `blocked` uses assertWithinBudget's arithmetic (D-063). */
function budgetView(status: BudgetStatus, estimateUsd: number): RelocationEstimateDto["budget"] {
  const budget = micros(status.budgetUsd);
  const spent = micros(status.spentUsd);
  const blocked = spent >= budget || spent + micros(status.pendingBatchUsd) + micros(estimateUsd) > budget;
  return {
    monthToDateUsd: status.spentUsd,
    budgetUsd: status.budgetUsd,
    remainingUsd: status.remainingUsd,
    blocked,
  };
}

// ---------------------------------------------------------------------------
// Estimate and start
// ---------------------------------------------------------------------------

export type RelocationClockOptions = {
  /** Epoch ms; defaults to Date.now (the budget month). */
  now?: () => number;
};

/**
 * The pre-run estimate the form shows: snapshot counts, chunks, cost range,
 * an identical finished run if there is one, and the budget. Makes no Claude
 * call and writes nothing; works without the API key.
 */
export async function estimateRelocation(
  db: Db,
  input: RelocationParamsInput,
  options: RelocationClockOptions = {},
): Promise<RelocationEstimateDto> {
  await requireSession();
  const now = options.now ?? Date.now;
  const plan = await planRun(db, parseParams(input));
  const [cached, budget] = await Promise.all([
    findCachedRun(db, plan.cacheKey),
    getBudgetStatus(db, new Date(now())),
  ]);
  return {
    itemCount: plan.snapshot.lines.length,
    excluded: plan.snapshot.excluded,
    chunkCount: plan.chunks.length,
    months: plan.months,
    model: plan.model,
    effort: plan.effort,
    usd: plan.cost.usd,
    lowUsd: plan.cost.lowUsd,
    highUsd: plan.cost.highUsd,
    placeholder: plan.profile.isPlaceholder,
    cached,
    tooLarge: plan.tooLarge,
    budget: budgetView(budget, plan.cost.usd),
  };
}

/**
 * Starts a run, or returns an identical finished one unless `force` ("Re-run
 * anyway"). Throws VALIDATION for a placeholder profile the owner has not
 * accepted, a snapshot without items or one too large for the synthesis's
 * output cap at this effort (D-175), NOT_FOUND for an unknown profile and
 * BUDGET_EXCEEDED when the estimate does not fit; none of these writes
 * anything. Otherwise inserts the analysis (status running, the snapshot)
 * with one part per chunk plus the synthesis, in one transaction.
 */
export async function startRelocation(
  db: Db,
  input: RelocationParamsInput,
  options: RelocationClockOptions & { force?: boolean } = {},
): Promise<StartRelocationResult> {
  await requireSession();
  const now = options.now ?? Date.now;
  const params = parseParams(input);
  const plan = await planRun(db, params);

  if (plan.profile.isPlaceholder && !params.acceptPlaceholder) {
    throw new AppError(
      "VALIDATION",
      `The ${truncate(plan.profile.city, 60)} climate profile is a placeholder with incomplete data. Confirm that you want to use it anyway, or complete it in Settings first.`,
      { reason: "placeholder_not_accepted", climateProfileId: plan.profile.id },
    );
  }
  if (plan.snapshot.lines.length === 0) {
    const { pending, archived, unconfirmed, running } = plan.snapshot.excluded;
    // Only running gear stood in the way: confirming or including tagged items cannot help (D-249).
    const onlyRunningGear = running > 0 && pending + archived + unconfirmed === 0;
    throw new AppError(
      "VALIDATION",
      onlyRunningGear
        ? "Only running gear is in the wardrobe, which the analysis leaves out. Add or confirm some clothes first."
        : params.includeOnlyConfirmed
          ? "There are no confirmed items to analyse. Confirm some tagged items first, or include unconfirmed ones."
          : "There are no tagged items to analyse. Add and tag some items first.",
      { reason: "no_items", excluded: plan.snapshot.excluded },
    );
  }
  if (options.force !== true) {
    const cached = await findCachedRun(db, plan.cacheKey);
    if (cached !== null) return { kind: "cached", analysisId: cached.analysisId };
  }
  if (plan.tooLarge) {
    // Every chunk would be paid for and then the synthesis would hit its
    // output cap on every Retry, so nothing is started (D-175).
    throw new AppError(
      "VALIDATION",
      `Too many items to plan in one pass at ${plan.effort} effort: the packing list would not fit in one part. Analyse fewer items, for example confirmed ones only, or set a lower analysis effort.`,
      { reason: "too_many_items", itemCount: plan.snapshot.lines.length, effort: plan.effort },
    );
  }

  await assertWithinBudget(db, { estimateUsd: plan.cost.usd, now: new Date(now()) });

  const inputSnapshot: RelocationInputSnapshot = {
    lines: plan.snapshot.lines,
    legend: plan.snapshot.legend,
    aliasMap: plan.snapshot.aliasMap,
    summaryText: plan.snapshot.summaryText,
    climateText: plan.climateText,
    months: plan.months,
    chunks: plan.chunks,
    names: plan.names,
    moved: plan.moved,
    profile: {
      id: plan.profile.id,
      city: plan.profile.city,
      country: plan.profile.country,
      isPlaceholder: plan.profile.isPlaceholder,
      slug: plan.profile.slug,
    },
  };

  const analysisId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(analyses)
      .values({
        kind: "relocation",
        status: "running",
        climateProfileId: plan.profile.id,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        params,
        model: plan.model,
        effort: plan.effort,
        promptVersion: RELOC_PROMPT_VERSION,
        inputSnapshotHash: plan.snapshot.snapshotHash,
        cacheKey: plan.cacheKey,
        inputSnapshot,
        estimatedCostUsd: plan.cost.usd,
      })
      .returning({ id: analyses.id });
    if (row === undefined) throw new AppError("INTERNAL", "The analysis could not be created.");
    await tx.insert(analysisParts).values([
      ...plan.chunks.map((chunk) => ({
        analysisId: row.id,
        kind: "chunk" as const,
        partIndex: chunk.index,
        input: { aliases: chunk.aliases },
      })),
      { analysisId: row.id, kind: "synthesis" as const, partIndex: 0, input: {} },
    ]);
    return row.id;
  });
  return { kind: "started", analysisId };
}

// ---------------------------------------------------------------------------
// Reading a stored run
// ---------------------------------------------------------------------------

type RunContext = {
  analysisId: string;
  model: PricedModelId;
  effort: RelocationEffort;
  params: RelocationParams;
  snapshot: RelocationInputSnapshot;
  sharedContext: string;
  estimatedCostUsd: number | null;
  byAlias: Map<string, RelocationInputSnapshot["lines"][number]>;
};

async function loadAnalysisRow(db: Db, analysisId: string): Promise<Analysis> {
  if (!isUuid(analysisId)) throw analysisNotFound(analysisId);
  const [row] = await db
    .select()
    .from(analyses)
    .where(and(eq(analyses.id, analysisId), eq(analyses.kind, "relocation")));
  if (row === undefined) throw analysisNotFound(analysisId);
  return row;
}

function readSnapshot(row: Pick<Analysis, "inputSnapshot">): RelocationInputSnapshot {
  const parsed = StoredSnapshotSchema.safeParse(row.inputSnapshot);
  if (!parsed.success) throw unreadable("analysis input", parsed.error);
  return parsed.data;
}

/**
 * The part of the snapshot the result screen reads: item categories and
 * names (for items deleted since), the months and the profile. A finished
 * run seeded for e2e needs only these, plus the result.
 */
const ViewSnapshotSchema = StoredSnapshotSchema.pick({ lines: true, names: true, months: true, profile: true });

function readParams(row: Pick<Analysis, "params">): RelocationParams {
  const parsed = RelocationParamsSchema.safeParse(row.params);
  if (!parsed.success) throw unreadable("analysis settings", parsed.error);
  return parsed.data;
}

function readRun(row: Analysis): RunContext {
  if (!isPricedModel(row.model)) throw unreadable("analysis model");
  const effort = EffortSchema.safeParse(row.effort);
  if (!effort.success) throw unreadable("analysis effort", effort.error);
  const params = readParams(row);
  const snapshot = readSnapshot(row);
  return {
    analysisId: row.id,
    model: row.model,
    effort: effort.data,
    params,
    snapshot,
    // Rebuilt from the stored pieces with the same builder, so every part of
    // the run sends the same bytes (the prompt cache depends on it).
    sharedContext: sharedContextOf({
      climateText: snapshot.climateText,
      months: snapshot.months,
      params,
      summaryText: snapshot.summaryText,
      legend: snapshot.legend,
    }),
    estimatedCostUsd: row.estimatedCostUsd,
    byAlias: new Map(snapshot.lines.map((line) => [line.alias, line])),
  };
}

/** Cost of every Claude attempt logged for the analysis, failed ones included (D-020). */
async function loggedCostUsd(db: Db, analysisId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`.mapWith(Number) })
    .from(aiCalls)
    .where(eq(aiCalls.analysisId, analysisId));
  return row?.total ?? 0;
}

/**
 * The run's parts in order (chunks by index, then the synthesis) with their
 * status, cost and error, for the progress list. costUsd is the stored total
 * of a finished run, otherwise every attempt logged so far.
 */
export async function getRelocationRun(db: Db, analysisId: string): Promise<RelocationRunDto> {
  await requireSession();
  if (!isUuid(analysisId)) throw analysisNotFound(analysisId);
  const [row] = await db
    .select({
      id: analyses.id,
      status: analyses.status,
      estimatedCostUsd: analyses.estimatedCostUsd,
      costUsd: analyses.costUsd,
    })
    .from(analyses)
    .where(and(eq(analyses.id, analysisId), eq(analyses.kind, "relocation")));
  if (row === undefined) throw analysisNotFound(analysisId);

  const [parts, costUsd] = await Promise.all([
    db
      .select({
        id: analysisParts.id,
        kind: analysisParts.kind,
        partIndex: analysisParts.partIndex,
        status: analysisParts.status,
        input: analysisParts.input,
        costUsd: analysisParts.costUsd,
        attempts: analysisParts.attempts,
        error: analysisParts.error,
      })
      .from(analysisParts)
      .where(eq(analysisParts.analysisId, analysisId))
      .orderBy(asc(analysisParts.kind), asc(analysisParts.partIndex)),
    row.status === "complete" ? Promise.resolve(row.costUsd) : loggedCostUsd(db, analysisId),
  ]);

  const chunkSizes = parts.map((part) => {
    if (part.kind !== "chunk") return 0;
    const input = ChunkPartInputSchema.safeParse(part.input);
    if (!input.success) throw unreadable("chunk input", input.error);
    return input.data.aliases.length;
  });
  const total = chunkSizes.reduce((sum, size) => sum + size, 0);

  return {
    analysisId: row.id,
    status: row.status,
    estimatedCostUsd: row.estimatedCostUsd,
    costUsd,
    parts: parts.map(
      (part, index): RelocationPartDto => ({
        id: part.id,
        kind: part.kind,
        partIndex: part.partIndex,
        status: part.status,
        itemCount: part.kind === "chunk" ? (chunkSizes[index] ?? 0) : total,
        costUsd: part.costUsd,
        attempts: part.attempts,
        error: part.error,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Running a part
// ---------------------------------------------------------------------------

export type RelocationPartDeps = {
  /** Called only when Claude is needed (D-064): re-running a finished part needs no API key. */
  anthropic: () => AnthropicLike;
  /** Epoch ms; defaults to Date.now. */
  now?: () => number;
  /**
   * Cancels the Claude call. The part route passes none: a part runs to its
   * end whether or not the tab that asked for it stays open, as on Vercel,
   * where a closed tab does not abort the request (D-167).
   */
  signal?: AbortSignal;
  /** Epoch ms by which Claude calls must be done; the route passes its start plus 270 s. */
  deadlineAt: number;
  /** Backoff jitter and waits between attempts; tests pass instant ones. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type RunPartOptions = {
  /**
   * The owner pressed Retry for this part. Only then does a failed part run
   * again: a re-ask the browser makes on its own (a tab that waited out
   * another tab's CONFLICT, a reloaded page) must not pay for it (D-157).
   */
  retry?: boolean;
};

/** "settled": nothing to run, answer with the run as it is. */
type LeaseState = "settled" | "free";

/**
 * A finished part needs nothing, and neither does a failed one unless the
 * owner asked for a Retry; one started less than PART_LEASE_MS ago is taken
 * (CONFLICT). A running part whose lease ran out was cut off and is free
 * without a Retry (D-145).
 */
function leaseState(
  part: Pick<AnalysisPart, "id" | "status" | "startedAt">,
  nowMs: number,
  retry: boolean,
): LeaseState {
  if (part.status === "complete") return "settled";
  if (part.status === "failed" && !retry) return "settled";
  if (part.status === "running" && part.startedAt !== null && nowMs - part.startedAt.getTime() < PART_LEASE_MS) {
    throw new AppError("CONFLICT", "This part is already running.", {
      partId: part.id,
      startedAt: part.startedAt.toISOString(),
      reason: "part_running",
    });
  }
  return "free";
}

type PartQueries = Pick<Db, "select">;

async function assertChunksComplete(db: PartQueries, analysisId: string): Promise<void> {
  const [row] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(analysisParts)
    .where(
      and(eq(analysisParts.analysisId, analysisId), eq(analysisParts.kind, "chunk"), ne(analysisParts.status, "complete")),
    );
  const pending = row?.count ?? 0;
  if (pending > 0) {
    throw new AppError("CONFLICT", "The synthesis can run once every chunk is done.", {
      pendingChunks: pending,
      reason: "chunks_incomplete",
    });
  }
}

/**
 * Takes the part under a row lock: running, startedAt now, attempts + 1. The
 * returned row's attempts count is the lease token: later writes only apply
 * while it still matches, so a part re-taken after a cut-off is not
 * overwritten by the earlier holder. Null when the part finished meanwhile,
 * or failed meanwhile and this is no Retry.
 */
async function leasePart(
  db: Db,
  analysisId: string,
  partId: string,
  nowMs: number,
  retry: boolean,
): Promise<AnalysisPart | null> {
  return await db.transaction(async (tx) => {
    const [part] = await tx
      .select()
      .from(analysisParts)
      .where(and(eq(analysisParts.id, partId), eq(analysisParts.analysisId, analysisId)))
      .for("update");
    if (part === undefined) throw partNotFound(partId);
    if (leaseState(part, nowMs, retry) === "settled") return null;
    if (part.kind === "synthesis") await assertChunksComplete(tx, analysisId);
    const [leased] = await tx
      .update(analysisParts)
      .set({
        status: "running",
        startedAt: new Date(nowMs),
        attempts: sql`${analysisParts.attempts} + 1`,
        error: null,
        completedAt: null,
      })
      .where(eq(analysisParts.id, partId))
      .returning();
    if (leased === undefined) throw partNotFound(partId);
    return leased;
  });
}

/** Writes only while the caller still holds the lease (see leasePart). */
function heldBy(lease: AnalysisPart) {
  return and(
    eq(analysisParts.id, lease.id),
    eq(analysisParts.attempts, lease.attempts),
    eq(analysisParts.status, "running"),
  );
}

/** What a part run has decided so far, for the failure record (a Retry asks only for the rest). */
type PartProgress = { partial: ChunkPartResult | null };

/**
 * Adds one paid attempt's cost to the part as soon as callStructured logged
 * it, whoever holds the lease now: a request cut off before it could record
 * anything (a killed function) still leaves its spend on the part, and the
 * increment commutes with a later holder's (D-168). Postgres rounds the same
 * decimal text the ai_calls insert sends, the same way (half away from zero
 * to the column's 6 decimals), so the part's cost is exactly the sum of its
 * rows; rounding the binary double in JS disagreed with it for about 1 cost
 * in 450 (D-178). A failed write only goes to the log: the attempt was paid
 * and logged already.
 */
async function addPartCost(db: Db, partId: string, usd: number): Promise<void> {
  if (usd === 0) return;
  // String(usd), as drizzle maps the ai_calls column's number to the driver.
  const text = String(usd);
  try {
    await db
      .update(analysisParts)
      .set({ costUsd: sql`${analysisParts.costUsd} + round(${text}::numeric, 6)` })
      .where(eq(analysisParts.id, partId));
  } catch (error) {
    console.error(`[relocation] could not add $${text} to the cost of part ${partId}:`, error);
  }
}

async function markPartFailed(db: Db, lease: AnalysisPart, error: unknown, progress: PartProgress): Promise<void> {
  try {
    await db
      .update(analysisParts)
      .set({
        status: "failed",
        error: partErrorMessage(error),
        ...(progress.partial === null ? {} : { result: progress.partial }),
      })
      .where(heldBy(lease));
  } catch (writeError) {
    // The caller rethrows the part's own error; this one only goes to the log.
    console.error(`[relocation] could not record the failure of part ${lease.id}:`, writeError);
  }
}

/** "1 item … is" or "3 items … are", for messages the owner reads. */
function countItems(count: number): { phrase: string; verb: string } {
  return count === 1 ? { phrase: "1 item", verb: "is" } : { phrase: `${count} items`, verb: "are" };
}

type CallSpec<T> = {
  purpose: AiPurpose;
  maxTokens: number;
  maxTokensCeiling: number;
  instruction: string;
  wire: z.ZodType;
  strict: z.ZodType<T>;
};

type Caller = <T>(spec: CallSpec<T>) => Promise<CallStructuredResult<T>>;

/**
 * One Claude call of the run: cached system prompt, cached shared context,
 * then the instruction. Every paid attempt is added to the part's stored cost
 * as it is logged, failed ones included, so the part's cost matches its
 * ai_calls rows even when a call gives up or the request is cut off (D-168).
 */
function makeCaller(db: Db, run: RunContext, deps: RelocationPartDeps, anthropic: AnthropicLike, partId: string): Caller {
  const shared: TextBlockParam = { type: "text", text: run.sharedContext, cache_control: { type: "ephemeral" } };
  return (spec) =>
    callStructured({
      model: run.model,
      system: RELOCATION_SYSTEM_PROMPT,
      content: [shared, { type: "text", text: spec.instruction }],
      wire: spec.wire,
      effort: run.effort,
      maxTokens: spec.maxTokens,
      maxTokensCeiling: spec.maxTokensCeiling,
      deps: {
        db,
        anthropic,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.random === undefined ? {} : { random: deps.random }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      },
      purpose: spec.purpose,
      strict: spec.strict,
      // Chunks write about 4K visible tokens and the synthesis more, plus thinking.
      stream: true,
      deadlineAt: deps.deadlineAt,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      links: { analysisId: run.analysisId },
      onAttemptCost: (usd) => addPartCost(db, partId, usd),
    });
}

/** One chunk call, priced like the run estimate (estimate.ts). */
function chunkEstimateUsd(run: RunContext, aliases: readonly string[]): number {
  const lines = linesFor(aliases, run.byAlias);
  return computeCostUsd(run.model, {
    input_tokens: estimateChunkInputTokens(run.sharedContext, lines),
    output_tokens: withThinkingAllowance(
      RELOCATION_ESTIMATE.outputTokensPerItem * aliases.length + RELOCATION_ESTIMATE.outputTokensPerChunk,
      run.effort,
    ),
  });
}

function synthesisEstimateUsd(run: RunContext, decisionLines: readonly string[]): number {
  return computeCostUsd(run.model, {
    input_tokens: estimateSynthesisInputTokens(run.sharedContext, run.snapshot.lines, decisionLines),
    output_tokens: withThinkingAllowance(synthesisOutputTokens(run.snapshot.lines.length), run.effort),
  });
}

function readChunkInput(part: Pick<AnalysisPart, "input">): string[] {
  const parsed = ChunkPartInputSchema.safeParse(part.input);
  if (!parsed.success) throw unreadable("chunk input", parsed.error);
  return parsed.data.aliases;
}

/** Decisions a failed earlier run of this part kept, limited to the chunk's aliases. */
function priorDecisions(part: Pick<AnalysisPart, "result">, aliases: ReadonlySet<string>): ChunkPartResult | null {
  if (part.result === null) return null;
  const parsed = ChunkPartResultSchema.safeParse(part.result);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  const decisions = parsed.data.decisions.filter((entry) => {
    if (!aliases.has(entry.item) || seen.has(entry.item)) return false;
    seen.add(entry.item);
    return true;
  });
  return decisions.length === 0 ? null : { decisions, repairCalls: parsed.data.repairCalls };
}

async function runChunk(
  db: Db,
  run: RunContext,
  lease: AnalysisPart,
  call: Caller,
  progress: PartProgress,
  now: () => number,
): Promise<void> {
  const aliases = readChunkInput(lease);
  const aliasSet = new Set(aliases);
  const prior = priorDecisions(lease, aliasSet);
  progress.partial = prior;

  let decisions: ChunkDecision[] = prior?.decisions ?? [];
  let repairCalls = prior?.repairCalls ?? 0;
  if (decisions.length === 0) {
    const reply = await call({
      ...RELOCATION_CALL_PARAMS.chunk,
      instruction: buildChunkInstruction(linesFor(aliases, run.byAlias)),
      wire: ChunkWireSchema,
      strict: makeChunkStrictSchema(aliases),
    });
    decisions = reply.data.decisions;
  }

  const missingOf = (decided: readonly ChunkDecision[]) => {
    const done = new Set(decided.map((entry) => entry.item));
    return aliases.filter((alias) => !done.has(alias));
  };
  let missing = missingOf(decisions);
  if (missing.length > 0) {
    // Kept on failure, so a Retry asks only for the items still missing.
    progress.partial = { decisions, repairCalls };
    const repair = await call({
      ...RELOCATION_CALL_PARAMS.repair,
      instruction: buildRepairInstruction(linesFor(missing, run.byAlias)),
      wire: ChunkWireSchema,
      strict: makeChunkStrictSchema(missing),
    });
    repairCalls += 1;
    decisions = [...decisions, ...repair.data.decisions];
    progress.partial = { decisions, repairCalls };
    missing = missingOf(decisions);
    if (missing.length > 0) {
      const { phrase } = countItems(missing.length);
      throw new AppError(
        "AI_INVALID_OUTPUT",
        `Claude left ${phrase} of this part without a decision. Try this part again.`,
        { missing: missing.length, reason: "missing_decisions" },
      );
    }
  }

  const byAlias = new Map(decisions.map((entry) => [entry.item, entry]));
  const ordered = aliases.map((alias) => {
    const entry = byAlias.get(alias);
    if (entry === undefined) throw new AppError("INTERNAL", `The decision for ${alias} went missing.`);
    return entry;
  });
  const result: ChunkPartResult = { decisions: ordered, repairCalls };
  await db
    .update(analysisParts)
    .set({
      status: "complete",
      result,
      error: null,
      completedAt: new Date(now()),
    })
    .where(heldBy(lease));
}

type ChunkOutcome = { byAlias: Map<string, ChunkDecision>; repairCalls: number };

/** Every chunk's decisions, checked to cover each snapshot alias exactly once. */
async function loadChunkDecisions(db: Db, run: RunContext): Promise<ChunkOutcome> {
  const parts = await db
    .select({ status: analysisParts.status, result: analysisParts.result })
    .from(analysisParts)
    .where(and(eq(analysisParts.analysisId, run.analysisId), eq(analysisParts.kind, "chunk")));
  const byAlias = new Map<string, ChunkDecision>();
  let repairCalls = 0;
  for (const part of parts) {
    if (part.status !== "complete") {
      throw new AppError("CONFLICT", "The synthesis can run once every chunk is done.", { reason: "chunks_incomplete" });
    }
    const parsed = ChunkPartResultSchema.safeParse(part.result);
    if (!parsed.success) throw unreadable("chunk result", parsed.error);
    repairCalls += parsed.data.repairCalls;
    for (const entry of parsed.data.decisions) byAlias.set(entry.item, entry);
  }
  for (const line of run.snapshot.lines) {
    if (!byAlias.has(line.alias)) throw new AppError("INTERNAL", `No chunk decided ${line.alias}.`);
  }
  return { byAlias, repairCalls };
}

function decisionLinesOf(run: RunContext, outcome: ChunkOutcome): string[] {
  return run.snapshot.lines.map((line) => {
    const entry = outcome.byAlias.get(line.alias);
    if (entry === undefined) throw new AppError("INTERNAL", `No chunk decided ${line.alias}.`);
    return formatDecisionLine(entry);
  });
}

// ---------------------------------------------------------------------------
// Finalizing: the stored result
// ---------------------------------------------------------------------------

const EUR = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

type WarningInput = {
  result: Pick<RelocationAnalysis, "items" | "layering_systems" | "packing_checklist" | "gaps">;
  moved: ReadonlySet<string>;
  purchaseBudgetEur: number | null;
  profile: { city: string; isPlaceholder: boolean };
};

/**
 * Warnings the service adds from the result itself (source "computed"): the
 * priority 1-2 purchases over the budget, layering or packing that disagrees
 * with the decisions, bring items without a packing group (items already at
 * the run's destination or on their way there need none, D-170), and a
 * placeholder climate profile.
 */
export function computedWarnings(input: WarningInput): RelocationWarning[] {
  const { result } = input;
  const warnings: RelocationWarning[] = [];
  const computed = (kind: RelocationWarning["kind"], itemIds: string[], message: string) =>
    warnings.push({ kind, item_ids: itemIds, message, source: "computed" });

  const minimum = priorityGapsMinimumEur(result.gaps);
  if (input.purchaseBudgetEur !== null && minimum > input.purchaseBudgetEur) {
    computed(
      "over_budget",
      [],
      `The priority 1 and 2 purchases cost at least €${EUR.format(minimum)}, more than the purchase budget of €${EUR.format(input.purchaseBudgetEur)}.`,
    );
  }

  const decisionOf = new Map(result.items.map((item) => [item.item_id, item.decision]));
  const notBring = (ids: Iterable<string>) => [...new Set(ids)].filter((id) => decisionOf.get(id) !== "bring");

  const layeringOff = notBring(result.layering_systems.flatMap((system) => system.item_ids));
  if (layeringOff.length > 0) {
    const { phrase, verb } = countItems(layeringOff.length);
    computed("packing", layeringOff, `${phrase} in the layering systems ${verb} not marked bring. Check their decisions.`);
  }

  const packed = result.packing_checklist.flatMap((group) => group.item_ids);
  const packedOff = notBring(packed);
  if (packedOff.length > 0) {
    const { phrase, verb } = countItems(packedOff.length);
    computed("packing", packedOff, `${phrase} in the packing checklist ${verb} not marked bring.`);
  }

  const packedMoved = [...new Set(packed)].filter((id) => input.moved.has(id));
  if (packedMoved.length > 0) {
    const { phrase, verb } = countItems(packedMoved.length);
    computed(
      "packing",
      packedMoved,
      `${phrase} in the packing checklist ${verb} already at the destination or on the way there.`,
    );
  }

  const packedSet = new Set(packed);
  const unpacked = result.items
    .filter((item) => item.decision === "bring" && !packedSet.has(item.item_id) && !input.moved.has(item.item_id))
    .map((item) => item.item_id);
  if (unpacked.length > 0) {
    const { phrase, verb } = countItems(unpacked.length);
    computed("packing", unpacked, `${phrase} marked bring ${verb} missing from the packing checklist.`);
  }

  if (input.profile.isPlaceholder) {
    computed(
      "placeholder_climate",
      [],
      `The climate data for ${truncate(input.profile.city, 60)} is a placeholder, so this advice is less reliable. Complete the profile in Settings and run the analysis again.`,
    );
  }
  return warnings;
}

/** Maps the chunk decisions and the synthesis reply (aliases) to the stored result (item ids). */
function buildRelocationResult(
  run: RunContext,
  outcome: ChunkOutcome,
  synthesis: SynthesisWire,
): RelocationAnalysis {
  const idOf = (alias: string): string => {
    const id = run.snapshot.aliasMap[alias];
    if (id === undefined) throw new AppError("INTERNAL", `Unknown alias ${alias} in the synthesis.`);
    return id;
  };
  const idsOf = (aliases: readonly string[]) => [...new Set(aliases.map(idOf))];

  const itemsOut = run.snapshot.lines.map((line) => {
    const entry = outcome.byAlias.get(line.alias);
    if (entry === undefined) throw new AppError("INTERNAL", `No chunk decided ${line.alias}.`);
    return { item_id: line.itemId, decision: entry.decision, priority: entry.priority, reason: entry.reason };
  });
  const core = {
    items: itemsOut,
    layering_systems: synthesis.layering_systems.map((system) => ({
      title: system.title,
      conditions: system.conditions,
      item_ids: idsOf(system.item_aliases),
      gap_note: system.gap_note,
    })),
    gaps: synthesis.gaps.map((gap, index) => ({
      gap_key: makeGapKey(index, gap),
      item_type: gap.item_type,
      category: gap.category,
      why_needed: gap.why_needed,
      specs: gap.specs,
      priority: gap.priority,
      quantity: gap.quantity,
      est_price_range_eur: { min: gap.est_price_min_eur, max: gap.est_price_max_eur },
      buy_before_or_after_move: gap.buy_timing,
    })),
    packing_checklist: synthesis.packing_checklist.map((group) => ({
      group: group.group,
      item_ids: idsOf(group.item_aliases),
      extras: group.extras,
    })),
  };
  const aiWarnings: RelocationWarning[] = synthesis.warnings.map((warning) => ({
    kind: warning.kind,
    item_ids: idsOf(warning.item_aliases),
    message: warning.message,
    source: "ai",
  }));

  return {
    summary: synthesis.summary,
    ...core,
    warnings: [
      ...aiWarnings,
      ...computedWarnings({
        result: core,
        moved: new Set(run.snapshot.moved),
        purchaseBudgetEur: run.params.purchaseBudgetEur,
        profile: run.snapshot.profile,
      }),
    ],
    meta: {
      prompt_version: RELOC_PROMPT_VERSION,
      model: run.model,
      effort: run.effort,
      item_count: run.snapshot.lines.length,
      chunk_count: run.snapshot.chunks.length,
      months: run.snapshot.months,
      climate_profile: {
        id: run.snapshot.profile.id,
        city: run.snapshot.profile.city,
        is_placeholder: run.snapshot.profile.isPlaceholder,
      },
      purchase_budget_eur: run.params.purchaseBudgetEur,
      estimated_cost_usd: run.estimatedCostUsd,
      repair_calls: outcome.repairCalls,
    },
  };
}

/**
 * Stores the result in one transaction: packing rows, the cost of every
 * logged attempt, status complete. Idempotent: an analysis that is already
 * complete keeps its result and rows, and only the part is marked done.
 */
async function finalize(
  db: Db,
  run: RunContext,
  lease: AnalysisPart,
  result: RelocationAnalysis,
  synthesis: SynthesisWire,
  nowMs: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: analyses.status })
      .from(analyses)
      .where(eq(analyses.id, run.analysisId))
      .for("update");
    if (current === undefined) throw analysisNotFound(run.analysisId);

    if (current.status !== "complete") {
      // Items deleted since the start get no row (there is nothing left to
      // pack); the lock keeps the rest from being deleted until the insert.
      const packedIds = [...new Set(result.packing_checklist.flatMap((group) => group.item_ids))];
      const existing =
        packedIds.length === 0
          ? []
          : await tx.select({ id: items.id }).from(items).where(inArray(items.id, packedIds)).for("key share");
      const present = new Set(existing.map((row) => row.id));

      const rows = PACKING_GROUPS.flatMap((group) => {
        const entry = result.packing_checklist.find((candidate) => candidate.group === group);
        if (entry === undefined) return [];
        const labelled = [
          ...entry.item_ids
            .filter((id) => present.has(id))
            .map((id) => ({ itemId: id as string | null, label: truncate(run.snapshot.names[id] ?? "Item", MAX_PACKING_LABEL) })),
          ...entry.extras.map((label) => ({ itemId: null, label })),
        ];
        return labelled.map((row, index) => ({ analysisId: run.analysisId, group, sortOrder: index, ...row }));
      });
      if (rows.length > 0) await tx.insert(packingChecklistItems).values(rows);

      const [cost] = await tx
        .select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`.mapWith(Number) })
        .from(aiCalls)
        .where(eq(aiCalls.analysisId, run.analysisId));
      await tx
        .update(analyses)
        .set({
          result,
          costUsd: cost?.total ?? 0,
          status: "complete",
          completedAt: new Date(nowMs),
          error: null,
        })
        .where(eq(analyses.id, run.analysisId));
    }

    await tx
      .update(analysisParts)
      .set({
        status: "complete",
        result: synthesis,
        error: null,
        completedAt: new Date(nowMs),
      })
      .where(heldBy(lease));
  });
}

async function runSynthesis(
  db: Db,
  run: RunContext,
  lease: AnalysisPart,
  outcome: ChunkOutcome,
  call: Caller,
  now: () => number,
): Promise<void> {
  const aliases = run.snapshot.lines.map((line) => line.alias);
  const reply = await call({
    ...RELOCATION_CALL_PARAMS.synthesis,
    instruction: buildSynthesisInstruction({ lines: run.snapshot.lines, decisions: decisionLinesOf(run, outcome) }),
    wire: SynthesisWireSchema,
    strict: makeSynthesisStrictSchema(aliases),
  });

  const checked = makeRelocationAnalysisSchema(run.snapshot.lines.map((line) => line.itemId)).safeParse(
    buildRelocationResult(run, outcome, reply.data),
  );
  if (!checked.success) {
    throw new AppError(
      "AI_INVALID_OUTPUT",
      "The finished analysis did not pass the final check. Run the synthesis again.",
      { issues: zodIssues(checked.error), reason: "final_check" },
    );
  }
  await finalize(db, run, lease, checked.data, reply.data, now());
}

/**
 * Runs one part: a chunk (its items' decisions, with exactly one repair call
 * when Claude leaves aliases out) or the synthesis (layering, gaps, packing,
 * warnings), which finalizes the run. Idempotent for a finished part (no
 * call, no API key needed); a failed part runs again only with
 * options.retry and is otherwise answered as it is, also without a key.
 * Throws NOT_FOUND (unknown analysis or part), CONFLICT (the part is
 * already running, or the synthesis before every chunk is done),
 * BUDGET_EXCEEDED (nothing changed) and CONFIG for a missing key (nothing
 * changed). Each paid attempt adds its cost to the part as it is logged
 * (D-168). A failed call marks the part failed with its message, leaves the
 * analysis running for a Retry, and is rethrown. Returns the run's progress.
 */
export async function runRelocationPart(
  db: Db,
  analysisId: string,
  partId: string,
  deps: RelocationPartDeps,
  options: RunPartOptions = {},
): Promise<RelocationRunDto> {
  await requireSession();
  const now = deps.now ?? Date.now;
  const retry = options.retry === true;
  if (!isUuid(partId)) throw partNotFound(partId);
  const row = await loadAnalysisRow(db, analysisId);
  const [part] = await db
    .select()
    .from(analysisParts)
    .where(and(eq(analysisParts.id, partId), eq(analysisParts.analysisId, analysisId)));
  if (part === undefined) throw partNotFound(partId);

  // Answered before the budget and the key are needed; the lease checks again under the lock.
  if (leaseState(part, now(), retry) === "settled") return await getRelocationRun(db, analysisId);
  if (part.kind === "synthesis") await assertChunksComplete(db, analysisId);

  const run = readRun(row);
  const outcome = part.kind === "synthesis" ? await loadChunkDecisions(db, run) : null;
  const estimateUsd =
    outcome === null
      ? chunkEstimateUsd(run, readChunkInput(part))
      : synthesisEstimateUsd(run, decisionLinesOf(run, outcome));
  await assertWithinBudget(db, { estimateUsd, now: new Date(now()) });
  const anthropic = deps.anthropic();

  const lease = await leasePart(db, analysisId, partId, now(), retry);
  if (lease === null) return await getRelocationRun(db, analysisId);

  const progress: PartProgress = { partial: null };
  const call = makeCaller(db, run, deps, anthropic, lease.id);
  try {
    if (outcome === null) await runChunk(db, run, lease, call, progress, now);
    else await runSynthesis(db, run, lease, outcome, call, now);
  } catch (error) {
    await markPartFailed(db, lease, error, progress);
    throw error;
  }
  return await getRelocationRun(db, analysisId);
}

// ---------------------------------------------------------------------------
// The result screen
// ---------------------------------------------------------------------------

function readResult(row: Pick<Analysis, "id" | "status" | "result">): RelocationAnalysis {
  if (row.status !== "complete" || row.result === null) throw notComplete(row.id, row.status);
  const parsed = RelocationAnalysisSchema.safeParse(row.result);
  if (!parsed.success) throw unreadable("analysis result", parsed.error);
  return parsed.data;
}

async function loadCompleteResult(db: Db, analysisId: string): Promise<RelocationAnalysis> {
  if (!isUuid(analysisId)) throw analysisNotFound(analysisId);
  const [row] = await db
    .select({ id: analyses.id, status: analyses.status, result: analyses.result })
    .from(analyses)
    .where(and(eq(analyses.id, analysisId), eq(analyses.kind, "relocation")));
  if (row === undefined) throw analysisNotFound(analysisId);
  return readResult(row);
}

function toPackingRow(row: PackingChecklistItem): PackingRowDto {
  return {
    id: row.id,
    group: row.group,
    label: row.label,
    itemId: row.itemId,
    packed: row.packed,
    sortOrder: row.sortOrder,
  };
}

const GROUP_ORDER = new Map<string, number>(PACKING_GROUPS.map((group, index) => [group, index]));

/**
 * A finished run for /relocate/[id]: the result, the items it names as they
 * are now (an item deleted since keeps its name from the run, exists false),
 * the packing rows by group and order, and the gaps already on the shopping
 * list. NOT_FOUND for an unknown id or another kind of analysis; CONFLICT
 * (details.reason "not_complete") while the run is unfinished.
 */
export async function loadRelocationView(db: Db, analysisId: string): Promise<RelocationViewDto> {
  await requireSession();
  const row = await loadAnalysisRow(db, analysisId);
  const result = readResult(row);
  const params = readParams(row);
  const view = ViewSnapshotSchema.safeParse(row.inputSnapshot);
  if (!view.success) throw unreadable("analysis input", view.error);
  const snapshot = view.data;
  const effort = EffortSchema.safeParse(row.effort);
  // Runs stored before D-170 have no slug; they were planned as moves to Hamburg.
  const destination = destinationLocation(snapshot.profile.slug ?? "hamburg");

  const ids = [...new Set(result.items.map((item) => item.item_id))];
  const [current, packing, gaps] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: items.id,
            name: items.name,
            subcategory: items.subcategory,
            category: items.category,
            decision: items.decision,
            status: items.status,
            location: items.location,
            collection: items.collection,
            thumbUrl: itemImages.blobUrl,
            thumbWidth: itemImages.width,
            thumbHeight: itemImages.height,
          })
          .from(items)
          .leftJoin(itemImages, and(eq(itemImages.itemId, items.id), eq(itemImages.kind, "thumb")))
          .where(inArray(items.id, ids)),
    db.select().from(packingChecklistItems).where(eq(packingChecklistItems.analysisId, analysisId)),
    db
      .select({ gapKey: shoppingListItems.gapKey })
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.analysisId, analysisId), isNotNull(shoppingListItems.gapKey))),
  ]);

  const categoryOf = new Map(snapshot.lines.map((line) => [line.itemId, line.category]));
  const itemRefs: Record<string, RelocationItemRefDto> = {};
  for (const id of ids) {
    itemRefs[id] = {
      id,
      name: snapshot.names[id] ?? "Deleted item",
      category: categoryOf.get(id) ?? null,
      thumb: null,
      currentDecision: "undecided",
      status: null,
      location: null,
      collection: null,
      exists: false,
    };
  }
  for (const item of current) {
    itemRefs[item.id] = {
      id: item.id,
      name: itemDisplayName(item),
      category: item.category,
      thumb:
        item.thumbUrl === null || item.thumbWidth === null || item.thumbHeight === null
          ? null
          : { url: item.thumbUrl, width: item.thumbWidth, height: item.thumbHeight },
      currentDecision: item.decision,
      status: item.status,
      location: item.location,
      collection: item.collection,
      exists: true,
    };
  }

  const packingRows = packing
    .map(toPackingRow)
    .sort(
      (a, b) =>
        (GROUP_ORDER.get(a.group) ?? 0) - (GROUP_ORDER.get(b.group) ?? 0) ||
        a.sortOrder - b.sortOrder ||
        a.id.localeCompare(b.id),
    );

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    status: row.status,
    model: row.model,
    effort: effort.success ? effort.data : null,
    promptVersion: row.promptVersion,
    estimatedCostUsd: row.estimatedCostUsd,
    costUsd: row.costUsd,
    params,
    months: snapshot.months,
    profile: {
      id: snapshot.profile.id,
      city: snapshot.profile.city,
      country: snapshot.profile.country,
      isPlaceholder: snapshot.profile.isPlaceholder,
    },
    destination,
    result,
    items: itemRefs,
    packing: packingRows,
    addedGapKeys: gaps.flatMap((gap) => (gap.gapKey === null ? [] : [gap.gapKey])),
  };
}

const ListMonthsSchema = z.array(z.number().int().min(1).max(12));

/** The newest relocation runs, finished or not, for the list under the form. */
export async function listRelocationAnalyses(db: Db): Promise<RelocationListItemDto[]> {
  await requireSession();
  // Read from the stored snapshot in SQL so the list does not load every
  // run's item lines.
  const rows = await db
    .select({
      id: analyses.id,
      createdAt: analyses.createdAt,
      completedAt: analyses.completedAt,
      status: analyses.status,
      estimatedCostUsd: analyses.estimatedCostUsd,
      storedCostUsd: analyses.costUsd,
      city: sql<string | null>`${analyses.inputSnapshot} -> 'profile' ->> 'city'`,
      isPlaceholder: sql<boolean | null>`(${analyses.inputSnapshot} -> 'profile' ->> 'isPlaceholder')::boolean`,
      months: sql<unknown>`${analyses.inputSnapshot} -> 'months'`,
      itemCount: sql<number>`case when jsonb_typeof(${analyses.inputSnapshot} -> 'lines') = 'array' then jsonb_array_length(${analyses.inputSnapshot} -> 'lines') else 0 end`.mapWith(
        Number,
      ),
      loggedCostUsd: sql<number>`(select coalesce(sum(${aiCalls.costUsd}), 0) from ${aiCalls} where ${aiCalls.analysisId} = ${analyses.id})`.mapWith(
        Number,
      ),
    })
    .from(analyses)
    .where(eq(analyses.kind, "relocation"))
    .orderBy(desc(analyses.createdAt))
    .limit(RELOCATION_LIST_LIMIT);

  return rows.map((row) => {
    const months = ListMonthsSchema.safeParse(row.months);
    if (!months.success) throw unreadable("analysis months", months.error);
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
      status: row.status,
      city: row.city,
      isPlaceholder: row.isPlaceholder === true,
      months: months.data,
      itemCount: row.itemCount,
      estimatedCostUsd: row.estimatedCostUsd,
      costUsd: row.status === "complete" ? row.storedCostUsd : row.loggedCostUsd,
    };
  });
}

/**
 * The rows "Apply AI decisions" may write among `ids`: undecided (D-028), not
 * archived, and still clothing, so an item moved to running gear after the
 * run keeps no decision from it (D-249). The lock and every update use this
 * one predicate, so they never lock a row out of order (D-166).
 */
function applicableItems(ids: string[]) {
  return and(
    inArray(items.id, ids),
    eq(items.decision, "undecided"),
    ne(items.status, "archived"),
    eq(items.collection, "clothing"),
  );
}

/**
 * "Apply AI decisions to undecided items": writes each item's AI decision to
 * items.decision, only where the owner has not decided (undecided), the item
 * is not archived (D-028) and it is still clothing (D-249). Returns the ids it
 * changed.
 */
export async function applyAiDecisionsToUndecided(
  db: Db,
  analysisId: string,
): Promise<{ updated: number; itemIds: string[] }> {
  await requireSession();
  const result = await loadCompleteResult(db, analysisId);
  const byDecision = new Map<RelocationDecision, string[]>();
  for (const item of result.items) {
    const list = byDecision.get(item.decision) ?? [];
    list.push(item.item_id);
    byDecision.set(item.decision, list);
  }

  const changed = await db.transaction(async (tx) => {
    // A fixed lock order, so two applies of different runs cannot deadlock:
    // each update below would otherwise lock its rows in its own order (D-166).
    // The same applicableItems predicate as the updates, so they never lock a row out of order.
    const candidates = result.items.map((item) => item.item_id);
    if (candidates.length > 0) {
      await tx
        .select({ id: items.id })
        .from(items)
        .where(applicableItems(candidates))
        .orderBy(asc(items.id))
        .for("no key update");
    }
    const ids: string[] = [];
    for (const [decision, itemIds] of byDecision) {
      const rows = await tx
        .update(items)
        .set({ decision })
        .where(applicableItems(itemIds))
        .returning({ id: items.id });
      ids.push(...rows.map((row) => row.id));
    }
    return ids;
  });
  return { updated: changed.length, itemIds: changed };
}

/**
 * Adds the chosen gaps to the shopping list. Idempotent on (analysis, gap
 * key): a gap already there is counted, not added twice (D-029). Unknown gap
 * keys are a VALIDATION error and nothing is added.
 */
export async function addGapsToShoppingList(
  db: Db,
  analysisId: string,
  gapKeys: readonly string[],
): Promise<{ added: number; alreadyThere: number }> {
  await requireSession();
  const result = await loadCompleteResult(db, analysisId);
  const wanted = [...new Set(gapKeys)];
  if (wanted.length === 0) return { added: 0, alreadyThere: 0 };
  const gapByKey = new Map(result.gaps.map((gap) => [gap.gap_key, gap]));
  const unknown = wanted.filter((key) => !gapByKey.has(key));
  if (unknown.length > 0) {
    throw new AppError("VALIDATION", "Some of these gaps are not part of this analysis.", { gapKeys: unknown });
  }

  const inserted = await db
    .insert(shoppingListItems)
    .values(
      wanted.flatMap((key) => {
        const gap = gapByKey.get(key);
        return gap === undefined
          ? []
          : [
              {
                analysisId,
                gapKey: gap.gap_key,
                itemType: gap.item_type,
                category: gap.category,
                priority: gap.priority,
                reason: gap.why_needed,
                specs: gap.specs,
                quantity: gap.quantity,
                estPriceMinEur: gap.est_price_range_eur.min,
                estPriceMaxEur: gap.est_price_range_eur.max,
                buyTiming: gap.buy_before_or_after_move,
              },
            ];
      }),
    )
    .onConflictDoNothing({ target: [shoppingListItems.analysisId, shoppingListItems.gapKey] })
    .returning({ id: shoppingListItems.id });
  return { added: inserted.length, alreadyThere: wanted.length - inserted.length };
}

function packingRowNotFound(id: string): AppError {
  return new AppError("NOT_FOUND", "That packing checklist entry no longer exists.", { id });
}

/** Ticks or unticks a packing checklist row. */
export async function setPackingItemPacked(db: Db, id: string, packed: boolean): Promise<PackingRowDto> {
  await requireSession();
  if (!isUuid(id)) throw packingRowNotFound(id);
  const [row] = await db
    .update(packingChecklistItems)
    .set({ packed })
    .where(eq(packingChecklistItems.id, id))
    .returning();
  if (row === undefined) throw packingRowNotFound(id);
  return toPackingRow(row);
}

/** Adds a free-text entry at the end of a group of a finished run's checklist. */
export async function addPackingExtra(
  db: Db,
  analysisId: string,
  group: string,
  label: string,
): Promise<PackingRowDto> {
  await requireSession();
  const packingGroup = PACKING_GROUPS.find((candidate) => candidate === group);
  if (packingGroup === undefined) throw new AppError("VALIDATION", "Choose a packing group.", { group });
  const text = label.replace(/\s+/g, " ").trim();
  if (text === "" || text.length > MAX_PACKING_LABEL) {
    throw new AppError("VALIDATION", `Write what to pack in 1 to ${MAX_PACKING_LABEL} characters.`);
  }
  await loadCompleteResult(db, analysisId);

  const [row] = await db
    .insert(packingChecklistItems)
    .values({
      analysisId,
      group: packingGroup,
      label: text,
      itemId: null,
      sortOrder: sql`(select coalesce(max(${packingChecklistItems.sortOrder}), -1) + 1 from ${packingChecklistItems} where ${packingChecklistItems.analysisId} = ${analysisId} and ${packingChecklistItems.group} = ${packingGroup})`,
    })
    .returning();
  if (row === undefined) throw new AppError("INTERNAL", "The packing entry could not be added.");
  return toPackingRow(row);
}

/** Removes a free-text entry; rows for catalogued items stay (VALIDATION). */
export async function deletePackingExtra(db: Db, id: string): Promise<{ deleted: true }> {
  await requireSession();
  if (!isUuid(id)) throw packingRowNotFound(id);
  const [deleted] = await db
    .delete(packingChecklistItems)
    .where(and(eq(packingChecklistItems.id, id), isNull(packingChecklistItems.itemId)))
    .returning({ id: packingChecklistItems.id });
  if (deleted !== undefined) return { deleted: true };
  const [kept] = await db
    .select({ id: packingChecklistItems.id })
    .from(packingChecklistItems)
    .where(eq(packingChecklistItems.id, id));
  if (kept === undefined) throw packingRowNotFound(id);
  throw new AppError("VALIDATION", "Only entries you added can be removed. Untick an item instead.", { id });
}
