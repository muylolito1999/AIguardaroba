import { getAnthropic } from "@/lib/ai/client";
import { getDb } from "@/lib/db";
import { isUuid, TagBodySchema } from "@/lib/items/contracts";
import { err, ok } from "@/lib/result";
import { authedRoute, type AuthedRouteContext } from "@/server/http";
import { tagItem } from "@/server/services/tag-item";

// Tags one item; the add page calls it up to four items at a time and the
// review card calls it for Retry, Re-tag and "Tag now instead" (a Route
// Handler so the calls run in parallel, D-035). The body is `{}`,
// `{ "force": true }`, or `{ "force": true, "batchId": "<uuid>" }` from a card
// that shows the item in a batch. The service stops calling Claude 50 s in,
// inside this limit.
export const maxDuration = 60;

export const POST = authedRoute(
  TagBodySchema,
  async ({ force, batchId }, { params }: AuthedRouteContext<{ id: string }>) => {
    const { id } = await params;
    if (!isUuid(id)) return err("VALIDATION", "That is not a valid item id.");
    // The request's abort signal is not passed on: if the browser leaves, the
    // paid-for answer is still stored instead of being thrown away.
    const options = batchId === undefined ? { force } : { force, batchId };
    return ok(await tagItem({ db: getDb(), anthropic: getAnthropic, fetch }, id, options));
  },
);
