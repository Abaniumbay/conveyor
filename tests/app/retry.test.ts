import { afterEach, describe, expect, test } from "bun:test";

import { ItemRetries, type ScheduledRetryCheck } from "../../src/app/retry";
import { RepositoryPausedError } from "../../src/core/repository-pause";
import { itemWorld, type ItemWorld } from "../support/item-world";

let opened: ItemWorld | null = null;
afterEach(async () => { await opened?.close(); opened = null; });

async function setup(options: { live?: Set<string>; running?: Set<string>; createsChildren?: boolean; checks?: Map<string, ScheduledRetryCheck> } = {}) {
  const current = await itemWorld();
  opened = current;
  const calls = { reconciled: [] as number[], settled: 0 };
  const retries = new ItemRetries({
    config: { ...current.config, labelPrefix: current.config.settings.labelPrefix },
    store: current.store,
    source: current.items.client,
    fencedSource: () => current.items.client,
    hasLiveRun: (issueId) => options.live?.has(issueId) ?? false,
    isRunning: (issueId) => options.running?.has(issueId) ?? false,
    stageCreatesChildren: () => options.createsChildren ?? false,
    reconcile: async (_repositoryId, sourceNumber) => {
      calls.reconciled.push(sourceNumber);
      await current.refresh(sourceNumber);
    },
    eventsSettled: async () => { calls.settled += 1; },
    scheduledCheck: (runId) => options.checks?.get(runId),
  });
  return { world: current, retries, calls };
}

/** A blocked item in implementation, on the source and in the store. */
function blocked(current: ItemWorld, stage = "implementation"): string {
  current.items.add(1, ["conveyor", `conveyor:${stage}`, "conveyor:blocked", "bug"]);
  return current.seed(1, { stage, state: "blocked" });
}

/** Records the stop of a CI gate that sends a retry back to implementation with feedback. */
function stoppedByCi(current: ItemWorld, issueId: string): void {
  current.store.beginStageTransition({
    id: "stop-1", issueId, fromStage: "review", toStage: "review", kind: "stopped", sourceMutationId: null,
    detail: {
      reason: "CI failed", requiredFixes: [], resultStatus: "blocked", sourceSnapshot: { title: "Issue 1", body: "" },
      retryTargetStage: "implementation", retryFeedback: { from: { stage: "review", taskInstanceId: "ci" }, message: "Fix the failing test" },
    },
  });
  current.store.completeStageTransition("stop-1");
}

describe("item retries", () => {
  test("a stopped item can be retried; an active, running or parent item cannot", async () => {
    const { world, retries } = await setup({ live: new Set(["issue-2"]) });
    const issueId = blocked(world);
    world.items.add(2, ["conveyor", "conveyor:implementation", "conveyor:blocked"]);
    world.seed(2, { stage: "implementation", state: "blocked" });
    world.items.add(3, ["conveyor", "conveyor:implementation"]);
    world.seed(3, { stage: "implementation", state: "active" });
    world.items.add(4, ["conveyor", "conveyor:implementation", "conveyor:blocked"]);
    world.seed(4, { stage: "implementation", state: "blocked" });
    world.store.replaceRelationships("issue-3", { parentId: "issue-4", siblingOrder: 1 }, []);
    expect(retries.canRetry(issueId)).toBe(true);
    expect(retries.canRetry("issue-2")).toBe(false);
    expect(retries.canRetry("issue-3")).toBe(false);
    expect(retries.canRetry("issue-4")).toBe(false);
    expect(retries.canRetry("missing")).toBe(false);
  });

  test("a retry clears the stop label, reconciles the item, requeues it and records the note", async () => {
    const { world, retries, calls } = await setup();
    const issueId = blocked(world);
    const outcome = await retries.retry(issueId, "  Try again with the new token  ", "maintainer");
    expect(outcome).toEqual({ status: "queued", stageId: "implementation" });
    expect(world.items.relabels).toEqual([{ number: 1, labels: ["conveyor", "conveyor:implementation"], preserve: ["conveyor:no-split", "conveyor:paused"] }]);
    expect(world.items.issues.get(1)?.labels).toEqual(["bug", "conveyor", "conveyor:implementation"]);
    expect(calls.reconciled).toEqual([1]);
    expect(calls.settled).toBe(1);
    expect(world.store.getIssue(issueId)?.projectedState).toBe("active");
    expect(world.store.getIssue(issueId)?.queueRank).not.toBeNull();
    expect(world.store.getLatestSourceMutationByKeyPrefix(`web-retry:${issueId}:`)?.status).toBe("succeeded");
    expect(world.store.events().read({ type: "item.requeued" }).map((event) => event.payload)).toEqual([{ reason: "retry" }]);
    expect(world.store.listConversationMessages(issueId).map((message) => [message.actorId, message.message])).toEqual([
      ["maintainer", "Try again with the new token"],
      ["conveyor", "Queued implementation after retry. The existing worktree and run history are retained."],
    ]);
  });

  test("a retry reports a stage that started", async () => {
    const { world, retries } = await setup({ running: new Set(["issue-1"]) });
    blocked(world);
    expect(await retries.retry("issue-1", "", "maintainer")).toEqual({ status: "started", stageId: "implementation" });
  });

  test("a retry is refused when the item moved, the repository is paused, the note is too long or a retry runs", async () => {
    const { world, retries } = await setup();
    const issueId = blocked(world);
    await expect(retries.retry(issueId, "x".repeat(4_001), "maintainer")).rejects.toThrow("retry note must not exceed 4000 characters");
    world.items.issues.get(1)!.labels = ["conveyor", "conveyor:review", "conveyor:blocked"];
    await expect(retries.retry(issueId, "", "maintainer")).rejects.toThrow("issue state changed or is inconsistent; refresh before retrying");
    await expect(retries.retry("missing", "", "maintainer")).rejects.toThrow("issue not found");
    world.items.issues.get(1)!.labels = ["conveyor", "conveyor:implementation", "conveyor:blocked"];
    const first = retries.retry(issueId, "", "maintainer");
    await expect(retries.retry(issueId, "", "maintainer")).rejects.toThrow("retry already in progress");
    await first;
    world.store.pauseRepository("repo", "maintainer", null);
    await expect(retries.retry(issueId, "", "maintainer")).rejects.toThrow(RepositoryPausedError);
    expect(world.items.relabels).toHaveLength(1);
  });

  test("a running item is not retried", async () => {
    const { world, retries } = await setup({ live: new Set(["issue-1"]) });
    blocked(world);
    await expect(retries.retry("issue-1", "", "maintainer")).rejects.toThrow("issue is already running");
  });

  test("a failed label write is recorded as a failed source mutation", async () => {
    const { world, retries } = await setup();
    const issueId = blocked(world);
    world.items.failRelabel = new Error("GitHub is unavailable");
    await expect(retries.retry(issueId, "", "maintainer")).rejects.toThrow("GitHub is unavailable");
    const mutation = world.store.getLatestSourceMutationByKeyPrefix(`web-retry:${issueId}:`);
    expect(mutation?.status).toBe("failed");
    expect(mutation?.error).toBe("GitHub is unavailable");
    expect(world.store.getIssue(issueId)?.projectedState).toBe("blocked");
  });

  test("a stopped CI gate sends the retry to its target stage, and reconciliation restores the handoff", async () => {
    const { world, retries } = await setup();
    const issueId = blocked(world, "review");
    stoppedByCi(world, issueId);
    expect(retries.targetStage(issueId)).toBe("implementation");
    expect(await retries.retry(issueId, "", "maintainer")).toEqual({ status: "queued", stageId: "implementation" });
    expect(world.items.issues.get(1)?.labels).toEqual(["bug", "conveyor", "conveyor:implementation"]);
    const mutation = world.store.getLatestSourceMutationByKeyPrefix(`web-retry:${issueId}:`);
    expect(mutation?.status).not.toBe("succeeded");

    retries.restoreFeedback("repo");
    const cursor = world.store.executions().getCursor(issueId);
    expect(cursor?.stage).toBe("implementation");
    expect(cursor?.feedback).toEqual({ from: { stage: "review", taskInstanceId: "ci" }, message: "Fix the failing test" });
    expect(world.store.getLatestSourceMutationByKeyPrefix(`web-retry:${issueId}:`)?.status).toBe("succeeded");
  });

  test("an item stopped in its own stage has no other retry target", async () => {
    const { world, retries } = await setup();
    const issueId = blocked(world);
    expect(retries.targetStage(issueId)).toBeNull();
    expect(retries.targetStage("missing")).toBeNull();
  });

  test("a scheduled check retries only an inspected target, with evidence recorded after the stop", async () => {
    const check: ScheduledRetryCheck = { targets: new Set(["issue-1"]), inspected: new Set(), outcomes: new Map() };
    const { world, retries } = await setup({ checks: new Map([["run-1", check]]) });
    const issueId = blocked(world);
    stoppedByCi(world, issueId);
    world.store.setIssueProjection(issueId, { stage: "implementation", state: "blocked", warning: null });
    world.store.createRun({ id: "run-1", issueId: null, stageId: "operator", attempt: 1, kind: "steering", status: "completed", configHash: "config-hash", startedAt: new Date().toISOString() });
    await expect(retries.scheduledRetry("run-2", issueId, "", "anything")).rejects.toThrow("scheduled checks may retry only their stopped targets");
    await expect(retries.scheduledRetry("run-1", issueId, "", "anything")).rejects.toThrow("inspect the item's history before retrying it");
    check.inspected = new Set([issueId]);
    await expect(retries.scheduledRetry("run-1", issueId, "", "  ")).rejects.toThrow("scheduled retry evidence must not be blank");
    await expect(retries.scheduledRetry("run-1", issueId, "", "the token was rotated"))
      .rejects.toThrow("scheduled retry evidence must quote source content added after the recorded stop");

    await Bun.sleep(5);
    world.store.appendConversationMessage({
      issueId, runId: null, stageId: "implementation", actorType: "user", actorId: "maintainer", actorName: "maintainer", actorTitle: null,
      message: "Done: the token was rotated.",
    });
    expect(await retries.scheduledRetry("run-1", issueId, "Retrying after the rotation", "the token was rotated"))
      .toEqual({ status: "queued", stageId: "implementation" });
    expect(check.outcomes.get(issueId)).toEqual({ outcome: "retried", reason: "Scheduled retry queued.", evidence: "the token was rotated" });
    expect(world.store.listConversationMessages(issueId).map((message) => [message.actorId, message.message])).toContainEqual(
      ["scheduled-operator", "Scheduled retry started from evidence: the token was rotated"],
    );
  });
});
