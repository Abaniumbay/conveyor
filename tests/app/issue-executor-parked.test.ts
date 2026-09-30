import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExternalWaitError } from "../../src/app/ci-gate";
import { IssueExecutor } from "../../src/app/issue-executor";
import { loadConfig, type ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import type { PipelineDependencies } from "../../src/core/pipeline";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const success = {
  stageResult: { outcome: "success" as const, status: "done", summary: "ok", reason: null, metrics: {} },
  sessionId: null,
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  cost: { amount: 0, currency: "USD" as const, source: "unavailable" as const },
  durationMs: 1,
  exitCode: 0,
  artifacts: [],
  stderr: "",
};

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-parked-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
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
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: implementation
        run: { agent: worker }
        concurrency: 1
      - id: review
        run: { agent: worker }
        concurrency: 1
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryPath}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({
    id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash,
  });
  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://example.test/7", title: "A feature",
    body: "Requirements", sourceState: "open", labels: ["conveyor", "conveyor:implementation"],
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
  store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  const labels: string[][] = [];
  const producers: string[] = [];
  let wait: ExternalWaitError | null = new ExternalWaitError("Waiting for CI at abc1234: Tests.", 60_000, "CI started");
  const executorFor = (current: ConveyorConfig) => new IssueExecutor({
    config: current,
    store,
    sourceName: "github",
    source: { async replaceConveyorLabels(_address, _number, next) { labels.push([...next]); } },
    workspaceManager: { async create() { return { path: path.join(root, "worktree"), branch: "conveyor/7", baseRevision: "abc" }; } },
    loadDeliveryState: async () => ({ pullRequest: null, checks: [] }),
    runtime: () => ({
      async runCheck() { throw new Error("no checks"); },
      async runProducer(stage) {
        producers.push(stage.id);
        if (wait) throw wait;
        return success;
      },
      async runAction() {},
    } satisfies PipelineDependencies),
    sourceGuidance: "",
  });
  return {
    config, store, labels, producers, executorFor,
    stopWaiting() { wait = null; },
    messages: () => store.listConversationMessages("issue").map((message) => message.message),
  };
}

describe("IssueExecutor parked stages", () => {
  test("parks a waiting stage: no transition, stage ready, status line set, wake-up persisted, no duplicate note", async () => {
    const h = await setup();
    const before = Date.now();
    const outcome = await h.executorFor(h.config).execute(h.store.getIssue("issue")!);

    expect(outcome).toMatchObject({ kind: "parked", stageId: "implementation", reason: "pending" });
    expect(h.labels).toEqual([]);
    expect(h.store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "ready" });
    expect(h.store.getIssue("issue")?.warning).toBe("Waiting for CI at abc1234: Tests.");
    const wake = h.store.executions().wakeAt("issue");
    expect(Date.parse(wake!)).toBeGreaterThanOrEqual(before + 60_000);
    expect(h.messages()).toEqual([]);

    h.stopWaiting();
    const resumed = await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    expect(resumed).toMatchObject({ kind: "advance", nextStageId: "review" });
    expect(h.store.executions().wakeAt("issue")).toBeNull();
    expect(h.labels).toEqual([["conveyor", "conveyor:review"]]);
    h.store.close();
  });

  test("a changed config hash restarts a parked stage and says so once", async () => {
    const h = await setup();
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    const epoch = h.store.executions().stageEpoch("issue");

    // Same hash: resumes quietly.
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    expect(h.store.executions().stageEpoch("issue")).toBe(epoch);
    expect(h.messages()).toEqual([]);

    const changed = { ...h.config, hash: "changed-hash" };
    await h.executorFor(changed).execute(h.store.getIssue("issue")!);
    expect(h.store.executions().stageEpoch("issue")).toBeGreaterThan(epoch);
    expect(h.store.executions().getContext("issue")?.context.configHash).toBe("changed-hash");
    const notes = h.messages();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/plan changed.*restart/i);
    expect(h.producers).toEqual(["implementation", "implementation", "implementation"]);
    h.store.close();
  });
});
