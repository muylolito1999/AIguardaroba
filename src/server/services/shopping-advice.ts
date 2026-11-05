import "server-only";

import { createHash } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  AdviceCandidateSchema,
  AdviceScenarioSchema,
  COUNTED_CATEGORIES,
  type AdviceBudgetDto,
  type AdviceCandidateDto,
  type AdviceRecommendationDto,
  type AdviceScenarioDto,
  type ShoppingAdviceReadyDto,
  type ShoppingAdviceRunDto,
  type ShoppingAdviceStateDto,
  type StoredAdviceDto,
} from "@/components/shopping/advice-model";
import { aiSettingsEnv, flagsEnv } from "@/env";
import { assertWithinBudget } from "@/lib/ai/budget";
import { callStructured } from "@/lib/ai/call";
import type { AnthropicLike } from "@/lib/ai/client";
import type { PricedModelId } from "@/lib/ai/models";
import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { aiCalls, analyses, climateProfiles, items, type Analysis, type ClimateProfile, type NewAnalysis } from "@/lib/db/schema";
import type { ShoppingItemDto, ShoppingListDto } from "@/lib/relocation/contracts";
import { RelocationAnalysisSchema, type RelocationGap } from "@/lib/relocation/schemas";
import { AppError, isAppError, toErrorPayload } from "@/lib/result";
import {
  buildShoppingAdviceInstruction,
  describeAdviceClimate,
  estimateShoppingAdviceUsd,
  makeShoppingAdviceStrictSchema,
  SHOPPING_CALL_PARAMS,
  SHOPPING_PROMPT_VERSION,
  SHOPPING_SYSTEM_PROMPT,
  ShoppingAdviceResultSchema,
  ShoppingAdviceWireSchema,
  type ShoppingAdviceCandidate,
  type ShoppingAdviceResult,
} from "@/lib/shopping/advice";
import {
  candidateFromShoppingRow,
  countOutfits,
  scenariosFromProfile,
  unlockCount,
  type ComboItem,
} from "@/lib/shopping/combinatorics";
import { getShoppingList } from "@/server/services/shopping";

// "What to buy next" (D-040), behind FEATURE_SHOPPING_AI. The candidates are
// the open shopping list rows plus the gaps of the latest complete relocation
// run that are not on the list; how many outfits each would add in Hamburg's
// January, April, July and October is counted deterministically
// (combinatorics.ts), and Claude only ranks them, explains the ranking and
// sets a budget per purchase. With the flag off nothing but the flag is read,
// and the route answers 404.

/** Candidates the prompt lists at most; the rest, least important first, are left out and counted. */
export const MAX_ADVICE_CANDIDATES = 50;

/** The climate profile the counts use: the move's destination (spec section 6). */
export const ADVICE_PROFILE_SLUG = "hamburg";

/** Stored error text, like the relocation parts' (D-053: CONFIG and unexpected errors stay generic). */
const MAX_ERROR_LENGTH = 300;

/**
 * A "running" ranking younger than this blocks another (D-220): the route
 * stops at 120 s, plus a margin, so a run whose function was killed frees
 * itself. As SUGGESTION_LEASE_MS for the outfit suggestion.
 */
export const SHOPPING_LEASE_MS = 130_000;
const LEASE_INTERVAL = sql.raw(`interval '${Math.ceil(SHOPPING_LEASE_MS / 1000)} seconds'`);

/**
 * The transaction-scoped advisory lock that lets one shopping run start at a
 * time. Its first key differs from the login rate limit's (0x10617), so the
 * two never wait for each other. A lock on a row would not do: the advice
 * reads no row that always exists.
 */
const ADVICE_LOCK_NAMESPACE = 0x10618;
const ADVICE_LOCK_KEY = 1;

export const SHOPPING_ADVICE_OFF_MESSAGE = "Shopping advice is turned off.";

function isEnabled(): boolean {
  return flagsEnv().FEATURE_SHOPPING_AI;
}

function offError(): AppError {
  return new AppError("NOT_FOUND", SHOPPING_ADVICE_OFF_MESSAGE);
}

/**
 * Whether FEATURE_SHOPPING_AI is on, for the read-only row in Settings.
 * Throws CONFIG when the variable holds something other than true, false, 1
 * or 0; the caller shows that without the details (D-053).
 */
export async function getShoppingAdviceFlag(): Promise<{ enabled: boolean }> {
  await requireSession();
  return { enabled: isEnabled() };
}

/** NOT_FOUND unless the flag is on; the route calls it before reading the body. */
export async function assertShoppingAdviceEnabled(): Promise<void> {
  await requireSession();
  if (!isEnabled()) throw offError();
}

// ---------------------------------------------------------------------------
// The plan: candidates, counts, budget, prompt
// ---------------------------------------------------------------------------

type PlannedCandidate = AdviceCandidateDto & {
  /** c1..cN in prompt order; the reply names candidates by it. */
  promptKey: string;
  specs: string[];
  /** The category the counts used: the row's own, else read from the item type. */
  countedAs: ComboItem["category"];
};

type AdvicePlan = {
  list: ShoppingListDto;
  model: PricedModelId;
  profile: ClimateProfile | null;
  scenarios: AdviceScenarioDto[];
  candidates: PlannedCandidate[];
  omitted: number;
  budget: AdviceBudgetDto;
  blocker: string | null;
  /** Set when nothing blocks the run. */
  ready: { instruction: string; estimateUsd: number; cacheKey: string } | null;
};

type RawCandidate = Omit<PlannedCandidate, "promptKey" | "counted" | "unlocks" | "countedAs">;

const SOURCE_ORDER: Record<AdviceCandidateDto["source"], number> = { list: 0, gap: 1 };

function listCandidate(row: ShoppingItemDto): RawCandidate {
  return {
    key: row.id,
    source: "list",
    itemType: row.itemType,
    category: row.category,
    priority: row.priority,
    quantity: row.quantity,
    specs: row.specs,
    estPriceMinEur: row.estPriceMinEur,
    estPriceMaxEur: row.estPriceMaxEur,
    relocationAnalysisId: row.analysisId,
  };
}

function gapCandidate(gap: RelocationGap, analysisId: string): RawCandidate {
  return {
    key: gap.gap_key,
    source: "gap",
    itemType: gap.item_type,
    category: gap.category,
    priority: gap.priority,
    quantity: gap.quantity,
    specs: gap.specs,
    estPriceMinEur: gap.est_price_range_eur.min,
    estPriceMaxEur: gap.est_price_range_eur.max,
    relocationAnalysisId: analysisId,
  };
}

const GapsSchema = RelocationAnalysisSchema.shape.gaps;

/**
 * The gaps of a complete relocation run and when it finished; no gaps and no
 * time when the run is gone or unfinished.
 */
async function relocationGaps(db: Db, analysisId: string): Promise<{ gaps: RelocationGap[]; finishedAt: Date | null }> {
  const [row] = await db
    .select({
      gaps: sql<unknown>`${analyses.result} -> 'gaps'`,
      completedAt: analyses.completedAt,
      createdAt: analyses.createdAt,
    })
    .from(analyses)
    .where(and(eq(analyses.id, analysisId), eq(analyses.kind, "relocation"), eq(analyses.status, "complete")));
  if (row === undefined) return { gaps: [], finishedAt: null };
  const parsed = GapsSchema.safeParse(row.gaps);
  if (!parsed.success) {
    console.error(`[shopping-advice] the gaps of relocation ${analysisId} are unreadable:`, parsed.error);
    throw new AppError("INTERNAL", "The latest relocation plan could not be read.");
  }
  return { gaps: parsed.data, finishedAt: row.completedAt ?? row.createdAt };
}

/**
 * The wardrobe the counts use: tagged or confirmed clothing items with a
 * category, not to be donated or sold, and not left behind unless already in
 * Hamburg or on the way there. Running gear never completes an outfit, so it
 * neither adds to "outfits now" nor makes a purchase unlock more (D-249).
 * Moving an item between collections can change the counts, and advice
 * stored before the move then reads as stale.
 */
async function wardrobeForCounts(db: Db): Promise<ComboItem[]> {
  const rows = await db
    .select({
      id: items.id,
      category: items.category,
      warmthLevel: items.warmthLevel,
      formality: items.formality,
      waterproof: items.waterproof,
      decision: items.decision,
      location: items.location,
    })
    .from(items)
    .where(
      and(
        inArray(items.status, ["tagged", "confirmed"]),
        eq(items.collection, "clothing"),
        isNotNull(items.category),
        notInArray(items.decision, ["donate", "sell"]),
      ),
    );
  return rows.flatMap((row) =>
    row.category === null || (row.decision === "leave" && row.location !== "hamburg" && row.location !== "in_transit")
      ? []
      : [
          {
            id: row.id,
            category: row.category,
            warmthLevel: row.warmthLevel,
            formality: row.formality,
            waterproof: row.waterproof,
          },
        ],
  );
}

/**
 * Whether a bought row was paid from the latest plan's budget: a row of that
 * plan, or a row added by hand once the plan was made (rows have no bought-at
 * date, so the day they were added stands in for it). Rows of older plans
 * were bought under those plans' budgets (D-219). Without a finished plan
 * every row added by hand counts.
 */
function boughtUnderLatestPlan(
  row: Pick<ShoppingItemDto, "analysisId" | "createdAt">,
  latestAnalysisId: string | null,
  latestFinishedAt: Date | null,
): boolean {
  if (row.analysisId !== null) return row.analysisId === latestAnalysisId;
  return latestFinishedAt === null || Date.parse(row.createdAt) >= latestFinishedAt.getTime();
}

/**
 * See AdviceBudgetSchema: the latest plan's budget minus the lowest estimate
 * of what was bought under it, whole euros, from 0. `latestFinishedAt` is when
 * that plan finished.
 */
export function adviceBudget(
  list: Pick<ShoppingListDto, "items" | "latestBudgetEur" | "latestAnalysisId">,
  latestFinishedAt: Date | null = null,
): AdviceBudgetDto {
  let bought = 0;
  let unpriced = 0;
  for (const row of list.items) {
    if (row.status !== "bought") continue;
    if (!boughtUnderLatestPlan(row, list.latestAnalysisId, latestFinishedAt)) continue;
    const low = row.estPriceMinEur ?? row.estPriceMaxEur;
    if (low === null) {
      unpriced += 1;
      continue;
    }
    bought += low * row.quantity;
  }
  // Prices carry cents; summing them piles up float error.
  const boughtMinimumEur = Math.round(bought * 100) / 100;
  const purchase = list.latestBudgetEur;
  return {
    purchaseBudgetEur: purchase,
    boughtMinimumEur,
    unpricedBought: unpriced,
    remainingEur:
      purchase === null ? null : Math.max(0, Math.floor(Math.round((purchase - boughtMinimumEur) * 100) / 100)),
    relocationAnalysisId: list.latestAnalysisId,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function promptCandidate(candidate: PlannedCandidate): ShoppingAdviceCandidate {
  return {
    key: candidate.promptKey,
    itemType: candidate.itemType,
    // The category the counts used, so the line and its numbers agree.
    category: candidate.category ?? (candidate.countedAs === "other" ? null : candidate.countedAs),
    priority: candidate.priority,
    quantity: candidate.quantity,
    specs: candidate.specs,
    estPriceMinEur: candidate.estPriceMinEur,
    estPriceMaxEur: candidate.estPriceMaxEur,
    source: candidate.source,
    unlocks: candidate.unlocks,
  };
}

async function buildPlan(db: Db): Promise<AdvicePlan> {
  const model = aiSettingsEnv().models.analysis;
  const [list, [profile], wardrobe] = await Promise.all([
    getShoppingList(db),
    db.select().from(climateProfiles).where(eq(climateProfiles.slug, ADVICE_PROFILE_SLUG)),
    wardrobeForCounts(db),
  ]);
  const latestId = list.latestAnalysisId;
  const { gaps, finishedAt } = latestId === null ? { gaps: [], finishedAt: null } : await relocationGaps(db, latestId);

  // A gap is on the list once a row holds it, whatever that row's status.
  const listedGaps = new Set(
    list.items.flatMap((row) => (row.analysisId === latestId && row.gapKey !== null ? [row.gapKey] : [])),
  );
  const raw: RawCandidate[] = [
    ...list.items.filter((row) => row.status === "todo").map(listCandidate),
    ...(latestId === null
      ? []
      : gaps.filter((gap) => !listedGaps.has(gap.gap_key)).map((gap) => gapCandidate(gap, latestId))),
  ];
  // The list is in its own order already and the gaps in the run's; priority
  // first, list rows before gaps, so the cap leaves out the least important.
  const ordered = raw
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        (a.candidate.priority ?? 4) - (b.candidate.priority ?? 4) ||
        SOURCE_ORDER[a.candidate.source] - SOURCE_ORDER[b.candidate.source] ||
        a.index - b.index,
    )
    .map(({ candidate }) => candidate);
  const kept = ordered.slice(0, MAX_ADVICE_CANDIDATES);

  let blocker: string | null = null;
  let scenarios: AdviceScenarioDto[] = [];
  if (profile === undefined) {
    blocker = "The Hamburg climate profile is missing, so outfits cannot be counted. Run pnpm db:seed to add it.";
  } else {
    try {
      scenarios = scenariosFromProfile(profile).map((scenario) => ({
        ...scenario,
        outfitsNow: countOutfits(wardrobe, scenario).count,
      }));
    } catch (error) {
      if (!isAppError(error) || error.code !== "VALIDATION") throw error;
      blocker = error.message;
    }
  }

  const candidates: PlannedCandidate[] = kept.map((candidate, index) => {
    const combo = candidateFromShoppingRow({
      id: candidate.key,
      itemType: candidate.itemType,
      category: candidate.category,
      specs: candidate.specs,
    });
    return {
      ...candidate,
      promptKey: `c${index + 1}`,
      countedAs: combo.category,
      counted: COUNTED_CATEGORIES.includes(combo.category),
      unlocks: Object.fromEntries(scenarios.map((scenario) => [scenario.key, unlockCount(wardrobe, combo, scenario)])),
    };
  });

  const budget = adviceBudget(list, finishedAt);
  if (blocker === null && candidates.length === 0) {
    blocker =
      "Nothing to rank: your shopping list has nothing left to buy and the latest relocation plan has no other gaps.";
  }
  if (blocker === null && budget.remainingEur === 0 && budget.purchaseBudgetEur !== null) {
    // A new plan states what is still left to spend, so the blocker must not
    // read as "plan again and the money comes back" (D-219, D-231).
    blocker = `Your €${budget.purchaseBudgetEur} purchase budget is used up by what you bought since the latest relocation plan, by the app's estimate. If you can still spend more, plan the move again and enter only what you have left.`;
  }

  let ready: AdvicePlan["ready"] = null;
  if (blocker === null && profile !== undefined) {
    const instruction = buildShoppingAdviceInstruction({
      candidates: candidates.map(promptCandidate),
      scenarios,
      remainingBudgetEur: budget.remainingEur,
      climateSummary: describeAdviceClimate(profile),
    });
    // The instruction holds every candidate line, count, budget and the
    // climate; the keys tie c1..cN to rows and gaps.
    const cacheKey = sha256(
      JSON.stringify([
        SHOPPING_PROMPT_VERSION,
        model,
        SHOPPING_CALL_PARAMS.effort,
        candidates.map((candidate) => [candidate.source, candidate.key, candidate.relocationAnalysisId]),
        instruction,
      ]),
    );
    ready = { instruction, estimateUsd: estimateShoppingAdviceUsd(model, instruction), cacheKey };
  }

  return {
    list,
    model,
    profile: profile ?? null,
    scenarios,
    candidates,
    omitted: ordered.length - kept.length,
    budget,
    blocker,
    ready,
  };
}

// ---------------------------------------------------------------------------
// The stored advice
// ---------------------------------------------------------------------------

/** analyses.input_snapshot of a shopping run: what the recommendations refer to. */
const StoredInputSchema = z.object({
  candidates: z.array(AdviceCandidateSchema.extend({ promptKey: z.string() })),
  scenarios: z.array(AdviceScenarioSchema),
  omitted: z.number().int().min(0),
});
type StoredInput = z.infer<typeof StoredInputSchema>;

function unreadable(what: string, cause?: unknown): AppError {
  console.error(`[shopping-advice] ${what} is unreadable:`, cause);
  return new AppError("INTERNAL", "The stored shopping advice could not be read.");
}

async function latestAdviceRow(db: Db): Promise<Analysis | undefined> {
  const [row] = await db
    .select()
    .from(analyses)
    .where(and(eq(analyses.kind, "shopping"), eq(analyses.status, "complete")))
    .orderBy(sql`${analyses.completedAt} DESC NULLS LAST`, desc(analyses.createdAt))
    .limit(1);
  return row;
}

function toCandidateDto(candidate: PlannedCandidate | StoredInput["candidates"][number]): AdviceCandidateDto {
  return {
    key: candidate.key,
    source: candidate.source,
    itemType: candidate.itemType,
    category: candidate.category,
    counted: candidate.counted,
    priority: candidate.priority,
    quantity: candidate.quantity,
    estPriceMinEur: candidate.estPriceMinEur,
    estPriceMaxEur: candidate.estPriceMaxEur,
    relocationAnalysisId: candidate.relocationAnalysisId,
    unlocks: candidate.unlocks,
  };
}

/** Where the candidate stands on the list now: a gap may have been added, a row bought or deleted. */
function listState(
  candidate: AdviceCandidateDto,
  rows: readonly ShoppingItemDto[],
): Pick<AdviceRecommendationDto, "onList" | "rowStatus"> {
  const row =
    candidate.source === "list"
      ? rows.find((entry) => entry.id === candidate.key)
      : rows.find((entry) => entry.analysisId === candidate.relocationAnalysisId && entry.gapKey === candidate.key);
  return { onList: row !== undefined, rowStatus: row?.status ?? null };
}

function storedAdviceView(row: Analysis, plan: AdvicePlan): StoredAdviceDto {
  const result = ShoppingAdviceResultSchema.safeParse(row.result);
  if (!result.success) throw unreadable(`the result of shopping advice ${row.id}`, result.error);
  const input = StoredInputSchema.safeParse(row.inputSnapshot);
  if (!input.success) throw unreadable(`the input of shopping advice ${row.id}`, input.error);
  const byKey = new Map(input.data.candidates.map((candidate) => [candidate.key, candidate]));

  const recommendations = result.data.recommendations.map((entry): AdviceRecommendationDto => {
    const stored = byKey.get(entry.key);
    if (stored === undefined) throw unreadable(`recommendation ${entry.key} of shopping advice ${row.id}`);
    const candidate = toCandidateDto(stored);
    return {
      rank: entry.rank,
      why: entry.why,
      budgetEur: entry.budget_eur,
      candidate,
      ...listState(candidate, plan.list.items),
    };
  });
  return {
    analysisId: row.id,
    completedAt: (row.completedAt ?? row.createdAt).toISOString(),
    model: row.model,
    costUsd: row.costUsd,
    remainingBudgetEur: result.data.meta.remaining_budget_eur,
    scenarios: input.data.scenarios,
    recommendations,
    stale: plan.ready === null || row.cacheKey !== plan.ready.cacheKey,
  };
}

function readyState(plan: AdvicePlan, latest: Analysis | undefined): ShoppingAdviceReadyDto {
  return {
    enabled: true,
    blocker: plan.blocker,
    climate: plan.profile === null ? null : { city: plan.profile.city, country: plan.profile.country },
    scenarios: plan.scenarios,
    candidates: plan.candidates.map(toCandidateDto),
    omittedCandidates: plan.omitted,
    budget: plan.budget,
    model: plan.model,
    estimateUsd: plan.ready?.estimateUsd ?? null,
    latest: latest === undefined ? null : storedAdviceView(latest, plan),
  };
}

/**
 * The /shopping section: { enabled: false } without reading anything but the
 * flag; otherwise the candidates with their unlock counts per scenario, the
 * budget, the estimate, what blocks a run, and the newest finished advice
 * with where each of its purchases stands on the list now. Makes no Claude
 * call and needs no API key.
 */
export async function getShoppingAdviceState(db: Db): Promise<ShoppingAdviceStateDto> {
  await requireSession();
  if (!isEnabled()) return { enabled: false };
  const [plan, latest] = await Promise.all([buildPlan(db), latestAdviceRow(db)]);
  return readyState(plan, latest);
}

// ---------------------------------------------------------------------------
// Running the advice
// ---------------------------------------------------------------------------

export type ShoppingAdviceDeps = {
  /** Called only when Claude is needed (D-064): a reused advice needs no API key. */
  anthropic: () => AnthropicLike;
  /** Epoch ms by which the call must be done; the route passes its start plus SHOPPING_DEADLINE_MS. */
  deadlineAt: number;
  /** Epoch ms; defaults to Date.now. */
  now?: () => number;
  signal?: AbortSignal;
  /** Backoff jitter and waits between attempts; tests pass instant ones. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Cost of every Claude attempt logged for the run, failed ones included (D-020). */
async function loggedCostUsd(db: Db, analysisId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`.mapWith(Number) })
    .from(aiCalls)
    .where(eq(aiCalls.analysisId, analysisId));
  return row?.total ?? 0;
}

function storedErrorMessage(error: unknown): string {
  const { message } = toErrorPayload(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}

async function markFailed(db: Db, analysisId: string, error: unknown): Promise<void> {
  try {
    await db
      .update(analyses)
      .set({ status: "failed", error: storedErrorMessage(error), costUsd: await loggedCostUsd(db, analysisId) })
      .where(eq(analyses.id, analysisId));
  } catch (writeError) {
    // The caller rethrows the run's own error; this one only goes to the log.
    console.error(`[shopping-advice] could not record the failure of ${analysisId}:`, writeError);
  }
}

/**
 * Inserts the "running" row the call is linked to, under the advisory lock,
 * or answers why no call is needed: CONFLICT while another ranking runs (with
 * `force` too, since a second tab's "Run again" sends it), or, without
 * `force`, the advice that a run finishing meanwhile stored with the same
 * cache key. Running rows are read before complete ones: under Read Committed
 * a run that completes between the two reads then shows as complete.
 */
async function startAdviceRun(
  db: Db,
  values: NewAnalysis,
  cacheKey: string,
  force: boolean,
): Promise<{ started: Analysis } | { reused: Analysis }> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVICE_LOCK_NAMESPACE}, ${ADVICE_LOCK_KEY})`);
    const [running] = await tx
      .select({ id: analyses.id })
      .from(analyses)
      .where(
        and(
          eq(analyses.kind, "shopping"),
          eq(analyses.status, "running"),
          sql`${analyses.createdAt} > now() - ${LEASE_INTERVAL}`,
        ),
      )
      .limit(1);
    if (running !== undefined) {
      throw new AppError(
        "CONFLICT",
        "Purchases are already being ranked in another tab or window. Try again in a minute.",
        { reason: "running" },
      );
    }
    if (!force) {
      const latest = await latestAdviceRow(tx);
      if (latest !== undefined && latest.cacheKey === cacheKey) return { reused: latest };
    }
    const [row] = await tx.insert(analyses).values(values).returning();
    if (row === undefined) throw new AppError("INTERNAL", "The shopping advice could not be created.");
    return { started: row };
  });
}

/**
 * Ranks the candidates with Claude and stores the advice (analyses, kind
 * shopping). Checks, in order and before anything is paid: the flag
 * (NOT_FOUND when off), what blocks a run (VALIDATION), the reuse of the
 * latest advice when made from the same inputs (unless `force`, "Run again"),
 * the monthly budget with the estimate (BUDGET_EXCEEDED), the API key
 * (CONFIG) and another ranking still running (CONFLICT). Unknown keys,
 * duplicate keys, ranks with gaps and budgets over the remaining purchase
 * budget are invalid output, which callStructured retries. Answers the
 * section's state with the new advice.
 */
export async function runShoppingAdvice(
  db: Db,
  deps: ShoppingAdviceDeps,
  options: { force?: boolean } = {},
): Promise<ShoppingAdviceRunDto> {
  await requireSession();
  if (!isEnabled()) throw offError();
  const now = deps.now ?? Date.now;

  const [plan, latest] = await Promise.all([buildPlan(db), latestAdviceRow(db)]);
  const ready = plan.ready;
  if (plan.blocker !== null || ready === null || plan.profile === null) {
    throw new AppError("VALIDATION", plan.blocker ?? "Shopping advice cannot run right now.", { reason: "blocked" });
  }
  if (options.force !== true && latest !== undefined && latest.cacheKey === ready.cacheKey) {
    return { outcome: "reused", state: readyState(plan, latest) };
  }

  await assertWithinBudget(db, { estimateUsd: ready.estimateUsd, now: new Date(now()) });
  // Before the row exists: a missing key is a CONFIG error with nothing to record.
  const anthropic = deps.anthropic();

  const inputSnapshot: StoredInput = {
    candidates: plan.candidates.map((candidate) => ({ ...toCandidateDto(candidate), promptKey: candidate.promptKey })),
    scenarios: plan.scenarios,
    omitted: plan.omitted,
  };
  const start = await startAdviceRun(
    db,
    {
      kind: "shopping",
      status: "running",
      climateProfileId: plan.profile.id,
      params: {
        force: options.force === true,
        purchaseBudgetEur: plan.budget.purchaseBudgetEur,
        boughtMinimumEur: plan.budget.boughtMinimumEur,
        remainingBudgetEur: plan.budget.remainingEur,
        relocationAnalysisId: plan.budget.relocationAnalysisId,
      },
      model: plan.model,
      effort: SHOPPING_CALL_PARAMS.effort,
      promptVersion: SHOPPING_PROMPT_VERSION,
      inputSnapshotHash: sha256(ready.instruction),
      cacheKey: ready.cacheKey,
      inputSnapshot,
      estimatedCostUsd: ready.estimateUsd,
    },
    ready.cacheKey,
    options.force === true,
  );
  if ("reused" in start) return { outcome: "reused", state: readyState(plan, start.reused) };
  const row = start.started;

  try {
    const byPromptKey = new Map(plan.candidates.map((candidate) => [candidate.promptKey, candidate]));
    const reply = await callStructured({
      model: plan.model,
      system: SHOPPING_SYSTEM_PROMPT,
      content: [{ type: "text", text: ready.instruction }],
      wire: ShoppingAdviceWireSchema,
      strict: makeShoppingAdviceStrictSchema([...byPromptKey.keys()], plan.budget.remainingEur),
      effort: SHOPPING_CALL_PARAMS.effort,
      maxTokens: SHOPPING_CALL_PARAMS.maxTokens,
      maxTokensCeiling: SHOPPING_CALL_PARAMS.maxTokensCeiling,
      purpose: SHOPPING_CALL_PARAMS.purpose,
      deadlineAt: deps.deadlineAt,
      deps: {
        db,
        anthropic,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.random === undefined ? {} : { random: deps.random }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      },
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      links: { analysisId: row.id },
    });

    const result: ShoppingAdviceResult = ShoppingAdviceResultSchema.parse({
      recommendations: reply.data.recommendations.map((entry) => {
        const candidate = byPromptKey.get(entry.key);
        // The strict schema accepts listed keys only.
        if (candidate === undefined) throw new AppError("INTERNAL", `Unknown candidate key ${entry.key}.`);
        return {
          key: candidate.key,
          rank: entry.rank,
          why: entry.why,
          budget_eur: entry.budget_eur,
          unlocks: candidate.unlocks,
        };
      }),
      meta: {
        prompt_version: SHOPPING_PROMPT_VERSION,
        model: plan.model,
        effort: SHOPPING_CALL_PARAMS.effort,
        candidate_count: plan.candidates.length,
        remaining_budget_eur: plan.budget.remainingEur,
        scenarios: plan.scenarios.map(({ key, label, tmeanC, rainy }) => ({ key, label, tmeanC, rainy })),
      },
    });

    const [done] = await db
      .update(analyses)
      .set({
        status: "complete",
        result,
        costUsd: await loggedCostUsd(db, row.id),
        completedAt: new Date(now()),
      })
      .where(eq(analyses.id, row.id))
      .returning();
    if (done === undefined) throw new AppError("INTERNAL", "The shopping advice could not be stored.");
    return { outcome: "ran", state: readyState(plan, done) };
  } catch (error) {
    await markFailed(db, row.id, error);
    throw error;
  }
}
