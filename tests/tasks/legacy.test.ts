import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkConfig } from "../../src/cli";
import { loadConfig } from "../../src/config/load";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import { renderPlan } from "../../src/tasks/plan";
import { translateLegacyStage } from "../../src/tasks/legacy";
import type { PipelineStage } from "../../src/core/pipeline";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures");
const FIXTURE = path.join(FIXTURES, "legacy-pipeline");
const GOLDEN = path.join(FIXTURES, "legacy-plan.golden.txt");

const pipeline = { successStatuses: ["done"], failureStatuses: ["blocked", "changes-requested"], stages: [{ id: "a" }, { id: "b" }], feedbackCycles: 2 };

function stage(overrides: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: "b",
    run: { type: "agent", agent: "kaveh" },
    concurrency: 1,
    failurePolicies: {},
    afterSuccess: [],
    ...overrides,
  };
}

describe("translateLegacyStage", () => {
  test("compiles enter check, producer, exit check and afterSuccess actions into the action list", () => {
    const compiled = translateLegacyStage(
      stage({
        enterCheck: "generic", exitCheck: "exit", feedbackCycles: 1,
        afterSuccess: [{ sourceAction: "pullRequest.ensure" }, { sourceAction: "pullRequest.comment" }],
      }),
      pipeline,
    );
    expect(compiled).toMatchObject({ id: "b", legacy: true, retries: 1, childrenStartAt: null, concurrency: 1 });
    expect(compiled.actions.map((task) => [task.id, task.task, task.kind])).toEqual([
      ["legacy.enterCheck", "legacy.enterCheck", "act"],
      ["legacy.produce", "legacy.produce", "act"],
      ["legacy.exitCheck", "legacy.exitCheck", "act"],
      ["afterSuccess1", "legacy.afterSuccess", "act"],
      ["afterSuccess2", "legacy.afterSuccess", "act"],
    ]);
    expect(compiled.exitGate.map((task) => [task.task, task.kind, task.reads])).toEqual([["legacy.succeeded", "check", ["legacy"]]]);
    expect(compiled.actions.find((task) => task.task === "legacy.produce")?.writes).toEqual(["legacy"]);
  });

  test("omits absent checks, takes the default retry budget and carries childrenStartAt", () => {
    const compiled = translateLegacyStage(stage({ childrenStartAt: "next" }), pipeline);
    expect(compiled.actions.map((task) => task.task)).toEqual(["legacy.produce"]);
    expect(compiled.retries).toBe(2);
    expect(compiled.childrenStartAt).toBe("next");
  });

  test("names a single afterSuccess action plainly", () => {
    const compiled = translateLegacyStage(stage({ afterSuccess: [{ sourceAction: "pullRequest.ensure" }] }), pipeline);
    expect(compiled.actions.map((task) => task.id)).toEqual(["legacy.produce", "legacy.afterSuccess"]);
  });
});

describe("golden plan", () => {
  test("the legacy fixture renders to the recorded plan", async () => {
    const config = await loadConfig(FIXTURE, createTaskRegistry());
    expect(config.plans.map((plan) => plan.repositoryId)).toEqual([
      "caravan-v2", "conveyor-v2", "meal-planner", "midgame", "quesshi",
    ]);
    const rendered = `${config.plans.map(renderPlan).join("\n\n")}\n`;
    if (process.env.UPDATE_GOLDEN === "1") await writeFile(GOLDEN, rendered);
    expect(rendered).toBe(await readFile(GOLDEN, "utf8"));
  });

  test("check-config prints the plan of every legacy repository", async () => {
    const output = await checkConfig(FIXTURE);
    expect(output).toMatch(/^Configuration is valid \([0-9a-f]{64}\)\n/);
    for (const repository of ["caravan-v2", "conveyor-v2", "meal-planner", "midgame", "quesshi"]) {
      expect(output).toContain(`Repository ${repository} (pipeline `);
    }
    expect(output).toContain("legacy.produce (agent kaveh)");
  });
});

describe("legacy.produce captured envelope", () => {
  test("keeps the captured envelope small enough for the item context, whatever the script printed", async () => {
    const { createTaskRegistry } = await import("../../src/tasks/catalogue");
    const { runTask } = await import("../../src/tasks/contract");
    const produce = createTaskRegistry().require("legacy.produce");
    const stage = { id: "deploy", run: { type: "script", runner: "process", script: "/s.ts" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] };
    const envelope = (outcome: "success" | "failure") => ({
      stageResult: { outcome, status: outcome === "success" ? "done" : "blocked", summary: `S${"s".repeat(20_000)}`, reason: outcome === "success" ? null : `R${"r".repeat(20_000)}`, metrics: {} },
      sessionId: null, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, cost: { amount: 0, currency: "USD", source: "unavailable" },
      durationMs: 1, exitCode: 0, artifacts: [], stderr: `${"workflow log line\n".repeat(30_000)}FINAL ERROR LINE`,
    });
    for (const outcome of ["success", "failure"] as const) {
      const result = await runTask(produce, {
        context: { run: { stage: "deploy", stageEpoch: 1, attempt: 1, maxAttempts: 1, taskInstanceId: "legacy.produce", enteredAt: "", feedback: null } } as never,
        config: { stage, stageIds: ["deploy"], successStatuses: ["done"], failureStatuses: ["blocked"] },
        deps: { input: {}, runProducer: async () => envelope(outcome) } as never,
        instance: { id: "legacy.produce", stage: "deploy", idempotencyKey: "k", resumed: false },
      });
      const captured = (result.status === "pass" ? result.output : (result as { details: { legacy: unknown } }).details.legacy) as ReturnType<typeof envelope>;
      expect(JSON.stringify(captured).length).toBeLessThan(16_000);
      expect(captured.stageResult.outcome).toBe(outcome);
      expect(captured.stderr.endsWith("FINAL ERROR LINE")).toBe(true);
      expect(captured.stageResult.summary.startsWith("S")).toBe(true);
    }
  });
});
