import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { ExecutionStore } from "../../src/engine/journal";
import { StageExecutor, type StageOutcome } from "../../src/engine/stage-executor";
import type { CiContext, TaskContext } from "../../src/tasks/context";
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
    repository: { id: "repo-1", address: "owner/sample", folder: "/srv/sample", baseBranch: "main", ciMode: "required" },
    item: ITEM,
    checkpoints: { ciPassed: null, reviewPassed: null },
  };
}

interface World {
  remote: string[]; // external side effects, keyed by idempotency key
  calls: string[]; // every act/check invocation
  resumedFlags: boolean[];
  loads: { item: number; ci: number };
  ciSha: string;
  changeSha: string;
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
          const ci: CiContext = { headSha: world.ciSha, defined: true, definitionSummary: "", runs: [] };
          return pass(ci);
        },
      }),
      d({
        name: "test.act", kind: "act", reads: ["item"], writes: ["agent"], invalidates: ["ci"],
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
        name: "test.check", kind: "check", reads: ["ci"],
        run: ({ instance }) => { world.calls.push(instance.id); return (world.checkResult[instance.id] ?? (() => pass()))(); },
      }),
      d({
        name: "test.ciPassed", kind: "check", reads: ["ci"], checkpoint: { name: "ciPassed", scope: "task" },
        run: () => pass(),
      }),
      d({
        name: "test.changeLoad", kind: "load", writes: ["change"],
        run: () => pass({ headSha: world.changeSha }),
      }),
      d({
        name: "test.reviewPassed", kind: "check", reads: ["change"], checkpoint: { name: "reviewPassed", scope: "gate" },
        run: () => pass(),
      }),
    ]),
  );
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

function stage(id: string, actions: CompiledTask[], exitGate: CompiledTask[], retries = 2): CompiledStage {
  return { id, concurrency: 1, retries, childrenStartAt: null, legacy: false, actions, exitGate };
}

function pipeline(...stages: CompiledStage[]): CompiledPipeline {
  return { id: "p", repositoryId: "repo-1", stages };
}

async function harness(options: { maxReturns?: number } = {}) {
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
    remote: [], calls: [], resumedFlags: [], loads: { item: 0, ci: 0 }, ciSha: "sha-1", changeSha: "def456",
    actResult: () => pass({ agentId: "a", status: "done", summary: "s", reason: null, sessionId: null, runId: "r" }),
    checkResult: {}, seenFeedback: [],
  };
  const registry = buildRegistry(world);
  const notes: string[] = [];
  const statuses: Array<string | null> = [];
  const executorFor = (j: ExecutionStore = journal) =>
    new StageExecutor({
      registry, journal: j, clock,
      notify: (m) => { notes.push(m); },
      setStatus: (m) => { statuses.push(m); },
      settings: { maxReturns: options.maxReturns ?? 5 },
    });
  const run = (plan: CompiledPipeline, stageId: string, exec = executorFor()): Promise<StageOutcome> =>
    exec.execute({ issueId: "issue-1", pipeline: plan, stageId, baseContext: baseContext(), deps: { tag: "deps" } });
  return {
    store, journal, world, registry, notes, statuses, executorFor, run,
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
    expect(parked).toEqual({ kind: "parked", reason: "pending", wakeAt: new Date(h.now().getTime() + 60_000).toISOString() });
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

  test("late completion after an epoch bump is discarded silently", async () => {
    const h = await harness();
    h.activate();
    const plan = simple(h);
    h.world.onAct = () => { h.journal.onStageChange("issue-1"); };
    const versionBefore = h.journal.getContext("issue-1")?.version ?? 0;
    const outcome = await h.run(plan, "implementation");
    expect(outcome).toEqual({ kind: "parked", reason: "superseded", wakeAt: null });
    expect(h.notes).toEqual([]);
    expect(h.journal.getCursor("issue-1")).toBeNull();
    expect(h.journal.getContext("issue-1")?.context.agent).toBeUndefined();
    expect(h.journal.getContext("issue-1")?.version ?? 0).toBeLessThanOrEqual(versionBefore + 1); // only the pre-act load save
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
      expect(h.journal.getCursor("issue-1")!.returns).toBe(Math.min(i + 1, 2));
      h.world.actResult = () => pass();
    }
    expect(seen).toEqual([1, 2, 2]);
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

describe("pending exit gate", () => {
  test("parks without repeating actions, then re-evaluates with fresh loads", async () => {
    const h = await harness();
    h.activate();
    let polls = 0;
    h.world.checkResult.gate = () => (++polls < 3 ? pending("ci running", { after: 5_000 }) : pass());
    const plan = simple(h, [ct(h.registry, "gate", "test.check", { wait: { timeoutMs: null, pollMs: 60_000 } })]);
    const first = await h.run(plan, "implementation");
    expect(first).toEqual({ kind: "parked", reason: "pending", wakeAt: new Date(h.now().getTime() + 5_000).toISOString() });
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
      expect(out).toEqual({ kind: "parked", reason: "pending", wakeAt: new Date(h.now().getTime() + 60_000).toISOString() });
    }
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
});

test("thrown errors propagate", async () => {
  const h = await harness();
  h.activate();
  h.world.actResult = () => { throw new Error("infra down"); };
  await expect(h.run(simple(h), "implementation")).rejects.toThrow("infra down");
});
