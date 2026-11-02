import { defineRelations } from "drizzle-orm";

import * as schema from "./schema";

// Relational query (db.query.*) definitions for the v1 API. Every relation names
// its columns explicitly, so nothing depends on inferring which foreign key a
// relation follows.
export const relations = defineRelations(schema, (r) => ({
  items: {
    images: r.many.itemImages({ from: r.items.id, to: r.itemImages.itemId }),
    wearLogs: r.many.wearLogs({ from: r.items.id, to: r.wearLogs.itemId }),
    outfitItems: r.many.outfitItems({ from: r.items.id, to: r.outfitItems.itemId }),
    outfits: r.many.outfits({
      from: r.items.id.through(r.outfitItems.itemId),
      to: r.outfits.id.through(r.outfitItems.outfitId),
    }),
    taggingBatch: r.one.aiBatches({ from: r.items.taggingBatchId, to: r.aiBatches.id }),
  },
  itemImages: {
    item: r.one.items({ from: r.itemImages.itemId, to: r.items.id, optional: false }),
  },
  aiBatches: {
    items: r.many.items({ from: r.aiBatches.id, to: r.items.taggingBatchId }),
  },
  climateProfiles: {
    analyses: r.many.analyses({ from: r.climateProfiles.id, to: r.analyses.climateProfileId }),
  },
  analyses: {
    climateProfile: r.one.climateProfiles({ from: r.analyses.climateProfileId, to: r.climateProfiles.id }),
    parts: r.many.analysisParts({ from: r.analyses.id, to: r.analysisParts.analysisId }),
    packingItems: r.many.packingChecklistItems({ from: r.analyses.id, to: r.packingChecklistItems.analysisId }),
    shoppingItems: r.many.shoppingListItems({ from: r.analyses.id, to: r.shoppingListItems.analysisId }),
    aiCalls: r.many.aiCalls({ from: r.analyses.id, to: r.aiCalls.analysisId }),
  },
  analysisParts: {
    analysis: r.one.analyses({ from: r.analysisParts.analysisId, to: r.analyses.id, optional: false }),
  },
  shoppingListItems: {
    analysis: r.one.analyses({ from: r.shoppingListItems.analysisId, to: r.analyses.id }),
    linkedItem: r.one.items({ from: r.shoppingListItems.linkedItemId, to: r.items.id }),
  },
  packingChecklistItems: {
    analysis: r.one.analyses({ from: r.packingChecklistItems.analysisId, to: r.analyses.id, optional: false }),
    item: r.one.items({ from: r.packingChecklistItems.itemId, to: r.items.id }),
  },
  outfits: {
    outfitItems: r.many.outfitItems({ from: r.outfits.id, to: r.outfitItems.outfitId }),
    items: r.many.items({
      from: r.outfits.id.through(r.outfitItems.outfitId),
      to: r.items.id.through(r.outfitItems.itemId),
    }),
    wearLogs: r.many.wearLogs({ from: r.outfits.id, to: r.wearLogs.outfitId }),
  },
  outfitItems: {
    outfit: r.one.outfits({ from: r.outfitItems.outfitId, to: r.outfits.id, optional: false }),
    item: r.one.items({ from: r.outfitItems.itemId, to: r.items.id, optional: false }),
  },
  wearLogs: {
    item: r.one.items({ from: r.wearLogs.itemId, to: r.items.id }),
    outfit: r.one.outfits({ from: r.wearLogs.outfitId, to: r.outfits.id }),
  },
  aiCalls: {
    item: r.one.items({ from: r.aiCalls.itemId, to: r.items.id }),
    analysis: r.one.analyses({ from: r.aiCalls.analysisId, to: r.analyses.id }),
  },
  appSettings: {
    homeProfile: r.one.climateProfiles({ from: r.appSettings.homeProfileId, to: r.climateProfiles.id }),
  },
}));

export type Relations = typeof relations;
