import { afterEach, describe, expect, test } from "bun:test";

import { Rollups } from "../../src/app/rollups";
import { RepositoryPausedError } from "../../src/core/repository-pause";
import { log, type LogRecord } from "../../src/log/logger";
import { itemWorld, type ItemWorld } from "../support/item-world";

let opened: ItemWorld | null = null;
afterEach(async () => { await opened?.close(); opened = null; });

async function setup(options: { running?: Set<string> } = {}) {
  const world = await itemWorld();
  opened = world;
  const records: LogRecord[] = [];
  log.configure({ sinks: [{ write: (record) => { records.push(record); } }] });
  const calls = { reconciled: [] as number[], removed: 0 };
  const create = () => new Rollups({
    config: { ...world.config, labelPrefix: world.config.settings.labelPrefix },
    store: world.store,
    source: world.items.client,
    fencedSource: () => world.items.client,
    webhookHealthy: () => false,
    runningIssueIds: () => options.running ?? [],
    hasLiveRun: (issueId) => options.running?.has(issueId) ?? false,
    stageCreatesChildren: () => false,
    childCreationRetryQueued: () => false,
    hasResumableQuestionExecution: () => false,
    hasWaitingFollowUp: () => false,
    workspaces: () => ({ remove: async () => { calls.removed += 1; } }),
    reconcile: async (_repositoryId, sourceNumber) => {
      calls.reconciled.push(sourceNumber);
      await world.refresh(sourceNumber);
    },
    itemFields: (issueId) => ({ item: issueId }),
  });
  return { world, rollups: create(), create, calls, records };
}

/** Parent #1 with child #2, both in implementation, on the source and in the store. */
function family(world: ItemWorld, parentLabels = ["conveyor", "conveyor:implementation"], childState: "open" | "closed" = "open"): void {
  world.items.add(1, parentLabels);
  world.items.add(2, ["conveyor", "conveyor:implementation"], childState);
  world.items.children.set(1, [2]);
  const stage = parentLabels.includes("conveyor:review") ? "review" : "implementation";
  world.seed(1, { stage, state: parentLabels.includes("conveyor:blocked") ? "blocked" : "active" });
  world.seed(2, { stage: "implementation", state: childState === "closed" ? "closed" : "active" });
}

describe("relationships", () => {
  test("stores children and blockers, adds a placeholder for an unknown blocker and reuses an unchanged read", async () => {
    const { world, rollups, create } = await setup();
    family(world);
    world.items.add(4, [], "closed");
    world.items.blockers.set(2, [4]);

    await rollups.reconcile("repo", "owner/my-app");
    expect(world.store.listChildren("issue-1").map((child) => [child.issueId, child.siblingOrder])).toEqual([["issue-2", 1]]);
    expect(world.store.listDependencies("issue-2")).toEqual(["issue-4"]);
    expect(world.store.getIssue("issue-4")).toMatchObject({ sourceNumber: 4, title: "", sourceState: "closed" });
    expect(world.items.reads).toEqual({ subIssues: 2, dependencies: 2 });

    await rollups.reconcile("repo", "owner/my-app");
    expect(world.items.reads).toEqual({ subIssues: 2, dependencies: 2 });

    rollups.forget("repo", [2]);
    await rollups.reconcile("repo", "owner/my-app");
    expect(world.items.reads).toEqual({ subIssues: 3, dependencies: 3 });

    // After a restart, a pass scoped to other issues keeps what was stored without reading.
    await create().reconcile("repo", "owner/my-app", new Set([99]));
    expect(world.items.reads).toEqual({ subIssues: 3, dependencies: 3 });
    expect(world.store.listChildren("issue-1").map((child) => child.issueId)).toEqual(["issue-2"]);
    expect(world.store.listDependencies("issue-2")).toEqual(["issue-4"]);
  });

  test("a paused repository is not read", async () => {
    const { world, rollups } = await setup();
    family(world);
    world.store.pauseRepository("repo", "maintainer", null);
    await rollups.reconcile("repo", "owner/my-app");
    expect(world.items.reads).toEqual({ subIssues: 0, dependencies: 0 });
  });
});

describe("roll-up completion rule", () => {
  test("a leaf is complete when done or closed without a merge; a parent when all its children are", async () => {
    const { world, rollups } = await setup();
    family(world);
    await rollups.reconcile("repo", "owner/my-app");
    expect(rollups.satisfied("issue-2")).toBe(false);
    expect(rollups.satisfied("issue-1")).toBe(false);
    expect(rollups.satisfied("missing")).toBe(false);
    world.items.issues.get(2)!.labels = ["conveyor", "conveyor:done"];
    await world.refresh(2);
    expect(rollups.satisfied("issue-2")).toBe(true);
    expect(rollups.satisfied("issue-1")).toBe(true);
  });
});

describe("roll-up parents", () => {
  test("a parent follows its earliest unfinished child's stage", async () => {
    const { world, rollups, records } = await setup();
    family(world, ["conveyor", "conveyor:review"]);
    await rollups.reconcile("repo", "owner/my-app");
    expect(world.items.relabels.map((relabel) => [relabel.number, relabel.labels])).toEqual([[1, ["conveyor", "conveyor:implementation"]]]);
    expect(records.map((record) => record.message)).toContain("Roll-up stage transition completed");
    expect(world.items.closes).toEqual([]);
  });

  test("a parent whose children are complete is marked done and closed as completed", async () => {
    const { world, rollups, records } = await setup();
    family(world, ["conveyor", "conveyor:implementation"], "closed");
    await rollups.reconcile("repo", "owner/my-app");
    expect(world.items.relabels.map((relabel) => [relabel.number, relabel.labels])).toEqual([[1, ["conveyor", "conveyor:done", "conveyor:implementation"]]]);
    expect(world.items.closes).toEqual([1]);
    expect(world.store.getIssue("issue-1")).toMatchObject({ sourceState: "closed", projectedState: "done" });
    expect(world.store.getLatestSourceMutationByKeyPrefix("rollup-completion-close:issue-1:")?.status).toBe("succeeded");
    expect(records.map((record) => record.message)).toContain("Parent roll-up completed");
  });

  test("a close that failed but reached the source counts as completed", async () => {
    const { world, rollups } = await setup();
    family(world, ["conveyor", "conveyor:implementation"], "closed");
    world.items.failClose = new Error("Unprocessable entity");
    world.items.closeBeforeFailure = true;
    await rollups.reconcile("repo", "owner/my-app");
    expect(world.store.getIssue("issue-1")?.projectedState).toBe("done");
    expect(world.store.getLatestSourceMutationByKeyPrefix("rollup-completion-close:issue-1:")?.status).toBe("succeeded");
  });

  test("a failed close is the parent's alone and the next pass closes it", async () => {
    const { world, rollups, records } = await setup();
    family(world, ["conveyor", "conveyor:implementation"], "closed");
    world.items.failClose = new Error("GitHub is unavailable");
    await rollups.reconcile("repo", "owner/my-app");
    expect(world.store.getLatestSourceMutationByKeyPrefix("rollup-completion-close:issue-1:")?.status).toBe("failed");
    expect(world.store.getIssue("issue-1")?.projectedState).toBe("active");
    expect(records.map((record) => record.message)).toContain("Roll-up parent could not be closed; the next pass retries it");

    await rollups.reconcile("repo", "owner/my-app");
    expect(world.items.closes).toEqual([1, 1]);
    expect(world.store.getIssue("issue-1")?.projectedState).toBe("done");
  });

  test("a running or stopped parent is left alone", async () => {
    const running = await setup({ running: new Set(["issue-1"]) });
    family(running.world, ["conveyor", "conveyor:review"]);
    await running.rollups.reconcile("repo", "owner/my-app");
    expect(running.world.items.relabels).toEqual([]);
    await running.world.close();

    const stopped = await setup();
    family(stopped.world, ["conveyor", "conveyor:review", "conveyor:blocked"]);
    await stopped.rollups.reconcile("repo", "owner/my-app");
    expect(stopped.world.items.relabels).toEqual([]);
  });
});

describe("resuming a stopped parent", () => {
  test("clears the stop label so the parent waits for its children again", async () => {
    const { world, rollups, calls } = await setup();
    family(world, ["conveyor", "conveyor:implementation", "conveyor:blocked"]);
    world.store.replaceRelationships("issue-2", { parentId: "issue-1", siblingOrder: 1 }, []);
    expect(rollups.canResume("issue-1")).toBe(true);
    expect(rollups.canResume("issue-2")).toBe(false);
    expect(await rollups.resume("issue-1")).toEqual({ stageId: "implementation" });
    expect(world.items.relabels).toEqual([{ number: 1, labels: ["conveyor", "conveyor:implementation"], preserve: ["conveyor:no-split", "conveyor:paused"] }]);
    expect(world.store.getLatestSourceMutationByKeyPrefix("rollup-resume:issue-1:")?.status).toBe("succeeded");
    expect(calls.reconciled).toEqual([1]);
    expect(world.store.getIssue("issue-1")?.projectedState).toBe("active");
  });

  test("a resume whose label write failed is finished once the source shows it resumed", async () => {
    const { world, rollups, calls } = await setup();
    family(world, ["conveyor", "conveyor:implementation", "conveyor:blocked"]);
    world.store.replaceRelationships("issue-2", { parentId: "issue-1", siblingOrder: 1 }, []);
    world.items.failRelabel = new Error("GitHub is unavailable");
    await expect(rollups.resume("issue-1")).rejects.toThrow("GitHub is unavailable");
    expect(world.store.getLatestSourceMutationByKeyPrefix("rollup-resume:issue-1:")?.status).toBe("failed");

    world.items.issues.get(1)!.labels = ["conveyor", "conveyor:implementation"];
    expect(await rollups.resume("issue-1")).toEqual({ stageId: "implementation" });
    expect(world.store.getLatestSourceMutationByKeyPrefix("rollup-resume:issue-1:")?.status).toBe("succeeded");
    expect(calls.reconciled).toEqual([1]);
  });

  test("a parent that is not eligible, lost its children or sits in a paused repository is refused", async () => {
    const { world, rollups } = await setup();
    family(world, ["conveyor", "conveyor:implementation", "conveyor:blocked"]);
    await expect(rollups.resume("issue-1")).rejects.toThrow("roll-up parent is not eligible to resume waiting for children");
    await expect(rollups.resume("missing")).rejects.toThrow("issue not found");
    world.store.replaceRelationships("issue-2", { parentId: "issue-1", siblingOrder: 1 }, []);
    world.items.children.set(1, []);
    await expect(rollups.resume("issue-1")).rejects.toThrow("roll-up parent no longer has children; refresh before resuming waiting for children");
    world.items.issues.get(1)!.labels = ["conveyor", "conveyor:review", "conveyor:blocked"];
    await expect(rollups.resume("issue-1")).rejects.toThrow("roll-up parent state changed or is not eligible; refresh before resuming waiting for children");
    world.store.pauseRepository("repo", "maintainer", null);
    await expect(rollups.resume("issue-1")).rejects.toThrow(RepositoryPausedError);
    expect(world.items.relabels).toEqual([]);
  });

  test("a second resume of the same parent waits for the first", async () => {
    const { world, rollups } = await setup();
    family(world, ["conveyor", "conveyor:implementation", "conveyor:blocked"]);
    world.store.replaceRelationships("issue-2", { parentId: "issue-1", siblingOrder: 1 }, []);
    const first = rollups.resume("issue-1");
    await expect(rollups.resume("issue-1")).rejects.toThrow("resume waiting for children is already in progress");
    await first;
  });
});
