import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConfiguredStageRuntime } from "../../src/app/runtime";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { AgentHarnessRegistry } from "../../src/runner/harness";
import { HarnessError } from "../../src/runner/harness-error";
import { HarnessRetryExhaustedError } from "../../src/runner/retry";
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
    await writeFile(path.join(root, "check.ts"), `
console.log(JSON.stringify({
  passed: false,
  commands: [
    { name: "Core tests", passed: false, output: "Executable not found in $PATH: dart" },
    { name: "Web tests", passed: true, output: "12 tests passed" },
  ],
}));
`);
    await writeFile(path.join(root, "agent.md"), "Implement only the requested issue.");
    await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
  retries:
    infrastructureAttempts: 2
    usageLimitAttempts: 2
    minBackoff: 3ms
    maxBackoff: 6ms
web: {}
sources:
  github: { type: github }
runners:
  codex: { type: codex, command: codex }
  process: { type: json-process }
agents:
  worker:
    name: Implementer
    title: Senior Developer
    runner: codex
    model: gpt-test
    effort: low
    instructions: ./agent.md
    tools: [source.get_issue, conversation.get, run.report_progress, workspace.request_fetch]
  checker:
    name: Verifier
    title: Quality Verifier
    runner: codex
    effort: high
    instructions: ./agent.md
    workspaceAccess: read-only
    tools: [source.get_issue, run.report_progress, source.set_acceptance_criteria]
checks:
  verify: { verifier: checker, script: ./check.ts }
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
      - id: deploy
        run: { runner: process, script: ./deploy.ts }
        concurrency: 1
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repository}
    pipeline: default
`);
    const config = await loadConfig(path.join(root, "config.yml"));
    config.runners.fake = { type: "fake" } as unknown as typeof config.runners[string];
    config.agents.worker!.runner = "fake";
    config.agents.checker!.runner = "fake";
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
    store.appendConversationMessage({
      issueId: issue.id,
      runId: null,
      stageId: "implementation",
      actorType: "user",
      actorId: "operator",
      actorName: "You",
      actorTitle: null,
      message: "Preserve the existing API.",
    });
    const grants: string[][] = [];
    const actors: unknown[] = [];
    const deliveryStates: unknown[] = [];
    const producerInputs: unknown[] = [];
    const checkInputs: unknown[] = [];
    let producerAttempts = 0;
    let checkAttempts = 0;
    let forcedFailure: "producer-infrastructure" | "check-usage-limit" | null = null;
    let interruptedHarnessCalls = 0;
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
      cost: { amount: 0.125, currency: "USD", source: "reported" },
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
          actors.push(input.actor);
          deliveryStates.push(structuredClone(input.context.delivery));
          return { configuration: { command: "bun", args: ["mcp.ts"] }, async close() {} };
        },
      },
      { async run() {} },
      async () => ({
        pullRequest: { number: 18, state: "merged", merged: true },
        checks: [{ name: "Tests", conclusion: "success" }],
      }),
      {
        harnesses: new AgentHarnessRegistry().register("fake", () => ({
          async runProducer(input) {
            producerInputs.push(input);
            producerAttempts += 1;
            if (forcedFailure === "producer-infrastructure") throw new HarnessError("temporary process failure", "process");
            if (forcedFailure === null && producerAttempts === 1) throw new HarnessError("rate limit reached", "usage-limit");
            return producerResult;
          },
          async runCheck(input) {
            checkInputs.push(input);
            checkAttempts += 1;
            if (forcedFailure === "check-usage-limit") throw new HarnessError("rate limit reached", "usage-limit");
            if (forcedFailure === null && checkAttempts === 1) throw new HarnessError("temporary process failure", "process");
            return {
            decision: "fail",
            status: "needs-intervention",
            reason: "The verification command could not start.",
            evidence: ["Core tests did not execute."],
            requiredFixes: ["Restore Dart to PATH."],
            criteria: [],
            sessionId: "check-thread",
            usage: { inputTokens: 10, outputTokens: 3, cachedTokens: 1 },
            durationMs: 25,
            exitCode: 0,
            stderr: "",
            cost: { amount: 0.075, currency: "USD", source: "reported" },
            };
          },
          async runSteering() { throw new Error("unused"); },
        })),
        async jsonProcess() {
          return {
            ...producerResult,
            stageResult: { ...producerResult.stageResult, summary: "Deployment completed" },
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
    const retryStarted = performance.now();
    expect(await runtime.runCheck("verify", "exit", { ...context, producerResult })).toMatchObject({
      decision: "fail",
      sessionId: "check-thread",
    });
    expect(performance.now() - retryStarted).toBeGreaterThanOrEqual(2);
    expect(await runtime.runProducer(config.pipelines.default!.stages[1]!, {
      ...context,
      stageId: "deploy",
    })).toMatchObject({ stageResult: { summary: "Deployment completed" } });

    expect(producerInputs).toHaveLength(2);
    expect(checkInputs).toHaveLength(2);
    expect((producerInputs[0] as { accessLevel: string; mcp: unknown }).accessLevel).toBe("workspace-write");
    expect((producerInputs[0] as { mcp: unknown }).mcp).toEqual({ command: "bun", args: ["mcp.ts"] });
    expect((checkInputs[0] as { accessLevel: string }).accessLevel).toBe("read-only");
    expect(grants[0]).toEqual(["source.get_issue", "conversation.get", "run.report_progress", "workspace.request_fetch"]);
    expect(grants[1]).toEqual(["source.get_issue", "run.report_progress"]);
    expect(deliveryStates[1]).toEqual({
      pullRequest: { number: 18, state: "merged", merged: true },
      checks: [{ name: "Tests", conclusion: "success" }],
    });
    expect(actors).toEqual([
      { id: "worker", name: "Implementer", title: "Senior Developer" },
      { id: "checker", name: "Verifier", title: "Quality Verifier" },
    ]);
    expect((producerInputs[0] as { instructions: string }).instructions).toContain("Implement only the requested issue.");
    expect((producerInputs[0] as { prompt: string }).prompt).toContain("Preserve the existing API.");
    expect((producerInputs[0] as { prompt: string }).prompt).toContain("Publish every interim update intended for the user exclusively through `run.report_progress`");
    expect((producerInputs[0] as { prompt: string }).prompt).toContain("continues for ten minutes without another report");
    expect((producerInputs[0] as { prompt: string }).prompt).toContain('"allowedFailureStatuses": [');
    expect((checkInputs[0] as { prompt: string }).prompt).toContain('"allowedFailureStatuses": [');
    expect((checkInputs[0] as { prompt: string }).prompt).toContain('"blocked"');
    expect(store.costSummary()).toMatchObject({
      runs: 3,
      amount: 0.325,
      unavailableRuns: 0,
      inputTokens: 50,
      outputTokens: 13,
      durationMs: 125,
    });
    expect(store.listConversationMessages(issue.id, 20).map((message) => ({
      actor: message.actorName,
      message: message.message,
    }))).toEqual([
      { actor: "You", message: "Preserve the existing API." },
      {
        actor: "Conveyor",
        message: "Implementation started — Implementer (Senior Developer).",
      },
      {
        actor: "Implementer",
        message: "Implementation completed: Implemented.",
      },
      {
        actor: "Verifier",
        message: "Implementation exit verification failed: The verification command could not start. Required: Restore Dart to PATH. Evidence: Core tests did not execute.",
      },
      {
        actor: "Conveyor",
        message: "Deploy script started.",
      },
      {
        actor: "Conveyor",
        message: "Deploy script completed: Deployment completed.",
      },
    ]);

    forcedFailure = "producer-infrastructure";
    producerAttempts = 0;
    await expect(runtime.runProducer(stage, context)).rejects.toBeInstanceOf(HarnessRetryExhaustedError);
    expect(producerAttempts).toBe(2);

    forcedFailure = "check-usage-limit";
    checkAttempts = 0;
    await expect(runtime.runCheck("verify", "exit", { ...context, producerResult })).rejects.toBeInstanceOf(HarnessRetryExhaustedError);
    expect(checkAttempts).toBe(2);

    const controller = new AbortController();
    controller.abort();
    const interruptedRuntime = new ConfiguredStageRuntime(
      config,
      store,
      {
        issue,
        repository: { id: "repo", address: "owner/repo", folder: repository, baseBranch: "main" },
        workspace: { path: repository, branch: "conveyor/1-r1-feature" },
        sourceGuidance: "Never close issues.",
      },
      {
        async create() {
          return { configuration: { command: "bun", args: ["mcp.ts"] }, async close() {} };
        },
      },
      { async run() {} },
      undefined,
      { harnesses: new AgentHarnessRegistry().register("fake", () => ({
        async runProducer() { interruptedHarnessCalls += 1; throw new HarnessError("unexpected", "process"); },
        async runCheck() { interruptedHarnessCalls += 1; throw new HarnessError("unexpected", "process"); },
        async runSteering() { throw new Error("unused"); },
      })) },
      controller.signal,
    );
    await expect(interruptedRuntime.runProducer(stage, context)).rejects.toMatchObject({ kind: "interrupted" });
    await expect(interruptedRuntime.runCheck("verify", "exit", { ...context, producerResult })).rejects.toMatchObject({ kind: "interrupted" });
    expect(interruptedHarnessCalls).toBe(0);
    store.close();
  });
});
