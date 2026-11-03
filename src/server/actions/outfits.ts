"use server";

import { z } from "zod";

import { getDb } from "@/lib/db";
import type { OutfitInputValues } from "@/lib/outfits/contracts";
import { ok } from "@/lib/result";
import { deleteOutfit as deleteOutfitService, saveOutfit as saveOutfitService } from "@/server/services/outfits";

import { authedAction } from "./_wrap";

// The outfit builder (/outfits/new, /outfits/[id]). Each action returns what
// the builder needs and revalidates nothing: the outfit pages read uncached
// data in Suspense children, and the list reads itself again when shown after
// an outfit change noted in the tab (src/components/outfits/outfit-changes.ts).

/**
 * Creates an outfit without `id`, otherwise replaces that outfit's fields and
 * items. The form is passed on as sent: the service parses it with
 * OutfitInputSchema itself, and parsing it twice would fail, because the
 * schema turns an empty occasion into null, which it does not accept as input.
 * Its VALIDATION errors carry the field issues, or the slot issues as
 * `details.outfitIssues`.
 */
export const saveOutfit = authedAction(
  z.strictObject({ id: z.uuid().optional(), outfit: z.custom<OutfitInputValues>() }),
  async ({ id, outfit }) => ok(await saveOutfitService(getDb(), outfit, id)),
  { name: "saveOutfit" },
);

/** Deletes the outfit; its items and their wear history stay. */
export const deleteOutfit = authedAction(
  z.strictObject({ id: z.uuid() }),
  async ({ id }) => ok(await deleteOutfitService(getDb(), id)),
  { name: "deleteOutfit" },
);
