import { afterEach, describe, expect, test } from "bun:test";

import { Admission } from "../../src/app/admission";
import { RepositoryPausedError } from "../../src/core/repository-pause";
import { log, type LogRecord } from "../../src/log/logger";
import { itemWorld, type ItemWorld } from "../support/item-world";

let opened: ItemWorld | null = null;
afterEach(async () => { await opened?.close(); opened = null; });

async function setup(options: { running?: Map<string, string> } = {}) {
  const world = await itemWorld();
  opened = world;
  const records: LogRecord[] = [];
  log.configure({ sinks: [{ write: (record) => { records.push(record); } }] });
  const calls = { scheduled: 0, settled: 0, interrupted: 0, reconciled: [] as number[], recovered: [] as string[] };
  const running = options.running ?? new Map<string, string>();
  const admission = new Admission({
    config: { labels: world.config.labels, labelPrefix: world.config.settings.labelPrefix, repositories: world.config.repositories },
    store: world.store,
    source: world.items.client,
    fencedSource: () => world.items.client,
    running: () => running.entries(),
    isRunning: (issueId) => running.has(issueId),
    schedule: () => { calls.scheduled += 1; },
    eventsSettled: async () => { calls.settled += 1; },
    reconcile: async (_repositoryId, sourceNumber) => {
      calls.reconciled.push(sourceNumber);
      await world.refresh(sourceNumber);
    },
    interruptIneligibleRuns: () => { calls.interrupted += 1; },
    recoverClosedItem: async (_repositoryId, issue) => { calls.recovered.push(issue.id); },
    itemFields: (issueId) => ({ item: issueId }),
  });
  return { world, admission, calls, records };
}

describe("drain", () => {
  test("pauses admission once, keeps the first reason and logs the stages that keep running", async () => {
    const { world, admission, records } = await setup({ running: new Map([["issue-1", "implementation"]]) });
    expect(admission.draining()).toBeNull();
    const drained = admission.drain("upgrade", { targetVersion: "1.2.3", releaseTag: "v1.2.3" });
    expect(admission.drain("second reason")).toEqual(drained);
    expect(drained.reason).toBe("upgrade");
    expect(admission.draining()).toEqual(drained);
    expect(admission.current).toEqual({ ...drained, upgrade: { targetVersion: "1.2.3", releaseTag: "v1.2.3" } });
    expect(world.store.events().read({ type: "admission.paused" })).toHaveLength(1);
    expect(records.map((record) => record.message)).toEqual(["Admission paused: draining", "Stage waiting during drain"]);
  });

  test("resuming admits work again and schedules; it is false without a drain", async () => {
    const { world, admission, calls } = await setup();
    expect(admission.resumeAdmission()).toBe(false);
    admission.drain("maintenance");
    expect(admission.resumeAdmission()).toBe(true);
    expect(admission.current).toBeNull();
    expect(calls.scheduled).toBe(1);
    expect(world.store.events().read({ type: "admission.resumed" })).toHaveLength(1);
  });
});

describe("repository pause", () => {
  test("pauses a configured repository with a trimmed reason, and rejects an unknown one", async () => {
    const { world, admission } = await setup();
    expect(() => admission.pauseRepository("missing", "", "maintainer")).toThrow("repository not found");
    const { pausedAt } = admission.pauseRepository("repo", "  release freeze ", "maintainer");
    expect(world.store.repositoryPause("repo")).toMatchObject({ pausedAt, reason: "release freeze" });
  });

  test("resuming retries deferred cleanups and schedules", async () => {
    const { world, admission, calls } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation"], "closed");
    world.seed(1, { stage: "implementation", state: "closed" });
    admission.pauseRepository("repo", "", "maintainer");
    await Bun.sleep(5);
    await expect(admission.resumeRepository("missing")).rejects.toThrow("repository not found");
    await admission.resumeRepository("repo");
    expect(world.store.repositoryPause("repo")).toBeNull();
    expect(calls.recovered).toEqual(["issue-1"]);
    expect(calls.scheduled).toBe(1);
  });
});

describe("item pause", () => {
  test("pausing adds the paused label, reconciles, interrupts the run and tells the conversation", async () => {
    const { world, admission, calls } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation", "bug"]);
    const issueId = world.seed(1, { stage: "implementation", state: "active" });
    expect(await admission.pauseItem(issueId, "maintainer")).toEqual({ stageId: "implementation" });
    expect(world.items.relabels).toEqual([{ number: 1, labels: ["conveyor", "conveyor:implementation", "conveyor:paused"], preserve: ["conveyor:no-split"] }]);
    expect(world.store.getLatestSourceMutationByKeyPrefix("issue.labels.pause:")?.status).toBe("succeeded");
    expect(calls.reconciled).toEqual([1]);
    expect(calls.interrupted).toBe(1);
    expect(world.store.getIssue(issueId)?.projectedState).toBe("paused");
    expect(world.store.listConversationMessages(issueId).map((message) => message.message))
      .toEqual(["Paused by maintainer. Its stage, worktree and history are kept."]);
    await expect(admission.pauseItem(issueId, "maintainer")).rejects.toThrow("the item is already paused");
  });

  test("resuming removes the paused label, requeues the item and reports whether it started", async () => {
    const { world, admission, calls } = await setup({ running: new Map([["issue-2", "implementation"]]) });
    world.items.add(1, ["conveyor", "conveyor:implementation", "conveyor:paused"]);
    const queued = world.seed(1, { stage: "implementation", state: "paused" });
    world.items.add(2, ["conveyor", "conveyor:implementation", "conveyor:paused"]);
    const started = world.seed(2, { stage: "implementation", state: "paused" });
    expect(await admission.resumeItem(queued, "maintainer")).toEqual({ status: "queued", stageId: "implementation" });
    expect(await admission.resumeItem(started, "maintainer")).toEqual({ status: "started", stageId: "implementation" });
    expect(world.items.issues.get(1)?.labels).toEqual(["conveyor", "conveyor:implementation"]);
    expect(world.store.getIssue(queued)?.projectedState).toBe("active");
    expect(world.store.events().read({ type: "item.requeued" }).map((event) => event.payload)).toEqual([{ reason: "resume" }, { reason: "resume" }]);
    expect(calls.settled).toBe(2);
    expect(world.store.listConversationMessages(queued).map((message) => message.message)).toEqual(["Resumed by maintainer; its stage is queued."]);
    await expect(admission.resumeItem(queued, "maintainer")).rejects.toThrow("the item is not paused");
  });

  test("an item that is unknown, closed, has left or sits in a paused repository is refused", async () => {
    const { world, admission } = await setup();
    await expect(admission.pauseItem("missing", "maintainer")).rejects.toThrow("item not found");
    world.items.add(1, ["conveyor", "conveyor:implementation"], "closed");
    world.seed(1, { stage: "implementation", state: "active" });
    await expect(admission.pauseItem("issue-1", "maintainer")).rejects.toThrow("the item is closed");
    world.items.add(2, ["bug"]);
    world.seed(2, { stage: "implementation", state: "active" });
    await expect(admission.pauseItem("issue-2", "maintainer")).rejects.toThrow("the item has left Conveyor (it has no conveyor label)");
    world.store.pauseRepository("repo", "maintainer", null);
    await expect(admission.pauseItem("issue-2", "maintainer")).rejects.toThrow(RepositoryPausedError);
    expect(world.items.relabels).toEqual([]);
  });

  test("a failed label write is recorded as a failed source mutation", async () => {
    const { world, admission, calls } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    const issueId = world.seed(1, { stage: "implementation", state: "active" });
    world.items.failRelabel = new Error("GitHub is unavailable");
    await expect(admission.pauseItem(issueId, "maintainer")).rejects.toThrow("GitHub is unavailable");
    const mutation = world.store.getLatestSourceMutationByKeyPrefix("issue.labels.pause:");
    expect(mutation?.status).toBe("failed");
    expect(mutation?.error).toBe("GitHub is unavailable");
    expect(calls.reconciled).toEqual([]);
  });
});
