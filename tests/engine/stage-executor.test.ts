import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEnvelope } from "../../src/runner/result";
import { ConveyorStore } from "../../src/db/store";
import { WaitDispatcher } from "../../src/app/wait-dispatcher";
import { ExecutionStore } from "../../src/engine/journal";
import { BOARD_APPROVAL_TASK_ID, ENTRY_APPROVAL_TASK_ID, StageExecutor, type StageOutcome } from "../../src/engine/stage-executor";
import { RepositoryPausedError } from "../../src/core/repository-pause";
import type { StoredEvent } from "../../src/events/catalogue";
import type { WaitKind } from "../../src/events/topics";
import type { ChangeContext, CiContext, TaskContext } from "../../src/tasks/context";
import { changeGroup } from "../../src/tasks/change";
import {
  defineGroup,
  fail,
  pass,
  pending,
  TaskRegistry,
  type Route,
  type TaskDefinition,
  type TaskResult,
} from "../../src/tasks/contract";
import type { CompiledPipeline, CompiledStage, CompiledTask } from "../../src/tasks/plan";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

class Crash extends Error {}

/** Throws Crash immediately before or after the first call of a journal method. */
function crashing(journal: ExecutionStore, spec: { before?: string; after?: string }): ExecutionStore {
  let armed = true;
  return new Proxy(journal, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (armed && prop === spec.before) {
          armed = false;
          throw new Crash(`before ${String(prop)}`);
        }
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (armed && prop === spec.after) {
          armed = false;
          throw new Crash(`after ${String(prop)}`);
        }
        return out;
      };
    },
  });
}

const ITEM = {
  id: "issue-1", number: 1, title: "T", body: "B", url: "u", labels: [], state: "open",
  criteria: [], children: [], dependencies: [], systemLabels: [],
};

function baseContext(): TaskContext {
  return {
    schemaVersion: 1,
    configHash: "hash",
    run: {
      stage: "", stageEpoch: 0, attempt: 1, maxAttempts: 1, taskInstanceId: "",
      enteredAt: "2026-01-01T00:00:00.000Z", feedback: null,
    },
    repository: { id: "repo-1", address: "owner/sample", folder: "/srv/sample", baseBranch: "main", ciMode: "required", systemLabels: [] },
    item: ITEM,
    checkpoints: { ciPassed: null, reviewPassed: null },
  };
}

interface World {
  remote: string[]; // external side effects, keyed by idempotency key
  calls: string[]; // every act/check invocation
  resumedFlags: boolean[];
  loads: { item: number; ci: number; change: number };
  ciSha: string;
  changeSha: string;
  changeState: "open" | "merged";
  actResult: (id: string) => TaskResult;
  checkResult: Record<string, () => TaskResult>;
  seenFeedback: unknown[];
  onAct?: () => void;
}

function buildRegistry(world: World): TaskRegistry {
  const reg = new TaskRegistry();
  const d = (def: Partial<TaskDefinition> & Pick<TaskDefinition, "name" | "kind">): TaskDefinition => ({
    description: "", reads: [], writes: [], invalidates: [], run: () => pass(), ...def,
  });
  reg.register(
    defineGroup("test", [
      d({ name: "test.itemLoad", kind: "load", writes: ["item"], run: () => { world.loads.item++; return pass(ITEM); } }),
      d({
        name: "test.ciLoad", kind: "load", writes: ["ci"],
        run: () => {
          world.loads.ci++;
          const ci: CiContext = {
            headSha: world.ciSha, defined: true, definitionProvable: true, definitionSummary: "", observedAt: "", firstSeenAt: "",
            reruns: [], awaitingStart: [], runs: [],
          };
          return pass(ci);
        },
      }),
      d({
        name: "test.act", kind: "act", reads: ["item", "run"], writes: ["agent"], invalidates: ["ci"],
        run: ({ instance, context }) => {
          world.calls.push(instance.id);
          world.resumedFlags.push(instance.resumed);
          world.seenFeedback.push((context as Partial<TaskContext>).run ?? null);
          // reconcile: observe first, do only the missing work
          if (!world.remote.includes(instance.idempotencyKey)) world.remote.push(instance.idempotencyKey);
          world.onAct?.();
          const result = world.actResult(instance.id);
          return result;
        },
      }),
      d({
        name: "test.legacyAct", kind: "act", writes: ["legacy"],
        run: ({ instance }) => { world.calls.push(instance.id); return world.actResult(instance.id); },
      }),
      d({
        name: "test.check", kind: "check", reads: ["ci"],
        run: ({ instance }) => { world.calls.push(instance.id); return (world.checkResult[instance.id] ?? (() => pass()))(); },
      }),
      d({
        name: "test.repaired", kind: "check", reads: ["ci"], repairedByActions: true,
        run: ({ instance }) => { world.calls.push(instance.id); return (world.checkResult[instance.id] ?? (() => pass()))(); },
      }),
      d({
        name: "test.ciPassed", kind: "check", reads: ["ci"], checkpoint: { name: "ciPassed", scope: "task" },
        run: () => pass(),
      }),
      d({
        name: "test.changeLoad", kind: "load", writes: ["change"],
        run: () => {
          world.loads.change++;
          const change: ChangeContext = {
            ref: { provider: "github", id: "github:5", number: 5 }, url: "https://example.test/pull/5", state: world.changeState,
            draft: false, headSha: world.changeSha, baseBranch: "main", mergeable: "yes", mergeCommitSha: null,
            criteria: [], projectedCriterionIds: [], projectionError: null, findings: [],
          };
          return pass(change);
        },
      }),
      d({
        name: "test.reviewPassed", kind: "check", reads: ["change"], checkpoint: { name: "reviewPassed", scope: "gate" },
        run: () => pass(),
      }),
    ]),
  );
  reg.register(defineGroup("ci", [
    d({
      name: "ci.passed", kind: "check", reads: ["ci"],
      run: ({ instance }) => { world.calls.push(instance.id); return (world.checkResult[instance.id] ?? (() => pass()))(); },
    }),
  ]));
  reg.register({
    ...changeGroup,
    definitions: changeGroup.definitions.filter((definition) => definition.name === "change.merged"),
  });
  return reg;
}

function ct(reg: TaskRegistry, id: string, task: string, extra: Partial<CompiledTask> = {}): CompiledTask {
  const def = reg.require(task);
  return {
    id, task, kind: def.kind, with: {}, wait: { timeoutMs: null, pollMs: 60_000 }, onFail: null,
    reads: [...def.reads], writes: [...def.writes], invalidates: [...def.invalidates],
    implicitLoads: def.reads.includes("item") ? ["item"] : def.reads.includes("ci") ? ["ci"] : def.reads.includes("change") ? ["change"] : [],
    ...extra,
  };
}

function stage(id: string, actions: CompiledTask[], exitGate: CompiledTask[], retries = 2, approval?: "manual"): CompiledStage {
  return { id, ...(approval === undefined ? {} : { approval }), concurrency: 1, retries, childrenStartAt: null, legacy: false, actions, exitGate };
}

function pipeline(...stages: CompiledStage[]): CompiledPipeline {
  return { id: "p", repositoryId: "repo-1", stages };
}

async function harness(options: { maxReturns?: number; fallbackMs?: (kind: WaitKind) => number | null } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-stage-"));
  directories.push(directory);
  const store = await ConveyorStore.open(path.join(directory, "conveyor.sqlite"));
  store.recordConfigSnapshot("hash", {});
  store.upsertRepository({
    id: "repo-1", configName: "sample", source: "github", address: "owner/sample", folder: "/srv/sample", configHash: "hash",
  });
  store.upsertIssue({
    id: "issue-1", repositoryId: "repo-1", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "T", body: "B",
    sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
  let now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = () => new Date(now);
  const journal = new ExecutionStore(store.sqlite(), { now: clock });
  const world: World = {
    remote: [], calls: [], resumedFlags: [], loads: { item: 0, ci: 0, change: 0 }, ciSha: "sha-1", changeSha: "def456", changeState: "open",
    actResult: () => pass({ agentId: "a", status: "done", summary: "s", reason: null, sessionId: null, runId: "r" }),
    checkResult: {}, seenFeedback: [],
  };
  const registry = buildRegistry(world);
  const notes: string[] = [];
  const statuses: Array<string | null> = [];
  let manualGate = (_input: { issueId: string; stageId: string; gateId: string; stageEpoch: number; attempt: number; task: string; configured: boolean }) =>
    ({ required: false, approved: false, message: "" });
  const manualGateWaits: Array<{ issueId: string; stageId: string; gateId: string; stageEpoch: number; attempt: number; task: string }> = [];
  let boardApproval = (_input: { issueId: string; stageId: string; stageEpoch: number; attempt: number }) =>
    ({ required: false, approved: false, message: "" });
  let onStatus: (message: string | null) => void | Promise<void> = () => {};
  const executorFor = (j: ExecutionStore = journal) =>
    new StageExecutor({
      registry, journal: j, clock,
      notify: (m) => { notes.push(m); },
      setStatus: async (m) => { statuses.push(m); await onStatus(m); },
      manualGate: (input) => manualGate(input),
      manualGateWaiting: (input) => { manualGateWaits.push(input); },
      boardApproval: (input) => boardApproval(input),
      ...(options.fallbackMs ? { fallbackMs: options.fallbackMs } : {}),
      settings: { maxReturns: options.maxReturns ?? 5 },
    });
  const run = (plan: CompiledPipeline, stageId: string, exec = executorFor()): Promise<StageOutcome> =>
    exec.execute({ issueId: "issue-1", pipeline: plan, stageId, baseContext: baseContext(), deps: { tag: "deps" } });
  return {
    store, journal, world, registry, notes, statuses, manualGateWaits, executorFor, run,
    setManualGate: (next: typeof manualGate) => { manualGate = next; },
    setBoardApproval: (next: typeof boardApproval) => { boardApproval = next; },
    setStatusHook: (next: typeof onStatus) => { onStatus = next; },
    advance: (ms: number) => { now += ms; },
    now: () => new Date(now),
    activate: () => journal.bumpStageEpoch("issue-1"),
  };
}

const simple = (h: Awaited<ReturnType<typeof harness>>, gate: CompiledTask[] = [], opts: { retries?: number; actionExtra?: Partial<CompiledTask> } = {}) =>
  pipeline(
    stage("implementation", [ct(h.registry, "act", "test.act", opts.actionExtra)], gate.length ? gate : [ct(h.registry, "gate", "test.check")], opts.retries ?? 2),
    stage("review", [ct(h.registry, "act2", "test.act")], [ct(h.registry, "gate2", "test.check")]),
  );

describe("happy path", () => {
  test("loads, runs acts, captures output, evaluates the gate, advances and clears the cursor", async () => {
    const h = await harness();
    h.activate();
    const outcome = await h.run(simple(h), "implementation");
    expect(outcome).toEqual({
      kind: "advance", stageId: "implementation", nextStageId: "review", result: null, feedbackCycles: 0,
    });
    expect(h.world.loads.item).toBe(1);
    expect(h.world.loads.ci).toBe(1); // the gate check reads ci, loaded before it, and the act invalidates ci
    const stored = h.journal.getContext("issue-1")!;
    expect(stored.context.agent?.status).toBe("done");
    expect(stored.context.run.stage).toBe("implementation");
    expect(stored.context.run.maxAttempts).toBe(3);
    expect(h.journal.getCursor("issue-1")).toBeNull();
    expect(h.notes).toEqual([]);
    expect(h.statuses.at(-1)).toBeNull();
  });

  test("the last stage advances to no next stage", async () => {
    const h = await harness();
    h.activate();
    const outcome = await h.run(simple(h), "review");
    expect(outcome).toMatchObject({ kind: "advance", stageId: "review", nextStageId: null });
  });

  test("delivers persisted stage-entry feedback to the first action after an executor restart", async () => {
    const h = await harness();
    h.activate();
    const feedback = {
      from: { stage: "ci-gate", taskInstanceId: "ci.passed" },
      message: "The same required CI failure repeated.",
      details: { evidence: ["required-ci-run"] },
    };
    h.journal.saveCursor({
      issueId: "issue-1", stage: "implementation", stageEpoch: h.journal.stageEpoch("issue-1"),
      attempt: 1, returns: 0, list: "actions", taskInstanceId: null, state: "planned", feedback,
      pendingSince: null, wakeAt: null, deadlineAt: null,
    }, h.journal.stageEpoch("issue-1"));

    await h.run(simple(h), "implementation", h.executorFor());

    expect(h.world.seenFeedback[0]).toMatchObject({ feedback });
  });

  test("waits for a fresh human approval after automatic gate checks pass", async () => {
    const h = await harness();
    h.activate();
    let approved = false;
    h.setManualGate(({ configured }) => ({ required: configured, approved, message: "Waiting for board approval of implementation / human." }));
    const plan = simple(h, [ct(h.registry, "human", "test.check", { manual: true })]);

    expect(await h.run(plan, "implementation")).toEqual({ kind: "parked", stageId: "implementation", reason: "pending", wakeAt: null });
    expect(h.journal.getCursor("issue-1")).toMatchObject({ list: "exit-gate", taskInstanceId: "human", state: "pending", wakeAt: null });
    expect(h.world.calls.filter((call) => call === "act")).toHaveLength(1);
    expect(h.statuses.at(-1)).toContain("board approval");

    approved = true;
    expect(h.journal.wakeNow("issue-1")).toBe(true);
    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "advance", stageId: "implementation" });
    expect(h.world.calls.filter((call) => call === "act")).toHaveLength(1);
  });

  test("parks before native stage actions until its entry approval is recorded", async () => {
    const h = await harness();
    h.activate();
    let approved = false;
    h.setManualGate(({ gateId, configured }) => ({
      required: configured && gateId === ENTRY_APPROVAL_TASK_ID,
      approved,
      message: "Waiting for entry approval",
    }));
    const plan = pipeline(
      stage("merge", [ct(h.registry, "merge", "test.act")], [ct(h.registry, "merged", "test.check")], 2, "manual"),
    );

    expect(await h.run(plan, "merge")).toEqual({ kind: "parked", stageId: "merge", reason: "pending", wakeAt: null });
    expect(h.journal.getCursor("issue-1")).toMatchObject({ list: "actions", taskInstanceId: ENTRY_APPROVAL_TASK_ID, state: "pending", wakeAt: null });
    expect(h.world.calls).not.toContain("merge");

    const restarted = h.executorFor();
    expect(await h.run(plan, "merge", restarted)).toMatchObject({ kind: "parked", stageId: "merge", reason: "pending" });
    expect(h.world.calls).not.toContain("merge");

    approved = true;
    expect(h.journal.wakeNow("issue-1")).toBe(true);
    expect(await h.run(plan, "merge", restarted)).toMatchObject({ kind: "advance", stageId: "merge" });
    expect(h.world.calls.filter((call) => call === "merge")).toHaveLength(1);
  });

  test("holds configured exit approval after an approved native entry approval", async () => {
    const h = await harness();
    h.activate();
    let entryApproved = false;
    let exitApproved = false;
    h.setManualGate(({ gateId, configured }) => ({
      required: configured,
      approved: gateId === ENTRY_APPROVAL_TASK_ID ? entryApproved : exitApproved,
      message: "Waiting for approval",
    }));
    const plan = pipeline(
      stage("merge", [ct(h.registry, "merge", "test.act")], [ct(h.registry, "human", "test.check", { manual: true })], 2, "manual"),
    );

    await h.run(plan, "merge");
    entryApproved = true;
    expect(h.journal.wakeNow("issue-1")).toBe(true);
    expect(await h.run(plan, "merge")).toMatchObject({ kind: "parked", stageId: "merge" });
    expect(h.world.calls.filter((call) => call === "merge")).toHaveLength(1);
    expect(h.journal.getCursor("issue-1")).toMatchObject({ list: "exit-gate", taskInstanceId: "human" });

    exitApproved = true;
    expect(h.journal.wakeNow("issue-1")).toBe(true);
    expect(await h.run(plan, "merge")).toMatchObject({ kind: "advance", stageId: "merge" });
  });

  test("notifies once after parking a configured manual gate", async () => {
    const h = await harness();
    h.activate();
    h.setManualGate(({ configured }) => ({ required: configured, approved: false, message: "Waiting for acknowledgement" }));
    const plan = simple(h, [ct(h.registry, "follow-ups", "test.check", { manual: true })]);

    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "parked", reason: "pending" });
    expect(h.manualGateWaits).toEqual([expect.objectContaining({
      issueId: "issue-1", stageId: "implementation", gateId: "follow-ups", task: "test.check",
    })]);

    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "parked", reason: "pending" });
    expect(h.manualGateWaits).toHaveLength(1);
  });

  test("waits for the final board approval after configured manual gates pass", async () => {
    const h = await harness();
    h.activate();
    let configuredApproved = false;
    let boardApproved = false;
    h.setManualGate(({ configured }) => ({ required: configured, approved: configuredApproved, message: "Waiting for configured approval" }));
    h.setBoardApproval(() => ({ required: true, approved: boardApproved, message: "Waiting for board approval" }));
    const plan = simple(h, [ct(h.registry, "human", "test.check", { manual: true })]);

    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "parked", stageId: "implementation" });
    expect(h.journal.getCursor("issue-1")).toMatchObject({ taskInstanceId: "human" });

    configuredApproved = true;
    expect(h.journal.wakeNow("issue-1")).toBe(true);
    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "parked", stageId: "implementation" });
    expect(h.journal.getCursor("issue-1")).toMatchObject({ taskInstanceId: BOARD_APPROVAL_TASK_ID });

    boardApproved = true;
    expect(h.journal.wakeNow("issue-1")).toBe(true);
    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "advance", stageId: "implementation" });
    expect(h.world.calls.filter((call) => call === "act")).toHaveLength(1);
  });

  test("waits for board approval when the native stage has no configured exit tasks", async () => {
    const h = await harness();
    h.activate();
    h.setBoardApproval(() => ({ required: true, approved: false, message: "Waiting for board approval" }));
    const plan = pipeline(
      stage("implementation", [ct(h.registry, "act", "test.act")], []),
      stage("review", [ct(h.registry, "act2", "test.act")], []),
    );

    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "parked", stageId: "implementation" });
    expect(h.journal.getCursor("issue-1")).toMatchObject({ list: "exit-gate", taskInstanceId: BOARD_APPROVAL_TASK_ID, state: "pending" });
  });

  test("keeps the exit-gate cursor live through the final status clear", async () => {
    const h = await harness();
    h.activate();
    let fenced = false;
    h.setStatusHook((message) => {
      if (message !== null || fenced) return;
      fenced = true;
      expect(h.journal.getCursor("issue-1")).toMatchObject({
        stage: "implementation", list: "exit-gate", taskInstanceId: "gate",
      });
      // This is the epoch fence setBoardApprovalRequirement applies when a board
      // operator makes the live gate manual while it is deciding to advance.
      h.journal.onStageChange("issue-1");
    });

    expect(await h.run(simple(h), "implementation")).toEqual({
      kind: "parked", stageId: "implementation", reason: "superseded", wakeAt: null,
    });
    expect(fenced).toBe(true);
  });

  test("acts see the instance id, key, resumed flag and the rewritten run context", async () => {
    const h = await harness();
    h.activate();
    await h.run(simple(h), "implementation");
    expect(h.world.resumedFlags).toEqual([false]);
    expect(h.world.remote).toHaveLength(1);
    const key = h.journal.idempotencyKey({ issueId: "issue-1", stage: "implementation", stageEpoch: 1, attempt: 1, taskInstanceId: "act" });
    expect(h.world.remote[0]).toBe(key);
  });

  test("a stale snapshot key an act invalidated is reloaded before the next reader", async () => {
    const h = await harness();
    h.activate();
    // the gate check reads ci without an implicit load in the plan; the act's invalidation forces one
    const plan = pipeline(
      stage("implementation", [ct(h.registry, "act", "test.act")], [ct(h.registry, "gate", "test.check", { implicitLoads: [] })]),
    );
    await h.run(plan, "implementation");
    expect(h.world.loads.ci).toBe(1);
  });
});

describe("crash injection", () => {
  test("crash before an act runs: resume runs it once, flagged resumed", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h);
    await expect(h.run(plan, "implementation", h.executorFor(crashing(h.journal, { before: "markRunning" })))).rejects.toBeInstanceOf(Crash);
    expect(h.world.remote).toHaveLength(0);
    const outcome = await h.run(plan, "implementation");
    expect(outcome.kind).toBe("advance");
    expect(h.world.remote).toHaveLength(1);
    expect(h.world.resumedFlags).toEqual([true]);
  });

  test("crash after the remote side effect but before completeExecution: resume reconciles, never duplicates", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h);
    const first = crashing(h.journal, { before: "completeExecution" });
    await expect(h.run(plan, "implementation", h.executorFor(first))).rejects.toBeInstanceOf(Crash);
    expect(h.world.remote).toHaveLength(1);
    const outcome = await h.run(plan, "implementation");
    expect(outcome.kind).toBe("advance");
    expect(h.world.remote).toHaveLength(1);
    expect(h.world.resumedFlags).toEqual([false, true]);
    expect(h.journal.getContext("issue-1")!.context.agent?.status).toBe("done");
  });

  test("crash after completion: the act is not re-run and its output is still captured", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h);
    const first = crashing(h.journal, { after: "completeExecution" });
    await expect(h.run(plan, "implementation", h.executorFor(first))).rejects.toBeInstanceOf(Crash);
    expect(h.journal.getContext("issue-1")!.context.agent).toBeUndefined();
    const outcome = await h.run(plan, "implementation");
    expect(outcome.kind).toBe("advance");
    expect(h.world.calls.filter((c) => c === "act")).toHaveLength(1);
    expect(h.journal.getContext("issue-1")!.context.agent?.status).toBe("done");
  });

  test("a later act is not repeated when an earlier one already completed", async () => {
    const h = await harness();
    h.activate();
    const plan = pipeline(
      stage("s", [ct(h.registry, "one", "test.act"), ct(h.registry, "two", "test.act")], [ct(h.registry, "gate", "test.check")]),
    );
    let runs = 0;
    h.world.onAct = () => { if (++runs === 2) throw new Crash("mid-stage"); };
    await expect(h.run(plan, "s")).rejects.toBeInstanceOf(Crash);
    await h.run(plan, "s");
    expect(h.world.calls.filter((c) => c === "one")).toHaveLength(1);
    expect(h.world.calls.filter((c) => c === "two")).toHaveLength(2);
    expect(h.world.remote).toHaveLength(2);
  });

  test("crash while pending: the first deadline survives a restart and a late wake times the task out", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h, [], { actionExtra: { wait: { timeoutMs: 600_000, pollMs: 60_000 } } });
    h.world.actResult = () => pending("waiting for an answer");
    const parked = await h.run(plan, "implementation");
    const pendingSince = h.journal.getCursor("issue-1")!.pendingSince;
    expect(parked).toEqual({ kind: "parked", stageId: "implementation", reason: "pending", wakeAt: new Date(h.now().getTime() + 60_000).toISOString() });
    expect(h.statuses.at(-1)).toBe("waiting for an answer");
    const deadline = h.journal.getCursor("issue-1")!.deadlineAt;
    expect(deadline).toBe(new Date(h.now().getTime() + 600_000).toISOString());

    h.advance(300_000); // restart: a brand new executor over the same database
    expect((await h.run(plan, "implementation")).kind).toBe("parked");
    expect(h.journal.getCursor("issue-1")).toMatchObject({ deadlineAt: deadline, pendingSince });
    expect(h.notes).toEqual([]);

    h.advance(301_000);
    const outcome = await h.run(plan, "implementation");
    expect(outcome).toMatchObject({ kind: "stopped", state: "blocked" });
    expect((outcome as { reason: string }).reason).toBe("act did not finish within 10m: waiting for an answer");
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain("did not finish within 10m");
  });

  test("a pending act that completes after wake-up proceeds without repeating earlier acts", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h);
    h.world.actResult = () => pending("asking");
    await h.run(plan, "implementation");
    h.world.actResult = () => pass({ agentId: "a", status: "done", summary: "answered", reason: null, sessionId: null, runId: "r" });
    h.advance(60_000);
    const outcome = await h.run(plan, "implementation");
    expect(outcome.kind).toBe("advance");
    expect(h.world.resumedFlags).toEqual([false, true]);
    expect(h.world.remote).toHaveLength(1);
    expect(h.journal.getContext("issue-1")!.context.agent?.summary).toBe("answered");
  });

  test("a repository pause parks an act at its cursor and resumes it without repeating its recorded work", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h);
    h.world.actResult = () => { throw new RepositoryPausedError(); };

    await expect(h.run(plan, "implementation")).resolves.toMatchObject({ kind: "parked", reason: "pending" });
    expect(h.journal.getCursor("issue-1")).toMatchObject({ taskInstanceId: "act", state: "pending" });
    expect(h.world.remote).toHaveLength(1);

    h.world.actResult = () => pass({ agentId: "a", status: "done", summary: "resumed", reason: null, sessionId: null, runId: "r" });
    h.advance(60_000);
    await expect(h.run(plan, "implementation")).resolves.toMatchObject({ kind: "advance" });
    expect(h.world.resumedFlags).toEqual([false, true]);
    expect(h.world.remote).toHaveLength(1);
  });

  test("late completion after an epoch bump is discarded silently", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h);
    h.world.onAct = () => { h.journal.onStageChange("issue-1"); };
    const versionBefore = h.journal.getContext("issue-1")?.version ?? 0;
    const outcome = await h.run(plan, "implementation");
    expect(outcome).toEqual({ kind: "parked", stageId: "implementation", reason: "superseded", wakeAt: null });
    expect(h.notes).toEqual([]);
    expect(h.journal.getCursor("issue-1")).toBeNull();
    expect(h.journal.getContext("issue-1")?.context.agent).toBeUndefined();
    expect(h.journal.getContext("issue-1")?.version ?? 0).toBe(versionBefore + 1); // only the pre-act load save
    const rows = h.store.sqlite().query("SELECT state FROM task_executions").all() as Array<{ state: string }>;
    expect(rows.every((row) => row.state !== "completed")).toBe(true);
  });

  test("a cursor from an older epoch is ignored and the stage starts again", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h);
    h.world.actResult = () => pending("x");
    await h.run(plan, "implementation");
    h.journal.onStageChange("issue-1");
    h.journal.bumpStageEpoch("issue-1"); // epoch moved on; nothing left to resume
    h.world.actResult = () => pass();
    const outcome = await h.run(plan, "implementation");
    expect(outcome.kind).toBe("advance");
    expect(h.world.resumedFlags).toEqual([false, false]);
  });
});

describe("routing", () => {
  const failing = (route?: Route) => () => fail("boom", { details: { line: 3 }, ...(route ? { route } : {}) });

  test("action failure defaults to stop blocked and notifies", async () => {
    const h = await harness();
    h.activate();
    h.world.actResult = failing();
    const outcome = await h.run(simple(h), "implementation");
    expect(outcome).toEqual({
      kind: "stopped", stageId: "implementation", state: "blocked", reason: "boom",
      requiredFixes: [], feedbackCycles: 0, result: null,
    });
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain("boom");
    expect(h.journal.getCursor("issue-1")).toBeNull();
    expect(h.statuses.at(-1)).toBeNull();
  });

  test("instance onFail stop and result.route precedence", async () => {
    const h = await harness();
    h.activate();
    h.world.actResult = failing();
    const plan = simple(h, [], { actionExtra: { onFail: { stop: "needs-input" } } });
    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "stopped", state: "needs-input" });

    const h2 = await harness();
    h2.activate();
    h2.world.actResult = failing({ stop: "paused" });
    const plan2 = simple(h2, [], { actionExtra: { onFail: { stop: "needs-input" } } });
    expect(await h2.run(plan2, "implementation")).toMatchObject({ kind: "stopped", state: "paused" });
  });

  test("an action routed to return becomes a correction", async () => {
    const h = await harness();
    h.activate();
    h.world.actResult = failing();
    const plan = simple(h, [], { actionExtra: { onFail: { return: "refinement" } } });
    const outcome = await h.run(plan, "implementation");
    expect(outcome).toEqual({
      kind: "correction", stageId: "implementation", targetStageId: "refinement", reason: "boom",
      requiredFixes: [], evidence: [], result: null,
    });
    expect(h.journal.getContext("issue-1")!.context.engine?.returns).toBe(1);
    expect(h.notes).toHaveLength(1);
  });

  test("a failing exit gate retries the actions with feedback, then passes", async () => {
    const h = await harness();
    h.activate();
    let gateRuns = 0;
    h.world.checkResult.gate = () => (++gateRuns === 1 ? fail("tests red", { details: { n: 2 } }) : pass());
    const feedback: unknown[] = [];
    h.world.onAct = () => {
      feedback.push(h.journal.getContext("issue-1")?.context.run.feedback ?? null);
    };
    const outcome = await h.run(simple(h), "implementation");
    expect(outcome).toMatchObject({ kind: "advance", feedbackCycles: 1 });
    expect(h.world.calls.filter((c) => c === "act")).toHaveLength(2);
    const history = h.journal.contextHistory("issue-1");
    const retryRun = history.map((row) => row.context.run).find((run) => run.attempt === 2)!;
    expect(retryRun.feedback).toEqual({ from: { stage: "implementation", taskInstanceId: "gate" }, message: "tests red", details: { n: 2 } });
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain("tests red");
  });

  test("feedback from a check the actions repair is marked, so the agent can skip its round", async () => {
    const h = await harness();
    h.activate();
    let gateRuns = 0;
    h.world.checkResult.gate = () => (++gateRuns === 1 ? fail("checklist out of sync") : pass());
    const outcome = await h.run(simple(h, [ct(h.registry, "gate", "test.repaired")]), "implementation");
    expect(outcome).toMatchObject({ kind: "advance", feedbackCycles: 1 });
    const retryRun = h.journal.contextHistory("issue-1").map((row) => row.context.run).find((run) => run.attempt === 2)!;
    expect(retryRun.feedback).toEqual({
      from: { stage: "implementation", taskInstanceId: "gate" }, message: "checklist out of sync", repairedByActions: true,
    });
  });

  test("retries are bounded by the stage retries and end as stop blocked", async () => {
    const h = await harness();
    h.activate();
    h.world.checkResult.gate = () => fail("still red");
    const outcome = await h.run(simple(h, [], { retries: 1 }), "implementation");
    expect(outcome).toMatchObject({ kind: "stopped", state: "blocked", reason: "still red", feedbackCycles: 1 });
    expect(h.world.calls.filter((c) => c === "act")).toHaveLength(2);
    expect(h.notes).toHaveLength(2); // one retry, one stop
  });

  test("gate onFail return and stop, and result.route overriding the instance", async () => {
    const h = await harness();
    h.activate();
    h.world.checkResult.gate = () => fail("wrong plan");
    const plan = simple(h, [ct(h.registry, "gate", "test.check", { onFail: { return: "refinement" } })]);
    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "correction", targetStageId: "refinement", reason: "wrong plan" });

    const h2 = await harness();
    h2.activate();
    h2.world.checkResult.gate = () => fail("nope", { route: { stop: "needs-intervention" } });
    const plan2 = simple(h2, [ct(h2.registry, "gate", "test.check", { onFail: { return: "refinement" } })]);
    expect(await h2.run(plan2, "implementation")).toMatchObject({ kind: "stopped", state: "needs-intervention" });
  });

  test("a repeated CI gate intervention preserves its configured retry destination and feedback", async () => {
    const h = await harness();
    h.activate();
    h.world.checkResult["ci-gate"] = () => fail("required CI is still failing", {
      route: { stop: "needs-intervention" },
      details: { requiredFixes: ["Fix the failing check."], evidence: ["run-2"] },
    });
    const plan = pipeline(
      stage("implementation", [ct(h.registry, "implement", "test.act")], [ct(h.registry, "implementation-gate", "test.check")]),
      stage("ci-gate", [], [ct(h.registry, "ci-gate", "ci.passed", { onFail: { return: "implementation" } })]),
    );

    expect(await h.run(plan, "ci-gate")).toEqual({
      kind: "stopped", stageId: "ci-gate", state: "needs-intervention", reason: "required CI is still failing",
      requiredFixes: ["Fix the failing check."], feedbackCycles: 0, result: null,
      retryTargetStage: "implementation",
      retryFeedback: {
        from: { stage: "ci-gate", taskInstanceId: "ci-gate" },
        message: "required CI is still failing",
        details: { requiredFixes: ["Fix the failing check."], evidence: ["run-2"] },
      },
    });
  });

  test("a CI intervention configured to return to its own stage remains a same-stage retry", async () => {
    const h = await harness();
    h.activate();
    h.world.checkResult["ci-gate"] = () => fail("required CI is still failing", { route: { stop: "needs-intervention" } });
    const plan = pipeline(
      stage("implementation", [], [ct(h.registry, "ci-gate", "ci.passed", { onFail: { return: "implementation" } })]),
    );

    const outcome = await h.run(plan, "implementation");

    expect(outcome).toMatchObject({ kind: "stopped", stageId: "implementation", state: "needs-intervention" });
    expect(outcome).not.toHaveProperty("retryTargetStage");
    expect(outcome).not.toHaveProperty("retryFeedback");
  });

  test("maxReturns guards cross-stage loops and the count carries into the target stage", async () => {
    const h = await harness({ maxReturns: 2 });
    const plan = simple(h, [ct(h.registry, "gate", "test.check", { onFail: { return: "review" } })]);
    h.world.checkResult.gate = () => fail("loop");
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      h.activate();
      const outcome = await h.run(plan, "implementation");
      seen.push(h.journal.getContext("issue-1")!.context.engine!.returns);
      if (i < 2) expect(outcome.kind).toBe("correction");
      else {
        expect(outcome).toMatchObject({ kind: "stopped", state: "blocked" });
        expect((outcome as { reason: string }).reason).toContain("loop guard");
      }
      // the next stage started by the service carries the counter in its cursor
      h.activate();
      h.world.actResult = () => pending("hold");
      await h.run(plan, "review");
      expect(h.journal.getCursor("issue-1")!.returns).toBe(i < 2 ? i + 1 : 0); // the guard stop resets the budget
      h.world.actResult = () => pass();
    }
    expect(seen).toEqual([1, 2, 0]);
  });

  test("the return counter resets when the item leaves the pipeline", async () => {
    const h = await harness();
    h.activate();
    h.world.checkResult.gate = () => fail("once", { route: { return: "review" } });
    await h.run(simple(h), "implementation");
    h.activate();
    h.world.checkResult.gate = () => pass();
    h.world.checkResult.gate2 = () => pass();
    await h.run(simple(h), "review");
    expect(h.journal.getContext("issue-1")!.context.engine?.returns).toBe(0);
  });
});

describe("deadlines", () => {
  test("an act past its deadline is not invoked and fails with its last pending message and route", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h, [], {
      actionExtra: { wait: { timeoutMs: 100_000, pollMs: 10_000 }, onFail: { stop: "needs-input" } },
    });
    h.world.actResult = () => pending("first question");
    await h.run(plan, "implementation");
    h.advance(10_000);
    await h.run(plan, "implementation");
    h.world.actResult = () => pending("latest question");
    h.advance(10_000);
    await h.run(plan, "implementation");
    const invocations = h.world.calls.length;
    h.advance(200_000);
    const outcome = await h.run(plan, "implementation");
    expect(h.world.calls).toHaveLength(invocations);
    expect(outcome).toMatchObject({
      kind: "stopped", state: "needs-input", reason: "act did not finish within 100s: latest question",
    });
  });

  test("a check past its deadline is evaluated once more and passes if it now passes", async () => {
    const h = await harness();
    h.activate();
    let green = false;
    h.world.checkResult.gate = () => (green ? pass() : pending("ci running"));
    const plan = simple(h, [ct(h.registry, "gate", "test.check", { wait: { timeoutMs: 120_000, pollMs: 60_000 } })]);
    await h.run(plan, "implementation");
    green = true;
    h.advance(500_000);
    expect((await h.run(plan, "implementation")).kind).toBe("advance");
  });

  test("a stop resets the return budget", async () => {
    const h = await harness();
    h.activate();
    h.world.checkResult.gate = () => fail("once", { route: { return: "review" } });
    await h.run(simple(h), "implementation");
    expect(h.journal.getContext("issue-1")!.context.engine?.returns).toBe(1);
    h.activate();
    h.world.checkResult.gate = () => fail("halt", { route: { stop: "blocked" } });
    await h.run(simple(h), "implementation");
    expect(h.journal.getContext("issue-1")!.context.engine?.returns).toBe(0);
  });

  test("an epoch bump while a gate check is going pending fences the pending write", async () => {
    const h = await harness();
    h.activate();
    h.world.checkResult.gate = () => { h.journal.onStageChange("issue-1"); return pending("ci"); };
    const outcome = await h.run(simple(h), "implementation");
    expect(outcome).toEqual({ kind: "parked", stageId: "implementation", reason: "superseded", wakeAt: null });
    expect(h.journal.getCursor("issue-1")).toBeNull();
    const rows = h.store.sqlite().query("SELECT state FROM task_executions WHERE task_instance_id = 'gate'").all() as Array<{ state: string }>;
    expect(rows.every((row) => row.state !== "pending")).toBe(true);
  });

  test("an aborted signal parks before the next task", async () => {
    const h = await harness();
    h.activate();
    const controller = new AbortController();
    h.world.onAct = () => controller.abort();
    const out = await h.executorFor().execute({
      issueId: "issue-1", pipeline: simple(h), stageId: "implementation", baseContext: baseContext(),
      deps: {}, signal: controller.signal,
    });
    expect(out).toEqual({ kind: "parked", stageId: "implementation", reason: "aborted", wakeAt: null });
    expect(h.world.calls).toEqual(["act"]);
  });
});

describe("pending exit gate", () => {
  test("parks without repeating actions, then re-evaluates with fresh loads", async () => {
    const h = await harness();
    h.activate();
    let polls = 0;
    h.world.checkResult.gate = () => (++polls < 3 ? pending("ci running", { after: 5_000 }) : pass());
    const plan = simple(h, [ct(h.registry, "gate", "test.check", { wait: { timeoutMs: null, pollMs: 60_000 } })]);
    const first = await h.run(plan, "implementation");
    expect(first).toEqual({ kind: "parked", stageId: "implementation", reason: "pending", wakeAt: new Date(h.now().getTime() + 5_000).toISOString() });
    expect(h.statuses).toContain("ci running");
    expect(h.journal.getCursor("issue-1")).toMatchObject({ list: "exit-gate", taskInstanceId: "gate", state: "pending" });
    const ciLoadsAfterFirst = h.world.loads.ci;
    h.world.ciSha = "sha-2";
    h.advance(5_000);
    await h.run(plan, "implementation");
    expect(h.world.loads.ci).toBe(ciLoadsAfterFirst + 1);
    expect(h.journal.getContext("issue-1")!.context.ci?.headSha).toBe("sha-2");
    h.advance(5_000);
    const done = await h.run(plan, "implementation");
    expect(done.kind).toBe("advance");
    expect(h.world.calls.filter((c) => c === "act")).toHaveLength(1);
  });

  test("an invalid or negative pending.after falls back to the poll interval", async () => {
    for (const after of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const h = await harness();
      h.activate();
      h.world.checkResult.gate = () => ({ status: "pending", message: "w", after });
      const out = await h.run(simple(h), "implementation");
      expect(out).toEqual({ kind: "parked", stageId: "implementation", reason: "pending", wakeAt: new Date(h.now().getTime() + 60_000).toISOString() });
    }
  });

  test("a pending gate records what it waits for, and passing ends the wait", async () => {
    const h = await harness();
    h.activate();
    let polls = 0;
    h.world.checkResult.gate = () => (++polls < 2 ? pending("ci running", { waitFor: { topics: ["ci:owner/sample:sha-1"], kind: "ci" } }) : pass());
    const plan = simple(h);
    await h.run(plan, "implementation");
    expect(h.journal.subscriptions("issue-1").map((row) => [row.topic, row.kind])).toEqual([["ci:owner/sample:sha-1", "ci"]]);
    h.advance(60_000);
    await h.run(plan, "implementation");
    expect(h.journal.subscriptions("issue-1")).toEqual([]);
  });

  test("an unlimited change.merged gate remains pending after more polls than its retry budget", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h, [ct(h.registry, "merged", "change.merged", { wait: { timeoutMs: null, pollMs: 1_000 } })], { retries: 2 });

    for (let evaluation = 0; evaluation < 3; evaluation++) {
      expect(await h.run(plan, "implementation")).toMatchObject({ kind: "parked", reason: "pending" });
      if (evaluation < 2) h.advance(1_000);
    }

    expect(h.world.loads.change).toBe(3);
    expect(h.journal.getCursor("issue-1")).toMatchObject({
      list: "exit-gate", taskInstanceId: "merged", state: "pending", deadlineAt: null,
    });
  });

  test("a merged change delivery wakes an open change.merged gate before its poll", async () => {
    const h = await harness({ fallbackMs: (kind) => kind === "change" ? 10 * 60_000 : null });
    h.activate();
    const plan = simple(h, [ct(h.registry, "merged", "change.merged", { wait: { timeoutMs: null, pollMs: 10 * 60_000 } })]);
    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "parked", reason: "pending" });
    const scheduledWakeAt = h.journal.getCursor("issue-1")?.wakeAt;
    expect(scheduledWakeAt).toBe(new Date(h.now().getTime() + 10 * 60_000).toISOString());
    expect(h.journal.subscriptions("issue-1")).toEqual([{
      topic: "change:owner/sample:5", executionId: expect.any(String), stageEpoch: 1, kind: "change",
    }]);

    const woken: string[] = [];
    const dispatcher = new WaitDispatcher({
      journal: h.journal,
      addressOf: () => "owner/sample",
      numberOf: () => 1,
      wake: (issueId) => { if (h.journal.wakeNow(issueId)) woken.push(issueId); },
    });
    const delivery: StoredEvent = {
      seq: 1, type: "github.changeUpdated", occurredAt: h.now().toISOString(), repositoryId: "repo-1", issueId: null,
      actor: { kind: "webhook", id: "delivery-1" }, correlationId: null,
      payload: { repository: "owner/sample", number: 5, action: "closed", headSha: "def456", merged: true },
    };
    dispatcher.handle(delivery);
    dispatcher.flush();

    expect(woken).toEqual(["issue-1"]);
    expect(h.journal.getCursor("issue-1")?.wakeAt).toBe(h.now().toISOString());
    expect(Date.parse(h.journal.getCursor("issue-1")?.wakeAt ?? "")).toBeLessThan(Date.parse(scheduledWakeAt ?? ""));
    h.world.changeState = "merged";
    expect(await h.run(plan, "implementation")).toMatchObject({ kind: "advance", stageId: "implementation" });
  });

  describe("wake-up time", () => {
    const FIVE_MINUTES = 5 * 60_000;
    const waitFor = { topics: ["ci:owner/sample:sha-1"], kind: "ci" as const };
    const parkedAt = async (fallbackMs: ((kind: WaitKind) => number | null) | undefined, result: () => ReturnType<typeof pending>) => {
      const h = await harness(fallbackMs ? { fallbackMs } : {});
      h.activate();
      h.world.checkResult.gate = result;
      const out = await h.run(simple(h, [ct(h.registry, "gate", "test.check", { wait: { timeoutMs: null, pollMs: 60_000 } })]), "implementation");
      return out.kind === "parked" && out.wakeAt ? Date.parse(out.wakeAt) - h.now().getTime() : null;
    };
    const healthy = (kind: WaitKind) => (kind === "ci" ? FIVE_MINUTES : null);

    test("healthy webhooks: a wait for events sleeps until its fallback", async () => {
      expect(await parkedAt(healthy, () => pending("ci running", { waitFor }))).toBe(FIVE_MINUTES);
    });
    test("healthy webhooks: an earlier `after` still wins", async () => {
      expect(await parkedAt(healthy, () => pending("settling", { waitFor, after: 30_000 }))).toBe(30_000);
    });
    test("healthy webhooks: a later `after` is cut to the fallback", async () => {
      expect(await parkedAt(healthy, () => pending("slow", { waitFor, after: 3_600_000 }))).toBe(FIVE_MINUTES);
    });
    test("healthy webhooks: a wait without events polls as before", async () => {
      expect(await parkedAt(healthy, () => pending("computing"))).toBe(60_000);
    });
    test("unhealthy or polling webhooks: a wait for events polls as before", async () => {
      expect(await parkedAt(() => null, () => pending("ci running", { waitFor }))).toBe(60_000);
    });
    test("no fallback lookup at all: a wait for events polls as before", async () => {
      expect(await parkedAt(undefined, () => pending("ci running", { waitFor }))).toBe(60_000);
    });
  });

  test("a gate check that stays pending past its deadline fails and retries", async () => {
    const h = await harness();
    h.activate();
    h.world.checkResult.gate = () => pending("ci running");
    const plan = simple(h, [ct(h.registry, "gate", "test.check", { wait: { timeoutMs: 120_000, pollMs: 60_000 } })], { retries: 0 });
    await h.run(plan, "implementation");
    h.advance(121_000);
    const out = await h.run(plan, "implementation");
    expect(out).toMatchObject({ kind: "stopped", state: "blocked", reason: "gate did not finish within 2m: ci running" });
  });
});

describe("checkpoints", () => {
  test("task-scope checkpoints record when the task passes and gate-scope when the gate passes", async () => {
    const h = await harness();
    h.activate();
    h.world.ciSha = "abc123";
    const gate = [ct(h.registry, "ci", "test.ciPassed"), ct(h.registry, "review", "test.reviewPassed")];
    const outcome = await h.run(simple(h, gate), "implementation");
    expect(outcome.kind).toBe("advance");
    const { checkpoints } = h.journal.getContext("issue-1")!.context;
    expect(checkpoints.ciPassed).toMatchObject({ sha: "abc123", taskInstanceId: "ci" });
    expect(checkpoints.reviewPassed).toMatchObject({ sha: "def456", taskInstanceId: "review" });
  });

  test("gate-scope checkpoints are not recorded when the gate does not pass", async () => {
    const h = await harness();
    h.activate();
    const gate = [ct(h.registry, "review", "test.reviewPassed"), ct(h.registry, "gate", "test.check")];
    h.world.checkResult.gate = () => fail("red", { route: { stop: "blocked" } });
    await h.run(simple(h, gate), "implementation");
    expect(h.journal.getContext("issue-1")!.context.checkpoints.reviewPassed).toBeNull();
  });

  test("a gate-scope checkpoint appears only on the run in which every gate task passes", async () => {
    const h = await harness();
    h.activate();
    h.world.changeSha = "def456";
    const gate = [ct(h.registry, "review", "test.reviewPassed"), ct(h.registry, "gate", "test.check")];
    const plan = simple(h, gate, { retries: 3 });
    h.world.checkResult.gate = () => fail("red");
    const first = await h.run(plan, "implementation");
    expect(first.kind).not.toBe("advance");
    expect(h.journal.getContext("issue-1")!.context.checkpoints.reviewPassed).toBeNull();
    delete h.world.checkResult.gate;
    h.activate();
    const second = await h.run(plan, "implementation");
    expect(second.kind).toBe("advance");
    expect(h.journal.getContext("issue-1")!.context.checkpoints.reviewPassed).toMatchObject({ sha: "def456", taskInstanceId: "review" });
  });
});

test("thrown errors propagate", async () => {
  const h = await harness();
  h.activate();
  h.world.actResult = () => { throw new Error("infra down"); };
  await expect(h.run(simple(h), "implementation")).rejects.toThrow("infra down");
});

describe("legacy envelope and fail details", () => {
  const ENVELOPE: RunEnvelope = {
    stageResult: { outcome: "success", status: "done", summary: "ok", reason: null, metrics: {} },
    sessionId: null, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    cost: { amount: 0, currency: "USD", source: "unavailable" }, durationMs: 1, exitCode: 0, artifacts: [], stderr: "",
  };
  const legacyPlan = (h: Awaited<ReturnType<typeof harness>>, gate: CompiledTask[] = []) =>
    pipeline(
      stage("implementation", [ct(h.registry, "act", "test.legacyAct")], gate.length ? gate : [ct(h.registry, "gate", "test.check")]),
      stage("review", [ct(h.registry, "act2", "test.legacyAct")], [ct(h.registry, "gate2", "test.check")]),
    );

  test("a captured legacy envelope becomes the advance result", async () => {
    const h = await harness();
    h.activate();
    h.world.actResult = () => pass(ENVELOPE);
    expect(await h.run(legacyPlan(h), "implementation")).toMatchObject({ kind: "advance", result: ENVELOPE });
  });

  test("a stop after the gate fails carries the envelope and the fail's requiredFixes", async () => {
    const h = await harness();
    h.activate();
    h.world.actResult = () => pass(ENVELOPE);
    h.world.checkResult.gate = () => fail("red", { route: { stop: "blocked" }, details: { requiredFixes: ["fix it"], evidence: ["log"] } });
    expect(await h.run(legacyPlan(h), "implementation")).toMatchObject({
      kind: "stopped", state: "blocked", reason: "red", requiredFixes: ["fix it"], result: ENVELOPE,
    });
  });

  test("a correction carries requiredFixes, evidence and an envelope captured from a failing act", async () => {
    const h = await harness();
    h.activate();
    h.world.actResult = () =>
      fail("changes", { route: { return: "refinement" }, details: { requiredFixes: ["a"], evidence: ["b"], legacy: ENVELOPE } });
    expect(await h.run(legacyPlan(h), "implementation")).toEqual({
      kind: "correction", stageId: "implementation", targetStageId: "refinement", reason: "changes",
      requiredFixes: ["a"], evidence: ["b"], result: ENVELOPE,
    });
  });

  test("an envelope captured by an earlier stage does not leak into the next stage's outcome", async () => {
    const h = await harness();
    h.activate();
    h.world.actResult = () => pass(ENVELOPE);
    const plan = legacyPlan(h);
    await h.run(plan, "implementation");
    h.world.actResult = () => fail("entry failed", { route: { stop: "blocked" } });
    expect(await h.run(plan, "review")).toMatchObject({ kind: "stopped", result: null, requiredFixes: [] });
  });
});
