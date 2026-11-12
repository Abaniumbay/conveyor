import { afterEach, describe, expect, test } from "bun:test";

import { Scheduler, type RunningStage } from "../../src/app/scheduler";
import type { SchedulerCandidate } from "../../src/core/scheduler";
import { itemWorld, type ItemWorld } from "../support/item-world";

let opened: { world: ItemWorld; scheduler: Scheduler } | null = null;
afterEach(async () => {
  opened?.scheduler.close();
  await opened?.world.close();
  opened = null;
});

async function setup(options: { runners?: number } = {}) {
  const world = await itemWorld();
  if (options.runners !== undefined) world.config.settings.runners = options.runners;
  const running = new Map<string, RunningStage>();
  const state = { draining: false, shuttingDown: false, unready: new Set<string>() };
  const calls = { launched: [] as string[], refreshed: [] as string[][], passes: 0, timers: 0 };
  const scheduler: Scheduler = new Scheduler({
    config: world.config,
    store: world.store,
    running: () => running,
    shuttingDown: () => state.shuttingDown,
    draining: () => state.draining,
    repositoryReady: (repositoryId) => !state.unready.has(repositoryId),
    isLightweightStage: () => false,
    isSkippedStage: () => false,
    isGateOnlyExecution: () => false,
    hasResumableQuestionExecution: () => false,
    childCreationRetryQueued: () => false,
    schedulePass: () => { calls.passes += 1; scheduler.schedule(); },
    launch: (issue, candidate: SchedulerCandidate) => {
      calls.launched.push(issue.id);
      running.set(issue.id, { repositoryId: issue.repositoryId, stageId: candidate.stageId, lightweight: false, gateOnly: false });
    },
    refreshStatusComments: (issueIds) => { calls.refreshed.push([...issueIds]); },
    timerFired: () => { calls.timers += 1; },
  });
  opened = { world, scheduler };
  /** An enrolled item queued and ready at the implementation stage. */
  const ready = (number: number) => {
    world.items.add(number, ["conveyor", "conveyor:implementation"]);
    const id = world.seed(number, { stage: "implementation", state: "active" });
    world.store.setQueueRank(id, world.store.nextQueueRank());
    world.store.setStageState({ issueId: id, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: world.config.hash });
    return id;
  };
  /** Parks the item's current execution, due at `wakeAt` (null: only an event wakes it), on an exit gate. */
  const park = (issueId: string, wakeAt: string | null) => {
    const journal = world.store.executions();
    const epoch = journal.stageEpoch(issueId);
    journal.saveCursor({
      issueId, stage: "implementation", stageEpoch: epoch, attempt: 1, returns: 0, list: "exit-gate",
      taskInstanceId: "review", state: "pending", feedback: null, pendingSince: new Date().toISOString(), wakeAt, deadlineAt: null,
    }, epoch);
  };
  return { world, scheduler, running, state, calls, ready, park };
}

describe("a scheduling pass", () => {
  test("starts ready items in queue order up to the limits and refreshes the rest's status", async () => {
    const { world, scheduler, calls, ready } = await setup();
    const first = ready(1);
    const second = ready(2);
    scheduler.schedule();
    expect(calls.launched).toEqual([first]);
    expect(calls.refreshed).toEqual([[first, second]]);
    expect(world.store.events().read({ type: "scheduler.decided" }).map((event) => event.payload)).toEqual([{ started: 1, waiting: 1, running: 0 }]);
  });

  test("records a decision only when it changed", async () => {
    const { world, scheduler, ready } = await setup();
    ready(1);
    ready(2);
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(world.store.events().read({ type: "scheduler.decided" }).map((event) => event.payload)).toEqual([
      { started: 1, waiting: 1, running: 0 },
      { started: 0, waiting: 1, running: 1 },
    ]);
  });

  test("starts nothing while draining or shutting down", async () => {
    const { scheduler, state, calls, ready } = await setup();
    ready(1);
    state.draining = true;
    scheduler.schedule();
    state.draining = false;
    state.shuttingDown = true;
    scheduler.schedule();
    expect(calls.launched).toEqual([]);
    expect(calls.refreshed).toEqual([]);
  });

  test("starts nothing in a paused repository or one that is not ready", async () => {
    const { world, scheduler, state, calls, ready } = await setup();
    ready(1);
    state.unready.add("repo");
    scheduler.schedule();
    state.unready.clear();
    world.store.pauseRepository("repo", "maintainer", null);
    scheduler.schedule();
    expect(calls.launched).toEqual([]);
  });

  test("a retry-ready item becomes ready as it starts", async () => {
    const { world, scheduler, calls, ready } = await setup();
    const id = ready(1);
    world.store.setStageState({ issueId: id, stageId: "implementation", status: "retry-ready", feedbackCycle: 0, configHash: world.config.hash });
    scheduler.schedule();
    expect(calls.launched).toEqual([id]);
    expect(world.store.getStageState(id)?.status).toBe("ready");
  });
});

describe("wake-ups", () => {
  test("a parked item waits for its wake-up time", async () => {
    const { scheduler, calls, ready, park } = await setup();
    const id = ready(1);
    park(id, new Date(Date.now() + 60_000).toISOString());
    scheduler.schedule();
    expect(calls.launched).toEqual([]);
    park(id, new Date(Date.now() - 1_000).toISOString());
    scheduler.schedule();
    expect(calls.launched).toEqual([id]);
  });

  test("a gate parked without a wake-up time starts only once an event wakes it, and the run says why", async () => {
    const { scheduler, calls, ready, park } = await setup();
    const id = ready(1);
    park(id, null);
    expect(scheduler.candidates().find((candidate) => candidate.id === id)?.eligible).toBe(false);
    expect(scheduler.wakeParked(id)).toBe(true);
    scheduler.schedule();
    expect(calls.launched).toEqual([id]);
    expect(scheduler.callSource(id)).toBe("wait");
    expect(scheduler.callSource(id)).toBe("fallback");
  });

  test("a parked item of a paused repository is not woken", async () => {
    const { world, scheduler, ready, park } = await setup();
    const id = ready(1);
    park(id, null);
    world.store.pauseRepository("repo", "maintainer", null);
    expect(scheduler.wakeParked(id)).toBe(false);
  });

  test("a run with no parked step is stage work", async () => {
    const { scheduler, ready } = await setup();
    expect(scheduler.callSource(ready(1))).toBe("stage");
  });

  test("the wake timer runs a pass at the earliest future wake-up", async () => {
    const { scheduler, calls, ready, park } = await setup();
    const id = ready(1);
    park(id, new Date(Date.now() + 30).toISOString());
    scheduler.schedule();
    expect(calls.launched).toEqual([]);
    const deadline = Date.now() + 5_000;
    while (calls.launched.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(calls.timers).toBe(1);
    expect(calls.launched).toEqual([id]);
  });

  test("closing stops the wake timer", async () => {
    const { scheduler, calls, ready, park } = await setup();
    park(ready(1), new Date(Date.now() + 30).toISOString());
    scheduler.schedule();
    scheduler.close();
    await Bun.sleep(150);
    expect(calls.timers).toBe(0);
  });

  test("requests within one burst run one pass", async () => {
    const { scheduler, calls } = await setup();
    scheduler.requestSchedule();
    scheduler.requestSchedule();
    scheduler.requestSchedule();
    await Promise.resolve();
    expect(calls.passes).toBe(1);
    scheduler.flushSchedule();
    expect(calls.passes).toBe(1);
  });
});

describe("live status", () => {
  test("a queued item names the busy slots and their holders", async () => {
    const { world, scheduler, running, ready } = await setup();
    const holder = ready(2);
    running.set(holder, { repositoryId: "repo", stageId: "implementation", lightweight: false, gateOnly: false });
    const id = ready(1);
    expect(scheduler.liveIssueStatus(id)).toEqual({
      kind: "queued",
      reason: "global runner slots 1/1 busy: #2; implementation slots 1/1 busy: #2; repo slots 1/1 busy: #2",
      since: world.store.getStageState(id)!.updatedAt,
      nextCheckAt: null,
      deadline: null,
    });
    expect(scheduler.itemNow(id)).toMatchObject({ stage: "implementation", state: "queued", reason: expect.stringContaining("busy: #2") });
  });

  test("an item waits for its unfinished dependencies", async () => {
    const { world, scheduler, ready } = await setup();
    const blocker = ready(2);
    const id = ready(1);
    world.store.replaceRelationships(id, null, [blocker]);
    expect(scheduler.liveStatusReader()(world.store.getIssue(id)!)).toMatchObject({ kind: "waiting", reason: "Waiting for dependencies: #2" });
  });

  test("a parked item shows its pending message until its wake-up", async () => {
    const { scheduler, ready, park } = await setup();
    const id = ready(1);
    const wakeAt = new Date(Date.now() + 60_000).toISOString();
    park(id, wakeAt);
    expect(scheduler.liveIssueStatus(id)).toMatchObject({ kind: "waiting", nextCheckAt: wakeAt });
    expect(scheduler.liveIssueStatus("missing")).toBeNull();
    expect(scheduler.itemNow("missing")).toBeNull();
  });

  test("a stopped item shows its stop", async () => {
    const { world, scheduler } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation", "conveyor:blocked"]);
    const id = world.seed(1, { stage: "implementation", state: "blocked" });
    expect(scheduler.itemNow(id)).toMatchObject({ stage: "implementation", state: "stopped" });
  });
});
