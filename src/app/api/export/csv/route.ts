import { getDb } from "@/lib/db";
import { authedRoute } from "@/server/http";
import { createCsvExport, crossSiteRefused, downloadResponse, isCrossSiteRequest } from "@/server/services/export";

// One row per item for spreadsheets (the export page links here), streamed
// page by page.
export const maxDuration = 60;

export const GET = authedRoute(null, async (_input, { request }) => {
  if (isCrossSiteRequest(request)) return crossSiteRefused();
  return downloadResponse(await createCsvExport({ db: getDb() }));
});
