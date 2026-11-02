import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import { createEnv, decodePasswordHash, serverEnvReport, type EnvSource } from "@/env";
import { AppError } from "@/lib/result";

// Cost 4 keeps the suite fast; the format is identical to the production cost 12.
const RAW_HASH = bcrypt.hashSync("correct horse battery staple", 4);
const HASH_B64 = Buffer.from(RAW_HASH, "utf8").toString("base64");

const SECRET_MARKER = "do-not-leak-7f3a9c";

const VALID: EnvSource = {
  DATABASE_URL: "postgresql://wardrobe:pw@localhost:5433/wardrobe",
  SESSION_SECRET: "s".repeat(32),
  APP_PASSWORD_HASH: HASH_B64,
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_abc123_def456",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
  CRON_SECRET: "c".repeat(16),
};

function captureError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("createEnv groups", () => {
  it("validates each group independently", () => {
    const env = createEnv({ SESSION_SECRET: "s".repeat(40) });

    expect(env.sessionEnv().SESSION_SECRET).toHaveLength(40);
    expect(env.flagsEnv().FEATURE_SHOPPING_AI).toBe(false);
    expect(() => env.dbEnv()).toThrow(AppError);
    expect(() => env.aiEnv()).toThrow(AppError);
    expect(() => env.blobEnv()).toThrow(AppError);
  });

  it("parses a complete source", () => {
    const env = createEnv(VALID);

    expect(env.dbEnv().DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.passwordEnv().passwordHash).toBe(RAW_HASH);
    expect(env.blobEnv().BLOB_READ_WRITE_TOKEN).toBe(VALID.BLOB_READ_WRITE_TOKEN);
    expect(env.cronEnv().CRON_SECRET).toBe(VALID.CRON_SECRET);
    expect(env.aiEnv()).toEqual({
      ANTHROPIC_API_KEY: VALID.ANTHROPIC_API_KEY,
      CLAUDE_ANALYSIS_EFFORT: "medium",
      MONTHLY_AI_BUDGET_USD: 20,
      AI_CREDIT_USD: 100,
      models: { tagging: "claude-haiku-5-5", analysis: "claude-sonnet-5-5", outfits: "claude-sonnet-5-5" },
    });
  });

  it("does not validate anything until a getter is called", () => {
    expect(() => createEnv({})).not.toThrow();
  });

  it("memoizes a successful parse", () => {
    const source: EnvSource = { ...VALID };
    const env = createEnv(source);
    const first = env.dbEnv();
    source.DATABASE_URL = "not a url";
    expect(env.dbEnv()).toBe(first);
  });

  it("throws CONFIG errors that name the group and variable", () => {
    const error = captureError(() => createEnv({}).dbEnv());
    expect(error.code).toBe("CONFIG");
    expect(error.message).toContain("(db)");
    expect(error.message).toContain("DATABASE_URL is not set");
    expect(error.details).toEqual({ group: "db", variables: ["DATABASE_URL"] });
  });
});

describe("blank values", () => {
  it("treats '' and whitespace as unset for required variables", () => {
    expect(captureError(() => createEnv({ SESSION_SECRET: "" }).sessionEnv()).message).toContain(
      "SESSION_SECRET is not set",
    );
    expect(captureError(() => createEnv({ CRON_SECRET: "   " }).cronEnv()).message).toContain(
      "CRON_SECRET is not set",
    );
  });

  it("applies defaults for blank optional variables", () => {
    const ai = createEnv({
      ...VALID,
      CLAUDE_ANALYSIS_EFFORT: "",
      MONTHLY_AI_BUDGET_USD: "",
      AI_CREDIT_USD: "",
      CLAUDE_TAGGING_MODEL: "",
      CLAUDE_ANALYSIS_MODEL: "",
      CLAUDE_OUTFIT_MODEL: "",
    }).aiEnv();

    expect(ai.CLAUDE_ANALYSIS_EFFORT).toBe("medium");
    expect(ai.MONTHLY_AI_BUDGET_USD).toBe(20);
    expect(ai.AI_CREDIT_USD).toBe(100);
    expect(ai.models.tagging).toBe("claude-haiku-5-5");
    expect(createEnv({ FEATURE_SHOPPING_AI: "" }).flagsEnv().FEATURE_SHOPPING_AI).toBe(false);
  });
});

describe("dbEnv", () => {
  it.each(["postgres://u:p@host:5432/db", "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=require"])(
    "accepts %s",
    (url) => {
      expect(createEnv({ DATABASE_URL: url }).dbEnv().DATABASE_URL).toBe(url);
    },
  );

  it.each(["mysql://u:p@host/db", "localhost:5432/db", "postgres://"])("rejects %s", (url) => {
    const error = captureError(() => createEnv({ DATABASE_URL: url }).dbEnv());
    expect(error.message).toContain("DATABASE_URL must be a postgres:// or postgresql:// connection URL");
  });
});

describe("sessionEnv", () => {
  it("rejects a secret shorter than 32 characters", () => {
    const error = captureError(() => createEnv({ SESSION_SECRET: "x".repeat(31) }).sessionEnv());
    expect(error.message).toContain("SESSION_SECRET must be at least 32 characters long");
  });
});

describe("passwordEnv", () => {
  it("decodes a base64 bcrypt hash", () => {
    const { passwordHash } = createEnv({ APP_PASSWORD_HASH: HASH_B64 }).passwordEnv();
    expect(passwordHash).toBe(RAW_HASH);
    expect(bcrypt.compareSync("correct horse battery staple", passwordHash)).toBe(true);
  });

  it("rejects a raw bcrypt hash with a hint", () => {
    const error = captureError(() => createEnv({ APP_PASSWORD_HASH: RAW_HASH }).passwordEnv());
    expect(error.code).toBe("CONFIG");
    expect(error.message).toContain("APP_PASSWORD_HASH looks like a raw bcrypt hash");
    expect(error.message).toContain("pnpm hash-password");
    expect(error.message).not.toContain(RAW_HASH);
  });

  it.each([
    ["not base64 at all", "%%%not-base64%%%"],
    ["base64 of something else", Buffer.from("hello world").toString("base64")],
    ["truncated base64", HASH_B64.slice(0, -4)],
    ["base64 of an invalid bcrypt shape", Buffer.from("$2b$12$tooshort").toString("base64")],
  ])("rejects %s", (_label, value) => {
    const error = captureError(() => createEnv({ APP_PASSWORD_HASH: value }).passwordEnv());
    expect(error.message).toContain("APP_PASSWORD_HASH must be the base64 encoding of a bcrypt hash");
  });

  it("decodePasswordHash returns null for non-bcrypt input", () => {
    expect(decodePasswordHash(HASH_B64)).toBe(RAW_HASH);
    expect(decodePasswordHash("")).toBeNull();
    expect(decodePasswordHash(RAW_HASH)).toBeNull();
  });
});

describe("blobEnv", () => {
  it("requires a read-write token prefix", () => {
    const error = captureError(() => createEnv({ BLOB_READ_WRITE_TOKEN: "vercel_blob_ro_abc" }).blobEnv());
    expect(error.message).toContain("BLOB_READ_WRITE_TOKEN must be a Vercel Blob read-write token");
  });
});

describe("aiEnv", () => {
  it("defaults the monthly budget to 20 and coerces numeric strings", () => {
    expect(createEnv(VALID).aiEnv().MONTHLY_AI_BUDGET_USD).toBe(20);
    const ai = createEnv({ ...VALID, MONTHLY_AI_BUDGET_USD: "12.5", AI_CREDIT_USD: "250" }).aiEnv();
    expect(ai.MONTHLY_AI_BUDGET_USD).toBe(12.5);
    expect(ai.AI_CREDIT_USD).toBe(250);
  });

  it.each(["0", "-5", "abc", "Infinity"])("rejects a budget of %s", (value) => {
    const error = captureError(() => createEnv({ ...VALID, MONTHLY_AI_BUDGET_USD: value }).aiEnv());
    expect(error.message).toContain("MONTHLY_AI_BUDGET_USD must be a positive number");
  });

  it("validates the analysis effort", () => {
    expect(createEnv({ ...VALID, CLAUDE_ANALYSIS_EFFORT: "high" }).aiEnv().CLAUDE_ANALYSIS_EFFORT).toBe("high");
    const error = captureError(() => createEnv({ ...VALID, CLAUDE_ANALYSIS_EFFORT: "extreme" }).aiEnv());
    expect(error.message).toContain("CLAUDE_ANALYSIS_EFFORT must be low, medium or high");
  });

  it("rejects unknown model ids", () => {
    const error = captureError(() =>
      createEnv({ ...VALID, CLAUDE_TAGGING_MODEL: "claude-haiku-4-5-20251001" }).aiEnv(),
    );
    expect(error.code).toBe("CONFIG");
    expect(error.message).toContain("CLAUDE_TAGGING_MODEL must be one of the priced models");
    expect(error.details).toEqual({ group: "ai", variables: ["CLAUDE_TAGGING_MODEL"] });
  });

  it("applies valid model overrides", () => {
    const ai = createEnv({ ...VALID, CLAUDE_ANALYSIS_MODEL: "claude-opus-5-5" }).aiEnv();
    expect(ai.models).toEqual({
      tagging: "claude-haiku-5-5",
      analysis: "claude-opus-5-5",
      outfits: "claude-opus-5-5",
    });
  });

  it("reports base and model problems together", () => {
    const error = captureError(() => createEnv({ CLAUDE_OUTFIT_MODEL: "gpt-x" }).aiEnv());
    expect(error.details).toEqual({ group: "ai", variables: ["ANTHROPIC_API_KEY", "CLAUDE_OUTFIT_MODEL"] });
  });
});

describe("flagsEnv", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ] as const)("maps %s to %s", (value, expected) => {
    expect(createEnv({ FEATURE_SHOPPING_AI: value }).flagsEnv().FEATURE_SHOPPING_AI).toBe(expected);
  });

  it("rejects other values", () => {
    const error = captureError(() => createEnv({ FEATURE_SHOPPING_AI: "yes" }).flagsEnv());
    expect(error.message).toContain("FEATURE_SHOPPING_AI must be true, false, 1 or 0");
  });
});

describe("error messages never contain values", () => {
  const cases: Array<[string, EnvSource, keyof ReturnType<typeof createEnv>]> = [
    ["DATABASE_URL", { DATABASE_URL: `mysql://${SECRET_MARKER}@host/db` }, "dbEnv"],
    ["SESSION_SECRET", { SESSION_SECRET: SECRET_MARKER }, "sessionEnv"],
    ["APP_PASSWORD_HASH (raw)", { APP_PASSWORD_HASH: `$2b$12$${SECRET_MARKER}` }, "passwordEnv"],
    ["APP_PASSWORD_HASH (base64)", { APP_PASSWORD_HASH: Buffer.from(SECRET_MARKER).toString("base64") }, "passwordEnv"],
    ["BLOB_READ_WRITE_TOKEN", { BLOB_READ_WRITE_TOKEN: SECRET_MARKER }, "blobEnv"],
    ["CRON_SECRET", { CRON_SECRET: SECRET_MARKER.slice(0, 10) }, "cronEnv"],
    ["FEATURE_SHOPPING_AI", { FEATURE_SHOPPING_AI: SECRET_MARKER }, "flagsEnv"],
    [
      "AI group",
      {
        ANTHROPIC_API_KEY: "",
        CLAUDE_TAGGING_MODEL: SECRET_MARKER,
        CLAUDE_ANALYSIS_EFFORT: SECRET_MARKER,
        MONTHLY_AI_BUDGET_USD: SECRET_MARKER,
      },
      "aiEnv",
    ],
  ];

  it.each(cases)("%s", (_label, source, getter) => {
    const error = captureError(() => createEnv(source)[getter]());
    const text = `${error.message} ${JSON.stringify(error.details)}`;
    expect(text).not.toContain(SECRET_MARKER);
    for (const value of Object.values(source)) {
      if (value) expect(text).not.toContain(value);
    }
  });
});

describe("serverEnvReport", () => {
  it("reports every group without throwing", () => {
    const report = serverEnvReport({ SESSION_SECRET: "short", FEATURE_SHOPPING_AI: "true" });

    expect(Object.keys(report).sort()).toEqual(["ai", "blob", "cron", "db", "flags", "password", "session"]);
    expect(report.flags).toEqual({ ok: true, problems: [] });
    expect(report.session).toEqual({ ok: false, problems: ["SESSION_SECRET must be at least 32 characters long"] });
    expect(report.db.problems).toEqual(["DATABASE_URL is not set"]);
    expect(report.ai.ok).toBe(false);
  });

  it("is all green for a complete source", () => {
    const report = serverEnvReport(VALID);
    expect(Object.values(report).every((group) => group.ok)).toBe(true);
  });
});
