import { getDb } from "@/lib/db";
import { CheckHashesBodySchema } from "@/lib/items/contracts";
import { ok } from "@/lib/result";
import { authedRoute } from "@/server/http";
import { checkHashes } from "@/server/services/check-hashes";

// Pre-upload dedupe for a batch of picked files (D-033): answers which source
// hashes already belong to an item, so those files are never uploaded.
export const POST = authedRoute(CheckHashesBodySchema, async ({ sourceHashes }) =>
  ok(await checkHashes(getDb(), sourceHashes)),
);
