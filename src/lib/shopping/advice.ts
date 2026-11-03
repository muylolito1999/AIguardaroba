// "What to buy next" (D-040): the prompt, the wire and strict schemas and the
// estimate of the shopping advice call. The unlock counts come from
// combinatorics.ts; Claude only ranks the candidates, explains the ranking and
// sets a budget per purchase. Every request sends the static
// SHOPPING_SYSTEM_PROMPT (it carries the cache breakpoint) and then one
// instruction with the climate, the scenarios, the budget and the candidates.
// advice.test.ts pins the system prompt and one hash over the instruction
// template and the wire schema per SHOPPING_PROMPT_VERSION.
// Pure, but not client-safe: it holds the prompt and prices with the server's
// model table. Client code imports advice-result.ts and types only (D-156).

import { z } from "zod";

import { computeCostUsd, estimateTextTokens } from "@/lib/ai/cost";
import type { PricedModelId } from "@/lib/ai/models";
import { describeClimateForPrompt, type ClimatePromptProfile } from "@/lib/climate/range";
import type { ItemCategory } from "@/lib/db/enums";
import { MAX_EUR } from "@/lib/relocation/contracts";
import { sanitizeLineValue } from "@/lib/relocation/payload";
import { SHOPPING_ADVICE_LIMITS } from "@/lib/shopping/advice-result";
import { RAINY_MONTH_DAYS, type Scenario } from "@/lib/shopping/combinatorics";

export {
  SHOPPING_ADVICE_LIMITS,
  ShoppingAdviceResultSchema,
  type ShoppingAdviceResult,
  type ShoppingRecommendation,
} from "@/lib/shopping/advice-result";

export const SHOPPING_PROMPT_VERSION = "shop-v2";

const A = SHOPPING_ADVICE_LIMITS;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** What Claude writes: candidates by key, every key required, limits stated in the descriptions. */
export const ShoppingAdviceWireSchema = z.strictObject({
  recommendations: z
    .array(
      z.strictObject({
        key: z.string().describe("The candidate's key exactly as listed, e.g. c3."),
        rank: z.number().int().describe("1 = buy first; ranks run 1, 2, 3 and so on, each once."),
        why: z
          .string()
          .describe(`Why it ranks here, citing the unlock counts and the climate, at most ${A.whyMax} characters.`),
        budget_eur: z.number().int().describe("Whole euros to set aside for it, quantity included."),
      }),
    )
    .describe(`Up to ${A.maxRecommendations} candidates worth buying, each at most once.`),
});
export type ShoppingAdviceWire = z.infer<typeof ShoppingAdviceWireSchema>;
export type ShoppingAdviceStrict = ShoppingAdviceWire;

/**
 * The strict check of a reply: 1 to min(candidates, maxRecommendations)
 * recommendations; every key one of `candidateKeys` (compared case- and
 * space-insensitively, kept in its listed form) and none twice; ranks exactly
 * 1..n; why non-empty and within its limit; budget_eur a whole number of euros
 * from 0; and, when a remaining budget is given, the budgets adding up to no
 * more than it. A failure is invalid output, which callStructured retries.
 * The parsed value is sorted by rank.
 */
export function makeShoppingAdviceStrictSchema(
  candidateKeys: readonly string[],
  remainingBudgetEur: number | null,
): z.ZodType<ShoppingAdviceStrict> {
  if (candidateKeys.length === 0) throw new RangeError("Shopping advice needs at least one candidate.");
  const canonical = new Map(candidateKeys.map((key) => [key.trim().toLowerCase(), key]));
  const max = Math.min(candidateKeys.length, A.maxRecommendations);

  return z
    .strictObject({
      recommendations: z
        .array(
          z.strictObject({
            key: z.string().transform((value) => value.trim().toLowerCase()),
            rank: z.number().int().min(1),
            why: z.string().trim().min(1).max(A.whyMax),
            budget_eur: z.number().int().min(0).max(MAX_EUR),
          }),
        )
        .min(1)
        .max(max),
    })
    .superRefine((reply, ctx) => {
      const seen = new Set<string>();
      reply.recommendations.forEach((entry, index) => {
        if (!canonical.has(entry.key)) {
          ctx.addIssue({ code: "custom", path: ["recommendations", index, "key"], message: `Unknown key ${entry.key}.` });
        } else if (seen.has(entry.key)) {
          ctx.addIssue({ code: "custom", path: ["recommendations", index, "key"], message: `Key ${entry.key} appears twice.` });
        }
        seen.add(entry.key);
      });
      const ranks = reply.recommendations.map((entry) => entry.rank).sort((a, b) => a - b);
      if (ranks.some((rank, index) => rank !== index + 1)) {
        ctx.addIssue({
          code: "custom",
          path: ["recommendations"],
          message: `Ranks must be 1 to ${reply.recommendations.length}, each once.`,
        });
      }
      const total = reply.recommendations.reduce((sum, entry) => sum + entry.budget_eur, 0);
      if (remainingBudgetEur !== null && total > remainingBudgetEur) {
        ctx.addIssue({
          code: "custom",
          path: ["recommendations"],
          message: `The budgets add up to €${total}, more than the €${remainingBudgetEur} left.`,
        });
      }
    })
    .transform((reply) => ({
      recommendations: reply.recommendations
        .map((entry) => ({ ...entry, key: canonical.get(entry.key) ?? entry.key }))
        .sort((a, b) => a.rank - b.rank),
    }));
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export const SHOPPING_SYSTEM_PROMPT = `You are a frugal shopping adviser inside a personal wardrobe app. The owner keeps a shopping list of clothes they might buy, many of them gaps a relocation analysis found for a new, colder and wetter climate. They ask which of these purchases to make next, in what order, and how much to set aside for each. You get the climate, the purchase budget left, a few weather scenarios with the number of outfits the wardrobe makes in each today, and the candidate purchases as compact lines under short keys. You answer in the required JSON format. The owner reads your ranking in the app and decides; be concrete and honest rather than encouraging.

THE UNLOCK COUNTS
The app counts outfits deterministically, and you must take its numbers as given: never recount or invent them.
- An outfit here is a top or a dress, plus a bottom unless it is a dress, plus shoes, with or without outerwear. It fits a scenario when the formality of its pieces is within one step (athletic, casual, smart_casual, business, formal), their summed warmth suits the month's mean temperature, each piece suits the month on its own (no summer-weight bottom, dress or shoes in cool or colder months, outerwear when it is near freezing, no heavy outerwear in mild or warm months), and, in a rainy month, the outerwear or the shoes are waterproof.
- "unlocks" says how many new outfits the purchase would add in each scenario. The attributes of a candidate are read from its description and may be rough, so treat the counts as a strong signal rather than exact truth.
- A scenario where the wardrobe makes few or no outfits today is a real gap: a purchase that unlocks outfits there is worth more than one that adds to a month already well covered.
- Base layers, hats, gloves, scarves, bags and accessories are not part of the count, so they always unlock 0. Judge them from the climate instead: in cold, wet or windy months they can matter as much as a coat.

RANKING
- Rank the candidates worth buying, most important first: at least 1 and at most ${A.maxRecommendations}. Leave out what the wardrobe does not need yet, duplicates of a better candidate, and anything the climate does not justify.
- Weigh, in this order: what the climate makes necessary (rain gear when most days are wet, warmth when the mean is near or below freezing), the outfits unlocked where the wardrobe is thin, the owner's own priority (p1 most important), and the price.
- Prefer versatile pieces that combine with much of the wardrobe and work across several scenarios.
- Two candidates that do the same job: rank the better one and leave the other out, or rank it far lower and say why.

BUDGET
- budget_eur is what to set aside in whole euros for the whole quantity: a realistic price for good mid-range quality, per item inside the listed price range when there is one, times the quantity.
- When a remaining budget is given, the budgets of all recommendations together must not exceed it. If the essentials cost more, keep the essentials and leave the rest out. When no budget is given, recommend only what the climate makes necessary.

CANDIDATE LINES
Each candidate is one line of |-separated fields:
key|category|what to buy|priority|quantity|price range|source|unlocks per scenario|specs
- key: the candidate's id in this request, such as c3. Use only the keys listed, each at most once.
- priority: p1 most important to the owner, p3 least, p? not set. quantity: how many.
- price range: the estimate per item in whole euros, or ? when unknown.
- source: list = on the shopping list; gap = found by the latest relocation analysis, not on the list yet.
- unlocks: new outfits per scenario key, as in jan:4 apr:0.
- ? = unknown. Long text is shortened.

WRITING
- why: at most ${A.whyMax} characters. Say why the purchase ranks where it does, citing the unlock counts and the climate numbers that matter, such as "Unlocks 12 outfits in January, where the wardrobe makes only 3; 17 rain days a month." No keys in the text.
- Plain English, metric units, whole euros. Every field of the format is required.`;

export type ShoppingAdviceCandidate = {
  /** Short and unique within the run, such as c1..cN; the reply names candidates by it. */
  key: string;
  itemType: string;
  category: ItemCategory | null;
  /** The shopping list priority; null when unset. */
  priority: number | null;
  quantity: number;
  specs: readonly string[];
  estPriceMinEur: number | null;
  estPriceMaxEur: number | null;
  /** list = an open shopping list row; gap = a relocation gap not on the list. */
  source: "list" | "gap";
  /** unlockCount per scenario key. */
  unlocks: Readonly<Record<string, number>>;
};

/** A scenario with the outfits the wardrobe makes in it now (countOutfits). */
export type ShoppingAdviceScenario = Scenario & { outfitsNow: number };

export type ShoppingAdviceInstructionInput = {
  candidates: readonly ShoppingAdviceCandidate[];
  scenarios: readonly ShoppingAdviceScenario[];
  /** The purchase budget left; null when none is set. */
  remainingBudgetEur: number | null;
  /** A short description of the climate, such as describeAdviceClimate's text. */
  climateSummary: string;
};

/** The advice's climate table covers the whole year: the scenarios are fixed months, not a stay with an arrival month. */
export const ADVICE_CLIMATE_HEADING = "Monthly normals, January to December:";

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/** The <climate> block of the advice: the relocation prompt's climate text with all twelve months under ADVICE_CLIMATE_HEADING. */
export function describeAdviceClimate(profile: ClimatePromptProfile): string {
  return describeClimateForPrompt(profile, ALL_MONTHS, { heading: ADVICE_CLIMATE_HEADING });
}

const EUR = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function priceRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return "?";
  if (min === null) return `up to €${EUR.format(max ?? 0)}`;
  if (max === null) return `from €${EUR.format(min)}`;
  return min === max ? `€${EUR.format(min)}` : `€${EUR.format(min)}-${EUR.format(max)}`;
}

/** One candidate as a prompt line. */
export function candidateLine(candidate: ShoppingAdviceCandidate, scenarios: readonly Pick<Scenario, "key">[]): string {
  const specs = candidate.specs
    .map((spec) => sanitizeLineValue(spec, 120, [";"]))
    .filter((spec) => spec !== "?")
    .slice(0, 10);
  const unlocks = scenarios.map((scenario) => `${scenario.key}:${candidate.unlocks[scenario.key] ?? 0}`).join(" ");
  return [
    sanitizeLineValue(candidate.key, 40),
    candidate.category ?? "?",
    sanitizeLineValue(candidate.itemType, 120),
    candidate.priority === null ? "p?" : `p${candidate.priority}`,
    `x${candidate.quantity}`,
    priceRange(candidate.estPriceMinEur, candidate.estPriceMaxEur),
    candidate.source,
    unlocks === "" ? "?" : unlocks,
    specs.length === 0 ? "?" : specs.join("; "),
  ].join("|");
}

function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (rounded === 0 ? 0 : rounded).toFixed(1);
}

/** The user turn: climate, budget, scenarios, the candidate lines, then the task. */
export function buildShoppingAdviceInstruction(input: ShoppingAdviceInstructionInput): string {
  const { candidates, scenarios, remainingBudgetEur } = input;
  const budget =
    remainingBudgetEur === null
      ? "No purchase budget set."
      : `€${EUR.format(remainingBudgetEur)} left for all purchases together.`;
  const max = Math.min(candidates.length, SHOPPING_ADVICE_LIMITS.maxRecommendations);
  return [
    "<climate>",
    input.climateSummary.trim(),
    "</climate>",
    "",
    "<budget>",
    budget,
    "</budget>",
    "",
    "<scenarios>",
    ...scenarios.map(
      (scenario) =>
        `${scenario.key}: ${scenario.label}, mean ${oneDecimal(scenario.tmeanC)} °C, ` +
        `${scenario.rainy ? `rainy (${RAINY_MONTH_DAYS} or more rain days)` : `fewer than ${RAINY_MONTH_DAYS} rain days`}; ` +
        `the wardrobe makes ${scenario.outfitsNow} ${scenario.outfitsNow === 1 ? "outfit" : "outfits"} now`,
    ),
    "</scenarios>",
    "",
    `<candidates count="${candidates.length}">`,
    ...candidates.map((candidate) => candidateLine(candidate, scenarios)),
    "</candidates>",
    "",
    max === 1
      ? "Rank this candidate as 1, using its key above."
      : `Rank 1 to ${max} of these candidates worth buying next, most important first, using only the keys above.`,
    "- rank: 1 for the first purchase, then 2, 3 and so on, each once.",
    remainingBudgetEur === null
      ? "- budget_eur: whole euros to set aside for each, quantity included."
      : `- budget_eur: whole euros to set aside for each, quantity included; together at most €${EUR.format(remainingBudgetEur)}.`,
    `- why: at most ${SHOPPING_ADVICE_LIMITS.whyMax} characters, citing the unlock counts and the climate.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Request parameters and estimate
// ---------------------------------------------------------------------------

/**
 * Effort low: the counts are given, so the call only orders a short list and
 * writes a sentence per entry. The cap is what Sonnet writes in about 55 s at
 * the slowest assumed speed, and the ceiling equals it (D-164).
 */
export const SHOPPING_CALL_PARAMS = {
  purpose: "shopping",
  effort: "low",
  maxTokens: 6000,
  maxTokensCeiling: 6000,
} as const;

/** The route's deadline for the whole call, from the start of the request (maxDuration 120). */
export const SHOPPING_DEADLINE_MS = 110_000;

/**
 * Assumptions behind the estimate, to be replaced by measured values: about
 * 100 visible tokens per recommendation for the most a reply may hold, about
 * 1,500 thinking tokens at effort low, and the format's own 400 tokens.
 */
export const SHOPPING_ESTIMATE = {
  formatOverheadTokens: 400,
  visibleOutputTokensPerRecommendation: 100,
  thinkingTokens: 1_500,
} as const;

/** Estimated USD of one advice call at standard rates, for its rendered instruction. */
export function estimateShoppingAdviceUsd(model: PricedModelId, instruction: string): number {
  const input =
    estimateTextTokens(SHOPPING_SYSTEM_PROMPT) + estimateTextTokens(instruction) + SHOPPING_ESTIMATE.formatOverheadTokens;
  const output =
    SHOPPING_ESTIMATE.visibleOutputTokensPerRecommendation * SHOPPING_ADVICE_LIMITS.maxRecommendations +
    SHOPPING_ESTIMATE.thinkingTokens;
  return computeCostUsd(model, { input_tokens: input, output_tokens: output });
}
