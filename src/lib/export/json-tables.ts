// The JSON export's layout (D-114). Pure and free of `server-only`, like
// csv.ts, so the Playwright export spec can check the downloaded file against
// the same list the server writes.

/** Bumped when the JSON layout changes in a way a reader must know about. */
export const EXPORT_FORMAT_VERSION = 1;

/**
 * The JSON file's table keys (the schema's export names), in file order.
 * item_images is not a key of its own: each item carries its photo rows.
 * login_attempts is left out: it holds keyed hashes of client IPs for the
 * rate limit, nothing of the owner's, and the hashes are derived from
 * SESSION_SECRET. No other table holds a secret. A unit test fails when the
 * schema gains a table this list neither has nor leaves out on purpose.
 */
export const EXPORT_JSON_TABLES = [
  "items",
  "climateProfiles",
  "appSettings",
  "analyses",
  "analysisParts",
  "shoppingListItems",
  "packingChecklistItems",
  "outfits",
  "outfitItems",
  "wearLogs",
  "aiCalls",
  "aiBatches",
] as const;

export type ExportJsonTable = (typeof EXPORT_JSON_TABLES)[number];
