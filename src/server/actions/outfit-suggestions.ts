"use server";

import { SaveSuggestedOutfitInputSchema } from "@/components/today/today-model";
import { getDb } from "@/lib/db";
import { ok } from "@/lib/result";
import { saveSuggestedOutfit as saveSuggestedOutfitService } from "@/server/services/outfit-suggestions";

import { authedAction } from "./_wrap";

// /today's Save on a suggested outfit. A Server Action, not a route: it is
// one quick write. Asking for suggestions takes up to two minutes and runs in
// POST /api/outfits/suggest instead, so it never holds the page's action
// queue (D-035). Nothing is revalidated: /today shows the saved state itself,
// and the outfit pages read again through the outfit change the page notes.

export const saveSuggestedOutfit = authedAction(
  SaveSuggestedOutfitInputSchema,
  async (input) => ok(await saveSuggestedOutfitService(getDb(), input)),
  { name: "saveSuggestedOutfit" },
);
