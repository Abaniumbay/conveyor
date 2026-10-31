import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config/load";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function configurationWith(toolchain: (root: string) => Promise<string>): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "conveyor-toolchain-config-")));
  directories.push(directory);
  await mkdir(path.join(directory, "state/worktrees"), { recursive: true });
  const declared = await toolchain(directory);
  await writeFile(path.join(directory, "conveyor.yml"), `
settings:
  database: ./state/conveyor.sqlite
  logs: ./state/logs
  workspaces: ./state/worktrees
  artifacts: ./state/artifacts
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states:
    done: conveyor:done
    blocked: conveyor:blocked
  metadata:
    closable: conveyor:closable
    orderTemplate: "conveyor:order:{number}"
runners:
  process:
    type: json-process
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: inspect
        run:
          runner: process
          script: ./scripts/inspect.ts
        concurrency: 1
repositories:
  sample:
    source: github
    address: owner/sample
    folder: ./sample
    pipeline: default
${declared}
sources:
  github:
    type: github
    webhookPath: /hooks/github
`);
  return directory;
}

describe("repository agentToolchainPaths", () => {
  test("accepts an absolute toolchain path", async () => {
    const directory = await configurationWith(async () => "    agentToolchainPaths:\n      paths: [/opt/sdk]");
    const config = await loadConfig(directory, null);
    expect(config.repositories.sample?.agentToolchainPaths?.paths).toEqual(["/opt/sdk"]);
  });

  test("rejects an unknown key in the setting", async () => {
    const directory = await configurationWith(async () => "    agentToolchainPaths:\n      paths: [/opt/sdk]\n      writable: true");
    await expect(loadConfig(directory, null)).rejects.toThrow(/agentToolchainPaths/);
  });

  test("rejects a relative path", async () => {
    const directory = await configurationWith(async () => "    agentToolchainPaths:\n      paths: [sdk/bin]");
    await expect(loadConfig(directory, null)).rejects.toThrow(/absolute/);
  });

  test("rejects a path inside a protected service location before any agent starts", async () => {
    const directory = await configurationWith(async (root) => `    agentToolchainPaths:\n      paths: [${root}/state/worktrees]`);
    await expect(loadConfig(directory, null)).rejects.toThrow("protected service location");
  });

  test("rejects a symbolic link into a protected service location before any agent starts", async () => {
    const directory = await configurationWith(async (root) => {
      const link = path.join(root, "sdk-link");
      await symlink(path.join(root, "state/worktrees"), link);
      return `    agentToolchainPaths:\n      paths: [${link}]`;
    });
    await expect(loadConfig(directory, null)).rejects.toThrow(/resolves to .*protected service location/);
  });
});
