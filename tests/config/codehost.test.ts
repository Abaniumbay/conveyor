import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config/load";

const directories: string[] = [];

async function config(codeHost?: string, defineHost = false): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-codehost-config-"));
  directories.push(directory);
  await writeFile(path.join(directory, "config.yml"), `
settings:
  database: /tmp/conveyor.sqlite
  logs: /tmp/logs
  workspaces: /tmp/workspaces
  artifacts: /tmp/artifacts
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: conveyor:done }
  metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
sources:
  github: { type: github }
${defineHost ? "codeHosts:\n  alternate: { type: github }\n" : ""}pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: inspect
        run: { sourceAction: noop }
        concurrency: 1
repositories:
  sample:
    source: github
    ${codeHost === undefined ? "" : `codeHost: ${codeHost}\n    `}address: owner/sample
    folder: /tmp/sample
    pipeline: default
`);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("repository code host configuration", () => {
  test("selects an explicit code host independently from the GitHub issue source", async () => {
    const directory = await config("alternate", true);
    const loaded = await loadConfig(directory);
    expect(loaded.repositories.sample?.source).toBe("github");
    expect(loaded.repositories.sample?.codeHost).toBe("alternate");
  });

  test("defaults an omitted code host to the source-backed GitHub implementation", async () => {
    const directory = await config();
    const loaded = await loadConfig(directory);
    expect(loaded.repositories.sample?.codeHost).toBeUndefined();
  });

  test("rejects an unknown explicit code host with the repository path", async () => {
    const directory = await config("missing");
    await expect(loadConfig(directory)).rejects.toThrow(
      /repositories.sample.codeHost references unknown or unsupported code host "missing"/,
    );
  });
});
