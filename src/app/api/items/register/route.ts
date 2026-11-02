import { getDb } from "@/lib/db";
import { getBlobStorage } from "@/lib/images/blob";
import { RegisterBodySchema } from "@/lib/items/contracts";
import { ok } from "@/lib/result";
import { authedRoute } from "@/server/http";
import { registerUpload } from "@/server/services/register-upload";

// Called by the browser after each upload() resolves, up to three at a time
// (a Route Handler rather than an action so they run in parallel, D-035).
// Fetching, sharp and two Blob puts fit well within a minute.
export const maxDuration = 60;

export const POST = authedRoute(RegisterBodySchema, async (input) =>
  ok(await registerUpload({ db: getDb(), storage: getBlobStorage(), fetch }, input)),
);
