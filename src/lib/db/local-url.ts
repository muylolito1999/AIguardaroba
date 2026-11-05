// Whether a Postgres URL names a database on this machine. Pure and free of
// `server-only`, because drizzle.config.ts imports it and drizzle-kit loads
// that file outside Next (like schema.ts and enums.ts).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why the URL is not a local database, or null when it is. `name` is the
 * variable the URL came from, for the message; the URL itself is never echoed,
 * so a password in it cannot reach a log.
 */
export function nonLocalReason(databaseUrl: string, name = "DATABASE_URL"): string | null {
  if (!URL.canParse(databaseUrl)) return `${name} is not a valid URL.`;
  const url = new URL(databaseUrl);
  // node-postgres copies every query parameter into its config, and a `host`
  // there replaces the URL's host (libpq reads `hostaddr` too), so
  // `localhost/db?host=<remote>` would pass a check of the hostname alone.
  if (url.searchParams.has("host") || url.searchParams.has("hostaddr")) {
    return `${name} sets the host in its query string; put a local host in the URL itself.`;
  }
  if (LOCAL_HOSTS.has(url.hostname)) return null;
  return `${name} points at host "${url.hostname}", not localhost or 127.0.0.1.`;
}

/** Set to "1" to open Drizzle Studio on a remote database anyway (D-242). */
export const ALLOW_REMOTE_STUDIO_VAR = "ALLOW_REMOTE_DB_STUDIO";

/**
 * Refuses `drizzle-kit studio` on a database that is not on this machine,
 * unless ALLOW_REMOTE_DB_STUDIO=1 (D-242). Studio serves an unauthenticated
 * SQL endpoint on 127.0.0.1:4983 that answers any web origin, so pointed at
 * Neon it would hand production to any page the browser lets reach loopback.
 * Returns a warning to print when the opt-in was used, otherwise null.
 */
export function assertStudioTarget(
  command: string | undefined,
  databaseUrl: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (command !== "studio" || databaseUrl === undefined) return null;
  const reason = nonLocalReason(databaseUrl, "DATABASE_URL_UNPOOLED");
  if (reason === null) return null;
  if (env[ALLOW_REMOTE_STUDIO_VAR] === "1") {
    return `Opening Drizzle Studio on a remote database (${ALLOW_REMOTE_STUDIO_VAR}=1). While it runs, any web page your browser lets reach 127.0.0.1:4983 can run SQL there; close other tabs and stop Studio when done.`;
  }
  throw new Error(
    `drizzle-kit studio refused: ${reason} Studio serves an unauthenticated SQL endpoint that any web page can call, ` +
      `so it is for local databases only. Point DATABASE_URL_UNPOOLED at the Docker database, or set ${ALLOW_REMOTE_STUDIO_VAR}=1 for one run if you really mean to.`,
  );
}
