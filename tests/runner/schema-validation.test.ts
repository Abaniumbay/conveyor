import { describe, expect, test } from "bun:test";

import { OUTPUT_SCHEMAS } from "../../src/runner/output-schemas";

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: unknown;
  additionalProperties?: unknown;
  items?: JsonSchema | JsonSchema[];
  [key: string]: unknown;
}

function isObjectSchema(schema: JsonSchema): boolean {
  return (
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object")) ||
    Object.hasOwn(schema, "properties")
  );
}

/** Returns every violation of OpenAI's strict structured-output object rules. */
export function findStrictObjectSchemaViolations(schema: JsonSchema, path = "$"): string[] {
  const violations: string[] = [];

  if (isObjectSchema(schema)) {
    const propertyKeys = Object.keys(schema.properties ?? {}).sort();

    if (!Array.isArray(schema.required)) {
      violations.push(`${path}: missing required array`);
    } else if (JSON.stringify([...schema.required].sort()) !== JSON.stringify(propertyKeys)) {
      violations.push(`${path}: required does not exactly match properties`);
    }

    if (schema.additionalProperties !== false) {
      violations.push(`${path}: additionalProperties must be false`);
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" || typeof value !== "object" || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          violations.push(...findStrictObjectSchemaViolations(item as JsonSchema, `${path}.${key}[${index}]`));
        }
      });
    } else {
      violations.push(...findStrictObjectSchemaViolations(value as JsonSchema, `${path}.${key}`));
    }
  }

  return violations;
}

describe("Codex output schema validation", () => {
  test("embedded output schemas follow strict structured-output rules", () => {
    for (const [name, serializedSchema] of Object.entries(OUTPUT_SCHEMAS)) {
      expect(findStrictObjectSchemaViolations(JSON.parse(serializedSchema) as JsonSchema, name)).toEqual([]);
    }
  });

  test("reports every strict object-schema violation", () => {
    const fixtures: Array<[string, JsonSchema, string]> = [
      ["missing-required", { type: "object", properties: {}, additionalProperties: false }, "missing required array"],
      ["incomplete-required", { type: "object", properties: { value: { type: "string" } }, required: [], additionalProperties: false }, "required does not exactly match properties"],
      ["missing-additional-properties", { type: "object", properties: {}, required: [] }, "additionalProperties must be false"],
      ["empty-object-without-required", { type: "object", additionalProperties: false }, "missing required array"],
      ["nested-array-item", { type: "array", items: { type: "object", properties: {}, additionalProperties: false } }, "missing required array"],
    ];

    for (const [name, fixture, expectedViolation] of fixtures) {
      expect(findStrictObjectSchemaViolations(fixture, name).some((violation) => violation.includes(expectedViolation))).toBe(true);
    }
  });

  test("walks union, composition, definitions, and property-only object schemas", () => {
    const schema: JsonSchema = {
      anyOf: [{ type: ["object", "null"], properties: {}, additionalProperties: false }],
      oneOf: [{ properties: {}, additionalProperties: false }],
      allOf: [{ type: "object", properties: {}, additionalProperties: false }],
      $defs: { nested: { type: "object", properties: {}, additionalProperties: false } },
      definitions: { legacy: { type: "object", properties: {}, additionalProperties: false } },
    };

    expect(findStrictObjectSchemaViolations(schema, "schema")).toHaveLength(5);
  });
});
