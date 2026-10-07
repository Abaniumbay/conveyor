import { describe, expect, test } from "bun:test";

import checkResult from "../../src/runner/schemas/check-result.json";
import producerResult from "../../src/runner/schemas/producer-result.json";

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  [key: string]: unknown;
}

function validateStrictObjectSchema(schema: JsonSchema, path: string): void {
  if (schema.type === "object") {
    const properties = schema.properties ?? {};
    const propertyKeys = Object.keys(properties);

    if (!Array.isArray(schema.required)) {
      throw new Error(
        `Missing or non-array 'required' at ${path}. Strict mode requires 'required' array on all objects.`,
      );
    }

    const requiredKeys = schema.required;
    const sortedRequired = [...requiredKeys].sort();
    const sortedProperties = [...propertyKeys].sort();

    if (JSON.stringify(sortedRequired) !== JSON.stringify(sortedProperties)) {
      throw new Error(
        `'required' array at ${path} does not match properties. Required: [${sortedRequired.join(", ")}], Properties: [${sortedProperties.join(", ")}]`,
      );
    }

    if (schema.additionalProperties !== false) {
      throw new Error(
        `Missing 'additionalProperties: false' at ${path}. Strict mode requires it on all objects.`,
      );
    }

    for (const [key, prop] of Object.entries(properties)) {
      validateStrictObjectSchema(prop as JsonSchema, `${path}.properties.${key}`);
    }
  } else if (schema.type === "array" && schema.items) {
    validateStrictObjectSchema(schema.items, `${path}.items`);
  }
}

describe("Codex output schema validation", () => {
  test("producer-result schema follows strict structured output rules", () => {
    expect(() => {
      validateStrictObjectSchema(producerResult as JsonSchema, "producer-result");
    }).not.toThrow();
  });

  test("check-result schema follows strict structured output rules", () => {
    expect(() => {
      validateStrictObjectSchema(checkResult as JsonSchema, "check-result");
    }).not.toThrow();
  });

  test("producer result metrics object has required array", () => {
    const metrics = (producerResult as JsonSchema).properties?.metrics as JsonSchema;
    expect(Array.isArray(metrics.required)).toBe(true);
    expect(metrics.required).toEqual([]);
  });
});
