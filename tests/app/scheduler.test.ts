import { afterEach, describe, expect, test } from "bun:test";

import { Scheduler, type RunningStage } from "../../src/app/scheduler";
import type { SchedulerCandidate } from "../../src/core/scheduler";
import { compileRepositories } from "../../src/tasks/plan";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import { itemWorld, type ItemWorld } from "../support/item-world";

let opened: { world: ItemWorld; scheduler: Scheduler } | null = null;
afterEach(async () => {
  opened?.scheduler.close();
  await opened?.world.close();
  opened = null;
});

async function setup(options: { runners?: number; extra?: (root: string) => Record<string, unknown> } = {}) {
  const world = await itemWorld(options.extra);
  if (options.runners !== undefined) {
    world.config.settings.runners = options.runners;
    for (const pipeline of Object.values(world.config.pipelines)) for (const stage of pipeline.stages) stage.concurrency = options.runners;
    for (const repository of Object.values(world.config.repositories)) repository.concurrency = options.runners;
  }
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

describe("an ancestor's unmet dependencies hold back its descendants", () => {
  /** A child queued under `parent` with no dependencies of its own; the parent is a roll-up, so it never starts itself. */
  async function family() {
    const context = await setup({ runners: 10 });
    context.world.items.add(10, ["conveyor", "conveyor:implementation"]);
    const blocker = context.world.seed(10, { stage: "implementation", state: "active" });
    const parent = context.ready(1);
    const leaf = context.ready(4);
    const child = context.ready(2);
    context.world.store.replaceRelationships(parent, null, [blocker]);
    context.world.store.replaceRelationships(leaf, { parentId: parent, siblingOrder: null }, []);
    context.world.store.replaceRelationships(child, { parentId: parent, siblingOrder: null }, []);
    const grandchild = context.ready(3);
    context.world.store.replaceRelationships(grandchild, { parentId: child, siblingOrder: null }, []);
    const close = (id: string) => context.world.store.upsertIssue({ ...context.world.store.getIssue(id)!, sourceState: "closed" });
    const candidate = (id: string) => context.scheduler.candidates().find((entry) => entry.id === id)!;
    return { ...context, blocker, parent, leaf, child, grandchild, close, candidate };
  }

  test("a child of a parent with an open dependency is not selected, and starts once it closes", async () => {
    const { scheduler, calls, blocker, leaf, close, candidate } = await family();
    expect(candidate(leaf).dependenciesSatisfied).toBe(false);
    scheduler.schedule();
    expect(calls.launched).toEqual([]);
    close(blocker);
    expect(candidate(leaf).dependenciesSatisfied).toBe(true);
    scheduler.schedule();
    expect(calls.launched).toContain(leaf);
  });

  test("a child is released when the parent's dependency is marked done", async () => {
    const { blocker, leaf, candidate, world } = await family();
    expect(candidate(leaf).dependenciesSatisfied).toBe(false);
    world.store.setIssueProjection(blocker, { stage: "implementation", state: "done", warning: null });
    expect(candidate(leaf).dependenciesSatisfied).toBe(true);
  });

  test("AC-4.2 a grandchild waits for a dependency of its parent and of its grandparent, each released on its own", async () => {
    const { world, scheduler, calls, ready, child, grandchild, blocker, close } = await family();
    const own = ready(20);
    world.store.replaceRelationships(child, { parentId: world.store.getIssue(child)!.parentId!, siblingOrder: null }, [own]);
    // The nearest waiting ancestor is named: the parent, not the grandparent.
    expect(scheduler.status(world.store.getIssue(grandchild)!)?.reason).toBe("Waiting: parent #2 is blocked by #20");
    scheduler.schedule();
    expect(calls.launched).not.toContain(grandchild);
    close(own);
    // The grandparent's dependency still holds it back.
    scheduler.schedule();
    expect(calls.launched).not.toContain(grandchild);
    expect(scheduler.status(world.store.getIssue(grandchild)!)?.reason).toBe("Waiting: ancestor #1 is blocked by #10");
    close(blocker);
    scheduler.schedule();
    expect(calls.launched).toContain(grandchild);
  });

  test("AC-4.1 a grandchild waits for a dependency of its grandparent and starts once it is met", async () => {
    const { grandchild, child, leaf, blocker, close, scheduler, calls, world } = await family();
    expect(world.store.listDependencies(child)).toEqual([]);
    scheduler.schedule();
    expect(calls.launched).not.toContain(grandchild);
    expect(calls.launched).not.toContain(leaf);
    close(blocker);
    scheduler.schedule();
    expect(calls.launched).toContain(grandchild);
  });

  test("a dependency added to the parent after the child exists applies at the next pass", async () => {
    const { world, scheduler, calls, parent, leaf, blocker, close, candidate } = await family();
    close(blocker);
    expect(candidate(leaf).dependenciesSatisfied).toBe(true);
    world.items.add(30, ["conveyor", "conveyor:implementation"]);
    const later = world.seed(30, { stage: "implementation", state: "active" });
    world.store.replaceRelationships(parent, null, [blocker, later]);
    scheduler.schedule();
    expect(calls.launched).not.toContain(leaf);
    expect(scheduler.status(world.store.getIssue(leaf)!)?.reason).toBe("Waiting: parent #1 is blocked by #30");
    close(later);
    scheduler.schedule();
    expect(calls.launched).toContain(leaf);
  });

  test("an item's own dependencies still hold it back and release it when met", async () => {
    const { world, scheduler, ready } = await setup();
    const blocker = ready(2);
    const id = ready(1);
    world.store.replaceRelationships(id, null, [blocker]);
    expect(scheduler.candidates().find((entry) => entry.id === id)!.dependenciesSatisfied).toBe(false);
    world.store.upsertIssue({ ...world.store.getIssue(blocker)!, sourceState: "closed" });
    expect(scheduler.candidates().find((entry) => entry.id === id)!.dependenciesSatisfied).toBe(true);
  });

  test("AC-6.1 the status line names the parent and lists every unmet blocker", async () => {
    const { world, scheduler, ready, parent, leaf, blocker } = await family();
    expect(scheduler.status(world.store.getIssue(leaf)!)).toMatchObject({ kind: "waiting", reason: "Waiting: parent #1 is blocked by #10" });
    const second = ready(30);
    world.store.replaceRelationships(parent, null, [blocker, second]);
    expect(scheduler.status(world.store.getIssue(leaf)!)?.reason).toBe("Waiting: parent #1 is blocked by #10, #30");
  });

  test("AC-6.2 a grandchild is held by the grandparent until a nearer ancestor has an unmet dependency", async () => {
    const { world, scheduler, ready, child, grandchild, parent, blocker } = await family();
    expect(scheduler.status(world.store.getIssue(grandchild)!)?.reason).toBe("Waiting: ancestor #1 is blocked by #10");
    world.store.replaceRelationships(child, { parentId: parent, siblingOrder: null }, [ready(20)]);
    expect(world.store.listDependencies(parent)).toEqual([blocker]);
    expect(scheduler.status(world.store.getIssue(grandchild)!)?.reason).toBe("Waiting: parent #2 is blocked by #20");
  });

  test("AC-3.4 a child's own dependency holds it independently of its parent", async () => {
    const { world, scheduler, calls, ready } = await setup({ runners: 10 });
    const parent = ready(1);
    const child = ready(2);
    const blocker = ready(3);
    world.store.replaceRelationships(child, { parentId: parent, siblingOrder: null }, [blocker]);
    scheduler.schedule();
    expect(calls.launched).not.toContain(child);
    world.store.upsertIssue({ ...world.store.getIssue(blocker)!, sourceState: "closed" });
    scheduler.schedule();
    expect(calls.launched).toContain(child);
  });

  test("AC-5.1 AC-5.3 a child blocked by its sibling starts after the sibling is done, behind an unmet parent dependency too", async () => {
    const { world, scheduler, calls, ready, parent, blocker, close } = await family();
    const first = ready(7);
    const second = ready(8);
    world.store.replaceRelationships(first, { parentId: parent, siblingOrder: 1 }, []);
    world.store.replaceRelationships(second, { parentId: parent, siblingOrder: 2 }, [first]);
    scheduler.schedule();
    expect(calls.launched).toEqual([]);
    close(blocker);
    scheduler.schedule();
    expect(calls.launched).toContain(first);
    expect(calls.launched).not.toContain(second);
    expect(scheduler.status(world.store.getIssue(second)!)?.reason).toBe("Waiting for dependencies: #7");
    world.store.setIssueProjection(first, { stage: "implementation", state: "done", warning: null });
    scheduler.schedule();
    expect(calls.launched).toContain(second);
  });

  test("AC-4.3 a parent-link cycle in stored data does not hang selection", async () => {
    const { world, scheduler, ready } = await setup();
    const a = ready(1);
    const b = ready(2);
    world.store.upsertIssue({ ...world.store.getIssue(a)!, parentId: b });
    world.store.upsertIssue({ ...world.store.getIssue(b)!, parentId: a });
    expect(() => scheduler.schedule()).not.toThrow();
  });

  test("a parent link recorded without a plan or tool applies the same way", async () => {
    // A sub-issue added on GitHub reaches the store as the issue's parent link and nothing else.
    const { world, ready, scheduler, parent } = await family();
    const added = ready(5);
    world.store.upsertIssue({ ...world.store.getIssue(added)!, parentId: parent });
    expect(scheduler.candidates().find((entry) => entry.id === added)!.dependenciesSatisfied).toBe(false);
  });

  test("admission leaves an item waiting, not stopped, when the parent's dependency is unmet", async () => {
    const { world, scheduler, calls, ready, parent } = await family();
    const racing = ready(6);
    // The parent link lands after the candidates are built: the recheck at admission still holds the item.
    const original = world.store.listChildren.bind(world.store);
    let linked = false;
    world.store.listChildren = (id: string) => {
      if (!linked && id === racing) {
        linked = true;
        world.store.upsertIssue({ ...world.store.getIssue(racing)!, parentId: parent });
      }
      return original(id);
    };
    scheduler.schedule();
    expect(calls.launched).not.toContain(racing);
    expect(world.store.getIssue(racing)!.projectedState).toBe("active");
    expect(world.store.getStageState(racing)?.status).toBe("ready");
  });
});

describe("dependencies released at a configured stage", () => {
  const native = (id: string, gate: Array<Record<string, unknown>> = [{ id: "criteria", task: "item.criteriaDefined" }]) => ({ id, actions: [], "exit-gate": gate, concurrency: 3 });
  const extra = (after?: string) => (root: string) => ({
    pipelines: {
      default: {
        stages: [
          native("implementation", [{ id: "dependencies", task: "item.dependenciesMet", ...(after ? { with: { after } } : {}) }]),
          native("review"), native("merge"), native("verify"),
        ],
      },
      other: { stages: [native("plan"), native("build"), native("ship")] },
    },
    repositories: {
      repo: { source: "github", address: "owner/my-app", folder: root, pipeline: "default", concurrency: 3 },
      elsewhere: { source: "github", address: "owner/other", folder: root, pipeline: "other" },
    },
  });
  const blockerAt = (world: Awaited<ReturnType<typeof setup>>["world"], number: number, stage: string | null, repositoryId = "repo") => {
    if (repositoryId !== "repo") world.store.upsertRepository({ id: repositoryId, configName: repositoryId, source: "github", address: "owner/other", folder: world.root, configHash: world.config.hash });
    world.store.upsertIssue({
      id: `issue-${number}`, repositoryId, sourceNumber: number, sourceUrl: `https://example.com/${number}`, title: `Issue ${number}`, body: "",
      sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-10-17T00:00:00Z",
    });
    world.store.setIssueProjection(`issue-${number}`, { stage, state: "active", warning: null });
    return `issue-${number}`;
  };
  const satisfied = (scheduler: Scheduler, id: string) => scheduler.candidates().find((candidate) => candidate.id === id)!.dependenciesSatisfied;

  test("AC-7.1 starts a dependent whose blocker is past the threshold", async () => {
    const { world, scheduler, calls, ready } = await setup({ extra: extra("merge") });
    const id = ready(1);
    world.store.replaceRelationships(id, null, [blockerAt(world, 2, "verify")]);
    expect(satisfied(scheduler, id)).toBe(true);
    scheduler.schedule();
    expect(calls.launched).toEqual([id]);
    expect(scheduler.liveStatusReader()(world.store.getIssue(id)!)?.reason ?? "").not.toContain("Waiting for dependencies");
  });

  test("AC-7.2 holds a dependent whose blocker is at or before the threshold and says so", async () => {
    const { world, scheduler, calls, ready } = await setup({ extra: extra("merge") });
    const id = ready(1);
    world.store.replaceRelationships(id, null, [blockerAt(world, 2, "merge")]);
    expect(satisfied(scheduler, id)).toBe(false);
    scheduler.schedule();
    expect(calls.launched).toEqual([]);
    expect(scheduler.liveStatusReader()(world.store.getIssue(id)!)).toMatchObject({ kind: "waiting", reason: "Waiting for dependencies: #2" });
    world.store.setIssueProjection("issue-2", { stage: "implementation", state: "active", warning: null });
    expect(satisfied(scheduler, id)).toBe(false);
  });

  test("AC-7.3 without after a blocker waits for closed or done whatever its stage", async () => {
    const { world, scheduler, ready } = await setup({ extra: extra() });
    const id = ready(1);
    const blocker = blockerAt(world, 2, "verify");
    world.store.replaceRelationships(id, null, [blocker]);
    expect(satisfied(scheduler, id)).toBe(false);
    world.store.setIssueProjection(blocker, { stage: "verify", state: "done", warning: null });
    expect(satisfied(scheduler, id)).toBe(true);
    world.store.setIssueProjection(blocker, { stage: "verify", state: "active", warning: null });
    world.store.upsertIssue({ ...world.store.getIssue(blocker)!, sourceState: "closed" });
    expect(satisfied(scheduler, id)).toBe(true);
  });

  test("AC-7.4 the admission recheck and an ancestor's dependency use the same threshold", async () => {
    const { world, scheduler, calls, ready } = await setup({ extra: extra("merge"), runners: 3 });
    const direct = ready(1);
    const child = ready(3);
    const parent = ready(4);
    const blocker = blockerAt(world, 2, "verify");
    world.store.replaceRelationships(direct, null, [blocker]);
    world.store.replaceRelationships(parent, null, [blocker]);
    world.store.replaceRelationships(child, { parentId: parent, siblingOrder: 1 }, []);
    scheduler.schedule();
    expect(calls.launched).toContain(direct);
    expect(calls.launched).toContain(child);
    expect(calls.launched).not.toContain(parent);
  });

  test("AC-7.4 neither starts while the blocker is still in implementation", async () => {
    const { world, scheduler, calls, ready } = await setup({ extra: extra("merge"), runners: 3 });
    const direct = ready(1);
    const child = ready(3);
    const parent = ready(4);
    const blocker = blockerAt(world, 2, "implementation");
    world.store.replaceRelationships(direct, null, [blocker]);
    world.store.replaceRelationships(parent, null, [blocker]);
    world.store.replaceRelationships(child, { parentId: parent, siblingOrder: 1 }, []);
    scheduler.schedule();
    expect(calls.launched).toEqual([]);
  });

  test("AC-7.5 a blocker of a pipeline without the stage counts only when closed or done", async () => {
    const { world, scheduler, ready } = await setup({ extra: extra("merge") });
    const id = ready(1);
    const blocker = blockerAt(world, 20, "ship", "elsewhere");
    world.store.replaceRelationships(id, null, [blocker]);
    expect(satisfied(scheduler, id)).toBe(false);
    world.store.setIssueProjection(blocker, { stage: "ship", state: "done", warning: null });
    expect(satisfied(scheduler, id)).toBe(true);
  });
});

describe("dependencies released at a configured stage, on a compiled plan", () => {
  const native = (id: string, gate: Array<Record<string, unknown>> = [{ id: "criteria", task: "item.criteriaDefined" }]) => ({ id, actions: [], "exit-gate": gate, concurrency: 3 });
  const extra = (override: boolean) => (root: string) => ({
    pipelines: {
      default: {
        stages: [
          native("implementation", [{ id: "dependencies", task: "item.dependenciesMet", ...(override ? {} : { with: { after: "merge" } }) }]),
          native("review"), native("merge"), native("verify"),
        ],
      },
    },
    repositories: {
      repo: {
        source: "github", address: "owner/my-app", folder: root, pipeline: "default", concurrency: 3,
        ...(override ? { overrides: { stages: { implementation: { "exit-gate": { dependencies: { with: { after: "merge" } } } } } } } : {}),
      },
    },
  });
  const compiled = async (override: boolean) => {
    const opened = await setup({ extra: extra(override) });
    opened.world.config.plans = compileRepositories(opened.world.config, createTaskRegistry());
    return opened;
  };
  const blocker = (world: ItemWorld, stage: string) => {
    world.store.upsertIssue({
      id: "issue-2", repositoryId: "repo", sourceNumber: 2, sourceUrl: "https://example.com/2", title: "Issue 2", body: "",
      sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-10-17T00:00:00Z",
    });
    world.store.setIssueProjection("issue-2", { stage, state: "active", warning: null });
    return "issue-2";
  };
  const satisfied = (scheduler: Scheduler, id: string) => scheduler.candidates().find((candidate) => candidate.id === id)!.dependenciesSatisfied;

  for (const override of [false, true]) {
    const where = override ? "set by a repository override" : "set in the pipeline";
    test(`AC-7.1 a compiled plan's after, ${where}, releases a dependent past the threshold`, async () => {
      const { world, scheduler, calls, ready } = await compiled(override);
      expect(world.config.plans!.length).toBeGreaterThan(0);
      const id = ready(1);
      world.store.replaceRelationships(id, null, [blocker(world, "verify")]);
      expect(satisfied(scheduler, id)).toBe(true);
      scheduler.schedule();
      expect(calls.launched).toEqual([id]);
    });

    test(`AC-7.2 a compiled plan's after, ${where}, holds a dependent at the threshold`, async () => {
      const { world, scheduler, calls, ready } = await compiled(override);
      const id = ready(1);
      world.store.replaceRelationships(id, null, [blocker(world, "merge")]);
      expect(satisfied(scheduler, id)).toBe(false);
      scheduler.schedule();
      expect(calls.launched).toEqual([]);
    });
  }

  test("AC-6.2 a dependent already past the dependenciesMet stage is still started when its blocker is sent back", async () => {
    const { world, scheduler, calls, ready } = await compiled(false);
    const id = ready(1);
    const dependency = blocker(world, "verify");
    world.store.replaceRelationships(id, null, [dependency]);
    // The dependent passed the check, moved on to review, and then the blocker was sent back.
    world.store.setStageState({ issueId: id, stageId: "review", status: "ready", feedbackCycle: 0, configHash: world.config.hash });
    world.store.setIssueProjection(dependency, { stage: "implementation", state: "active", warning: null });
    const before = { stage: world.store.getStageState(id), issue: world.store.getIssue(id) };
    expect(satisfied(scheduler, id)).toBe(true);
    scheduler.schedule();
    expect(calls.launched).toEqual([id]);
    expect(scheduler.liveStatusReader()(world.store.getIssue(id)!)?.reason ?? "").not.toContain("Waiting for dependencies");
    expect(world.store.getStageState(id)).toEqual(before.stage);
    expect(world.store.getIssue(id)).toEqual(before.issue);
  });

  test("AC-6.2 a dependent still at the dependenciesMet stage waits again when its blocker is sent back", async () => {
    const { world, scheduler, calls, ready } = await compiled(false);
    const id = ready(1);
    const dependency = blocker(world, "verify");
    world.store.replaceRelationships(id, null, [dependency]);
    world.store.setIssueProjection(dependency, { stage: "implementation", state: "active", warning: null });
    scheduler.schedule();
    expect(calls.launched).toEqual([]);
  });
});
