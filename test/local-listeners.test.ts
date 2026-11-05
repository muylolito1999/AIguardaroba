import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALLOW_REMOTE_STUDIO_VAR, assertStudioTarget } from "@/lib/db/local-url";

// D-242: local servers and tools must not offer the machine's data to the
// network. The dev and start servers bind localhost, the Docker database
// publishes its port on 127.0.0.1, and Drizzle Studio refuses a remote
// database. These read the config files, which no other test exercises.

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("local listeners", () => {
  it("binds the dev and start servers to localhost", () => {
    const scripts = (JSON.parse(read("../package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.dev).toMatch(/\bnext dev -H localhost\b/);
    expect(scripts.start).toMatch(/\bnext start -H localhost\b/);
    // The e2e server is `pnpm start`, so it inherits the bind.
    expect(read("../playwright.config.ts")).toContain('command: "pnpm build && pnpm start"');
  });

  it("publishes the Docker database on 127.0.0.1 only", () => {
    const ports = [...read("../docker-compose.yml").matchAll(/^\s*-\s*"([^"]*:\d+)"\s*$/gm)].map((match) => match[1]);
    expect(ports).toEqual(["127.0.0.1:5433:5432"]);
  });

  it("runs production migrations through vercel env run, never from .env.local", () => {
    const scripts = (JSON.parse(read("../package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["db:migrate:prod"]).toBe("vercel env run -e production -- drizzle-kit migrate");
  });
});

describe("assertStudioTarget", () => {
  const remote = "postgresql://u:secret-pw@ep-prod-1.eu-central-1.aws.neon.tech/neondb?sslmode=require";

  it("refuses Studio on a remote database and never echoes the URL", () => {
    expect(() => assertStudioTarget("studio", remote, {})).toThrow(/studio refused.*ep-prod-1/);
    try {
      assertStudioTarget("studio", remote, {});
    } catch (error) {
      expect(String(error)).not.toContain("secret-pw");
    }
  });

  it("refuses a local URL whose query string names another host", () => {
    expect(() => assertStudioTarget("studio", "postgres://u:p@localhost:5433/db?host=db.example.com", {})).toThrow(/query string/);
  });

  it("allows the local Docker database", () => {
    expect(assertStudioTarget("studio", "postgres://wardrobe:wardrobe@localhost:5433/wardrobe", {})).toBeNull();
    expect(assertStudioTarget("studio", "postgres://wardrobe:wardrobe@127.0.0.1:5433/wardrobe", {})).toBeNull();
  });

  it("allows a remote database only with the explicit opt-in, and then warns", () => {
    const warning = assertStudioTarget("studio", remote, { [ALLOW_REMOTE_STUDIO_VAR]: "1" });
    expect(warning).toMatch(/remote database/);
    expect(() => assertStudioTarget("studio", remote, { [ALLOW_REMOTE_STUDIO_VAR]: "true" })).toThrow();
  });

  it("leaves every other drizzle-kit command alone", () => {
    for (const command of ["migrate", "generate", "check", undefined]) {
      expect(assertStudioTarget(command, remote, {}), String(command)).toBeNull();
    }
    expect(assertStudioTarget("studio", undefined, {})).toBeNull();
  });
});

describe("drizzle.config.ts", () => {
  it("calls the Studio guard", () => {
    const config = read("../drizzle.config.ts");
    expect(config).toContain('from "./src/lib/db/local-url"');
    expect(config).toMatch(/assertStudioTarget\(command, unpooledUrl, process\.env\)/);
  });
});
