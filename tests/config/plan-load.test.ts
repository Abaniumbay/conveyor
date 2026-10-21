import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkConfig } from "../../src/cli/commands/config";
import { ConfigError, loadConfig } from "../../src/config/load";
import { legacyGroup } from "../../src/tasks/legacy";
import { defineGroup, pass, TaskRegistry, type TaskDefinition } from "../../src/tasks/contract";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function def(input: Partial<TaskDefinition> & Pick<TaskDefinition, "name" | "kind">): TaskDefinition {
  return { description: "", reads: [], writes: [], invalidates: [], run: () => pass(), ...input };
}

function registry(): TaskRegistry {
  const r = new TaskRegistry();
  r.register(legacyGroup);
  r.register(defineGroup("item", [def({ name: "item.load", kind: "load", writes: ["item"] })]));
  r.register(
    defineGroup("demo", [
      def({ name: "demo.act", kind: "act", reads: ["item"] }),
      def({ name: "demo.gate", kind: "check", reads: ["item"] }),
    ]),
  );
  return r;
}

const NATIVE = `
    stages:
      - id: build
        concurrency: 1
        actions: [{ task: demo.act }]
        exit-gate: [{ task: demo.gate }]
`;
const LEGACY = `
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: old
        concurrency: 1
        run: { sourceAction: noop }
`;

async function write(pipeline: string, repositoryCi = ""): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-plan-load-"));
  directories.push(directory);
  await writeFile(
    path.join(directory, "config.yml"),
    `
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
pipelines:
  default:${pipeline}
repositories:
  sample:
    source: github
    address: owner/sample
    folder: /tmp/sample
    pipeline: default
${repositoryCi}`,
  );
  return directory;
}

describe("plan compilation at load", () => {
  test("loads a native pipeline that compiles against the injected registry", async () => {
    const config = await loadConfig(await write(NATIVE), registry());
    expect(config.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(config.plans.map((plan) => plan.repositoryId)).toEqual(["sample"]);
  });

  test("turns a plan error into a ConfigError", async () => {
    await expect(loadConfig(await write(NATIVE))).rejects.toThrow(ConfigError);
    await expect(loadConfig(await write(NATIVE))).rejects.toThrow(/unknown task "demo.act"/);
  });

  test("compiles legacy pipelines through the compatibility translator", async () => {
    const config = await loadConfig(await write(LEGACY), registry());
    expect(config.plans.map((plan) => [plan.repositoryId, plan.stages[0]?.legacy])).toEqual([["sample", true]]);
  });

  test("keeps a configured manual native exit gate in the compiled plan", async () => {
    const config = await loadConfig(await write(`
    stages:
      - id: build
        concurrency: 1
        actions: [{ task: demo.act }]
        exit-gate: [{ id: operator, task: demo.gate, manual: true }]
`), registry());
    expect(config.plans[0]?.stages[0]?.exitGate[0]).toMatchObject({ id: "operator", manual: true });
  });

  test("keeps a configured native entry approval in the compiled plan", async () => {
    const config = await loadConfig(await write(`
    stages:
      - id: merge
        concurrency: 1
        approval: manual
        actions: [{ task: demo.act }]
        exit-gate: [{ task: demo.gate }]
`), registry());
    expect(config.plans[0]?.stages[0]).toMatchObject({ id: "merge", approval: "manual" });
  });

  test("rejects unsupported and legacy entry approvals", async () => {
    await expect(loadConfig(await write(`
    stages:
      - id: build
        concurrency: 1
        approval: automatic
        actions: [{ task: demo.act }]
        exit-gate: [{ task: demo.gate }]
`), registry())).rejects.toThrow(/approval/);
    await expect(loadConfig(await write(`
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: old
        concurrency: 1
        approval: manual
        run: { sourceAction: noop }
`), registry())).rejects.toThrow(/approval/);
  });

  test("rejects manual requirements outside native exit gates", async () => {
    await expect(loadConfig(await write(`
    stages:
      - id: build
        concurrency: 1
        actions: [{ task: demo.act, manual: true }]
        exit-gate: [{ task: demo.gate }]
`), registry())).rejects.toThrow(/manual is valid only on a native exit-gate task/);
  });
});

describe("check-config", () => {
  test("prints manual approval markers while keeping ordinary task details", async () => {
    const manual = await checkConfig(await write(`
    stages:
      - id: build
        concurrency: 1
        actions: [{ task: demo.act }]
        exit-gate:
          - { id: operator, task: demo.gate, manual: true }
          - { id: automatic, task: demo.gate }
`), registry());
    expect(manual).toMatch(/1\. operator: demo\.gate \[check, manual approval\]/);
    expect(manual).toMatch(/2\. automatic: demo\.gate \[check\]/);
    expect(manual).toContain("1. demo.act [act]");
    expect(manual).toContain("wait timeout 30m, poll 1m");
  });

  test("prints a configured stage entry approval", async () => {
    const output = await checkConfig(await write(`
    stages:
      - id: merge
        concurrency: 1
        approval: manual
        actions: [{ task: demo.act }]
        exit-gate: [{ task: demo.gate }]
`), registry());
    expect(output).toContain("Stage merge (concurrency 1, retries 2, entry approval manual)");
  });

  test("prints the hash then the rendered plan of each compilable repository", async () => {
    const output = await checkConfig(await write(NATIVE), registry());
    expect(output).toMatch(/^Configuration is valid \([0-9a-f]{64}\)\n/);
    expect(output).toContain("Repository sample (pipeline default)");
    expect(output).toContain("(load item)");
    expect(output).toContain("1. demo.gate [check]");
  });

  test("shows each repository's effective JUnit report locator", async () => {
    const output = await checkConfig(await write(NATIVE, "    ci: { mode: required, junit: { artifact: junit-results, path: reports/**/*.xml } }\n"), registry());
    expect(output).toContain('JUnit report locators:\n  sample: artifact "junit-results", path "reports/**/*.xml"');
  });

  test("prints the plan of a legacy repository", async () => {
    const output = await checkConfig(await write(LEGACY), registry());
    expect(output).toMatch(/^Configuration is valid \([0-9a-f]{64}\)\n/);
    expect(output).toContain("Stage old (concurrency 1, retries 2, legacy)");
    expect(output).toContain("legacy.produce (source action noop)");
  });
});
