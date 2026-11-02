import { z } from "zod";

import { getDb } from "@/lib/db";
import { EXPORT_IMAGE_KINDS } from "@/lib/export/zip-plan";
import { authedRoute } from "@/server/http";
import { createImageZip, crossSiteRefused, downloadResponse, isCrossSiteRequest } from "@/server/services/export";

// One ZIP part of one photo kind, built while it downloads: the server fetches
// each photo from Vercel Blob in turn and streams it into the archive. Parts
// hold at most 100 photos so one finishes inside Vercel's 300 s limit, the
// Hobby maximum.
export const maxDuration = 300;

const ImagesQuerySchema = z.object({
  kind: z.enum(EXPORT_IMAGE_KINDS),
  // Digits only, from 1: "1.0", "01" or "-1" are not part numbers.
  part: z
    .string()
    .regex(/^[1-9]\d{0,5}$/, "Expected a part number from 1.")
    .transform(Number),
});

export const GET = authedRoute(ImagesQuerySchema, async ({ kind, part }, { request }) => {
  if (isCrossSiteRequest(request)) return crossSiteRefused();
  // fetch is read here, per request, so tests can stub the global.
  const download = await createImageZip({ db: getDb(), fetch, signal: request.signal }, { kind, part });
  return downloadResponse(download);
});
