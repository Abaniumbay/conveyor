import { afterEach, expect, test } from "bun:test";

import { deliveryWorld, REQUIRED_DESCRIPTION, type DeliveryWorld } from "../support/delivery-world";
import { dashboardViews } from "../support/dashboard";

let world: DeliveryWorld | null = null;
afterEach(async () => { await world?.close(); world = null; });

test("a fresh item runs the whole reference delivery pipeline and ends done", async () => {
  world = await deliveryWorld();
  const w = world;
  await w.drive();

  expect([...new Set(w.executed)]).toEqual(["refinement", "refinement-review", "work-breakdown", "implementation", "review", "merge", "deploy", "verify", "cleanup"]);
  expect(w.agentRuns).toEqual(["refinement", "refinement-review", "work-breakdown", "implementation", "review"]);
  expect(w.scriptRuns).toEqual(["deploy", "verify"]);
  expect(w.store.getStageState("issue")?.status).toBe("done");
  expect(w.store.getActiveWorkspace("issue")).toBeNull();

  const { checkpoints } = w.store.executions().getContext("issue")!.context;
  expect(w.host.headSha).toMatch(/^[0-9a-f]{40}$/);
  expect(checkpoints.ciPassed?.sha).toBe(w.host.headSha);
  expect(checkpoints.reviewPassed?.sha).toBe(w.host.headSha);
  expect(w.host.merges).toHaveLength(1);
  expect(w.host.merges[0]!.expectedHeadSha).toBe(w.host.headSha);
  expect(w.store.criterionTestEvidence("issue")).toMatchObject([{
    criterionId: "works", recordedHead: null, sourceLinkHead: w.host.headSha,
    tests: [{ name: "feature", file: "feature.txt", line: 1 }],
  }]);
});

test("an implementation agent explains a criterion-required result through the managed PR description", async () => {
  world = await deliveryWorld({ requireDescription: true });
  const w = world;
  await w.drive();

  expect(w.agentRuns).toEqual(["refinement", "refinement-review", "work-breakdown", "implementation", "review", "implementation", "review"]);
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

test("an item whose issue closed after the merge finishes without ever stopping", async () => {
  world = await deliveryWorld();
  const w = world;
  await w.drive();
  expect(w.store.getStageState("issue")?.status).toBe("done");
  expect(w.store.listStageTransitions("issue").filter((transition) => transition.kind === "stopped")).toEqual([]);
  expect(w.labelWrites.flat().some((label) => label === "conveyor:needs-intervention")).toBe(false);
});

test("an issue GitHub left open waits through the grace period, then stops the item with an exact reason", async () => {
  world = await deliveryWorld({ githubClosesIssue: false });
  const w = world;
  await expect(w.drive(25)).rejects.toThrow("did not finish");
  // Within the grace period after the merge the cleanup gate is pending and the item needs nothing from the owner.
  expect(w.store.getStageState("issue")).toMatchObject({ stageId: "cleanup" });
  expect(w.store.listStageTransitions("issue").filter((transition) => transition.kind === "stopped")).toEqual([]);
  expect(w.labelWrites.flat()).not.toContain("conveyor:needs-intervention");

  w.store.sqlite().query("UPDATE pull_requests SET merged_at = ?").run("2026-01-01T00:00:00.000Z");
  await expect(w.drive(25)).rejects.toThrow("did not finish");
  const stopped = w.store.listStageTransitions("issue").filter((transition) => transition.kind === "stopped");
  expect(stopped.find((transition) => transition.reason?.includes("GitHub did not close"))?.reason).toBe("Change #5 merged, but GitHub did not close issue #1. Conveyor never closes the issue itself: close the issue as completed, or reopen the work.");
  expect(w.labelWrites.some((labels) => labels.includes("conveyor:needs-intervention"))).toBe(true);
});

test("an issue closed after the owner was asked resumes cleanup, finishes the item and clears the reason", async () => {
  world = await deliveryWorld({ githubClosesIssue: false });
  const w = world;
  await expect(w.drive(25)).rejects.toThrow("did not finish");
  w.store.sqlite().query("UPDATE pull_requests SET merged_at = ?").run("2026-01-01T00:00:00.000Z");
  await expect(w.drive(1)).rejects.toThrow("did not finish");
  const stoppedBefore = w.store.listStageTransitions("issue").filter((transition) => transition.kind === "stopped").length;
  expect(stoppedBefore).toBeGreaterThan(0);
  // The reconciler projects the stop from the written needs-intervention label; the driver only does so for done/ready.
  expect(w.labelWrites.some((labels) => labels.includes("conveyor:needs-intervention"))).toBe(true);
  const stopped = w.store.getIssue("issue")!;
  w.store.upsertIssue({ ...stopped, labels: ["conveyor", "conveyor:cleanup", "conveyor:needs-intervention"], sourceUpdatedAt: new Date().toISOString() });
  w.store.setIssueProjection("issue", { stage: "cleanup", state: "needs-intervention", warning: null });
  expect(dashboardViews(w.service).dashboard("csrf").needsYou.some((card) => card.number === 1)).toBe(true);

  await w.closeIssueOnGitHub();
  await w.drive(25);

  expect(w.store.getStageState("issue")?.status).toBe("done");
  // The cleanup stage wrote the done label and no stop label with it.
  expect(w.labelWrites.at(-1)).toContain("conveyor:done");
  expect(w.labelWrites.at(-1)).not.toContain("conveyor:needs-intervention");
  expect(dashboardViews(w.service).dashboard("csrf").needsYou.some((card) => card.number === 1)).toBe(false);
  expect(w.store.listStageTransitions("issue").filter((transition) => transition.kind === "stopped")).toHaveLength(stoppedBefore);
});

test("a required-CI failure returns to implementation once and the item passes the gate on the new head", async () => {
  world = await deliveryWorld({ ciFailsFirstHead: "not ok 1 - feature fails" });
  const w = world;
  await w.drive();

  expect(w.agentRuns.filter((stage) => stage === "implementation")).toEqual(["implementation", "implementation"]);
  expect(w.store.getStageState("issue")?.status).toBe("done");
  expect(w.store.listStageTransitions("issue").filter((transition) => transition.kind === "stopped")).toEqual([]);
  expect(w.labelWrites.flat()).not.toContain("conveyor:needs-intervention");
  expect(w.store.executions().getContext("issue")!.context.checkpoints.ciPassed?.sha).toBe(w.host.headSha);
  expect([...new Set(w.executed)]).toContain("review");
});
