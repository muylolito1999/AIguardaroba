"use server";

import { z } from "zod";

import { ClimateProfileUpdateSchema } from "@/components/climate/climate-model";
import { getDb } from "@/lib/db";
import { ok } from "@/lib/result";
import {
  setDefaultClimateProfile as setDefaultClimateProfileService,
  updateClimateProfile as updateClimateProfileService,
} from "@/server/services/climate";

import { authedAction } from "./_wrap";

// The /settings/climate editor. Nothing is revalidated: the page reads its
// profiles uncached in a Suspense child, and the editor replaces the card it
// holds with the profile each action returns.

export const updateClimateProfile = authedAction(
  ClimateProfileUpdateSchema,
  async (input) => ok(await updateClimateProfileService(getDb(), input)),
  { name: "updateClimateProfile" },
);

export const setDefaultClimateProfile = authedAction(
  z.strictObject({ id: z.uuid() }),
  async ({ id }) => ok(await setDefaultClimateProfileService(getDb(), id)),
  { name: "setDefaultClimateProfile" },
);
