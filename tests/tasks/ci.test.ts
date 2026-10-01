import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CiChange, CiDefinition, CiProvider, CiRun } from "../../src/app/ci-provider";
import type { ChangeDelivery, ChangeRequest, CodeHost } from "../../src/codehost/types";
import { configSchema } from "../../src/config/schema";
import { ConveyorStore } from "../../src/db/store";
import { StageExecutor } from "../../src/engine/stage-executor";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { ChangeContext, CiContext, TaskContext } from "../../src/tasks/context";
import { runTask, type TaskResult } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";
import { compilePipeline } from "../../src/tasks/plan";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const registry = createTaskRegistry();
const run = (name: string, args: Record<string, unknown>) =>
  runTask(registry.require(name), { config: {}, instance: { id: name, stage: "impl", idempotencyKey: "k", resumed: false }, ...args } as never);
type Pass = Extract<TaskResult, { status: "pass" }>;
type Fail = Extract<TaskResult, { status: "fail" }>;
type Pending = Extract<TaskResult, { status: "pending" }>;

const ID = "github:o/r#pr-5";
const PR_URL = "https://x/pull/5";
const T0 = Date.parse("2026-01-01T00:10:00.000Z");

class FakeCi implements CiProvider {
  runs: CiRun[] = [];
  waiting: string[] = [];
  definition: CiDefinition = { defined: true, provable: true, summary: "workflow ci.yml (pull_request)" };
  logs: Record<string, string> = {};
  calls: string[] = [];
  onRerun: (run: CiRun) => void = () => {};
  async start(change: CiChange, commit: string, retryWindowMs: number, now: number) {
    this.calls.push(`start ${change.changeId}@${commit} ${retryWindowMs} ${now}`);
    return this.waiting;
  }
  async list(_change: CiChange, commit: string) { this.calls.push(`list@${commit}`); return this.runs; }
  async rerun(_change: CiChange, runId: string) {
    this.calls.push(`rerun ${runId}`);
    const target = this.runs.find((candidate) => candidate.id === runId);
    if (target) this.onRerun(target);
  }
  async definitions(_change: CiChange, commit: string) { this.calls.push(`definitions@${commit}`); return this.definition; }
  async log(_change: CiChange, runId: string, lines?: number) { this.calls.push(`log ${runId} ${lines}`); return this.logs[runId] ?? ""; }
}

const ciRun = (name: string, state: CiRun["state"], over: Partial<CiRun> = {}): CiRun => ({
  id: `id-${name}`, name, state, url: `https://ci/${name}`, canRerun: false, hasLog: true, ...over,
});

const request = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  id: ID, number: 5, url: PR_URL, state: "open", headSha: "head1", draft: false, mergeable: true, ...over,
});

function host(state: { change: ChangeRequest }): CodeHost {
  return {
    async getChange() { return state.change; },
    async getChangeDelivery(): Promise<ChangeDelivery> {
      const change = state.change;
      return {
        change, checks: [],
        pullRequest: {
          number: change.number, url: change.url, state: change.state, merged: false, mergedAt: null, mergeCommitSha: null,
          draft: false, mergeState: null, headBranch: "conveyor/7", headSha: change.headSha, baseBranch: "main",
        },
      };
    },
  } as unknown as CodeHost;
}

async function world(options: { ignoreChecks?: string[]; withChange?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-ci-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://x/7", title: "T", body: "",
    sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.activateEnrollment("i1");
  if (options.withChange !== false) store.upsertPullRequest({ issueId: "i1", id: ID, number: 5, url: PR_URL, state: "open" });
  const provider = new FakeCi();
  const changeState = { change: request() };
  const notes: Array<[string, string]> = [];
  const watches: unknown[] = [];
  const clock = { now: T0 };
  const deps: TaskDeps = {
    store, config: { repositories: { repo: { ci: { ignoreChecks: options.ignoreChecks ?? [] } } } } as never, items: {} as never,
    repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main" },
    issueId: "i1", sourceGuidance: "", git: {} as never, workspaces: {} as never,
    codeHost: host(changeState),
    ci: { provider: () => provider, watchAdvisory: (input) => { watches.push(input); } },
    notify: (message, stage) => { notes.push([stage, message]); },
    clock: () => new Date(clock.now),
  };
  return { store, deps, provider, changeState, notes, watches, clock };
}

const change = (over: Partial<ChangeContext> = {}): ChangeContext => ({
  ref: { provider: "github", id: ID, number: 5 }, url: PR_URL, state: "open", draft: false,
  headSha: "head1", baseBranch: "main", mergeable: "yes", mergeCommitSha: null, criteria: [], findings: [], ...over,
});
const repository = (ciMode: "required" | "advisory" | "disabled" = "required"): Partial<TaskContext> => ({
  repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main", ciMode, systemLabels: [] },
});
const ci = (over: Partial<CiContext> = {}): CiContext => ({
  headSha: "head1", defined: true, definitionProvable: true, definitionSummary: "workflow ci.yml", runs: [],
  observedAt: new Date(T0).toISOString(), firstSeenAt: new Date(T0 - 300_000).toISOString(), reruns: [], awaitingStart: [], ...over,
});
const crun = (name: string, state: CiContext["runs"][number]["state"], over: Partial<CiContext["runs"][number]> = {}): CiContext["runs"][number] => ({
  id: `id-${name}`, name, state, url: `https://ci/${name}`, rerunnable: false, hasLog: true, log: null, ...over,
});
const gateCtx = (snapshot: CiContext | null, over: Partial<TaskContext> = {}): Partial<TaskContext> => ({
  ...repository(), change: change(), ci: snapshot as never, ...over,
});

describe("ci.load", () => {
  test("loads nothing without a change request", async () => {
    const w = await world({ withChange: false });
    const out = (await run("ci.load", { context: {}, deps: w.deps }) as Pass).output;
    expect(out).toBeNull();
    expect(w.provider.calls).toEqual([]);
  });

  test("lists the runs of the current head, excluding ignored checks, with the definition", async () => {
    const w = await world({ ignoreChecks: ["Lint"] });
    w.provider.runs = [ciRun("Tests", "running"), ciRun("Lint", "failed"), ciRun("Cancelled", "cancelled", { canRerun: true, hasLog: false })];
    const out = (await run("ci.load", { context: { change: change() }, deps: w.deps }) as Pass).output as CiContext;
    expect(out.headSha).toBe("head1");
    expect(out.runs.map((r) => r.name)).toEqual(["Tests", "Cancelled"]);
    expect(out.runs[1]).toMatchObject({ state: "cancelled", rerunnable: true, hasLog: false, log: null });
    expect(out).toMatchObject({ defined: true, definitionProvable: true, definitionSummary: "workflow ci.yml (pull_request)", reruns: [], awaitingStart: [] });
    expect(w.provider.calls).toContain("list@head1");
    expect(w.provider.calls).toContain("definitions@head1");
    expect(w.provider.calls.some((call) => call.startsWith("start") || call.startsWith("rerun"))).toBe(false);
  });

  test("first-seen is durable per head; observedAt is the load time", async () => {
    const w = await world();
    const load = async (head = "head1") => (await run("ci.load", { context: { change: change({ headSha: head }) }, deps: w.deps }) as Pass).output as CiContext;
    const first = await load();
    expect(first.firstSeenAt).toBe(new Date(T0).toISOString());
    expect(first.observedAt).toBe(new Date(T0).toISOString());
    w.clock.now += 90_000;
    const again = await load();
    expect(again.firstSeenAt).toBe(new Date(T0).toISOString());
    expect(again.observedAt).toBe(new Date(T0 + 90_000).toISOString());
    expect((await load("head2")).firstSeenAt).toBe(new Date(T0 + 90_000).toISOString());
  });

  test("reads bounded focused logs only for failed or cancelled runs that have one", async () => {
    const w = await world();
    w.provider.runs = [ciRun("Tests", "failed"), ciRun("Ok", "passed"), ciRun("Ext", "failed", { hasLog: false })];
    w.provider.logs["id-Tests"] = "##[error]boom";
    const out = (await run("ci.load", { context: { change: change() }, deps: w.deps }) as Pass).output as CiContext;
    expect(out.runs.map((r) => [r.name, r.log])).toEqual([["Tests", "##[error]boom"], ["Ok", null], ["Ext", null]]);
    expect(w.provider.calls.filter((call) => call.startsWith("log"))).toEqual(["log id-Tests 200"]);
  });

  test("a log that cannot be read does not fail the load", async () => {
    const w = await world();
    w.provider.runs = [ciRun("Tests", "failed")];
    w.provider.log = async () => { throw new Error("gone"); };
    const out = (await run("ci.load", { context: { change: change() }, deps: w.deps }) as Pass).output as CiContext;
    expect(out.runs[0]!.log).toBe("(log unavailable: gone)");
  });

  test("exposes started label-triggered checks that have not registered a run yet", async () => {
    const w = await world();
    w.provider.waiting = ["Web", "Android"];
    w.provider.runs = [ciRun("Android", "running")];
    await run("ci.start", { context: gateCtx(ci({ runs: [] })), deps: w.deps });
    const out = (await run("ci.load", { context: { change: change() }, deps: w.deps }) as Pass).output as CiContext;
    expect(out.awaitingStart).toEqual(["Web"]);
  });
});

describe("ci.start", () => {
  test("starts label-triggered runs for the head, announces once per head and invalidates ci", async () => {
    const w = await world();
    const context = gateCtx(ci({ runs: [crun("Tests", "running")] }));
    expect(registry.require("ci.start").invalidates).toEqual(["ci"]);
    expect((await run("ci.start", { context, deps: w.deps })).status).toBe("pass");
    expect(w.provider.calls).toContain(`start 5@head1 600000 ${T0}`);
    expect(w.notes).toEqual([["impl", `CI started for head1: ${PR_URL}/checks\n- Tests: https://ci/Tests`]]);
    await run("ci.start", { context, deps: w.deps });
    expect(w.notes).toHaveLength(1);
    const moved = gateCtx(ci({ headSha: "head2", runs: [] }), { change: change({ headSha: "head2" }) });
    w.provider.waiting = ["Web"];
    await run("ci.start", { context: moved, deps: w.deps });
    expect(w.notes).toHaveLength(2);
    expect(w.notes[1]![1]).toContain("- Web: starting");
  });

  test("reruns a cancelled rerunnable run once per head and name, across a restart", async () => {
    const w = await world();
    const cancelled = gateCtx(ci({ runs: [crun("Tests", "cancelled", { rerunnable: true }), crun("Fixed", "cancelled", { rerunnable: false })] }));
    await run("ci.start", { context: cancelled, deps: w.deps });
    expect(w.provider.calls.filter((call) => call.startsWith("rerun"))).toEqual(["rerun id-Tests"]);
    // A restart is a new process over the same database.
    await run("ci.start", { context: cancelled, deps: w.deps });
    expect(w.provider.calls.filter((call) => call.startsWith("rerun"))).toEqual(["rerun id-Tests"]);
    const next = gateCtx(ci({ headSha: "head2", runs: [crun("Tests", "cancelled", { rerunnable: true })] }), { change: change({ headSha: "head2" }) });
    await run("ci.start", { context: next, deps: w.deps });
    expect(w.provider.calls.filter((call) => call.startsWith("rerun"))).toHaveLength(2);
  });

  test("advisory mode also starts the durable watch; required mode does not", async () => {
    const w = await world();
    await run("ci.start", { context: gateCtx(ci(), repository("advisory")), deps: w.deps });
    expect(w.watches).toEqual([{ itemId: "i1", headSha: "head1", stage: "impl", changeId: "5", changeUrl: PR_URL }]);
    await run("ci.start", { context: gateCtx(ci(), repository("required")), deps: w.deps });
    expect(w.watches).toHaveLength(1);
  });

  test("fails without a change request", async () => {
    const w = await world();
    const result = await run("ci.start", { context: { ...repository(), change: null, ci: null }, deps: w.deps }) as Fail;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("No change request");
  });
});

describe("ci.defined", () => {
  test("passes when CI is defined for the head", async () => {
    expect((await run("ci.defined", { context: gateCtx(ci()) })).status).toBe("pass");
  });
  test("fails blocked when no definition applies", async () => {
    const result = await run("ci.defined", { context: gateCtx(ci({ defined: false, definitionSummary: "No workflow runs for pull requests or pushes" })) }) as Fail;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("no applicable CI definition");
    expect(result.message).toContain("No workflow runs");
    expect(result.route).toEqual({ stop: "blocked" });
  });
  test("an unprovable definition also fails blocked", async () => {
    const result = await run("ci.defined", { context: gateCtx(ci({ defined: false, definitionProvable: false, definitionSummary: "HTTP 502" })) }) as Fail;
    expect(result.message).toContain("could not be verified");
    expect(result.route).toEqual({ stop: "blocked" });
  });
  test("is a pure check", () => {
    const definition = registry.require("ci.defined");
    expect(definition).toMatchObject({ kind: "check", reads: ["change", "ci"], writes: [], invalidates: [] });
  });
});

describe("ci.passed", () => {
  const SETTLED = new Date(T0 - 300_000).toISOString();
  test("declares the ciPassed task checkpoint and a 3h wait polled each minute", () => {
    expect(registry.require("ci.passed")).toMatchObject({
      kind: "check", checkpoint: { name: "ciPassed", scope: "task" }, defaultWait: { timeoutMs: 3 * 3_600_000, pollMs: 60_000 },
    });
  });

  test("is pending during the settle window even with no runs, then passes", async () => {
    const early = ci({ firstSeenAt: new Date(T0 - 30_000).toISOString() });
    const result = await run("ci.passed", { context: gateCtx(early) }) as Pending;
    expect(result.status).toBe("pending");
    expect(result.message).toContain("head1");
    expect((await run("ci.passed", { context: gateCtx(ci({ firstSeenAt: SETTLED })) })).status).toBe("pass");
  });

  test("the settle window is configurable with settleSeconds", async () => {
    const snapshot = ci({ firstSeenAt: new Date(T0 - 30_000).toISOString() });
    expect((await run("ci.passed", { context: gateCtx(snapshot), config: { settleSeconds: 10 } })).status).toBe("pass");
    expect((await run("ci.passed", { context: gateCtx(snapshot), config: { settleSeconds: 60 } })).status).toBe("pending");
  });

  test("is pending while runs are queued or running, or a started check has not registered", async () => {
    const running = await run("ci.passed", { context: gateCtx(ci({ runs: [crun("Tests", "running"), crun("Lint", "queued"), crun("Done", "passed")] })) }) as Pending;
    expect(running.status).toBe("pending");
    expect(running.message).toContain("Tests");
    expect(running.message).toContain("Lint");
    expect(running.message).not.toContain("Done");
    const awaiting = await run("ci.passed", { context: gateCtx(ci({ awaitingStart: ["Web"] })) }) as Pending;
    expect(awaiting.status).toBe("pending");
    expect(awaiting.message).toContain("Web to start");
  });

  test("fails with focused logs and a retry route when a run failed", async () => {
    const snapshot = ci({ runs: [crun("Tests", "failed", { log: "##[error]boom" }), crun("Lint", "running"), crun("Ext", "failed", { hasLog: false, url: null })] });
    const result = await run("ci.passed", { context: gateCtx(snapshot) }) as Fail;
    expect(result.status).toBe("fail");
    expect(result.route).toEqual({ retry: true });
    expect(result.message).toContain("Tests (failed)");
    expect(result.message).toContain("Ext (failed)");
    const details = result.details as { requiredFixes: string[]; evidence: string[] };
    expect(details.requiredFixes[0]).toContain('"Tests"');
    expect(details.requiredFixes[0]).toContain("ci.getLogs");
    expect(details.evidence[0]).toContain("### Tests — failed");
    expect(details.evidence[0]).toContain("##[error]boom");
  });

  test("a cancelled rerunnable run not yet rerun fails with a retry that names it; once rerun it counts as failed", async () => {
    const cancelled = crun("Tests", "cancelled", { rerunnable: true });
    const first = await run("ci.passed", { context: gateCtx(ci({ runs: [cancelled] })) }) as Fail;
    expect(first.route).toEqual({ retry: true });
    expect(first.message).toContain("Tests");
    expect(first.message).toContain("cancelled");
    expect(first.message).toContain("rerun");
    const second = await run("ci.passed", { context: gateCtx(ci({ runs: [cancelled], reruns: ["Tests"] })) }) as Fail;
    expect(second.route).toEqual({ retry: true });
    expect(second.message).toContain("CI failed");
    expect(second.message).toContain("Tests (cancelled)");
  });

  test("logLines keeps only the last lines of a failed run's log", async () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const snapshot = ci({ runs: [crun("Tests", "failed", { log })] });
    const keep = async (config: Record<string, unknown>) => {
      const result = await run("ci.passed", { context: gateCtx(snapshot), config }) as Fail;
      return (result.details as { evidence: string[] }).evidence[0]!;
    };
    const dflt = await keep({});
    expect(dflt).toContain("line 99");
    expect(dflt).toContain("line 40");
    expect(dflt).not.toContain("line 39\n");
    const few = await keep({ logLines: 2 });
    expect(few).toContain("line 98");
    expect(few).not.toContain("line 97");
  });

  test("a non-rerunnable cancelled run is a failure straight away", async () => {
    const result = await run("ci.passed", { context: gateCtx(ci({ runs: [crun("Tests", "cancelled")] })) }) as Fail;
    expect(result.message).toContain("Tests (cancelled)");
  });

  test("passes when every run passed or was skipped after the settle window", async () => {
    expect((await run("ci.passed", { context: gateCtx(ci({ runs: [crun("A", "passed"), crun("B", "skipped")] })) })).status).toBe("pass");
  });

  test("fails without a change request or CI snapshot", async () => {
    expect((await run("ci.passed", { context: gateCtx(null, { change: null }) })).status).toBe("fail");
  });
});

describe("ci.getLogs", () => {
  const logsTool = (w: Awaited<ReturnType<typeof world>>, input: Record<string, unknown> = {}) =>
    run("ci.getLogs", { context: {}, deps: w.deps, input }).then((result) => (result as Pass).output as { change: unknown; pullRequest: unknown; checks: Array<Record<string, unknown>>; note?: string });

  test("is a read-only tool", () => {
    expect(registry.require("ci.getLogs")).toMatchObject({ kind: "tool" });
    expect(registry.require("ci.getLogs").mutating).toBeFalsy();
  });
  test("explains when no pull request exists yet", async () => {
    const w = await world({ withChange: false });
    expect(await logsTool(w)).toMatchObject({ change: null, pullRequest: null, checks: [] });
  });
  test("returns the failing runs of the head with logs, or the named check, bounded", async () => {
    const w = await world();
    w.provider.runs = [ciRun("Tests", "failed"), ciRun("Lint", "passed"), ciRun("Ext", "cancelled", { hasLog: false })];
    w.provider.logs["id-Tests"] = "test failed";
    const failing = await logsTool(w);
    expect(failing.checks.map((check) => [check.name, check.log])).toEqual([["Tests", "test failed"], ["Ext", null]]);
    expect(w.provider.calls).toContain("log id-Tests 200");
    const named = await logsTool(w, { checkName: "Lint", lines: 5000 });
    expect(named.checks.map((check) => check.name)).toEqual(["Lint"]);
    expect(w.provider.calls).toContain("log id-Lint 1000");
    await logsTool(w, { checkName: "Lint", lines: 3 });
    expect(w.provider.calls).toContain("log id-Lint 20");
    expect(failing.change).toMatchObject({ headSha: "head1" });
  });
});

const baseConfig = (mode: "required" | "advisory" | "disabled") => configSchema.parse({
  settings: { database: "/d", logs: "/l", workspaces: "/w", artifacts: "/a" },
  labels: { stageTemplate: "c:{stage}", states: { blocked: "c:blocked", done: "c:done" }, metadata: { closable: "c:closable", orderTemplate: "c:order:{number}" } },
  sources: { github: { type: "github" } },
  pipelines: {
    delivery: {
      stages: [{
        id: "implementation", concurrency: 1, retries: 2,
        actions: [{ id: "startCi", task: "ci.start", when: "ci.enabled" }],
        "exit-gate": [
          { task: "ci.defined", when: "ci.required" },
          { task: "ci.passed", when: "ci.required", with: { settleSeconds: 1 } },
          { task: "change.mergeable" },
        ],
      }],
    },
  },
  repositories: { sample: { source: "github", address: "o/r", folder: "/r", pipeline: "delivery", ci: { mode } } },
});

describe("ci modes", () => {
  const plan = (mode: "required" | "advisory" | "disabled") => compilePipeline({ config: baseConfig(mode), repositoryId: "sample", registry }).stages[0]!;
  test("required compiles start, defined and passed with settle config and the load order change before ci", () => {
    const stage = plan("required");
    expect(stage.actions.map((t) => t.task)).toEqual(["ci.start"]);
    expect(stage.exitGate.map((t) => t.task)).toEqual(["ci.defined", "ci.passed", "change.mergeable"]);
    expect(stage.exitGate[1]!.with).toEqual({ settleSeconds: 1 });
    expect(stage.exitGate[1]!.wait).toEqual({ timeoutMs: 3 * 3_600_000, pollMs: 60_000 });
    expect(stage.actions[0]!.implicitLoads).toEqual(["change", "ci"]);
    expect(stage.exitGate[0]!.implicitLoads).toEqual(["change", "ci"]);
  });
  test("advisory compiles ci.start but no definition or pass gate", () => {
    const stage = plan("advisory");
    expect(stage.actions.map((t) => t.task)).toEqual(["ci.start"]);
    expect(stage.exitGate.map((t) => t.task)).toEqual(["change.mergeable"]);
  });
  test("disabled compiles no CI task and needs no CI provider", () => {
    const stage = plan("disabled");
    expect(stage.actions).toEqual([]);
    expect(stage.exitGate.map((t) => t.task)).toEqual(["change.mergeable"]);
  });
});

describe("a rerun run the provider still reports as cancelled", () => {
  test("is pending, not failed, until it changes; a new run id is classified normally", async () => {
    const w = await world();
    w.provider.runs = [ciRun("Tests", "cancelled", { canRerun: true })];
    const load = async () => (await run("ci.load", { context: { change: change() }, deps: w.deps }) as Pass).output as CiContext;
    const before = await load();
    expect(before.runs[0]!.state).toBe("cancelled");
    await run("ci.start", { context: gateCtx(before), deps: w.deps });
    const stale = await load();
    expect(stale.runs[0]).toMatchObject({ state: "running", log: null });
    const result = await run("ci.passed", { context: gateCtx(stale) }) as Pending;
    expect(result.status).toBe("pending");
    expect(result.message).toContain("Tests");
    w.provider.runs = [ciRun("Tests", "passed", { canRerun: true })];
    w.clock.now += 300_000;
    expect((await run("ci.passed", { context: gateCtx(await load()) })).status).toBe("pass");
    // The rerun produced a new run id that was cancelled again: normal classification, now a failure.
    w.provider.runs = [ciRun("Tests", "cancelled", { id: "id-new", canRerun: true })];
    const again = await load();
    expect(again.runs[0]!.state).toBe("cancelled");
    expect((await run("ci.passed", { context: gateCtx(again) }) as Fail).message).toContain("Tests (cancelled)");
  });
});

describe("a cancelled run through the stage executor", () => {
  test("the gate fails with a retry, ci.start reruns the run once, and the rerun passes", async () => {
    const w = await world();
    w.provider.runs = [ciRun("Tests", "running", { canRerun: true })];
    w.provider.onRerun = (target) => { target.state = "running"; };
    const pipeline = compilePipeline({ config: baseConfig("required"), repositoryId: "sample", registry });
    const messages: string[] = [];
    const journal = w.store.executions();
    const executor = new StageExecutor({
      registry, journal, clock: () => new Date(w.clock.now),
      notify: (message) => { messages.push(message); }, setStatus: () => {}, settings: { maxReturns: 5 },
    });
    const baseContext: TaskContext = {
      schemaVersion: 1, configHash: "h",
      run: { stage: "", stageEpoch: 0, attempt: 1, maxAttempts: 1, taskInstanceId: "", enteredAt: new Date(T0).toISOString(), feedback: null },
      repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main", ciMode: "required", systemLabels: [] },
      item: { id: "i1", number: 7, title: "T", body: "", url: "u", labels: [], state: "open", criteria: [], children: [], dependencies: [], systemLabels: [] },
      checkpoints: { ciPassed: null, reviewPassed: null },
    };
    const execute = () => executor.execute({ issueId: "i1", pipeline, stageId: "implementation", baseContext, deps: w.deps });

    // CI is running when the stage starts: ci.start has nothing to rerun and the gate parks.
    expect(await execute()).toMatchObject({ kind: "parked", reason: "pending" });
    expect(w.provider.calls.filter((call) => call.startsWith("rerun"))).toEqual([]);
    expect(w.notes).toHaveLength(1);

    // The run is cancelled while the stage is parked: the gate fails with a retry, and the retried
    // actions run ci.start, which reruns it.
    w.provider.runs[0]!.state = "cancelled";
    w.clock.now += 60_000;
    expect(await execute()).toMatchObject({ kind: "parked", reason: "pending" });
    expect(messages.some((m) => m.includes("retrying") && m.includes("Tests") && m.includes("cancelled"))).toBe(true);
    expect(w.provider.calls.filter((call) => call.startsWith("rerun"))).toEqual(["rerun id-Tests"]);
    expect(w.notes).toHaveLength(1);

    // The rerun finishes and the settle window has passed.
    w.provider.runs[0]!.state = "passed";
    w.clock.now += 5 * 60_000;
    expect(await execute()).toMatchObject({ kind: "advance", stageId: "implementation" });
    expect(w.provider.calls.filter((call) => call.startsWith("rerun"))).toHaveLength(1);
    expect(journal.getContext("i1")!.context.checkpoints.ciPassed).toMatchObject({ sha: "head1", taskInstanceId: "ci.passed" });
  });
});
