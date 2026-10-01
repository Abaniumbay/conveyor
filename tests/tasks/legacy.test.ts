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
