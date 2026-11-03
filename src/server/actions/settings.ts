"use server";

import { z } from "zod";

import { getDb } from "@/lib/db";
import { ok } from "@/lib/result";
import { setHomeProfile as setHomeProfileService } from "@/server/services/settings";

import { authedAction } from "./_wrap";

// Settings, Home city. Nothing is revalidated: /settings reads the choice
// uncached in a Suspense child, and the select shows what this returns. A
// /today that Next keeps hidden reads itself again when shown (the select
// notes the change in the browser).

export const setHomeProfile = authedAction(
  z.strictObject({ profileId: z.uuid() }),
  async ({ profileId }) => ok(await setHomeProfileService(getDb(), profileId)),
  { name: "setHomeProfile" },
);
