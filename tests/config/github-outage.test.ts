import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config/load";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function load(github: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-outage-config-"));
  directories.push(directory);
  await writeFile(path.join(directory, "config.yml"), `
settings:
  database: /tmp/conveyor.sqlite
  logs: /tmp/logs
  workspaces: /tmp/workspaces
  artifacts: /tmp/artifacts
${github}labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: conveyor:done }
  metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
`);
  return loadConfig(directory);
}

describe("github.outageWaitLimit", () => {
  test("defaults to two hours", async () => {
    expect((await load("")).github.outageWaitLimit).toBe(2 * 60 * 60_000);
  });

  test("is parsed as a duration", async () => {
    expect((await load("github: { outageWaitLimit: 45m }\n")).github.outageWaitLimit).toBe(45 * 60_000);
  });

  test("rejects a value that is not a duration", async () => {
    await expect(load("github: { outageWaitLimit: soon }\n")).rejects.toThrow();
  });

  test("is documented with its default in docs/configuration.md", async () => {
    const docs = await readFile(path.join(import.meta.dir, "../../docs/configuration.md"), "utf8");
    expect(docs).toContain("github.outageWaitLimit");
    expect(docs).toMatch(/outageWaitLimit: 2h/);
  });
});
