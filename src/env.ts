import "server-only";

import { z } from "zod";

import { safeResolveModels, type ResolvedModels } from "@/lib/ai/models";
import { AppError } from "@/lib/result";

// Each concern validates on first use and is memoized, so a build or a page
// that never touches the AI layer does not need AI credentials. Failures name
// variables and the problem, never the values.

export type EnvSource = Record<string, string | undefined>;

export const ENV_GROUPS = ["db", "session", "password", "blob", "ai", "cron", "flags"] as const;
export type EnvGroup = (typeof ENV_GROUPS)[number];

type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; variables: string[]; problems: string[] };

// Blank lines copied from .env.example must count as "unset", not as a value.
function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function envVar<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToUndefined, schema);
}

// Every message is written here so Zod defaults (which may evolve) never echo input.
function requiredString() {
  return z.string({
    error: (issue) => (issue.input === undefined ? "is not set" : "must be a string"),
  });
}

function positiveNumber(fallback: number) {
  return z.coerce
    .number({ error: "must be a positive number" })
    .positive({ error: "must be a positive number" })
    .default(fallback);
}

function fromSchema<T>(schema: z.ZodType<T>): (source: EnvSource) => ParseOutcome<T> {
  return (source) => {
    const parsed = schema.safeParse({ ...source });
    if (parsed.success) return { ok: true, value: parsed.data };
    const variables: string[] = [];
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.map(String).join(".");
      if (name && !variables.includes(name)) variables.push(name);
      return name ? `${name} ${issue.message}` : issue.message;
    });
    return { ok: false, variables, problems };
  };
}

const POSTGRES_URL = /^postgres(?:ql)?:\/\/\S+$/;

const parseDb = fromSchema(
  z.object({
    DATABASE_URL: envVar(
      requiredString().refine((value) => POSTGRES_URL.test(value) && URL.canParse(value), {
        error: "must be a postgres:// or postgresql:// connection URL",
      }),
    ),
  }),
);

const parseSession = fromSchema(
  z.object({
    SESSION_SECRET: envVar(requiredString().min(32, { error: "must be at least 32 characters long" })),
  }),
);

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Returns the bcrypt hash encoded in `value`, or null when it is not base64 of one. */
export function decodePasswordHash(value: string): string | null {
  if (!BASE64.test(value)) return null;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return BCRYPT_HASH.test(decoded) ? decoded : null;
}

// The value is base64 because @next/env expands `$` in .env files, which
// silently corrupts a raw bcrypt hash pulled into .env.local.
const parsePassword = fromSchema(
  z
    .object({
      APP_PASSWORD_HASH: envVar(
        requiredString().transform((value, ctx) => {
          if (value.startsWith("$2")) {
            ctx.addIssue(
              "looks like a raw bcrypt hash; set the base64 value printed by `pnpm hash-password` instead",
            );
            return z.NEVER;
          }
          const decoded = decodePasswordHash(value);
          if (decoded === null) {
            ctx.addIssue("must be the base64 encoding of a bcrypt hash (generate it with `pnpm hash-password`)");
            return z.NEVER;
          }
          return decoded;
        }),
      ),
    })
    .transform(({ APP_PASSWORD_HASH }) => ({ passwordHash: APP_PASSWORD_HASH })),
);

const parseBlob = fromSchema(
  z.object({
    BLOB_READ_WRITE_TOKEN: envVar(
      requiredString().startsWith("vercel_blob_rw_", {
        error: "must be a Vercel Blob read-write token (starting with vercel_blob_rw_)",
      }),
    ),
  }),
);

// The AI settings without the key. Pages that show the budget or the model
// (usage, add) must work before ANTHROPIC_API_KEY is configured.
const aiSettingsShape = {
  CLAUDE_ANALYSIS_EFFORT: envVar(
    z.enum(["low", "medium", "high"], { error: "must be low, medium or high" }).default("medium"),
  ),
  MONTHLY_AI_BUDGET_USD: envVar(positiveNumber(20)),
  AI_CREDIT_USD: envVar(positiveNumber(100)),
};

const aiSettingsBaseSchema = z.object(aiSettingsShape);
const aiBaseSchema = z.object({ ANTHROPIC_API_KEY: envVar(requiredString()), ...aiSettingsShape });

export type AiSettingsEnv = z.output<typeof aiSettingsBaseSchema> & { models: ResolvedModels };
export type AiEnv = z.output<typeof aiBaseSchema> & { models: ResolvedModels };

/** Adds the resolved models to a parsed base, reporting base and model problems together. */
function withModels<T>(parseBase: (source: EnvSource) => ParseOutcome<T>) {
  return (source: EnvSource): ParseOutcome<T & { models: ResolvedModels }> => {
    const base = parseBase(source);
    const models = safeResolveModels(source);
    if (base.ok && models.ok) return { ok: true, value: { ...base.value, models: models.models } };
    return {
      ok: false,
      variables: [...(base.ok ? [] : base.variables), ...(models.ok ? [] : models.variables)],
      problems: [...(base.ok ? [] : base.problems), ...(models.ok ? [] : models.problems)],
    };
  };
}

const parseAi: (source: EnvSource) => ParseOutcome<AiEnv> = withModels(fromSchema(aiBaseSchema));
const parseAiSettings: (source: EnvSource) => ParseOutcome<AiSettingsEnv> = withModels(
  fromSchema(aiSettingsBaseSchema),
);

const parseCron = fromSchema(
  z.object({
    CRON_SECRET: envVar(requiredString().min(16, { error: "must be at least 16 characters long" })),
  }),
);

const parseFlags = fromSchema(
  z.object({
    FEATURE_SHOPPING_AI: envVar(
      z
        .enum(["true", "false", "1", "0"], { error: "must be true, false, 1 or 0" })
        .optional()
        .transform((value) => value === "true" || value === "1"),
    ),
  }),
);

const PARSERS = {
  db: parseDb,
  session: parseSession,
  password: parsePassword,
  blob: parseBlob,
  ai: parseAi,
  cron: parseCron,
  flags: parseFlags,
} satisfies Record<EnvGroup, (source: EnvSource) => ParseOutcome<unknown>>;

type ValueOf<G extends EnvGroup> = ReturnType<(typeof PARSERS)[G]> extends ParseOutcome<infer T> ? T : never;

export type DbEnv = ValueOf<"db">;
export type SessionEnv = ValueOf<"session">;
export type PasswordEnv = ValueOf<"password">;
export type BlobEnv = ValueOf<"blob">;
export type CronEnv = ValueOf<"cron">;
export type FlagsEnv = ValueOf<"flags">;

function configError(group: EnvGroup, variables: string[], problems: string[]): AppError {
  return new AppError(
    "CONFIG",
    `Invalid server configuration (${group}): ${problems.join("; ")}. See .env.example.`,
    { group, variables },
  );
}

function memoized<T>(group: EnvGroup, parse: (source: EnvSource) => ParseOutcome<T>, source: EnvSource) {
  let cached: { value: T } | undefined;
  return (): T => {
    if (cached) return cached.value;
    const outcome = parse(source);
    if (!outcome.ok) throw configError(group, outcome.variables, outcome.problems);
    cached = { value: outcome.value };
    return cached.value;
  };
}

/** Builds independent, lazily validated getters; tests pass their own `source`. */
export function createEnv(source: EnvSource = process.env) {
  return {
    dbEnv: memoized("db", PARSERS.db, source),
    sessionEnv: memoized("session", PARSERS.session, source),
    passwordEnv: memoized("password", PARSERS.password, source),
    blobEnv: memoized("blob", PARSERS.blob, source),
    aiEnv: memoized("ai", PARSERS.ai, source),
    // A subset of the ai group (errors name that group), not a group of its
    // own: `pnpm env:check` already reports these variables under ai.
    aiSettingsEnv: memoized("ai", parseAiSettings, source),
    cronEnv: memoized("cron", PARSERS.cron, source),
    flagsEnv: memoized("flags", PARSERS.flags, source),
  };
}

export type Env = ReturnType<typeof createEnv>;

export type EnvGroupReport = { ok: boolean; problems: string[] };

/** Validates every group without throwing; used by `pnpm env:check`. */
export function serverEnvReport(source: EnvSource = process.env): Record<EnvGroup, EnvGroupReport> {
  const report = {} as Record<EnvGroup, EnvGroupReport>;
  for (const group of ENV_GROUPS) {
    const outcome = PARSERS[group](source);
    report[group] = outcome.ok ? { ok: true, problems: [] } : { ok: false, problems: outcome.problems };
  }
  return report;
}

const env = createEnv();

export const dbEnv = env.dbEnv;
export const sessionEnv = env.sessionEnv;
export const passwordEnv = env.passwordEnv;
export const blobEnv = env.blobEnv;
export const aiEnv = env.aiEnv;
/** Models, effort and budget without requiring ANTHROPIC_API_KEY. */
export const aiSettingsEnv = env.aiSettingsEnv;
export const cronEnv = env.cronEnv;
export const flagsEnv = env.flagsEnv;
