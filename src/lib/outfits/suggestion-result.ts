// The stored result of an outfit suggestion (analyses.result, kind
// outfit_suggestion) and the limits it shares with the prompt. Client- and
// server-safe: /today parses stored results with it. The prompt, the payload
// and the estimate live in suggestion.ts, which stays off the client (D-156).

import { z } from "zod";

import { MAX_OUTFIT_ITEMS, OutfitEntrySchema } from "@/lib/outfits/contracts";
import { WeatherSnapshotSchema } from "@/lib/weather/open-meteo";

/** Outfits per suggestion. */
export const OUTFIT_SUGGESTION_COUNT = 3;

/** Text limits the prompt states and the strict check enforces. */
export const SUGGESTION_LIMITS = { titleMax: 60, whyMax: 300 } as const;

export const SuggestedOutfitSchema = z.strictObject({
  title: z.string().trim().min(1).max(SUGGESTION_LIMITS.titleMax),
  why: z.string().trim().min(1).max(SUGGESTION_LIMITS.whyMax),
  rain_ok: z.boolean(),
  /** Item uuids, in slot order once the style check ran (outfit-v3), else in the order Claude listed them. */
  items: z.array(OutfitEntrySchema).min(1).max(MAX_OUTFIT_ITEMS),
  /**
   * The style direction the outfit follows (outfit-v3, D-257). A plain string,
   * not the enum, so a direction removed later never makes a stored row
   * unreadable; absent in rows written before outfit-v3.
   */
  direction: z.string().min(1).max(40).optional(),
});
export type SuggestedOutfit = z.infer<typeof SuggestedOutfitSchema>;

export const OutfitSuggestionResultSchema = z.strictObject({
  outfits: z.array(SuggestedOutfitSchema).length(OUTFIT_SUGGESTION_COUNT),
  /** The forecast the outfits were chosen for. */
  weather: WeatherSnapshotSchema,
  meta: z.strictObject({
    prompt_version: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1),
    /** Items the prompt listed. */
    item_count: z.number().int().min(0),
    /** Eligible items left out because the prompt holds at most MAX_SUGGESTION_ITEMS. */
    dropped_count: z.number().int().min(0),
    // The selection's numbers (outfit-v3, D-256); absent in rows written before it.
    /** Candidate outfits in Claude's reply. */
    candidate_count: z.number().int().min(0).optional(),
    /** Candidates the strict adapter or the selection left out, whatever the reason. */
    dropped_candidates: z.number().int().min(0).optional(),
    /** Usable candidates that needed a layering or socks repair. */
    repaired_candidates: z.number().int().min(0).optional(),
    /**
     * The directions assigned to the candidates, in order (D-257). Plain
     * strings, as for an outfit's direction; the variety history reads them.
     */
    directions: z.array(z.string().min(1).max(40)).max(8).optional(),
  }),
});
export type OutfitSuggestionResult = z.infer<typeof OutfitSuggestionResultSchema>;
