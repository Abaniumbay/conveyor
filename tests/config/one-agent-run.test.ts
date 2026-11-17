import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config/load";
import { PLUGINS } from "../../src/plugins";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const HEADER = `
settings: { database: /tmp/c.sqlite, logs: /tmp/logs, workspaces: /tmp/ws, artifacts: /tmp/art }
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: conveyor:done }
  metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
sources:
  github: { type: github }
runners:
  claude: { type: claude-code }
agents:
  first: { runner: claude, instructions: /tmp/worker.md, workspaceAccess: read-only }
  second: { runner: claude, instructions: /tmp/worker.md, workspaceAccess: read-only }
`;

const TWO = "[{ id: write, task: agent.run, with: { agent: first } }, { id: check, task: agent.run, with: { agent: second } }]";
const ONE = "[{ id: write, task: agent.run, with: { agents: [first, second] } }]";
const stage = (actions: string) => `{ id: build, concurrency: 1, actions: ${actions}, exit-gate: [{ task: item.criteriaDefined }] }`;

const repository = (extra = "") => `
repositories:
  sample:
    source: github
    address: owner/sample
    folder: /tmp/sample
${extra}`;

async function load(body: string): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-one-agent-"));
  directories.push(directory);
  await writeFile(path.join(directory, "config.yml"), HEADER + body);
  await loadConfig(directory, null, { plugins: PLUGINS });
}

async function failure(body: string): Promise<string> {
  try {
    await load(body);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a failure");
}

describe("one agent.run per stage", () => {
  test("a stages list with two agent.run actions in one stage names the stage and both action ids", async () => {
    const message = await failure(`stages:\n  - ${stage(TWO)}\n${repository()}`);
    expect(message).toContain('stage "build"');
    expect(message).toContain('"write", "check"');
    expect(message).toContain("more than one agent.run");
  });

  test("a repository whose effective stages put two agent.run actions in one stage is named with the stage and ids", async () => {
    const overrides = "    overrides:\n      stages:\n        build: { actions: { write: { with: { agent: second } } } }\n";
    const message = await failure(`stages:\n  - ${stage(TWO)}\n${repository(overrides)}`);
    expect(message).toContain('repository "sample"');
    expect(message).toContain('stage "build"');
    expect(message).toContain('"write", "check"');
  });

  test("one agent.run whose agents list names several agents loads", async () => {
    await load(`stages:\n  - ${stage(ONE)}\n${repository()}`);
  });

  test("the deprecated pipelines form fails with the same error, naming the pipeline and stage", async () => {
    const message = await failure(`pipelines:\n  delivery:\n    stages:\n      - ${stage(TWO)}\n${repository("    pipeline: delivery\n")}`);
    expect(message).toContain('stage "build" in pipeline "delivery"');
    expect(message).toContain('"write", "check"');
    expect(message).toContain("more than one agent.run");
  });
});
