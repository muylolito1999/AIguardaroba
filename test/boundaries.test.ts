import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// Guards the client/server split that Next only enforces at build time (and
// only for modules that import `server-only`): env, DB, AI and auth code must
// never reach a client bundle, and server modules must fail loudly if they do.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(ROOT, "src");
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

// Module ids (as `@/…` paths) a client bundle must not contain. Prefix match.
// @/lib/ai/cost is caught through its import of models. The relocation
// payload and chunk modules use node:crypto, the prompts hold the relocation
// system prompt and the estimate prices with the server's model table: none of
// them belongs in the browser (the client-safe relocation modules are
// contracts.ts and schemas.ts).
const CLIENT_FORBIDDEN = [
  "@/env",
  "@/lib/db",
  "@/lib/ai/models",
  "@/lib/ai/client",
  "@/lib/ai/call",
  "@/lib/ai/log",
  "@/lib/ai/budget",
  "@/lib/images/blob",
  "@/lib/images/server-pipeline",
  "@/lib/auth",
  "@/lib/relocation/payload",
  "@/lib/relocation/chunks",
  "@/lib/relocation/prompts",
  "@/lib/relocation/estimate",
  // The outfit and shopping-advice prompts and estimates; the client-safe
  // stored-result schemas are suggestion-result.ts and advice-result.ts (D-187).
  "@/lib/outfits/suggestion",
  "@/lib/shopping/advice",
  "@/server",
];
// Exceptions: actions are passed to the client as references, the shared enum
// constants are plain values the forms need, and the redirect check is a pure
// function with no secrets.
const CLIENT_ALLOWED = ["@/server/actions", "@/lib/db/enums", "@/lib/auth/safe-redirect"];

// Single server modules outside the directories below. schema.ts, enums.ts and
// relations.ts stay out: drizzle-kit loads them, and `server-only` throws there.
const SERVER_ONLY_FILES = [
  "src/env.ts",
  "src/lib/db/client.ts",
  "src/lib/db/index.ts",
  "src/lib/images/blob.ts",
  "src/lib/images/server-pipeline.ts",
];
// Every non-test module in these directories, except 'use server' modules
// (the client only ever gets references to their exports) and the exemptions.
const SERVER_ONLY_DIRS = ["src/lib/auth", "src/lib/ai", "src/server"];
const SERVER_ONLY_EXEMPT = [
  // Shared with proxy.ts, scripts and the Playwright specs, where `server-only`
  // throws because they run outside Next's react-server condition.
  "src/lib/auth/token.ts",
  // Pure and safe in any bundle.
  "src/lib/auth/safe-redirect.ts",
  // Pure AI modules: no I/O and no secrets. models.ts and cost.ts read the
  // pricing table (and models.ts process.env), so CLIENT_FORBIDDEN keeps them
  // out of client bundles; the Playwright usage spec and the scripts load them
  // outside the react-server condition.
  "src/lib/ai/models.ts",
  "src/lib/ai/cost.ts",
  "src/lib/ai/json-schema.ts",
  "src/lib/ai/retry.ts",
  // Shared with client code: the review form reads the tag limits.
  "src/lib/ai/tagging/prompt.ts",
  "src/lib/ai/tagging/schema.ts",
];

// Browser-only modules: they decode images with canvas and load wasm or LGPL
// and AGPL code, none of which belongs in a server bundle.
const BROWSER_ONLY = [
  "@/lib/images/client-pipeline",
  "@/lib/images/bg-removal",
  "heic-to",
  "@imgly/background-removal",
  "onnxruntime-web",
];
// Server code (route handlers live under src/app/api) that must never import them.
const SERVER_CODE_DIRS = ["src/server", "src/lib/ai", "src/lib/auth", "src/app/api"];
const SERVER_CODE_FILES = ["src/lib/images/blob.ts", "src/lib/images/server-pipeline.ts"];

// D-013: proxy lets forged Next-Action requests through, so every exported
// async service function, and every server read function in src/server/items
// (the item card and detail reads), checks the session itself. The exceptions
// run before a session can exist; each needs a reason here.
const SESSION_CHECKED_DIRS = ["src/server/services", "src/server/items"];
// Single server read modules outside those directories.
const SESSION_CHECKED_FILES = ["src/server/weather.ts"];
const SESSION_CHECKS = ["requireSession", "verifySession"];
const SESSIONLESS_SERVICE_FUNCTIONS: Record<string, readonly string[]> = {
  // The password check that creates the session.
  "src/server/services/login.ts": ["attemptLogin"],
  // Cron, authenticated by CRON_SECRET: the daily Vercel cron has no session
  // cookie. The session-checked variant for the review page is pollTaggingBatches.
  "src/server/services/batches.ts": ["runBatchPoll"],
  // Cron, authenticated by CRON_SECRET: deletes the Blob files still queued
  // (D-234, D-235). deleteItem and attachNobgImage call it after their own
  // session check. deleteOrQueue (D-245) is called only by registerUpload and
  // attachNobgImage after theirs, often on an error path where it must not throw.
  "src/server/services/blob-cleanup.ts": ["runBlobCleanup", "deleteOrQueue"],
};
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

type ModuleInfo = {
  directives: string[];
  /** Specifiers of imports that survive compilation (type-only ones are erased). */
  valueImports: string[];
  startsWithServerOnly: boolean;
};

function matchesPrefix(id: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}/`));
}

function isForbiddenInClient(moduleId: string): boolean {
  return !matchesPrefix(moduleId, CLIENT_ALLOWED) && matchesPrefix(moduleId, CLIENT_FORBIDDEN);
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return (
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

function analyzeSource(fileName: string, source: string): ModuleInfo {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  const directives: string[] = [];
  let firstStatement = 0;
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    directives.push(statement.expression.text);
    firstStatement += 1;
  }

  const first = file.statements[firstStatement];
  const startsWithServerOnly =
    first !== undefined &&
    ts.isImportDeclaration(first) &&
    first.importClause === undefined &&
    ts.isStringLiteral(first.moduleSpecifier) &&
    first.moduleSpecifier.text === "server-only";

  const valueImports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) valueImports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyExport(node)) valueImports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const isImportCall = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isImportCall || isRequire) && arg && ts.isStringLiteralLike(arg)) valueImports.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return { directives, valueImports, startsWithServerOnly };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

/** Async, or declared to return a Promise: anything that can do I/O. */
function isAsyncFunction(node: ts.SignatureDeclaration): boolean {
  if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) return true;
  return node.type !== undefined && /^Promise\b/.test(node.type.getText());
}

function callsAny(node: ts.Node, names: readonly string[]): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && names.includes(child.expression.text)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * The exported async functions of a module (declarations and `const` arrow or
 * function expressions) that never call one of `checks`.
 */
function exportedAsyncWithout(fileName: string, source: string, checks: readonly string[]): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const missing: string[] = [];
  for (const statement of file.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.body && isAsyncFunction(statement)) {
      if (!callsAny(statement.body, checks)) missing.push(statement.name?.text ?? "default");
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (!init || !(ts.isArrowFunction(init) || ts.isFunctionExpression(init)) || !isAsyncFunction(init)) continue;
        if (!callsAny(init.body, checks)) missing.push(declaration.name.getText());
      }
    }
  }
  return missing;
}

type CachedFunction = {
  name: string;
  exported: boolean;
  /** Each call of it in its module: the calling top-level function, and whether a session check runs before the call there. */
  calls: Array<{ caller: string; checkedBefore: boolean }>;
};

function bodyDirectives(body: ts.Block | undefined): string[] {
  const directives: string[] = [];
  for (const statement of body?.statements ?? []) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    directives.push(statement.expression.text);
  }
  return directives;
}

/**
 * The module's 'use cache' functions (D-041, D-203). A cached function may
 * not read cookies or headers, so it cannot check the session itself: it is
 * safe only while nothing outside its module can call it and every call in
 * the module comes after the caller's own session check.
 */
function cachedFunctions(fileName: string, source: string, checks: readonly string[]): CachedFunction[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const cached = file.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name !== undefined && bodyDirectives(statement.body).includes("use cache"),
  );
  const topLevel: Array<{ name: string; body: ts.Node }> = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      topLevel.push({ name: statement.name?.text ?? "default", body: statement.body });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          topLevel.push({ name: declaration.name.getText(), body: init.body });
        }
      }
    }
  }
  return cached.map((declaration) => {
    const name = declaration.name?.text ?? "default";
    const calls: CachedFunction["calls"] = [];
    for (const caller of topLevel) {
      if (caller.name === name) continue;
      const checkAt: number[] = [];
      const callAt: number[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (checks.includes(node.expression.text)) checkAt.push(node.getStart());
          if (node.expression.text === name) callAt.push(node.getStart());
        }
        ts.forEachChild(node, visit);
      };
      visit(caller.body);
      for (const at of callAt) calls.push({ caller: caller.name, checkedBefore: checkAt.some((check) => check < at) });
    }
    return { name, exported: hasModifier(declaration, ts.SyntaxKind.ExportKeyword), calls };
  });
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return SOURCE_FILE.test(entry.name) ? [full] : [];
  });
}

function fileToModuleId(file: string, src: string): string {
  return `@/${toPosix(path.relative(src, file))
    .replace(SOURCE_FILE, "")
    .replace(/(?:^|\/)index$/, "")}`.replace(/\/$/, "");
}

/** Maps an import specifier to an `@/…` module id, or null for packages and paths outside src. */
function toModuleId(specifier: string, fromFile: string, src: string): string | null {
  let absolute: string;
  if (specifier.startsWith("@/")) absolute = path.join(src, specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    absolute = path.resolve(path.dirname(fromFile), specifier);
  } else return null;
  const relative = toPosix(path.relative(src, absolute));
  if (relative.startsWith("..")) return null;
  return fileToModuleId(absolute, src);
}

const RESOLVE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mts", "/index.ts", "/index.tsx", "/index.js"];

function resolveModuleFile(moduleId: string, src: string): string | null {
  const base = path.join(src, moduleId.slice(2));
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const infoCache = new Map<string, ModuleInfo>();
function analyzeFile(file: string): ModuleInfo {
  let info = infoCache.get(file);
  if (!info) {
    info = analyzeSource(file, readFileSync(file, "utf8"));
    infoCache.set(file, info);
  }
  return info;
}

/**
 * Follows value imports from a client entry through plain shared modules, so
 * a helper that re-exports server code is caught too. Stops at other client
 * entries (checked on their own) and at 'use server' modules, which the client
 * only receives as action references.
 */
function clientViolations(entry: string, src: string): string[] {
  const violations: string[] = [];
  const seen = new Set<string>([entry]);
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [fileToModuleId(entry, src)] }];

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { file, chain } = next;
    for (const specifier of analyzeFile(file).valueImports) {
      const id = toModuleId(specifier, file, src);
      if (id === null) continue;
      if (isForbiddenInClient(id)) {
        violations.push([...chain, id].join(" -> "));
        continue;
      }
      const target = resolveModuleFile(id, src);
      if (target === null || seen.has(target)) continue;
      seen.add(target);
      const { directives } = analyzeFile(target);
      if (directives.includes("use client") || directives.includes("use server")) continue;
      queue.push({ file: target, chain: [...chain, id] });
    }
  }
  return violations;
}

describe("source analysis", () => {
  it("detects the 'use client' directive after comments only", () => {
    expect(analyzeSource("a.tsx", "// header\n/* note */\n'use client'\nimport x from 'y'").directives).toEqual([
      "use client",
    ]);
    expect(analyzeSource("a.tsx", "import x from 'y'\n'use client'").directives).toEqual([]);
  });

  it("ignores type-only imports and keeps value imports", () => {
    const source = [
      "import type { A } from '@/env'",
      "import { type B, type C } from '@/lib/db/schema'",
      "export type { D } from '@/lib/auth/session'",
      "import { type E, f } from '@/lib/ai/models'",
      "import g from '@/lib/ai/call'",
      "import * as h from '@/server/services/items'",
      "import '@/lib/db/client'",
      "export { i } from '@/lib/auth/dal'",
      "// import j from '@/lib/ai/client'",
      "const k = () => import('@/lib/db')",
    ].join("\n");
    expect(analyzeSource("a.tsx", source).valueImports).toEqual([
      "@/lib/ai/models",
      "@/lib/ai/call",
      "@/server/services/items",
      "@/lib/db/client",
      "@/lib/auth/dal",
      "@/lib/db",
    ]);
  });

  it("recognizes a leading server-only import", () => {
    expect(analyzeSource("a.ts", "// why\nimport 'server-only';\nimport x from 'y'").startsWithServerOnly).toBe(true);
    expect(analyzeSource("a.ts", "import x from 'y'\nimport 'server-only'").startsWithServerOnly).toBe(false);
  });

  it.each([
    ["@/env", true],
    ["@/lib/db", true],
    ["@/lib/db/client", true],
    ["@/lib/db/enums", false],
    ["@/lib/ai/models", true],
    ["@/lib/ai/cost", false],
    ["@/lib/ai/budget", true],
    ["@/lib/ai/log", true],
    ["@/lib/ai/tagging/schema", false],
    ["@/lib/images/blob", true],
    ["@/lib/images/server-pipeline", true],
    ["@/lib/images/client-pipeline", false],
    ["@/lib/items/contracts", false],
    ["@/server/services/items", true],
    ["@/server/actions/items", false],
    ["@/server/actions", false],
    ["@/lib/result", false],
    ["@/environment", false],
    ["@/lib/auth/dal", true],
    ["@/lib/auth/client-key", true],
    ["@/lib/auth/password", true],
    ["@/lib/auth/token", true],
    ["@/lib/auth/safe-redirect", false],
    ["@/lib/authors", false],
    ["@/lib/relocation/payload", true],
    ["@/lib/relocation/chunks", true],
    ["@/lib/relocation/prompts", true],
    ["@/lib/relocation/estimate", true],
    ["@/lib/relocation/contracts", false],
    ["@/lib/relocation/schemas", false],
    ["@/lib/climate/range", false],
    ["@/lib/outfits/suggestion", true],
    ["@/lib/outfits/suggestion-result", false],
    ["@/lib/outfits/contracts", false],
    ["@/lib/shopping/advice", true],
    ["@/lib/shopping/advice-result", false],
    ["@/lib/shopping/combinatorics", false],
    ["@/lib/weather/open-meteo", false],
  ])("isForbiddenInClient(%s) is %s", (id, expected) => {
    expect(isForbiddenInClient(id)).toBe(expected);
  });

  it("finds exported async functions that skip the session check", () => {
    const source = [
      "import { requireSession } from '@/lib/auth/dal'",
      "export async function listItems(db) { await requireSession(); return db.select() }",
      "export async function leaky(db) { return db.select() }",
      "export function promised(db): Promise<number> { return db.count() }",
      "export const arrowLeak = async (db) => db.select()",
      "export const arrowOk = async () => { const s = await requireSession(); return s }",
      "export function pure(x: number) { return x + 1 }",
      "async function internal(db) { return db.select() }",
      "export async function nested(db) { const check = () => requireSession(); await check(); return db }",
    ].join("\n");
    expect(exportedAsyncWithout("s.ts", source, SESSION_CHECKS)).toEqual(["leaky", "promised", "arrowLeak"]);
  });

  it("finds 'use cache' functions and whether each call follows a session check", () => {
    const source = [
      "async function cached(a) { 'use cache'; return a }",
      "export async function checked(db) { await requireSession(); return cached(1) }",
      "export async function late(db) { const v = await cached(2); await requireSession(); return v }",
      "export const arrow = async () => cached(3)",
      "export async function plain() { 'use strict'; return 1 }",
    ].join("\n");
    expect(cachedFunctions("w.ts", source, SESSION_CHECKS)).toEqual([
      {
        name: "cached",
        exported: false,
        calls: [
          { caller: "checked", checkedBefore: true },
          { caller: "late", checkedBefore: false },
          { caller: "arrow", checkedBefore: false },
        ],
      },
    ]);
    const exported = cachedFunctions("e.ts", "export async function c() { 'use cache'; return 1 }", SESSION_CHECKS);
    expect(exported.map((cached) => cached.exported)).toEqual([true]);
  });

  it("follows shared helpers but not server actions or type-only imports", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "boundaries-"));
    try {
      const src = path.join(tmp, "src");
      const write = (rel: string, content: string) => {
        const file = path.join(src, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      };
      write("components/leaky.tsx", "'use client'\nimport { label } from '@/lib/helper'\n");
      write("lib/helper.ts", "export { MODELS as label } from './ai/models'\n");
      write("lib/ai/models.ts", "export const MODELS = {}\n");
      write("components/action-form.tsx", "'use client'\nimport { save } from '../app/actions'\n");
      write("app/actions.ts", "'use server'\nimport { dbEnv } from '@/env'\nexport async function save() { dbEnv() }\n");
      write("components/typed.tsx", "'use client'\nimport type { Env } from '@/env'\nimport { type DbEnv } from '@/env'\n");

      const check = (rel: string) => clientViolations(path.join(src, rel), src);
      expect(check("components/leaky.tsx")).toEqual(["@/components/leaky -> @/lib/helper -> @/lib/ai/models"]);
      expect(check("components/action-form.tsx")).toEqual([]);
      expect(check("components/typed.tsx")).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("client/server boundaries", () => {
  const files = walk(SRC);
  const clientEntries = files.filter((file) => analyzeFile(file).directives.includes("use client"));

  it("finds client modules to check", () => {
    // The shadcn primitives are client components, so an empty list means detection broke.
    expect(clientEntries.length).toBeGreaterThan(0);
  });

  it("keeps env, db, AI, auth and server modules out of client bundles", () => {
    const violations = clientEntries.flatMap((entry) => clientViolations(entry, SRC));
    expect(
      violations,
      "Client code reaches server-only modules. Move the logic behind a server action, or use `import type` for types.",
    ).toEqual([]);
  });

  it("starts every existing server module with import 'server-only'", () => {
    const relative = (file: string) => toPosix(path.relative(ROOT, file));
    const serverFiles = [
      ...SERVER_ONLY_FILES.map((rel) => path.join(ROOT, rel)).filter((file) => existsSync(file)),
      ...SERVER_ONLY_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).filter(
        (file) =>
          !TEST_FILE.test(file) &&
          !SERVER_ONLY_EXEMPT.includes(relative(file)) &&
          !analyzeFile(file).directives.includes("use server"),
      ),
    ];
    const checked = serverFiles.map(relative);
    // Guards against the directory walk silently finding nothing.
    for (const expected of [
      "src/env.ts",
      "src/lib/auth/dal.ts",
      "src/lib/auth/password.ts",
      "src/lib/auth/rate-limit.ts",
      "src/lib/auth/client-key.ts",
      "src/server/http.ts",
      "src/server/actions/_wrap.ts",
      "src/server/services/login.ts",
      "src/lib/ai/client.ts",
      "src/lib/ai/call.ts",
      "src/lib/ai/log.ts",
      "src/lib/ai/budget.ts",
      "src/lib/images/blob.ts",
      "src/lib/images/server-pipeline.ts",
      "src/server/items/dto.ts",
      "src/server/items/detail.ts",
      "src/server/services/tag-item.ts",
      "src/server/services/items-query.ts",
      "src/server/services/item-lifecycle.ts",
      "src/server/services/stats.ts",
      "src/server/services/export.ts",
      "src/server/services/relocation.ts",
      "src/server/services/climate.ts",
      "src/server/services/shopping.ts",
      "src/server/weather.ts",
      "src/server/services/outfits.ts",
      "src/server/services/wear.ts",
      "src/server/services/settings.ts",
      "src/server/services/outfit-suggestions.ts",
      "src/server/services/shopping-advice.ts",
    ]) {
      expect(checked).toContain(expected);
    }
    for (const exempt of SERVER_ONLY_EXEMPT) expect(existsSync(path.join(ROOT, exempt)), exempt).toBe(true);

    const missing = serverFiles.filter((file) => !analyzeFile(file).startsWithServerOnly).map(relative);
    expect(missing).toEqual([]);
  });

  it("keeps browser-only image modules out of server code", () => {
    const serverFiles = [
      ...SERVER_CODE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))),
      ...SERVER_CODE_FILES.map((rel) => path.join(ROOT, rel)),
    ].filter((file) => !TEST_FILE.test(file));
    const checked = serverFiles.map((file) => toPosix(path.relative(ROOT, file)));
    expect(checked).toContain("src/app/api/items/register/route.ts");
    expect(checked).toContain("src/app/api/analyses/[id]/parts/[partId]/route.ts");
    const violations = serverFiles.flatMap((file) =>
      analyzeFile(file)
        .valueImports.filter((specifier) => {
          const id = toModuleId(specifier, file, SRC) ?? specifier;
          return matchesPrefix(id, BROWSER_ONLY);
        })
        .map((specifier) => `${toPosix(path.relative(ROOT, file))} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  it("checks the session in every exported async service and read function (D-013)", () => {
    const serviceFiles = [
      ...SESSION_CHECKED_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))),
      ...SESSION_CHECKED_FILES.map((rel) => path.join(ROOT, rel)),
    ].filter((file) => !TEST_FILE.test(file));
    // Guards against the walk silently finding nothing.
    for (const expected of [
      "src/server/items/detail.ts",
      "src/server/services/items-query.ts",
      "src/server/services/relocation.ts",
      "src/server/services/climate.ts",
      "src/server/services/shopping.ts",
      "src/server/services/outfits.ts",
      "src/server/services/wear.ts",
      "src/server/services/settings.ts",
      "src/server/services/outfit-suggestions.ts",
      "src/server/services/shopping-advice.ts",
      "src/server/weather.ts",
    ]) {
      expect(serviceFiles.map((file) => toPosix(path.relative(ROOT, file)))).toContain(expected);
    }
    const unchecked = serviceFiles.flatMap((file) => {
      const rel = toPosix(path.relative(ROOT, file));
      const allowed = SESSIONLESS_SERVICE_FUNCTIONS[rel] ?? [];
      return exportedAsyncWithout(file, readFileSync(file, "utf8"), SESSION_CHECKS)
        .filter((name) => !allowed.includes(name))
        .map((name) => `${rel}: ${name}`);
    });
    expect(
      unchecked,
      "Call requireSession() (or verifySession() in page reads) at the top of each exported service function. " +
        "Only a function that must run before a session exists may be listed in SESSIONLESS_SERVICE_FUNCTIONS, with a reason.",
    ).toEqual([]);

    // The exemptions must name functions that still exist, so they cannot go stale.
    for (const [rel, names] of Object.entries(SESSIONLESS_SERVICE_FUNCTIONS)) {
      const file = path.join(ROOT, rel);
      expect(existsSync(file), rel).toBe(true);
      const exported = exportedAsyncWithout(file, readFileSync(file, "utf8"), []);
      for (const name of names) expect(exported, `${rel}: ${name}`).toContain(name);
    }
  });

  it("calls a 'use cache' function only after the caller checked the session (D-013, D-203)", () => {
    const found = walk(SRC)
      .filter((file) => !TEST_FILE.test(file))
      .flatMap((file) => {
        const rel = toPosix(path.relative(ROOT, file));
        return cachedFunctions(file, readFileSync(file, "utf8"), SESSION_CHECKS).map((cached) => ({ rel, ...cached }));
      });
    // The forecast helper is the only cached function so far. It is exempt from
    // the session check only because loadTodayWeather checks before calling it.
    expect(found.map(({ rel, name }) => `${rel}: ${name}`)).toEqual(["src/server/weather.ts: fetchForecast"]);
    for (const { rel, name, exported, calls } of found) {
      expect(exported, `${rel}: ${name} must not be exported, or callers elsewhere could skip the check`).toBe(false);
      expect(calls.length, `${rel}: ${name} is never called`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.checkedBefore, `${rel}: ${call.caller} calls ${name} before requireSession()`).toBe(true);
      }
    }
    const weather = found.find(({ name }) => name === "fetchForecast");
    expect(weather?.calls.map((call) => call.caller)).toEqual(["loadTodayWeather"]);
  });
});
