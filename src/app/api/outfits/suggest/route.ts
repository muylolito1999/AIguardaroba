import { SuggestRequestSchema } from "@/components/today/today-model";
import { getAnthropic } from "@/lib/ai/client";
import { getDb } from "@/lib/db";
import { OUTFIT_DEADLINE_MS } from "@/lib/outfits/suggestion";
import { ok } from "@/lib/result";
import { authedRoute } from "@/server/http";
import { suggestOutfits } from "@/server/services/outfit-suggestions";

// "Suggest outfits" on /today: three outfits for today's forecast from the
// items at home, as the page shows them (TodaySuggestionDto). The body is {}
// or { force: true } for "Suggest again"; without force a stored suggestion
// for the same items, day, prompt and model is answered without a call. A
// Route Handler rather than a Server Action: the Claude call can take a
// minute or more, and Server Actions run one at a time per client, so an
// action would hold Save and "Wore this today" until it answered (D-035).
//
// The route gets 120 s and the service stops calling Claude 110 s after the
// request started (OUTFIT_DEADLINE_MS), leaving time to store the result. The
// request's abort signal is not passed on: a suggestion that is already paid
// for is stored for the page to show, whether or not the tab is still open.
// Failures answer as the wrapper maps them: UPSTREAM when the weather cannot
// be read, NOT_FOUND without a home city, VALIDATION when the items cannot
// make three outfits, BUDGET_EXCEEDED, CONFLICT while another suggestion
// runs, and CONFIG without an API key (its details hidden, D-053).
export const maxDuration = 120;

export const POST = authedRoute(SuggestRequestSchema, async (input) => {
  const startedAt = Date.now();
  // The getter, not the client: a stored suggestion is answered without an API key (D-064).
  return ok(
    await suggestOutfits(
      getDb(),
      { anthropic: getAnthropic, deadlineAt: startedAt + OUTFIT_DEADLINE_MS },
      { force: input?.force === true },
    ),
  );
});
