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
const CLIENT_FORBIDDEN = [
  "@/env",
  "@/lib/db",
  "@/lib/ai/models",
  "@/lib/ai/client",
  "@/lib/ai/call",
  "@/lib/auth/session",
  "@/lib/auth/dal",
  "@/server",
];
// Exceptions: actions are passed to the client as references, and the shared
// enum constants are plain values the forms need.
const CLIENT_ALLOWED = ["@/server/actions", "@/lib/db/enums"];

const SERVER_ONLY_FILES = [
  "src/env.ts",
  "src/lib/db/client.ts",
  "src/lib/db/index.ts",
  "src/lib/ai/client.ts",
  "src/lib/ai/call.ts",
  "src/lib/ai/log.ts",
  "src/lib/ai/budget.ts",
  "src/lib/auth/session.ts",
  "src/lib/auth/dal.ts",
];
const SERVER_ONLY_DIRS = ["src/server/services"];

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
    ["@/server/services/items", true],
    ["@/server/actions/items", false],
    ["@/server/actions", false],
    ["@/lib/result", false],
    ["@/environment", false],
  ])("isForbiddenInClient(%s) is %s", (id, expected) => {
    expect(isForbiddenInClient(id)).toBe(expected);
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
    const serverFiles = [
      ...SERVER_ONLY_FILES.map((rel) => path.join(ROOT, rel)).filter((file) => existsSync(file)),
      ...SERVER_ONLY_DIRS.flatMap((dir) => walk(path.join(ROOT, dir))).filter(
        (file) => !/\.test\.[cm]?[jt]sx?$/.test(file),
      ),
    ];
    expect(serverFiles.map((file) => toPosix(path.relative(ROOT, file)))).toContain("src/env.ts");

    const missing = serverFiles
      .filter((file) => !analyzeFile(file).startsWithServerOnly)
      .map((file) => toPosix(path.relative(ROOT, file)));
    expect(missing).toEqual([]);
  });
});
