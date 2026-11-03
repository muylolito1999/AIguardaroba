import { z } from "zod";

import { getAnthropic } from "@/lib/ai/client";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/items/contracts";
import { RELOCATION_PART_DEADLINE_MS } from "@/lib/relocation/prompts";
import { err, ok } from "@/lib/result";
import { authedRoute, type AuthedRouteContext } from "@/server/http";
import { runRelocationPart } from "@/server/services/relocation";

// Runs one part of a relocation analysis: a chunk of items or the synthesis
// (D-025). /relocate calls it for up to four chunks at a time, then for the
// synthesis, and again for Retry; a Route Handler, so the calls run in
// parallel (D-035). The body is {} or, for the owner's Retry of a failed
// part, { retry: true }: without it a failed part is answered as it is and
// never paid for again on the browser's own re-ask (D-157). Answers the run's
// progress (RelocationRunDto).
//
// One part may take minutes on Sonnet, so the route gets the full 300 s and
// the service stops calling Claude 270 s in (RELOCATION_PART_DEADLINE_MS),
// leaving time to store the result. The request's abort signal is not passed
// on: a part runs to its end, stored for the page to show, whether or not the
// tab that asked for it is still open. On Vercel a closed tab does not abort
// the request anyway (cancellation is opt-in per path, and turning it on
// would end the function before the part could record anything), so the app
// behaves the same locally and deployed and nothing paid is thrown away
// (D-167).
export const maxDuration = 300;

/** An empty body counts as {}. */
const PartRequestSchema = z.strictObject({ retry: z.boolean().optional() }).optional();

export const POST = authedRoute(
  PartRequestSchema,
  async (input, { params }: AuthedRouteContext<{ id: string; partId: string }>) => {
    const startedAt = Date.now();
    const { id, partId } = await params;
    if (!isUuid(id) || !isUuid(partId)) return err("NOT_FOUND", "That part of the analysis does not exist.");
    // The getter is passed, not the client: a finished part is answered without
    // an API key, and a missing key is a CONFIG error the wrapper hides (D-053).
    return ok(
      await runRelocationPart(
        getDb(),
        id,
        partId,
        {
          anthropic: getAnthropic,
          deadlineAt: startedAt + RELOCATION_PART_DEADLINE_MS,
        },
        { retry: input?.retry === true },
      ),
    );
  },
);
