import { getDb } from "@/lib/db";
import { ok } from "@/lib/result";
import { authedRoute } from "@/server/http";
import { getTaggingSetup } from "@/server/services/tagging-setup";

// The tagging model, rates and month's budget, re-read by the add page after
// tagging spent some of it. A whole-page refresh would re-run the page's
// server reads, and a failure there would replace the page mid-upload. A
// CONFIG error is answered as a 500 with the safe message.
export const GET = authedRoute(null, async () => ok(await getTaggingSetup(getDb(), new Date())));
