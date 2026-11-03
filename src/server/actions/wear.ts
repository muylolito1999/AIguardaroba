"use server";

import { getDb } from "@/lib/db";
import { ok } from "@/lib/result";
import { LogWearInputSchema, UndoWearInputSchema } from "@/lib/wear/contracts";
import { logWear as logWearService, undoWear as undoWearService } from "@/server/services/wear";

import { authedAction } from "./_wrap";

// Wear logging from the item page ("+1 worn today"), the outfit pages and
// /today ("Wore this today"), and the Undo in the toast that follows. The
// callers note a wardrobe change once the answer arrives, so the pages Next
// keeps hidden read the new counts when shown (D-107).

export const logWear = authedAction(
  LogWearInputSchema,
  async (input) => ok(await logWearService(getDb(), input, { now: new Date() })),
  { name: "logWear" },
);

export const undoWear = authedAction(
  UndoWearInputSchema,
  async (input) => ok(await undoWearService(getDb(), input, { now: new Date() })),
  { name: "undoWear" },
);
