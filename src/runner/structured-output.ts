import { readFile } from "node:fs/promises";

import { HarnessError } from "./harness-error";

interface StructuredSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

/** Read, decode, and validate a structured result using one protocol boundary. */
export async function readStructuredOutput<T>(
  outputFile: string,
  schema: StructuredSchema<T>,
  label: string,
): Promise<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(outputFile, "utf8"));
  } catch (error) {
    throw new HarnessError(
      `${label} did not produce valid structured output: ${error instanceof Error ? error.message : String(error)}`,
      "protocol",
      { cause: error },
    );
  }

  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new HarnessError(
      `${label} structured output failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
        .join("; ")}`,
      "protocol",
    );
  }
  return parsed.data;
}
