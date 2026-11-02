import { getDb } from "@/lib/db";
import { authedRoute } from "@/server/http";
import { createJsonExport, crossSiteRefused, downloadResponse, isCrossSiteRequest } from "@/server/services/export";

// The whole database except login attempts, as one JSON file (the export page
// links here). It streams page by page, so a minute covers thousands of items.
export const maxDuration = 60;

export const GET = authedRoute(null, async (_input, { request }) => {
  if (isCrossSiteRequest(request)) return crossSiteRefused();
  return downloadResponse(await createJsonExport({ db: getDb() }));
});
