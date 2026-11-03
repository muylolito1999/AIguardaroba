import { z } from "zod";

import { getAnthropic } from "@/lib/ai/client";
import { getDb } from "@/lib/db";
import { err, ok } from "@/lib/result";
import { SHOPPING_DEADLINE_MS } from "@/lib/shopping/advice";
import { authedRoute, validationErr } from "@/server/http";
import { assertShoppingAdviceEnabled, runShoppingAdvice } from "@/server/services/shopping-advice";

// "What to buy next" on /shopping (D-040): one Claude call that ranks the
// candidates. A Route Handler rather than a Server Action, because the call
// can take a minute and Server Actions run one at a time per client, which
// would hold up every other action on the page meanwhile (D-035). The body is
// {} or, for "Run again", { force: true }; answers ShoppingAdviceRunDto.
//
// With FEATURE_SHOPPING_AI off the route answers 404 before reading the body,
// so it looks the same as a route that does not exist. The service stops
// calling Claude 110 s in (SHOPPING_DEADLINE_MS), leaving time to store the
// result within maxDuration. The request's abort signal is not passed on: an
// answer that is paid for is stored for the page to show, as with the
// relocation parts (D-167).
export const maxDuration = 120;

/** An empty body counts as {}. */
const AdviceRequestSchema = z.strictObject({ force: z.boolean().optional() }).optional();

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await request.text();
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export const POST = authedRoute(null, async (_input, { request }) => {
  const startedAt = Date.now();
  await assertShoppingAdviceEnabled();
  const body = await readJson(request);
  if (!body.ok) return err("VALIDATION", "The request body must be JSON.");
  const parsed = AdviceRequestSchema.safeParse(body.value);
  if (!parsed.success) return validationErr(parsed.error);
  // The getter is passed, not the client: reused advice is answered without
  // an API key, and a missing key is a CONFIG error the wrapper hides (D-053).
  return ok(
    await runShoppingAdvice(
      getDb(),
      { anthropic: getAnthropic, deadlineAt: startedAt + SHOPPING_DEADLINE_MS },
      { force: parsed.data?.force === true },
    ),
  );
});
