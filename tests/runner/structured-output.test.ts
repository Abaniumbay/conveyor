import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { HarnessError } from "../../src/runner/harness-error";
import { producerResultSchema } from "../../src/runner/result";
import { readStructuredOutput } from "../../src/runner/structured-output";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("readStructuredOutput", () => {
  test("reads and validates a structured result", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-structured-output-"));
    directories.push(directory);
    const file = path.join(directory, "result.json");
    await writeFile(file, JSON.stringify({
      version: 1,
      outcome: "success",
      status: "done",
      summary: "Implemented",
      reason: null,
      metrics: {},
      artifacts: [],
    }));

    await expect(readStructuredOutput(file, producerResultSchema, "Codex"))
      .resolves.toMatchObject({ outcome: "success", status: "done" });
  });

  test("classifies missing and malformed files as protocol errors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-structured-output-"));
    directories.push(directory);
    const missing = path.join(directory, "missing.json");
    const missingError = await readStructuredOutput(missing, producerResultSchema, "Codex").catch((error: unknown) => error);
    expect(missingError).toBeInstanceOf(HarnessError);
    expect(missingError).toMatchObject({ kind: "protocol" });
    expect((missingError as Error).message).toMatch(/did not produce valid structured output/);

    const malformed = path.join(directory, "malformed.json");
    await writeFile(malformed, "{not-json");
    const malformedError = await readStructuredOutput(malformed, producerResultSchema, "Codex").catch((error: unknown) => error);
    expect(malformedError).toBeInstanceOf(HarnessError);
    expect(malformedError).toMatchObject({ kind: "protocol" });
    expect((malformedError as Error).message).toMatch(/did not produce valid structured output/);
  });

  test("classifies schema-invalid data as a protocol error", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-structured-output-"));
    directories.push(directory);
    const file = path.join(directory, "invalid.json");
    await writeFile(file, JSON.stringify({ version: 1, outcome: "unknown" }));

    const error = await readStructuredOutput(file, producerResultSchema, "Codex").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HarnessError);
    expect(error).toMatchObject({ kind: "protocol" });
    expect((error as Error).message).toMatch(/structured output failed validation/);
  });
});
