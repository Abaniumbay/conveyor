import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { IssueExecutor } from "../../src/app/issue-executor";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(skipped: string) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-skipped-"));
  directories.push(root);
  for (const name of ["skipper", "runner"]) await mkdir(path.join(root, name));
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources: { github: { type: github } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./instructions.md } }
checks: { verify: { verifier: worker } }
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked, error]
    stages:
      - { id: refinement, run: { agent: worker }, concurrency: 1, enterCheck: verify, exitCheck: verify }
      - { id: implementation, run: { agent: worker }, concurrency: 1, enterCheck: verify, exitCheck: verify }
repositories:
  skipper:
    source: github
    address: owner/skipper
    folder: ${root}/skipper
    pipeline: default
    overrides: { stages: { ${skipped}: { skip: true } } }
  runner:
    source: github
    address: owner/runner
    folder: ${root}/runner
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  for (const name of ["skipper", "runner"]) {
    store.upsertRepository({ id: name, configName: name, source: "github", address: `owner/${name}`, folder: path.join(root, name), configHash: config.hash });
  }
  const calls: string[] = [];
  const labels: string[][] = [];
  const enroll = (repository: string, stage: string, number: number) => {
    const id = `${repository}-${number}`;
    store.upsertIssue({
      id, repositoryId: repository, sourceNumber: number, sourceUrl: `https://example.test/${number}`, title: id, body: "Requirements",
      sourceState: "open", labels: ["conveyor", `conveyor:${stage}`], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection(id, { stage, state: "active", warning: null });
    store.setStageState({ issueId: id, stageId: stage, status: "ready", feedbackCycle: 0, configHash: config.hash });
    return store.getIssue(id)!;
  };
  const executor = new IssueExecutor({
    config,
    store,
    sourceName: "github",
    source: { async replaceConveyorLabels(_address, _number, next) { labels.push([...next]); } },
    workspaceManager: {
      async create(input) {
        calls.push(`workspace:${input.issueNumber}`);
        return { path: path.join(root, "worktree"), branch: `conveyor/${input.issueNumber}`, baseRevision: "abc", adopted: true };
      },
    },
    loadDeliveryState: async () => ({ pullRequest: null, checks: [] }),
    runtime() {
      return {
        async runCheck(_id, phase) {
          calls.push(`check:${phase}`);
          return { decision: "pass", status: "done", reason: null, evidence: [], requiredFixes: [], criteria: [] };
        },
        async runProducer(stage) {
          calls.push(`producer:${stage.id}`);
          return {
            stageResult: { outcome: "success", status: "done", summary: "ok", reason: null, metrics: {} },
            sessionId: null,
            usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            cost: { amount: 0, currency: "USD", source: "unavailable" },
            durationMs: 1, exitCode: 0, artifacts: [], stderr: "",
          };
        },
        async runAction() { calls.push("action"); },
      };
    },
    sourceGuidance: "g",
  });
  return { store, enroll, executor, calls, labels };
}

describe("skipped stages in the engine", () => {
  test("an item passes a skipped stage with no action, gate, agent or workspace, and history says why", async () => {
    const w = await setup("refinement");
    const result = await w.executor.execute(w.enroll("skipper", "refinement", 1));
    expect(result).toMatchObject({ kind: "advance", stageId: "refinement", nextStageId: "implementation" });
    expect(w.calls).toEqual([]);
    expect(w.labels).toEqual([["conveyor", "conveyor:implementation"]]);
    expect(w.store.getStageState("skipper-1")).toMatchObject({ stageId: "implementation" });
    const history = w.store.listStageTransitions("skipper-1");
    expect(history.map((entry) => [entry.kind, entry.fromStage, entry.reason])).toContainEqual(["skipped", "refinement", "skipped for this repository"]);
  });

  test("an item skipping the final stage still reaches Done", async () => {
    const w = await setup("implementation");
    const result = await w.executor.execute(w.enroll("skipper", "implementation", 2));
    expect(result).toMatchObject({ kind: "advance", stageId: "implementation", nextStageId: null });
    expect(w.calls).toEqual([]);
    expect(w.labels.at(-1)).toContain("conveyor:done");
  });

  test("an item of a repository that does not skip the stage still runs its actions and gates", async () => {
    const w = await setup("refinement");
    const result = await w.executor.execute(w.enroll("runner", "refinement", 3));
    expect(result).toMatchObject({ kind: "advance", nextStageId: "implementation" });
    expect(w.calls).toEqual(["workspace:3", "check:enter", "producer:refinement", "check:exit"]);
  });
});
