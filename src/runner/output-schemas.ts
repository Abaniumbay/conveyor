// The JSON schemas agents' final results must match, embedded in the executable. The Codex CLI
// reads a schema by path, so each run writes it beside its other artifacts.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import checkResult from "./schemas/check-result.json";
import producerResult from "./schemas/producer-result.json";

export const OUTPUT_SCHEMAS = {
  producer: JSON.stringify(producerResult),
  check: JSON.stringify(checkResult),
} as const;

/** Writes the schema into `directory` and returns its path. */
export async function writeOutputSchema(directory: string, name: keyof typeof OUTPUT_SCHEMAS): Promise<string> {
  const file = path.join(directory, `${name}-result.schema.json`);
  await writeFile(file, OUTPUT_SCHEMAS[name]);
  return file;
}
