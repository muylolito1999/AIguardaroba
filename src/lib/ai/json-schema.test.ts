import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  countSchemaComplexity,
  SCHEMA_LIMITS,
  SchemaConversionError,
  toJsonSchema,
  toJsonSchemaFormat,
  type JsonSchema,
} from "@/lib/ai/json-schema";
import { ItemTagsWireSchema } from "@/lib/ai/tagging/schema";
import { FORMALITIES, ITEM_CATEGORIES, ITEM_CONDITIONS, SEASONS } from "@/lib/db/enums";

const STRIPPED_KEYS = [
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
];

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every schema node of a JSON Schema, depth first. */
function nodes(schema: unknown): JsonSchema[] {
  if (Array.isArray(schema)) return schema.flatMap(nodes);
  if (!isRecord(schema)) return [];
  const children = [
    ...(isRecord(schema.properties) ? Object.values(schema.properties) : []),
    schema.items,
    schema.anyOf,
    schema.allOf,
    ...(isRecord(schema.$defs) ? Object.values(schema.$defs) : []),
  ];
  return [schema, ...children.flatMap(nodes)];
}

function property(schema: JsonSchema, ...path: string[]): JsonSchema {
  let node: unknown = schema;
  for (const key of path) {
    if (!isRecord(node) || !isRecord(node.properties)) throw new Error(`no properties at ${key}`);
    node = node.properties[key];
  }
  if (!isRecord(node)) throw new Error(`no schema at ${path.join(".")}`);
  return node;
}

describe("toJsonSchema with the tagging wire schema", () => {
  const schema = toJsonSchema(ItemTagsWireSchema);

  it("removes every keyword structured outputs does not support", () => {
    for (const node of nodes(schema)) {
      for (const key of STRIPPED_KEYS) expect(node, key).not.toHaveProperty(key);
    }
  });

  it("closes every object and requires every key", () => {
    const objects = nodes(schema).filter((node) => node.type === "object");
    expect(objects.length).toBeGreaterThanOrEqual(2); // root and confidence
    for (const node of objects) {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties as JsonSchema));
    }
  });

  it("keeps the enums so the grammar enforces them", () => {
    expect(property(schema, "category").enum).toEqual([...ITEM_CATEGORIES]);
    expect(property(schema, "formality").enum).toEqual([...FORMALITIES]);
    expect(property(schema, "condition").enum).toEqual([...ITEM_CONDITIONS]);
    expect((property(schema, "seasons").items as JsonSchema).enum).toEqual([...SEASONS]);
    expect(property(schema, "warmth_level").enum).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the descriptions that state the stripped limits", () => {
    expect(property(schema, "description").description).toMatch(/180 characters/);
  });

  it("stays within the compile limits, with no optional keys", () => {
    const complexity = countSchemaComplexity(schema);
    expect(complexity).toEqual({ unions: 3, optionals: 0 });
    expect(complexity.unions).toBeLessThanOrEqual(SCHEMA_LIMITS.unions);
  });

  it("has no key that mentions reasoning, thinking or thought", () => {
    const keys = nodes(schema).flatMap((node) => (isRecord(node.properties) ? Object.keys(node.properties) : []));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect(key).not.toMatch(/reasoning|thinking|thought/i);
  });
});

describe("toJsonSchema rejects what the API cannot compile", () => {
  it.each([
    ["an optional key", z.object({ a: z.string(), b: z.string().optional() }), /optional keys/],
    ["a default (optional on the input side)", z.object({ a: z.string().default("x") }), /optional keys/],
    ["a record", z.object({ a: z.record(z.string(), z.number()) }), /not supported|unknown keys/],
    ["a loose object", z.looseObject({ a: z.string() }), /unknown keys/],
    ["an unknown value", z.object({ a: z.unknown() }), /has no type/],
    ["a tuple", z.object({ a: z.tuple([z.string(), z.number()]) }), /prefixItems/],
    ["a reasoning key", z.object({ reasoning: z.string() }), /reserved/],
    ["a nested thought key", z.object({ a: z.object({ Thoughts: z.string() }) }), /reserved/],
    ["a thinking key", z.object({ thinking_steps: z.array(z.string()) }), /reserved/],
    ["a transform output", z.object({ a: z.date() }), /zod could not convert/],
  ])("throws on %s", (_label, wire, message) => {
    expect(() => toJsonSchema(wire)).toThrow(SchemaConversionError);
    expect(() => toJsonSchema(wire)).toThrow(message);
  });

  it("throws when the schema has more than 16 unions", () => {
    const shape = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, z.string().nullable()]));
    expect(() => toJsonSchema(z.object(shape))).toThrow(/17 union parameters exceed the limit of 16/);
    const ok = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, z.string().nullable()]));
    expect(countSchemaComplexity(toJsonSchema(z.object(ok))).unions).toBe(16);
  });
});

describe("toJsonSchema normalises supported constructs", () => {
  it("closes plain objects and strips numeric and string limits", () => {
    const schema = toJsonSchema(
      z.object({ n: z.int().min(1).max(5), s: z.string().min(1).max(40).regex(/^a/), d: z.iso.date() }),
    );
    expect(schema).toEqual({
      type: "object",
      properties: { n: { type: "integer" }, s: { type: "string" }, d: { type: "string" } },
      required: ["n", "s", "d"],
      additionalProperties: false,
    });
  });

  it("turns a discriminated union into anyOf with closed branches and keeps const", () => {
    const schema = toJsonSchema(
      z.object({
        v: z.discriminatedUnion("k", [z.object({ k: z.literal("a"), x: z.string() }), z.object({ k: z.literal("b") })]),
      }),
    );
    const v = property(schema, "v");
    expect(v).not.toHaveProperty("oneOf");
    const branches = v.anyOf as JsonSchema[];
    expect(branches).toHaveLength(2);
    expect(property(branches[0] as JsonSchema, "k").const).toBe("a");
    for (const branch of branches) expect(branch.additionalProperties).toBe(false);
    expect(countSchemaComplexity(schema).unions).toBe(1);
  });

  it("counts optionals in foreign schemas", () => {
    expect(
      countSchemaComplexity({
        type: "object",
        properties: { a: { type: "string" }, b: { type: ["string", "null"] } },
        required: ["a"],
      }),
    ).toEqual({ unions: 1, optionals: 1 });
  });
});

describe("toJsonSchemaFormat", () => {
  it("wraps the schema as output_config.format", () => {
    const format = toJsonSchemaFormat(ItemTagsWireSchema);
    expect(format.type).toBe("json_schema");
    expect(format.schema).toEqual(toJsonSchema(ItemTagsWireSchema));
  });

  it("returns the same frozen object for the same schema, so requests stay byte-identical", () => {
    const first = toJsonSchemaFormat(ItemTagsWireSchema);
    expect(toJsonSchemaFormat(ItemTagsWireSchema)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.schema)).toBe(true);
    expect(JSON.stringify(toJsonSchema(ItemTagsWireSchema))).toBe(JSON.stringify(first.schema));
  });
});
