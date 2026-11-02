import { getDb } from "@/lib/db";
import { getBlobStorage } from "@/lib/images/blob";
import { NobgBodySchema } from "@/lib/items/contracts";
import { ok } from "@/lib/result";
import { authedRoute, type AuthedRouteContext } from "@/server/http";
import { attachNobgImage } from "@/server/services/nobg";

// Called by the Remove background button after the browser has made the
// cut-out and uploaded it (D-034). Reading a PNG of a few MB, one sharp
// encode, one Blob put and the upsert fit well within a minute.
export const maxDuration = 60;

export const POST = authedRoute(NobgBodySchema, async (input, { params }: AuthedRouteContext<{ id: string }>) => {
  const { id } = await params;
  return ok(await attachNobgImage({ db: getDb(), storage: getBlobStorage(), fetch }, id, input));
});
