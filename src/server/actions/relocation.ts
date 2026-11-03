"use server";

import { z } from "zod";

import { getDb } from "@/lib/db";
import { PACKING_GROUPS } from "@/lib/db/enums";
import { RelocationParamsSchema } from "@/lib/relocation/contracts";
import { RELOCATION_LIMITS } from "@/lib/relocation/schemas";
import { ok } from "@/lib/result";
import {
  addGapsToShoppingList as addGapsService,
  addPackingExtra as addPackingExtraService,
  applyAiDecisionsToUndecided as applyDecisionsService,
  deletePackingExtra as deletePackingExtraService,
  estimateRelocation as estimateService,
  MAX_PACKING_LABEL,
  setPackingItemPacked as setPackedService,
  startRelocation as startService,
} from "@/server/services/relocation";

import { authedAction } from "./_wrap";

// The relocation form and result screen's single calls. The parts of a
// run go through POST /api/analyses/[id]/parts/[partId] instead, so several
// run at once (D-035). Decision overrides use setItemDecision from the item
// actions. Nothing is revalidated: the pages read uncached data in Suspense
// children, and the client updates what it shows from the returned DTOs.
// The run's progress has no action: /relocate/[id] reads it on the server,
// and every part answer carries it (RelocationRunDto).

/** The form's live estimate; no Claude call, no write, no API key needed. */
export const estimateRelocation = authedAction(
  RelocationParamsSchema,
  async (params) => ok(await estimateService(getDb(), params)),
  { name: "estimateRelocation" },
);

/** Run, or "Re-run anyway" with force; an identical finished run comes back as { kind: "cached" }. */
export const startRelocation = authedAction(
  z.strictObject({ params: RelocationParamsSchema, force: z.boolean().default(false) }),
  async ({ params, force }) => ok(await startService(getDb(), params, { force })),
  { name: "startRelocation" },
);

/** Writes the run's decisions to undecided, non-archived items; the client notes a wardrobe change. */
export const applyAiDecisionsToUndecided = authedAction(
  z.strictObject({ analysisId: z.uuid() }),
  async ({ analysisId }) => ok(await applyDecisionsService(getDb(), analysisId)),
  { name: "applyAiDecisionsToUndecided" },
);

export const addGapsToShoppingList = authedAction(
  z.strictObject({
    analysisId: z.uuid(),
    gapKeys: z
      .array(z.string().min(1).max(RELOCATION_LIMITS.gapKeyMax))
      .min(1, { error: "Choose at least one gap." })
      .max(RELOCATION_LIMITS.gapsMax),
  }),
  async ({ analysisId, gapKeys }) => ok(await addGapsService(getDb(), analysisId, gapKeys)),
  { name: "addGapsToShoppingList" },
);

export const setPackingItemPacked = authedAction(
  z.strictObject({ id: z.uuid(), packed: z.boolean() }),
  async ({ id, packed }) => ok(await setPackedService(getDb(), id, packed)),
  { name: "setPackingItemPacked" },
);

export const addPackingExtra = authedAction(
  z.strictObject({
    analysisId: z.uuid(),
    group: z.enum(PACKING_GROUPS),
    label: z
      .string()
      .trim()
      .min(1, { error: "Write what to pack." })
      .max(MAX_PACKING_LABEL, { error: `Keep it under ${MAX_PACKING_LABEL} characters.` }),
  }),
  async ({ analysisId, group, label }) => ok(await addPackingExtraService(getDb(), analysisId, group, label)),
  { name: "addPackingExtra" },
);

export const deletePackingExtra = authedAction(
  z.strictObject({ id: z.uuid() }),
  async ({ id }) => ok(await deletePackingExtraService(getDb(), id)),
  { name: "deletePackingExtra" },
);
