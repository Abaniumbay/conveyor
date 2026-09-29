import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfiguredStageRuntime } from "../../src/app/runtime";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import type { RunEnvelope } from "../../src/runner/result";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ConfiguredStageRuntime", () => {
  test("runs configured producer and independent verifier with scoped MCP and journals usage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-runtime-"));
    directories.push(root);
    const repository = path.join(root, "repository");
    await mkdir(repository);
    await writeFile(path.join(root, "agent.md"), "Implement only the requested issue.");
    await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources:
  github: { type: github }
runners:
  codex: { type: codex, command: codex }
agents:
  worker:
    runner: codex
    model: gpt-test
    effort: low
    instructions: ./agent.md
  checker:
    runner: codex
    effort: high
    instructions: ./agent.md
    workspaceAccess: read-only
checks:
  verify: { verifier: checker }
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
      - id: implementation
        run: { agent: worker }
        concurrency: 1
        enterCheck: verify
        exitCheck: verify
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repository}
    pipeline: default
`);
    const config = await loadConfig(path.join(root, "config.yml"));
    const store = await ConveyorStore.open(config.settings.database);
    store.upsertRepository({
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: repository,
      configHash: config.hash,
    });
    store.upsertIssue({
      id: "issue",
      repositoryId: "repo",
      sourceNumber: 1,
      sourceUrl: "https://github.com/owner/repo/issues/1",
      title: "Feature",
      body: "Requirements",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    const issue = store.getIssue("issue")!;
    const grants: string[][] = [];
    const producerInputs: unknown[] = [];
    const checkInputs: unknown[] = [];
    const producerResult: RunEnvelope = {
      stageResult: {
        outcome: "success",
        status: "done",
        summary: "Implemented",
        reason: null,
        metrics: {},
      },
      sessionId: "producer-thread",
      usage: { inputTokens: 20, outputTokens: 5, cachedTokens: 2 },
      cost: { amount: 0, currency: "USD", source: "unavailable" },
      durationMs: 50,
      exitCode: 0,
      artifacts: [],
      stderr: "",
    };
    const runtime = new ConfiguredStageRuntime(
      config,
      store,
      {
        issue,
        repository: { id: "repo", address: "owner/repo", folder: repository, baseBranch: "main" },
        workspace: { path: repository, branch: "conveyor/1-r1-feature" },
        sourceGuidance: "Never close issues.",
      },
      {
        async create(input) {
          grants.push([...input.allowedTools]);
          return { configuration: { command: "bun", args: ["mcp.ts"] }, async close() {} };
        },
      },
      { async run() {} },
      {
        async codex(input) {
          producerInputs.push(input);
          return producerResult;
        },
        async codexCheck(input) {
          checkInputs.push(input);
          return {
            decision: "pass",
            status: "done",
            reason: null,
            evidence: ["tests pass"],
            requiredFixes: [],
            criteria: [],
            sessionId: "check-thread",
            usage: { inputTokens: 10, outputTokens: 3, cachedTokens: 1 },
            durationMs: 25,
            exitCode: 0,
            stderr: "",
          };
        },
      },
    );
    const stage = config.pipelines.default!.stages[0]!;
    const context = {
      issue: issue as unknown as Record<string, unknown>,
      workspace: repository,
      stageId: stage.id,
      attempt: 1,
      feedback: null,
    };

    expect(await runtime.runProducer(stage, context)).toEqual(producerResult);
    expect(await runtime.runCheck("verify", "exit", { ...context, producerResult })).toMatchObject({
      decision: "pass",
      sessionId: "check-thread",
    });

    expect(producerInputs).toHaveLength(1);
    expect(checkInputs).toHaveLength(1);
    expect(grants[0]).toContain("source.set_acceptance_criteria");
    expect(grants[1]).not.toContain("source.set_acceptance_criteria");
    expect(store.costSummary()).toMatchObject({
      runs: 2,
      inputTokens: 30,
      outputTokens: 8,
      durationMs: 75,
    });
    store.close();
  });
});
