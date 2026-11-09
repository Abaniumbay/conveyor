import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { deliveryWorld, type DeliveryWorld } from "../support/delivery-world";

let world: DeliveryWorld | null = null;
afterEach(async () => { await world?.close(); world = null; });

const HANGING_DEPLOY = [
  'import { writeFile } from "node:fs/promises";',
  'await writeFile("script-ready", String(process.pid));',
  'await new Promise<never>(() => {});',
].join("\n");

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A deploy script that never finishes, started through the public service so a real process runs. */
async function runningDeploy(): Promise<{ w: DeliveryWorld; ready: string }> {
  world = await deliveryWorld({ interruptGrace: "50ms", publicLifecycle: true, deployScript: HANGING_DEPLOY });
  const w = world;
  w.store.setIssueProjection("issue", { stage: "deploy", state: "active", warning: null });
  w.editLabelsOnGitHub(() => ["conveyor", "conveyor:deploy"]);
  w.store.setStageState({ issueId: "issue", stageId: "deploy", status: "ready", feedbackCycle: 0, configHash: w.config.hash });
  const ready = path.join(w.root, "repos", "conveyor", "script-ready");
  await w.service.postIssueMessage("issue", "Start deploy", "operator");
  await until(() => existsSync(ready), "the deploy script to start");
  return { w, ready };
}

describe("the conveyor:paused label", () => {
  test("adding it on GitHub kills the running agent within one reconcile and records the item paused for that label", async () => {
    const { w } = await runningDeploy();
    expect(w.service.activeWork().items.map((entry) => entry.issueId)).toEqual(["issue"]);

    w.editLabelsOnGitHub((labels) => [...labels, "conveyor:paused"]);
    await w.service.syncRepository("conveyor");
    await until(() => w.store.getStageState("issue")?.status === "interrupted", "the stage to be interrupted");

    expect(w.service.activeWork().items).toEqual([]);
    expect(w.store.getIssue("issue")).toMatchObject({ projectedStage: "deploy", projectedState: "paused" });
    expect(w.store.listStageTransitions("issue")).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "paused", status: "completed", reason: "Paused: the conveyor:paused label is present.",
    })]));
  });

  test("item.pause adds it, kills the running agent and keeps the conveyor and stage labels", async () => {
    const { w } = await runningDeploy();

    await w.service.pauseIssue("issue", "operator");
    await until(() => w.store.getStageState("issue")?.status === "interrupted", "the stage to be interrupted");

    expect(w.sourceLabels().sort()).toEqual(["conveyor", "conveyor:deploy", "conveyor:paused"]);
    expect(w.service.activeWork().items).toEqual([]);
    expect(w.store.getIssue("issue")).toMatchObject({ projectedStage: "deploy", projectedState: "paused" });
  });

  test("removing it on GitHub resumes the same stage from the interrupted step", async () => {
    const { w, ready } = await runningDeploy();
    w.editLabelsOnGitHub((labels) => [...labels, "conveyor:paused"]);
    await w.service.syncRepository("conveyor");
    await until(() => w.store.getStageState("issue")?.status === "interrupted", "the stage to be interrupted");
    await rm(ready);

    w.editLabelsOnGitHub((labels) => labels.filter((label) => label !== "conveyor:paused"));
    await w.service.syncRepository("conveyor");
    await until(() => existsSync(ready), "the deploy script to start again");

    expect(w.store.getIssue("issue")).toMatchObject({ projectedStage: "deploy", projectedState: "active" });
    expect(w.store.getStageState("issue")).toMatchObject({ stageId: "deploy", status: "running" });
  });

  test("item.resume removes it and resumes the same stage", async () => {
    const { w, ready } = await runningDeploy();
    await w.service.pauseIssue("issue", "operator");
    await until(() => w.store.getStageState("issue")?.status === "interrupted", "the stage to be interrupted");
    await rm(ready);

    await w.service.resumeIssue("issue", "operator");
    await until(() => existsSync(ready), "the deploy script to start again");

    expect(w.sourceLabels().sort()).toEqual(["conveyor", "conveyor:deploy"]);
    expect(w.store.getIssue("issue")).toMatchObject({ projectedStage: "deploy", projectedState: "active" });
    expect(w.store.getStageState("issue")).toMatchObject({ stageId: "deploy", status: "running" });
  });

  test.each([
    ["refinement", "ready"],
    ["implementation", "ready"],
    ["review", "ready"],
    ["deploy", "ready"],
    ["refinement", "retry-ready"],
    ["implementation", "retry-ready"],
  ] as const)("starts no %s stage work (%s) for a paused item on a scheduler pass", async (stageId, status) => {
    world = await deliveryWorld({ publicLifecycle: true });
    const w = world;
    w.editLabelsOnGitHub(() => ["conveyor", `conveyor:${stageId}`, "conveyor:paused"]);
    await w.service.syncRepository("conveyor");
    w.store.setStageState({ issueId: "issue", stageId, status, feedbackCycle: 0, configHash: w.config.hash });

    await w.service.tick();
    await Bun.sleep(100);

    expect(w.store.getIssue("issue")).toMatchObject({ projectedStage: stageId, projectedState: "paused" });
    expect(w.store.getStageState("issue")).toMatchObject({ stageId, status });
    expect(w.store.listIssueRuns("issue")).toEqual([]);
    expect(w.agentRuns).toEqual([]);
    expect(w.scriptRuns).toEqual([]);
    expect(w.service.activeWork().items).toEqual([]);
  });
});
