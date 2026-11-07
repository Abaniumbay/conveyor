import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readConfiguration } from "../../src/config/load";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function warningsFor(yaml: string): Promise<string[]> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-deprecation-"));
  directories.push(directory);
  const file = path.join(directory, "conveyor.yaml");
  await writeFile(file, yaml);
  return (await readConfiguration(file)).warnings;
}

test("a configuration with stages: and no pipeline keys prints no pipelines deprecation", async () => {
  const warnings = await warningsFor("stages:\n  - id: build\nrepositories:\n  app:\n    address: owner/app\n");
  expect(warnings.filter((warning) => warning.includes("migrate --stages"))).toEqual([]);
});

test("pipelines: names the file that declares it", async () => {
  const warnings = await warningsFor("pipelines:\n  delivery:\n    stages: []\n");
  expect(warnings.join("\n")).toMatch(/conveyor\.yaml.*migrate --stages/);
});
