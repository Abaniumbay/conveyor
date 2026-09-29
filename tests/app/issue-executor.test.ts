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

describe("IssueExecutor", () => {
  test("creates one enrollment workspace, executes checks, and checkpoints the next stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-executor-"));
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
      - id: refinement
        run: { agent: worker }
        concurrency: 1
        enterCheck: verify
        exitCheck: verify
      - id: implementation
        run: { agent: worker }
        concurrency: 1
        enterCheck: verify
        exitCheck: verify
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
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: repositoryPath,
      configHash: config.hash,
    });
    store.upsertIssue({
      id: "issue",
      repositoryId: "repo",
      sourceNumber: 7,
      sourceUrl: "https://example.test/7",
      title: "A feature",
      body: "Requirements",
      sourceState: "open",
      labels: ["conveyor", "conveyor:refinement"],
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection("issue", { stage: "refinement", state: "active", warning: null });
    store.setStageState({
      issueId: "issue",
      stageId: "refinement",
      status: "ready",
      feedbackCycle: 0,
      configHash: config.hash,
    });
    const calls: string[] = [];
    const labels: string[][] = [];
    const runtimeDelivery: unknown[] = [];
    const executor = new IssueExecutor({
      config,
      store,
      sourceName: "github",
      source: {
        async replaceConveyorLabels(_address, _number, next) { labels.push([...next]); },
      },
      workspaceManager: {
        async create(input) {
          calls.push(`workspace:${input.issueNumber}`);
          return {
            path: path.join(root, "worktree"),
            branch: "conveyor/7-r1-a-feature",
            baseRevision: "abc",
          };
        },
      },
      loadDeliveryState: async () => ({
        pullRequest: { number: 190, state: "open" },
        checks: [{ name: "Tests", conclusion: "success" }],
      }),
      runtime(context) {
        runtimeDelivery.push(context.delivery);
        return {
          async runCheck(_id, phase) {
            calls.push(`check:${phase}`);
            return {
              decision: "pass",
              status: "done",
              reason: null,
              evidence: [],
              requiredFixes: [],
              criteria: [],
            };
          },
          async runProducer(stage) {
            calls.push(`producer:${stage.id}`);
            return {
              stageResult: { outcome: "success", status: "done", summary: "ok", reason: null, metrics: {} },
              sessionId: null,
              usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
              cost: { amount: 0, currency: "USD", source: "unavailable" },
              durationMs: 1,
              exitCode: 0,
              artifacts: [],
              stderr: "",
            };
          },
          async runAction() {},
        };
      },
      sourceGuidance: "Never close issues.",
    });

    const result = await executor.execute(store.getIssue("issue")!);

    expect(result).toMatchObject({ kind: "advance", nextStageId: "implementation" });
    expect(runtimeDelivery).toEqual([{
      pullRequest: { number: 190, state: "open" },
      checks: [{ name: "Tests", conclusion: "success" }],
    }]);
    expect(calls).toEqual([
      "workspace:7",
      "check:enter",
      "producer:refinement",
      "check:exit",
    ]);
    expect(labels).toEqual([["conveyor", "conveyor:implementation"]]);
    expect(store.getStageState("issue")).toMatchObject({
      stageId: "implementation",
      status: "awaiting-source",
    });
    expect(store.getActiveWorkspace("issue")).toMatchObject({
      branch: "conveyor/7-r1-a-feature",
      generation: 1,
    });

    store.upsertIssue({
      id: "issue-abort",
      repositoryId: "repo",
      sourceNumber: 8,
      sourceUrl: "https://example.test/8",
      title: "Interrupted feature",
      body: "Requirements",
      sourceState: "open",
      labels: ["conveyor", "conveyor:refinement"],
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection("issue-abort", { stage: "refinement", state: "active", warning: null });
    store.setStageState({
      issueId: "issue-abort",
      stageId: "refinement",
      status: "ready",
      feedbackCycle: 0,
      configHash: config.hash,
    });
    const controller = new AbortController();
    const interrupted = new IssueExecutor({
      config,
      store,
      sourceName: "github",
      source: {
        async replaceConveyorLabels() { throw new Error("must not transition after abort"); },
      },
      workspaceManager: {
        async create() {
          return {
            path: path.join(root, "worktree-abort"),
            branch: "conveyor/8-r1-interrupted-feature",
            baseRevision: "abc",
          };
        },
      },
      runtime() {
        return {
          async runCheck() {
            return { decision: "pass", status: "done", reason: null, evidence: [], requiredFixes: [], criteria: [] };
          },
          async runProducer() {
            controller.abort();
            return {
              stageResult: { outcome: "success", status: "done", summary: "late", reason: null, metrics: {} },
              sessionId: null,
              usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
              cost: { amount: 0, currency: "USD", source: "unavailable" },
              durationMs: 1,
              exitCode: 0,
              artifacts: [],
              stderr: "",
            };
          },
          async runAction() {},
        };
      },
      sourceGuidance: "Never close issues.",
      signal: controller.signal,
    });

    await expect(interrupted.execute(store.getIssue("issue-abort")!)).rejects.toMatchObject({ name: "AbortError" });
    expect(store.getStageState("issue-abort")?.status).toBe("interrupted");
    store.close();
  });
});
