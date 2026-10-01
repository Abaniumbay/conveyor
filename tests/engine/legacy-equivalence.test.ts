// Runs every PipelineEngine scenario through both the legacy engine and the task-chain
// executor (with the compatibility translator) on identical fakes, and requires the same
// StageExecutionResult and the same calls to the fakes.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExternalWaitError } from "../../src/app/ci-gate";
import { ConveyorStore } from "../../src/db/store";
import {
  PipelineExecutionError,
  type CheckResult,
  type PipelineDefinition,
  type PipelineDependencies,
  type ProducerContext,
  type StageExecutionResult,
} from "../../src/core/pipeline";
import { PipelineEngine } from "./reference-engine";
import { ExecutionStore } from "../../src/engine/journal";
import { StageExecutor } from "../../src/engine/stage-executor";
import type { RunEnvelope } from "../../src/runner/result";
import type { TaskContext } from "../../src/tasks/context";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import { translateLegacyStage, type LegacyRuntime } from "../../src/tasks/legacy";
import type { CompiledPipeline } from "../../src/tasks/plan";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function envelope(outcome: "success" | "failure", status: string, reason: string | null = null): RunEnvelope {
  return {
    stageResult: { outcome, status, summary: `${status} summary`, reason, metrics: {} },
    sessionId: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    cost: { amount: 0, currency: "USD", source: "unavailable" },
    durationMs: 1,
    exitCode: 0,
    artifacts: [],
    stderr: "",
  };
}

const passed: CheckResult = { decision: "pass", status: "done", reason: null, evidence: [], requiredFixes: [], criteria: [] };
const failedCheck = (status: string, reason: string | null, requiredFixes: string[] = [], evidence: string[] = []): CheckResult => ({
  decision: "fail", status, reason, evidence, requiredFixes, criteria: [],
});

function pipeline(overrides: Record<string, unknown> = {}): PipelineDefinition {
  return {
    successStatuses: ["done", "skipped"],
    failureStatuses: ["blocked", "rejected", "error", "changes-requested"],
    stages: [
      {
        id: "implementation",
        run: { type: "agent", agent: "implementer" },
        concurrency: 2,
        enterCheck: "implementation-enter",
        exitCheck: "implementation-exit",
        feedbackCycles: 2,
        failurePolicies: {},
        afterSuccess: [{ sourceAction: "pullRequest.ensure", with: { closingReference: true } }],
        ...overrides,
      },
      {
        id: "review",
        run: { type: "agent", agent: "reviewer" },
        concurrency: 2,
        enterCheck: "review-enter",
        exitCheck: "review-exit",
        feedbackCycles: 2,
        failurePolicies: { "changes-requested": { action: "returnToPrevious" } },
        afterSuccess: [],
      },
    ],
  };
}

interface Fake {
  value: PipelineDependencies;
  calls: string[];
  producerContexts: ProducerContext[];
}

interface Script {
  checks?: CheckResult[];
  producers?: Array<RunEnvelope | Error>;
  actionError?: Error;
}

function fakeDependencies(script: Script): Fake {
  const calls: string[] = [];
  const producerContexts: ProducerContext[] = [];
  const checks = [...(script.checks ?? [passed, passed])];
  const producers = [...(script.producers ?? [envelope("success", "done")])];
  const value: PipelineDependencies = {
    async runCheck(checkId, phase, context) {
      calls.push(`check:${phase}:${checkId}:${context.attempt}:${context.producerResult?.stageResult.status ?? "-"}`);
      const result = checks.shift();
      if (!result) throw new Error("missing fake check result");
      return result;
    },
    async runProducer(_stage, context) {
      calls.push(`producer:${context.stageId}:${context.attempt}`);
      producerContexts.push(context);
      const result = producers.shift();
      if (!result) throw new Error("missing fake producer result");
      if (result instanceof Error) throw result;
      return result;
    },
    async runAction(action, context) {
      calls.push(`action:${action.sourceAction}:${context.attempt}`);
      if (script.actionError) throw script.actionError;
    },
  };
  return { value, calls, producerContexts };
}

const INPUT = { issue: { id: "issue-1" }, workspace: "/tmp/workspace" };

function baseContext(): TaskContext {
  return {
    schemaVersion: 1,
    configHash: "hash",
    run: { stage: "", stageEpoch: 0, attempt: 1, maxAttempts: 1, taskInstanceId: "", enteredAt: "2026-01-01T00:00:00.000Z", feedback: null },
    repository: { id: "repo-1", address: "owner/sample", folder: "/srv/sample", baseBranch: "main", ciMode: "required", systemLabels: [] },
    item: {
      id: "issue-1", number: 1, title: "T", url: "u", labels: [], state: "open",
      criteria: [], children: [], dependencies: [], systemLabels: [],
    },
    checkpoints: { ciPassed: null, reviewPassed: null },
  };
}

async function chain() {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-legacy-"));
  directories.push(directory);
  const store = await ConveyorStore.open(path.join(directory, "conveyor.sqlite"));
  store.recordConfigSnapshot("hash", {});
  store.upsertRepository({
    id: "repo-1", configName: "sample", source: "github", address: "owner/sample", folder: "/srv/sample", configHash: "hash",
  });
  store.upsertIssue({
    id: "issue-1", repositoryId: "repo-1", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "T", body: "B",
    sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
  let now = Date.UTC(2026, 0, 1);
  const clock = () => new Date(now);
  const journal = new ExecutionStore(store.sqlite(), { now: clock });
  const notes: string[] = [];
  const statuses: Array<string | null> = [];
  const executor = new StageExecutor({
    registry: createTaskRegistry(), journal, clock,
    notify: (m) => { notes.push(m); },
    setStatus: (m) => { statuses.push(m); },
    settings: { maxReturns: 5 },
  });
  return { journal, executor, notes, statuses, advance: (ms: number) => { now += ms; } };
}

function compiled(definition: PipelineDefinition, defaultFeedbackCycles: number): CompiledPipeline {
  return {
    id: "legacy",
    repositoryId: "repo-1",
    stages: definition.stages.map((stage) => translateLegacyStage(stage, { ...definition, feedbackCycles: defaultFeedbackCycles })),
  };
}

type Outcome = { result: StageExecutionResult } | { error: Error };

async function viaEngine(definition: PipelineDefinition, stageId: string, fake: Fake): Promise<Outcome> {
  try {
    return { result: await new PipelineEngine(definition, fake.value, 2).executeStage(stageId, INPUT) };
  } catch (error) {
    return { error: error as Error };
  }
}

async function viaChain(definition: PipelineDefinition, stageId: string, fake: Fake): Promise<Outcome & { notes: string[] }> {
  const h = await chain();
  h.journal.bumpStageEpoch("issue-1");
  const deps: LegacyRuntime = { ...fake.value, input: INPUT };
  try {
    const outcome = await h.executor.execute({
      issueId: "issue-1", pipeline: compiled(definition, 2), stageId, baseContext: baseContext(), deps,
    });
    if (outcome.kind === "parked") throw new Error(`unexpected park: ${outcome.reason}`);
    return { result: outcome, notes: h.notes };
  } catch (error) {
    return { error: error as Error, notes: h.notes };
  }
}

/** Runs one scenario through both engines on identical fakes and requires identical behaviour. */
async function same(definition: PipelineDefinition, stageId: string, script: Script) {
  const a = fakeDependencies(script);
  const b = fakeDependencies(script);
  const engine = await viaEngine(definition, stageId, a);
  const executed = await viaChain(definition, stageId, b);
  if ("error" in engine) {
    expect("error" in executed).toBe(true);
    expect((executed as { error: Error }).error.constructor).toBe(engine.error.constructor);
    expect((executed as { error: Error }).error.message).toBe(engine.error.message);
  } else {
    expect("result" in executed && executed.result).toEqual(engine.result);
  }
  expect(b.calls).toEqual(a.calls);
  expect(b.producerContexts).toEqual(a.producerContexts);
  return { engine, executed, calls: a.calls, producerContexts: a.producerContexts };
}

describe("legacy compiler is equivalent to PipelineEngine", () => {
  test("runs checks, producer, and lifecycle actions in order before advancing", async () => {
    const { engine, calls } = await same(pipeline(), "implementation", {});
    expect(engine).toMatchObject({ result: { kind: "advance", nextStageId: "review" } });
    expect(calls.map((c) => c.split(":").slice(0, 3).join(":"))).toEqual([
      "check:enter:implementation-enter",
      "producer:implementation:1",
      "check:exit:implementation-exit",
      "action:pullRequest.ensure:1",
    ]);
  });

  test("lets deterministic stages rely on their script or source-action result", async () => {
    const { engine, calls } = await same(
      pipeline({ enterCheck: undefined, exitCheck: undefined, afterSuccess: [] }),
      "implementation",
      { checks: [] },
    );
    expect(engine).toMatchObject({ result: { kind: "advance", nextStageId: "review" } });
    expect(calls).toEqual(["producer:implementation:1"]);
  });

  test("stops a failed entry check at the current stage by default", async () => {
    const { engine } = await same(pipeline(), "review", {
      checks: [failedCheck("needs-intervention", "Verification infrastructure is unavailable", ["Restore the verification environment"])],
      producers: [],
    });
    expect(engine).toMatchObject({
      result: { kind: "stopped", stageId: "review", state: "needs-intervention", feedbackCycles: 0, requiredFixes: ["Restore the verification environment"] },
    });
  });

  test("uses the default reason when an entry check gives none", async () => {
    const { engine } = await same(pipeline(), "review", { checks: [failedCheck("blocked", null)], producers: [] });
    expect(engine).toMatchObject({ result: { kind: "stopped", reason: "stage entry verification failed" } });
  });

  test("returns from a failed entry check only when its status explicitly requests it", async () => {
    const { engine } = await same(pipeline(), "review", {
      checks: [failedCheck("changes-requested", "Implementation evidence is stale", ["Refresh the implementation"], ["Branch changed after implementation"])],
      producers: [],
    });
    expect(engine).toMatchObject({
      result: {
        kind: "correction", targetStageId: "implementation", reason: "Implementation evidence is stale",
        requiredFixes: ["Refresh the implementation"], evidence: ["Branch changed after implementation"], result: null,
      },
    });
  });

  test("returns exit-check feedback to a fresh producer attempt", async () => {
    const { engine, producerContexts } = await same(pipeline(), "implementation", {
      checks: [passed, failedCheck("blocked", "Missing empty state", ["Add empty state"], ["review"]), passed],
      producers: [envelope("success", "done"), envelope("success", "done")],
    });
    expect(engine).toMatchObject({ result: { kind: "advance", feedbackCycles: 1 } });
    expect(producerContexts[1]?.feedback).toEqual({ reason: "Missing empty state", requiredFixes: ["Add empty state"], evidence: ["review"] });
    expect(producerContexts[1]?.attempt).toBe(2);
  });

  test("falls back to the default feedback reason when the exit check gives none", async () => {
    const { producerContexts } = await same(pipeline(), "implementation", {
      checks: [passed, failedCheck("blocked", null, ["x"]), passed],
      producers: [envelope("success", "done"), envelope("success", "done")],
    });
    expect(producerContexts[1]?.feedback?.reason).toBe("verification failed");
  });

  test("stops with the configured state after exhausting feedback cycles", async () => {
    const failure = failedCheck("blocked", "Still incomplete", ["Finish it"]);
    const { engine } = await same(pipeline({ feedbackCycles: 2 }), "implementation", {
      checks: [passed, failure, failure, failure],
      producers: [envelope("success", "done"), envelope("success", "done"), envelope("success", "done")],
    });
    expect(engine).toMatchObject({
      result: { kind: "stopped", state: "blocked", reason: "Still incomplete", feedbackCycles: 2, requiredFixes: ["Finish it"] },
    });
  });

  test("uses failureState for an exhausted exit check and falls back to the default cycle budget", async () => {
    const failure = failedCheck("blocked", "Still incomplete");
    const { engine } = await same(pipeline({ feedbackCycles: undefined, failureState: "needs-intervention" }), "implementation", {
      checks: [passed, failure, failure, failure],
      producers: [envelope("success", "done"), envelope("success", "done"), envelope("success", "done")],
    });
    expect(engine).toMatchObject({ result: { kind: "stopped", state: "needs-intervention", feedbackCycles: 2 } });
  });

  test("does not repeat a successful source action when its exit verifier fails", async () => {
    const { engine, calls } = await same(
      pipeline({ run: { type: "source-action", action: "pullRequest.squashMerge" }, feedbackCycles: 2, afterSuccess: [] }),
      "implementation",
      { checks: [passed, failedCheck("needs-intervention", "External state is not yet confirmed", ["Inspect the delivery state"])] },
    );
    expect(engine).toMatchObject({ result: { kind: "stopped", state: "needs-intervention", feedbackCycles: 0 } });
    expect(calls).toHaveLength(3);
  });

  test("routes review changes back to the previous producer", async () => {
    const { engine } = await same(pipeline(), "review", {
      checks: [passed],
      producers: [envelope("failure", "changes-requested", "Update the empty state")],
    });
    expect(engine).toMatchObject({
      result: { kind: "correction", targetStageId: "implementation", reason: "Update the empty state", requiredFixes: ["Update the empty state"], evidence: [] },
    });
  });

  test("returns review changes past an intermediate CI stage to the configured stage", async () => {
    const base = pipeline();
    const [implementation, review] = base.stages;
    const withCi: PipelineDefinition = {
      ...base,
      stages: [
        implementation!,
        {
          id: "ci", run: { type: "source-action", action: "pullRequest.awaitChecks" }, concurrency: 4,
          failurePolicies: { "changes-requested": { action: "returnToPrevious" } }, afterSuccess: [],
        },
        { ...review!, failurePolicies: { "changes-requested": { action: "returnToPrevious", stage: "implementation" } } },
      ],
    };
    const { engine } = await same(withCi, "review", {
      checks: [passed],
      producers: [envelope("failure", "changes-requested", "Rename the flag")],
    });
    expect(engine).toMatchObject({ result: { kind: "correction", targetStageId: "implementation" } });
  });

  test("a failure policy that cannot resolve a target stops instead", async () => {
    const { engine } = await same(pipeline({ failurePolicies: { "changes-requested": { action: "returnToPrevious" } } }), "implementation", {
      checks: [passed],
      producers: [envelope("failure", "changes-requested", "Nothing before me")],
    });
    // implementation is the first stage: there is nothing to return to.
    expect(engine).toMatchObject({ result: { kind: "stopped", state: "changes-requested", requiredFixes: [], feedbackCycles: 0 } });
  });

  test("a failed producer stops with failureState, carrying its envelope", async () => {
    const failure = envelope("failure", "blocked", "Cannot proceed");
    const { engine } = await same(pipeline({ failureState: "needs-intervention" }), "implementation", {
      checks: [passed],
      producers: [failure],
    });
    expect(engine).toMatchObject({ result: { kind: "stopped", state: "needs-intervention", reason: "Cannot proceed", result: failure } });
  });

  test("a failed producer without a reason reports its summary", async () => {
    await same(pipeline(), "implementation", { checks: [passed], producers: [envelope("failure", "blocked")] });
  });

  test("rejects an unconfigured producer status", async () => {
    const { engine } = await same(pipeline(), "implementation", {
      checks: [passed],
      producers: [envelope("success", "mystery")],
    });
    expect(engine).toMatchObject({ error: { name: "PipelineExecutionError" } });
    const { engine: failure } = await same(pipeline(), "implementation", {
      checks: [passed],
      producers: [envelope("failure", "done", "x")],
    });
    expect(failure).toMatchObject({ error: { name: "PipelineExecutionError" } });
  });

  test("honours stage-level status lists over the pipeline's", async () => {
    await same(pipeline({ successStatuses: ["shipped"] }), "implementation", {
      checks: [passed, passed],
      producers: [envelope("success", "shipped")],
    });
  });

  test("does not advance when a lifecycle action fails", async () => {
    const { engine, executed } = await same(pipeline(), "implementation", { actionError: new Error("GitHub unavailable") });
    expect("error" in engine && engine.error).toBeInstanceOf(PipelineExecutionError);
    expect("error" in executed && executed.error.message).toBe(
      'afterSuccess action "pullRequest.ensure" failed for stage "implementation": GitHub unavailable',
    );
  });

  test("the last stage advances to no next stage", async () => {
    const { engine } = await same(pipeline(), "review", { checks: [passed, passed] });
    expect(engine).toMatchObject({ result: { kind: "advance", nextStageId: null } });
  });
});

describe("external waits", () => {
  test("a producer that is waiting on CI parks without posting (the runtime narrates it), then completes when polled again, then completes when polled again", async () => {
    const h = await chain();
    h.journal.bumpStageEpoch("issue-1");
    const wait = new ExternalWaitError("Waiting for CI at abc1234: lint.", 30_000, "CI started for abc1234");
    const fake = fakeDependencies({
      checks: [],
      producers: [wait, new ExternalWaitError("Waiting for CI at abc1234: lint.", 30_000, null), envelope("success", "done")],
    });
    const definition = pipeline({ enterCheck: undefined, exitCheck: undefined, afterSuccess: [], run: { type: "source-action", action: "pullRequest.awaitChecks" } });
    const deps: LegacyRuntime = { ...fake.value, input: INPUT };
    const execute = () =>
      h.executor.execute({ issueId: "issue-1", pipeline: compiled(definition, 2), stageId: "implementation", baseContext: baseContext(), deps });

    const first = await execute();
    expect(first).toMatchObject({ kind: "parked", reason: "pending", wakeAt: "2026-01-01T00:00:30.000Z" });
    expect(h.notes).toEqual([]);
    expect(h.statuses).toContain("Waiting for CI at abc1234: lint.");

    h.advance(30_000);
    expect(await execute()).toMatchObject({ kind: "parked", reason: "pending" });
    h.advance(30_000);
    const done = await execute();
    expect(done).toMatchObject({ kind: "advance", nextStageId: "review", feedbackCycles: 0, result: envelope("success", "done") });
    expect(h.notes).toEqual([]);
    expect(fake.calls).toEqual(["producer:implementation:1", "producer:implementation:1", "producer:implementation:1"]);
  });

  test("a legacy wait has no deadline", async () => {
    const plan = compiled(pipeline(), 2);
    for (const stage of plan.stages) {
      for (const task of [...stage.actions, ...stage.exitGate]) expect(task.wait.timeoutMs).toBeNull();
    }
    expect(plan.stages[0]?.retries).toBe(2);
    expect(plan.stages[0]?.legacy).toBe(true);
  });
});
