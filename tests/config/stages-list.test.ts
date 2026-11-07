import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkConfig } from "../../src/cli/commands/config";
import { loadConfig, readConfiguration } from "../../src/config/load";
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
  r.register(defineGroup("item", [def({ name: "item.load", kind: "load", writes: ["item"] })]));
  r.register(defineGroup("demo", [def({ name: "demo.act", kind: "act", reads: ["item"] }), def({ name: "demo.gate", kind: "check", reads: ["item"] })]));
  return r;
}

const STAGE_LIST = `
  - { id: build, concurrency: 1, actions: [{ task: demo.act }], exit-gate: [{ task: demo.gate }] }
  - { id: review, concurrency: 1, actions: [{ id: look, task: demo.act }], exit-gate: [{ task: demo.gate }] }
  - { id: ship, concurrency: 1, actions: [{ task: demo.act }], exit-gate: [{ task: demo.gate }] }
`;

async function write(sections: string, repository = ""): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-stages-"));
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "conveyor.yaml");
  await writeFile(
    file,
    `
settings: { database: /tmp/c.sqlite, logs: /tmp/logs, workspaces: /tmp/ws, artifacts: /tmp/art }
labels:
  stageTemplate: "conveyor:{stage}"
  states: { done: conveyor:done }
  metadata: { closable: conveyor:closable, orderTemplate: "conveyor:order:{number}" }
sources:
  github: { type: github }
${sections}
repositories:
  sample:
    source: github
    address: owner/sample
    folder: /tmp/sample
${repository}`,
  );
  return file;
}

const STAGES = `stages:${STAGE_LIST}`;
const PIPELINES = `pipelines:\n  default:\n    stages:${STAGE_LIST.replace(/\n  /g, "\n      ")}`;

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a failure");
}

describe("installation-wide stages", () => {
  test("a stages list without pipelines compiles a repository without pipeline to exactly those stages in order", async () => {
    const config = await loadConfig(await write(STAGES), registry());
    expect(config.plans.map((plan) => plan.stages.map((stage) => stage.id))).toEqual([["build", "review", "ship"]]);
    expect(config.plans[0]!.stages.every((stage) => !stage.skipped)).toBe(true);
  });

  test("pipelines and pipeline compile to the same stages as the equivalent stages list", async () => {
    const legacy = await loadConfig(await write(PIPELINES, "    pipeline: default\n"), registry());
    const single = await loadConfig(await write(STAGES), registry());
    expect(legacy.plans[0]!.id).toBe("default");
    expect(legacy.plans[0]!.stages).toEqual(single.plans[0]!.stages);
  });

  test("overrides.stages.<id>.skip keeps the stage in place, skipped, with no actions or gate", async () => {
    const config = await loadConfig(await write(STAGES, "    overrides:\n      stages:\n        review: { skip: true }\n"), registry());
    const stages = config.plans[0]!.stages;
    expect(stages.map((stage) => [stage.id, stage.skipped])).toEqual([["build", false], ["review", true], ["ship", false]]);
    expect(stages[1]!.actions).toEqual([]);
    expect(stages[1]!.exitGate).toEqual([]);
    expect(stages[0]!.actions.length).toBe(1);
  });

  test("an override for a stage outside the list names the repository and the stage", async () => {
    const message = await failure(checkConfig(await write(STAGES, "    overrides:\n      stages:\n        nope: { actions: { x: { with: {} } } }\n"), registry()));
    expect(message).toContain('repository "sample"');
    expect(message).toContain('"nope"');
  });

  test("a skip for a stage outside the list names the repository and the stage", async () => {
    const message = await failure(checkConfig(await write(STAGES, "    overrides:\n      stages:\n        nope: { skip: true }\n"), registry()));
    expect(message).toContain('repository "sample"');
    expect(message).toContain('"nope"');
  });

  test("skip is not allowed in the installation-wide list", async () => {
    const message = await failure(loadConfig(await write(STAGES.replace("id: ship,", "id: ship, skip: true,")), registry()));
    expect(message).toContain("skip");
  });

  test("config check prints the one stage list and per repository only overrides and skipped stages", async () => {
    const report = await checkConfig(await write(STAGES, "    overrides:\n      stages:\n        review: { skip: true }\n        build: { actions: { demo.act: { with: {} } } }\n"), registry());
    expect(report).toContain("Stages (all repositories):");
    expect(report).toContain("1. build");
    expect(report).toContain("2. review");
    expect(report).toContain("Repository sample");
    expect(report).toContain("overrides: build.actions.demo.act");
    expect(report).toContain("skipped stages: review");
    expect(report).not.toContain("Stage build (");
  });

  test("defining both stages and pipelines fails with a message to use only one", async () => {
    const message = await failure(checkConfig(await write(`${STAGES}\n${PIPELINES}`, "    pipeline: default\n"), registry()));
    expect(message).toContain("use only one");
  });

  test("a repository with no pipeline and no stages list is an error", async () => {
    const message = await failure(loadConfig(await write(PIPELINES), registry()));
    expect(message).toContain("pipeline");
  });

  test("builtin:stages.yaml is the stage list of the packaged delivery pipeline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-stages-home-"));
    directories.push(root);
    const body = (section: string) => `settings: { database: /tmp/c.sqlite, logs: /tmp/l, workspaces: /tmp/w, artifacts: /tmp/a }\n${section}\n`;
    await mkdir(path.join(root, "config"), { recursive: true });
    const single = path.join(root, "config/single.yaml");
    const multi = path.join(root, "config/multi.yaml");
    await writeFile(single, body("stages: !include builtin:stages.yaml"));
    await writeFile(multi, body("pipelines: !include builtin:pipelines.yaml"));
    const left = (await readConfiguration(single, { home: root })).merged;
    const right = (await readConfiguration(multi, { home: root })).merged as { pipelines: { delivery: { stages: unknown } } };
    expect(left.stages).toEqual(right.pipelines.delivery.stages);
  });
});
