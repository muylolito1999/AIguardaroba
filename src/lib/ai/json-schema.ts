// zod wire schema -> structured-output JSON Schema (D-018). Pure.
//
// The SDK's zodOutputFormat drops `enum` and `const`, so enums would only be
// hints. This converter keeps them, removes the keywords structured outputs
// does not support (the strict zod schema enforces those limits after
// JSON.parse), forces `additionalProperties: false` and every key required on
// every object, and refuses constructs the API cannot compile instead of
// quietly loosening them.

import { z } from "zod";

export type JsonSchema = { [key: string]: unknown };

/** The `output_config.format` value; matches the SDK's JSONOutputFormat. */
export type JsonSchemaFormat = { type: "json_schema"; schema: JsonSchema };

/** Per-request limits of structured outputs. We allow no optional keys at all. */
export const SCHEMA_LIMITS = { unions: 16, optionals: 24 } as const;

/** Keys the API reserves: asking for them risks a `reasoning_extraction` refusal (D-022). */
export const FORBIDDEN_KEY = /reasoning|thinking|thought/i;

// Validation keywords the API does not support; removed, never sent.
const STRIPPED = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "format",
  "default",
]);

// Keywords copied after sanitising their sub-schemas. Anything else is an
// error, so a new zod construct cannot slip through unreviewed.
const KEPT = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "description",
  "title",
  "$defs",
  "$ref",
]);

const SHAPE_KEYS = ["type", "enum", "const", "anyOf", "oneOf", "allOf", "$ref"];

export class SchemaConversionError extends Error {
  constructor(path: string, problem: string) {
    super(`Structured-output schema at ${path || "<root>"}: ${problem}`);
    this.name = "SchemaConversionError";
  }
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function sanitizeProperties(value: unknown, path: string): JsonSchema {
  if (!isRecord(value)) throw new SchemaConversionError(path, "properties must be an object");
  const properties: JsonSchema = {};
  for (const [name, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(name)) {
      throw new SchemaConversionError(path, `key "${name}" is reserved; name it why or reason instead`);
    }
    properties[name] = sanitizeNode(child, childPath(path, name));
  }
  return properties;
}

function sanitizeBranches(key: string, value: unknown, path: string): JsonSchema[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SchemaConversionError(path, `${key} must be a non-empty array`);
  }
  return value.map((branch, index) => sanitizeNode(branch, `${path}.${key}[${index}]`));
}

function sanitizeDefs(value: unknown, path: string): JsonSchema {
  if (!isRecord(value)) throw new SchemaConversionError(path, "$defs must be an object");
  return Object.fromEntries(Object.entries(value).map(([name, def]) => [name, sanitizeNode(def, `$defs.${name}`)]));
}

/** Copies one kept keyword into `out`, sanitising sub-schemas. */
function copyKeyword(out: JsonSchema, key: string, value: unknown, path: string): void {
  switch (key) {
    case "properties":
      out.properties = sanitizeProperties(value, path);
      return;
    case "items":
      out.items = sanitizeNode(value, `${path}[]`);
      return;
    case "anyOf":
    case "oneOf": {
      // Discriminated unions arrive as oneOf; the API takes anyOf, and the
      // strict schema still rejects anything matching more than one branch.
      const existing = Array.isArray(out.anyOf) ? out.anyOf : [];
      out.anyOf = [...existing, ...sanitizeBranches(key, value, path)];
      return;
    }
    case "allOf":
      out.allOf = sanitizeBranches(key, value, path);
      return;
    case "$defs":
      out.$defs = sanitizeDefs(value, path);
      return;
    case "additionalProperties":
      // `{}` (z.looseObject) or a schema (z.record) lets the model invent keys.
      if (value !== false) throw new SchemaConversionError(path, "objects must not allow unknown keys");
      return;
    case "required":
      // Rebuilt from the properties by closeObject.
      return;
    default:
      out[key] = value;
  }
}

/** Every key required, none unknown; a key zod left optional is an error, not a silent change. */
function closeObject(node: JsonSchema, out: JsonSchema, path: string): void {
  const properties = isRecord(out.properties) ? out.properties : {};
  const names = Object.keys(properties);
  const required = Array.isArray(node.required) ? node.required : [];
  const optional = names.filter((name) => !required.includes(name));
  if (optional.length > 0) {
    throw new SchemaConversionError(
      path,
      `optional keys are not allowed (${optional.join(", ")}); make them nullable or required`,
    );
  }
  out.properties = properties;
  out.required = names;
  out.additionalProperties = false;
}

function sanitizeNode(node: unknown, path: string): JsonSchema {
  if (!isRecord(node)) throw new SchemaConversionError(path, "expected a schema object");
  if (!SHAPE_KEYS.some((key) => key in node)) {
    // `{}` is what zod emits for unknown/any: the model could return anything.
    throw new SchemaConversionError(path, "has no type (z.unknown or z.any is not allowed)");
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED.has(key)) continue;
    if (!KEPT.has(key)) throw new SchemaConversionError(path, `keyword "${key}" is not supported`);
    copyKeyword(out, key, value, path);
  }
  if (node.type === "object" || "properties" in node) closeObject(node, out, path);
  return out;
}

/** Sanitises a JSON Schema produced by zod; throws SchemaConversionError on unsupported constructs. */
export function sanitizeJsonSchema(raw: JsonSchema): JsonSchema {
  return sanitizeNode(raw, "");
}

export type SchemaComplexity = {
  /** Parameters using anyOf or a type array (nullable fields included). */
  unions: number;
  /** Object properties that are not required. */
  optionals: number;
};

/** Counts what the API's compile limits count, over the whole schema including $defs. */
export function countSchemaComplexity(schema: JsonSchema): SchemaComplexity {
  let unions = 0;
  let optionals = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    if (
      (Array.isArray(node.anyOf) && node.anyOf.length > 1) ||
      (Array.isArray(node.oneOf) && node.oneOf.length > 1) ||
      (Array.isArray(node.type) && node.type.length > 1)
    ) {
      unions += 1;
    }
    if (isRecord(node.properties)) {
      const required = Array.isArray(node.required) ? node.required : [];
      optionals += Object.keys(node.properties).filter((name) => !required.includes(name)).length;
      Object.values(node.properties).forEach(visit);
    }
    for (const key of ["items", "anyOf", "oneOf", "allOf"]) visit(node[key]);
    if (isRecord(node.$defs)) Object.values(node.$defs).forEach(visit);
  };
  visit(schema);
  return { unions, optionals };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * The sanitised JSON Schema of a wire schema. zod's input side is converted
 * because the model writes what we then parse; refs are inlined and cycles
 * rejected (the API compiles no recursive schemas).
 */
export function toJsonSchema(wire: z.ZodType): JsonSchema {
  let raw: JsonSchema;
  try {
    raw = z.toJSONSchema(wire, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "throw",
      cycles: "throw",
      reused: "inline",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SchemaConversionError("", `zod could not convert it: ${reason}`);
  }
  const schema = sanitizeJsonSchema(raw);
  const { unions, optionals } = countSchemaComplexity(schema);
  if (unions > SCHEMA_LIMITS.unions) {
    throw new SchemaConversionError("", `${unions} union parameters exceed the limit of ${SCHEMA_LIMITS.unions}`);
  }
  if (optionals > 0) throw new SchemaConversionError("", "optional parameters are not allowed");
  return schema;
}

const formats = new WeakMap<z.ZodType, JsonSchemaFormat>();

/**
 * `output_config.format` for a wire schema. Memoised and frozen: the same
 * object is sent on every request, so the compiled grammar and the prompt
 * cache see byte-identical schemas.
 */
export function toJsonSchemaFormat(wire: z.ZodType): JsonSchemaFormat {
  let format = formats.get(wire);
  if (!format) {
    format = deepFreeze({ type: "json_schema", schema: toJsonSchema(wire) });
    formats.set(wire, format);
  }
  return format;
}
