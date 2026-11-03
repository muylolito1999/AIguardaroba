// The stored result of a "What to buy next" run (analyses.result, kind
// shopping, D-040) and the limits it shares with the prompt. Client- and
// server-safe; the prompt and the estimate live in advice.ts, which stays off
// the client (D-156).

import { z } from "zod";

import { MAX_EUR } from "@/lib/relocation/contracts";

export const SHOPPING_ADVICE_LIMITS = {
  /** Recommendations per run, most important first. */
  maxRecommendations: 10,
  whyMax: 300,
} as const;

export const ScenarioSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  tmeanC: z.number(),
  rainy: z.boolean(),
});

export const ShoppingRecommendationSchema = z.strictObject({
  /** The candidate's key as the run listed it. */
  key: z.string().min(1),
  /** 1 = buy first; ranks run 1..n without gaps. */
  rank: z.number().int().min(1),
  why: z.string().trim().min(1).max(SHOPPING_ADVICE_LIMITS.whyMax),
  /** Whole euros to set aside for it. */
  budget_eur: z.number().int().min(0).max(MAX_EUR),
  /** New outfits per scenario key, computed by combinatorics.ts, not by Claude. */
  unlocks: z.record(z.string(), z.number().int().min(0)),
});
export type ShoppingRecommendation = z.infer<typeof ShoppingRecommendationSchema>;

export const ShoppingAdviceResultSchema = z.strictObject({
  recommendations: z.array(ShoppingRecommendationSchema).max(SHOPPING_ADVICE_LIMITS.maxRecommendations),
  meta: z.strictObject({
    prompt_version: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1),
    /** Candidates the prompt listed. */
    candidate_count: z.number().int().min(0),
    /** The purchase budget left when the run started; null when none was set. */
    remaining_budget_eur: z.number().int().min(0).max(MAX_EUR).nullable(),
    /** The scenarios the unlock counts refer to, in order. */
    scenarios: z.array(ScenarioSchema),
  }),
});
export type ShoppingAdviceResult = z.infer<typeof ShoppingAdviceResultSchema>;
