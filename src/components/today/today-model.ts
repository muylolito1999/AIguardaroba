// What /today exchanges between the server and the browser: the page's data,
// a stored suggestion with its items as they are now, the cost quote, and the
// inputs of the suggestion route and the Save action. Client- and
// server-safe (zod, the enum lists and the client-safe weather and outfit
// modules only): the services build these DTOs and the browser checks the
// route's answer with the same schemas.

import { z } from "zod"

import { ITEM_CATEGORIES, ITEM_COLLECTIONS, ITEM_STATUSES, OUTFIT_SLOTS } from "@/lib/db/enums"
import type { OutfitItemDto } from "@/lib/outfits/contracts"
import { OUTFIT_SUGGESTION_COUNT } from "@/lib/outfits/suggestion-result"
import { WeatherSnapshotSchema, type WeatherSnapshot } from "@/lib/weather/open-meteo"

/** One suggested outfit with its items as they are now. */
export type SuggestedOutfitDto = {
  /** 0 to 2: the outfit's place in the stored result, which Save names. */
  index: number
  title: string
  why: string
  /**
   * The style direction key the outfit follows (D-256), which directionLabel
   * names on the card. null for a suggestion stored before directions; a key
   * since removed has no label, so the card shows nothing either way.
   */
  direction: string | null
  rainOk: boolean
  /** In SLOT_ORDER. An item deleted since has exists false. */
  items: OutfitItemDto[]
  /**
   * No item has an outfitItemProblem (deleted, archived or moved to running
   * gear, D-250), so Save and "Wore this today" can work. The cards badge
   * items with the same helper, so a badge and this flag always agree.
   */
  available: boolean
  /** The outfit Save created from this one, while it exists. */
  savedOutfitId: string | null
  /** Every item of the outfit has a wear logged for today. */
  wornToday: boolean
}

/** The latest stored suggestion for today, as /today shows it. */
export type TodaySuggestionDto = {
  analysisId: string
  /** ISO 8601. */
  createdAt: string
  /** The home city (climate profile) it was chosen for; null once that profile is deleted. */
  profileId: string | null
  /** YYYY-MM-DD: the forecast day the outfits were chosen for. */
  date: string
  /** The forecast the outfits were chosen for. */
  weather: WeatherSnapshot
  model: string
  costUsd: number
  /** Items the prompt listed, and eligible items left out above the limit. */
  itemCount: number
  droppedCount: number
  outfits: SuggestedOutfitDto[]
}

/** What "Suggest outfits" would cost now, for the button's description. */
export type SuggestionQuoteDto = {
  model: string
  estimateUsd: number
  /** Eligible items the prompt would list. */
  itemCount: number
  /** Eligible items above the prompt's limit, left out. */
  droppedCount: number
  /** At least three different valid outfits can be made, so a call can succeed. */
  canSuggest: boolean
}

export type TodayPlace = { profileId: string; city: string; country: string }

/** Everything the /today view shows once the weather is known. */
export type TodayViewData = {
  place: TodayPlace
  /** YYYY-MM-DD in the home time zone. */
  today: string
  weather: WeatherSnapshot
  quote: SuggestionQuoteDto
  suggestion: TodaySuggestionDto | null
}

export type SavedSuggestionDto = {
  analysisId: string
  index: number
  outfitId: string
  /** Saved before: the existing outfit is answered and nothing new is created. */
  alreadySaved: boolean
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** POST /api/outfits/suggest. An empty body counts as {}; force asks for new outfits even when nothing changed. */
export const SuggestRequestSchema = z.strictObject({ force: z.boolean().optional() }).optional()
export type SuggestRequest = z.input<typeof SuggestRequestSchema>

export const SaveSuggestedOutfitInputSchema = z.strictObject({
  analysisId: z.uuid(),
  index: z
    .number()
    .int()
    .min(0)
    .max(OUTFIT_SUGGESTION_COUNT - 1),
})
export type SaveSuggestedOutfitInput = z.infer<typeof SaveSuggestedOutfitInputSchema>

// ---------------------------------------------------------------------------
// The route's answer, checked in the browser
// ---------------------------------------------------------------------------

const OutfitItemSchema: z.ZodType<OutfitItemDto> = z.object({
  itemId: z.string(),
  slot: z.enum(OUTFIT_SLOTS),
  name: z.string(),
  category: z.enum(ITEM_CATEGORIES).nullable(),
  thumbUrl: z.string().nullable(),
  status: z.enum(ITEM_STATUSES).nullable(),
  // An older server omits it during a deploy; null reads as clothing.
  collection: z.enum(ITEM_COLLECTIONS).nullable().default(null),
  wearCount: z.number().int(),
  exists: z.boolean(),
})

const SuggestedOutfitSchema: z.ZodType<SuggestedOutfitDto> = z.object({
  index: z.number().int(),
  title: z.string(),
  why: z.string(),
  // An older server omits it during a deploy; null shows no style line.
  direction: z.string().nullable().default(null),
  rainOk: z.boolean(),
  items: z.array(OutfitItemSchema),
  available: z.boolean(),
  savedOutfitId: z.string().nullable(),
  wornToday: z.boolean(),
})

/** Unknown keys are dropped, so the server can add fields first. */
export const TodaySuggestionSchema: z.ZodType<TodaySuggestionDto> = z.object({
  analysisId: z.string(),
  createdAt: z.string(),
  profileId: z.string().nullable(),
  date: z.string(),
  weather: WeatherSnapshotSchema,
  model: z.string(),
  costUsd: z.number(),
  itemCount: z.number().int(),
  droppedCount: z.number().int(),
  outfits: z.array(SuggestedOutfitSchema),
})
