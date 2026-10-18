import { afterEach, expect, test } from "bun:test";

import { deliveryWorld, REQUIRED_DESCRIPTION, type DeliveryWorld } from "../support/delivery-world";

let world: DeliveryWorld | null = null;
afterEach(async () => { await world?.close(); world = null; });

test("a fresh item runs the whole reference delivery pipeline and ends done", async () => {
  world = await deliveryWorld();
  const w = world;
  await w.drive();

  expect([...new Set(w.executed)]).toEqual(["refinement", "refinement-review", "work-breakdown", "implementation", "review", "merge", "deploy", "verify", "cleanup"]);
  expect(w.agentRuns).toEqual(["refinement", "refinement-review", "work-breakdown", "implementation", "implementation", "review"]);
  expect(w.scriptRuns).toEqual(["deploy", "verify"]);
  expect(w.store.getStageState("issue")?.status).toBe("done");
  expect(w.store.getActiveWorkspace("issue")).toBeNull();

  const { checkpoints } = w.store.executions().getContext("issue")!.context;
  expect(w.host.headSha).toMatch(/^[0-9a-f]{40}$/);
  expect(checkpoints.ciPassed?.sha).toBe(w.host.headSha);
  expect(checkpoints.reviewPassed?.sha).toBe(w.host.headSha);
  expect(w.host.merges).toHaveLength(1);
  expect(w.host.merges[0]!.expectedHeadSha).toBe(w.host.headSha);
});

test("an implementation agent explains a criterion-required result through the managed PR description", async () => {
  world = await deliveryWorld({ requireDescription: true });
  const w = world;
  await w.drive();

  expect(w.agentRuns).toEqual(["refinement", "refinement-review", "work-breakdown", "implementation", "implementation", "review", "implementation", "review"]);
  expect(w.store.getStageState("issue")?.status).toBe("done");
  expect((await w.host.getChange({ address: "owner/conveyor", id: "github:owner/conveyor#pr-5" })).body).toContain(REQUIRED_DESCRIPTION);
  expect(w.host.descriptionUpdates).toBe(1);
  expect(w.host.humanBodyEdits).toBe(0);
  expect(w.store.executions().getContext("issue")!.context.checkpoints.reviewPassed?.sha).toBe(w.host.headSha);
});

test("a repository pause defers a completed in-flight transition and resumes it once", async () => {
  world = await deliveryWorld();
  const w = world;
  const originalHash = w.store.getStageState("issue")!.configHash;

  w.store.pauseRepository("conveyor", "operator", "Conserve CI time");
  await expect(w.drive(1)).rejects.toThrow("item did not finish");

  const transition = w.store.listStageTransitions("issue")[0]!;
  expect(w.store.getStageState("issue")).toMatchObject({
    stageId: "refinement",
    status: "ready",
    configHash: originalHash,
  });
  expect(transition).toMatchObject({ fromStage: "refinement", status: "pending" });
  expect(w.store.getSourceMutation(transition.sourceMutationId!)).toMatchObject({ status: "pending" });
  expect(w.store.getIssue("issue")?.warning).toContain("Repository is paused");
  expect(w.agentRuns).toEqual(["refinement"]);
  expect(w.labelWrites).toEqual([]);

  w.store.resumeRepository("conveyor");
  await w.drive();

  expect(w.agentRuns.filter((stage) => stage === "refinement")).toEqual(["refinement"]);
  expect(w.labelWrites.filter((labels) => labels.includes("conveyor:refinement-review"))).toHaveLength(1);
  expect(w.store.listStageTransitions("issue")).toContainEqual(expect.objectContaining({ id: transition.id, status: "completed" }));
});

test("a repository pause fences the recorded code-host action until resume", async () => {
  world = await deliveryWorld({ pauseBeforeChangeEnsure: true });
  const w = world;

  await expect(w.drive()).rejects.toThrow("item did not finish");

  expect(w.host.pushes).toBe(0);
  expect(w.host.ensures).toBe(0);
  expect(w.ci.starts).toBe(0);
  expect(w.store.repositoryPause("conveyor")).not.toBeNull();

  await w.service.resumeRepository("conveyor");
  await w.drive();

  expect(w.host.pushes).toBeGreaterThan(0);
  expect(w.host.ensures).toBeGreaterThan(0);
  expect(w.store.getStageState("issue")?.status).toBe("done");
});

test("a repository pause after opening a change fences CI dispatch until resume", async () => {
  world = await deliveryWorld({ pauseBeforeCiStart: true });
  const w = world;

  await expect(w.drive()).rejects.toThrow("item did not finish");

  expect(w.host.ensures).toBe(1);
  expect(w.host.checklistUpdates).toBe(1);
  expect(w.ci.starts).toBe(0);

  await w.service.resumeRepository("conveyor");
  await w.drive();

  expect(w.ci.starts).toBeGreaterThan(0);
  expect(w.store.getStageState("issue")?.status).toBe("done");
});
