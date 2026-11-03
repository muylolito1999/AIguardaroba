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
  /** Item uuids, in the order Claude listed them. */
  items: z.array(OutfitEntrySchema).min(1).max(MAX_OUTFIT_ITEMS),
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
  }),
});
export type OutfitSuggestionResult = z.infer<typeof OutfitSuggestionResultSchema>;
