import { describe, expect, test } from "bun:test";

import {
  PipelineEngine,
  PipelineExecutionError,
  type CheckResult,
  type PipelineDependencies,
  type ProducerContext,
} from "../../src/core/pipeline";
import type { RunEnvelope } from "../../src/runner/result";

function envelope(
  outcome: "success" | "failure",
  status: string,
  reason: string | null = null,
): RunEnvelope {
  return {
    stageResult: {
      outcome,
      status,
      summary: `${status} summary`,
      reason,
      metrics: {},
    },
    sessionId: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    cost: { amount: 0, currency: "USD", source: "unavailable" },
    durationMs: 1,
    exitCode: 0,
    artifacts: [],
    stderr: "",
  };
}

const passed: CheckResult = {
  decision: "pass",
  status: "done",
  reason: null,
  evidence: [],
  requiredFixes: [],
  criteria: [],
};

function pipeline(overrides: Record<string, unknown> = {}) {
  return {
    successStatuses: ["done", "skipped"],
    failureStatuses: ["blocked", "rejected", "error", "changes-requested"],
    stages: [
      {
        id: "implementation",
        run: { type: "agent" as const, agent: "implementer" },
        concurrency: 2,
        enterCheck: "implementation-enter",
        exitCheck: "implementation-exit",
        feedbackCycles: 2,
        failurePolicies: {},
        afterSuccess: [
          { sourceAction: "pullRequest.ensure", with: { closingReference: true } },
        ],
        ...overrides,
      },
      {
        id: "review",
        run: { type: "agent" as const, agent: "reviewer" },
        concurrency: 2,
        enterCheck: "review-enter",
        exitCheck: "review-exit",
        feedbackCycles: 2,
        failurePolicies: {
          "changes-requested": { action: "returnToPrevious" as const },
        },
        afterSuccess: [],
      },
    ],
  };
}

function dependencies(input: {
  checks?: CheckResult[];
  producers?: RunEnvelope[];
  actionError?: Error;
}) {
  const calls: string[] = [];
  const producerContexts: ProducerContext[] = [];
  const checks = [...(input.checks ?? [passed, passed])];
  const producers = [...(input.producers ?? [envelope("success", "done")])];
  const value: PipelineDependencies = {
    async runCheck(checkId, phase) {
      calls.push(`check:${phase}:${checkId}`);
      const result = checks.shift();
      if (!result) throw new Error("missing fake check result");
      return result;
    },
    async runProducer(_stage, context) {
      calls.push(`producer:${context.stageId}:${context.attempt}`);
      producerContexts.push(context);
      const result = producers.shift();
      if (!result) throw new Error("missing fake producer result");
      return result;
    },
    async runAction(action) {
      calls.push(`action:${action.sourceAction}`);
      if (input.actionError) throw input.actionError;
    },
  };
  return { value, calls, producerContexts };
}

describe("PipelineEngine", () => {
  test("runs checks, producer, and lifecycle actions in order before advancing", async () => {
    const fake = dependencies({});
    const engine = new PipelineEngine(pipeline(), fake.value, 2);

    const result = await engine.executeStage("implementation", {
      issue: { id: "issue-1" },
      workspace: "/tmp/workspace",
    });

    expect(result).toMatchObject({ kind: "advance", nextStageId: "review" });
    expect(fake.calls).toEqual([
      "check:enter:implementation-enter",
      "producer:implementation:1",
      "check:exit:implementation-exit",
      "action:pullRequest.ensure",
    ]);
  });

  test("lets deterministic stages rely on their script or source-action result", async () => {
    const fake = dependencies({ checks: [] });
    const engine = new PipelineEngine(pipeline({
      enterCheck: undefined,
      exitCheck: undefined,
      afterSuccess: [],
    }), fake.value, 2);

    const result = await engine.executeStage("implementation", {
      issue: { id: "issue-1" },
      workspace: "/tmp/workspace",
    });

    expect(result).toMatchObject({ kind: "advance", nextStageId: "review" });
    expect(fake.calls).toEqual(["producer:implementation:1"]);
  });

  test("stops a failed entry check at the current stage by default", async () => {
    const failure: CheckResult = {
      decision: "fail",
      status: "needs-intervention",
      reason: "Verification infrastructure is unavailable",
      evidence: [],
      requiredFixes: ["Restore the verification environment"],
      criteria: [],
    };
    const fake = dependencies({ checks: [failure], producers: [] });
    const engine = new PipelineEngine(pipeline(), fake.value, 2);

    const result = await engine.executeStage("review", {
      issue: { id: "issue-1" },
      workspace: "/tmp/workspace",
    });

    expect(result).toMatchObject({
      kind: "stopped",
      stageId: "review",
      state: "needs-intervention",
      reason: "Verification infrastructure is unavailable",
      feedbackCycles: 0,
    });
    expect(fake.calls).toEqual(["check:enter:review-enter"]);
  });

  test("returns from a failed entry check only when its status explicitly requests it", async () => {
    const failure: CheckResult = {
      decision: "fail",
      status: "changes-requested",
      reason: "Implementation evidence is stale",
      evidence: ["Branch changed after implementation"],
      requiredFixes: ["Refresh the implementation"],
      criteria: [],
    };
    const fake = dependencies({ checks: [failure], producers: [] });
    const engine = new PipelineEngine(pipeline(), fake.value, 2);

    const result = await engine.executeStage("review", {
      issue: { id: "issue-1" },
      workspace: "/tmp/workspace",
    });

    expect(result).toMatchObject({
      kind: "correction",
      stageId: "review",
      targetStageId: "implementation",
      reason: "Implementation evidence is stale",
    });
    expect(fake.calls).toEqual(["check:enter:review-enter"]);
  });

  test("returns exit-check feedback to a fresh producer attempt", async () => {
    const failedCheck: CheckResult = {
      decision: "fail",
      status: "blocked",
      reason: "Missing empty state",
      evidence: ["review"],
      requiredFixes: ["Add empty state"],
      criteria: [],
    };
    const fake = dependencies({
      checks: [passed, failedCheck, passed],
      producers: [envelope("success", "done"), envelope("success", "done")],
    });
    const engine = new PipelineEngine(pipeline(), fake.value, 2);

    const result = await engine.executeStage("implementation", {
      issue: { id: "issue-1" },
      workspace: "/tmp/workspace",
    });

    expect(result).toMatchObject({ kind: "advance", feedbackCycles: 1 });
    expect(fake.producerContexts[1]?.feedback).toEqual({
      reason: "Missing empty state",
      requiredFixes: ["Add empty state"],
      evidence: ["review"],
    });
    expect(fake.producerContexts[1]?.attempt).toBe(2);
  });

  test("stops with the configured state after exhausting feedback cycles", async () => {
    const failure: CheckResult = {
      decision: "fail",
      status: "blocked",
      reason: "Still incomplete",
      evidence: [],
      requiredFixes: ["Finish it"],
      criteria: [],
    };
    const fake = dependencies({
      checks: [passed, failure, failure, failure],
      producers: [
        envelope("success", "done"),
        envelope("success", "done"),
        envelope("success", "done"),
      ],
    });
    const engine = new PipelineEngine(pipeline({ feedbackCycles: 2 }), fake.value, 2);

    const result = await engine.executeStage("implementation", {
      issue: { id: "issue-1" },
      workspace: "/tmp/workspace",
    });

    expect(result).toMatchObject({
      kind: "stopped",
      state: "blocked",
      reason: "Still incomplete",
      feedbackCycles: 2,
    });
  });

  test("routes review changes back to the previous producer", async () => {
    const fake = dependencies({
      checks: [passed],
      producers: [
        envelope("failure", "changes-requested", "Update the empty state"),
      ],
    });
    const engine = new PipelineEngine(pipeline(), fake.value, 2);

    const result = await engine.executeStage("review", {
      issue: { id: "issue-1" },
      workspace: "/tmp/workspace",
    });

    expect(result).toMatchObject({
      kind: "correction",
      targetStageId: "implementation",
      reason: "Update the empty state",
    });
  });

  test("does not advance when a lifecycle action fails", async () => {
    const fake = dependencies({ actionError: new Error("GitHub unavailable") });
    const engine = new PipelineEngine(pipeline(), fake.value, 2);

    await expect(
      engine.executeStage("implementation", {
        issue: { id: "issue-1" },
        workspace: "/tmp/workspace",
      }),
    ).rejects.toBeInstanceOf(PipelineExecutionError);
  });
});
