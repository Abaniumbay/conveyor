import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config/load";
import { agentRunVariables, commandVariables } from "../../src/config/run-environment";
import { PLUGINS } from "../../src/plugins";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function load(text: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-run-environment-"));
  directories.push(directory);
  await writeFile(path.join(directory, "config.yml"), text);
  return loadConfig(directory, null, { plugins: PLUGINS });
}

const REPOSITORY = (extra = "") => `
repositories:
  sample:
    source: github
    address: owner/sample
    folder: /tmp/sample
    pipeline: default
${extra}`;

describe("settings.environment levels", () => {
  const levels = `
settings:
  database: /tmp/conveyor.sqlite
  logs: /tmp/logs
  workspaces: /tmp/workspaces
  artifacts: /tmp/artifacts
  environment: { PATH: , LEVEL: root, ROOT_ONLY: r }
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: conveyor:done }
  metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
sources:
  github: { type: github }
runners:
  claude: { type: claude-code, settings: { environment: { ANTHROPIC_API_KEY: , LEVEL: harness } } }
agents:
  worker: { runner: claude, instructions: /tmp/worker.md, workspaceAccess: read-only, settings: { environment: { LEVEL: agent, NPM_TOKEN: listed } } }
pipelines:
  default:
    stages:
      - id: review
        concurrency: 1
        settings: { environment: { LEVEL: stage, STAGE_ONLY: s } }
        actions: [{ task: agent.run, with: { agent: worker } }]
        exit-gate: [{ task: change.mergeable }]
`;

  test("an agent run takes root, repository, stage, harness and agent in that order, the harness level for its program only", async () => {
    const config = await load(levels + REPOSITORY("    settings: { environment: { LEVEL: repository, REPO_ONLY: p } }\n"));
    const run = agentRunVariables(config, { runId: "run-1", repositoryId: "sample", itemId: "7", stageId: "review", agentId: "worker" }, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", GH_TOKEN: "service" });
    expect(run.env).toEqual({
      PATH: "/usr/bin", LEVEL: "agent", ROOT_ONLY: "r", REPO_ONLY: "p", STAGE_ONLY: "s", ANTHROPIC_API_KEY: "k", NPM_TOKEN: "listed",
      CONVEYOR_RUN_ID: "run-1", CONVEYOR_REPOSITORY_ID: "sample", CONVEYOR_ITEM_ID: "7", CONVEYOR_STAGE_ID: "review", CONVEYOR_AGENT_ID: "worker",
    });
    expect(run.programVariables).toEqual(["ANTHROPIC_API_KEY"]);
    expect(commandVariables(run)).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(commandVariables(run)).toHaveProperty("NPM_TOKEN", "listed");
  });

  test("without a root environment every run starts from the default list, taken from the service", async () => {
    const config = await load(levels.replace("  environment: { PATH: , LEVEL: root, ROOT_ONLY: r }\n", "") + REPOSITORY());
    expect(Object.keys(config.settings.environment)).toEqual(["USER", "LOGNAME", "PATH", "TERM", "COLORTERM", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);
  });
});
