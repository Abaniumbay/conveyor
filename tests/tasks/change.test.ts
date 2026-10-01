import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChangeDelivery, ChangeRequest, CodeHost } from "../../src/codehost/types";
import { ConveyorStore } from "../../src/db/store";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { ChangeContext, TaskContext } from "../../src/tasks/context";
import { runTask, type TaskResult } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const registry = createTaskRegistry();
const run = (name: string, args: Record<string, unknown>) =>
  runTask(registry.require(name), { config: {}, instance: { id: name, stage: "merge", idempotencyKey: "k", resumed: false }, ...args } as never);
type Pass = Extract<TaskResult, { status: "pass" }>;
type Fail = Extract<TaskResult, { status: "fail" }>;

const ID = "github:o/r#pr-5";
const request = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  id: ID, number: 5, url: "https://x/pull/5", state: "open", headSha: "head1", draft: false, mergeable: true, ...over,
});

function hostFake(state: {
  change?: ChangeRequest; push?: { pushed: true } | { pushed: false; status: "changes-requested"; reason: string };
  merge?: { merged: boolean; sha?: string; headMoved?: boolean }; mergeCommitSha?: string | null;
} = {}) {
  const calls: Array<[string, unknown]> = [];
  const host: CodeHost = {
    async pushBranch(input) { calls.push(["push", input]); return state.push ?? { pushed: true }; },
    async ensureChange(input) { calls.push(["ensure", input]); return state.change ?? request(); },
    async getChange(input) { calls.push(["get", input]); return state.change ?? request(); },
    async mergeChange(input) { calls.push(["merge", input]); return state.merge ?? { merged: true, sha: "merge1" }; },
    async getChangeDelivery(input): Promise<ChangeDelivery> {
      calls.push(["delivery", input]);
      const change = state.change ?? request();
      return {
        change, checks: [],
        pullRequest: {
          number: change.number, url: change.url, state: change.state, merged: change.state === "merged",
          mergedAt: change.mergedAt ?? null, mergeCommitSha: state.mergeCommitSha ?? null, draft: change.draft,
          mergeState: null, headBranch: "conveyor/7", headSha: change.headSha, baseBranch: "main",
        },
      };
    },
  };
  return { host, calls };
}

async function world(hostState: Parameters<typeof hostFake>[0] = {}, withChange = true) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-change-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://x/7", title: "Fix the Thing!", body: "",
    sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  const enrollment = store.activateEnrollment("i1");
  store.recordWorkspace({ id: "w1", enrollmentId: enrollment.id, path: "/w", branch: "conveyor/7-r1-x", status: "active" });
  if (withChange) store.upsertPullRequest({ issueId: "i1", id: ID, number: 5, url: "https://x/pull/5", state: "open" });
  store.createRun({ id: "run1", issueId: "i1", stageId: "merge", attempt: 1, kind: "agent", status: "running", configHash: "h", startedAt: "2026-01-01T00:00:00Z" });
  const fake = hostFake(hostState);
  const events: unknown[] = [];
  const deps: TaskDeps = {
    store, config: {} as never, items: {} as never,
    repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main" },
    issueId: "i1", sourceGuidance: "", git: {} as never, workspaces: {} as never,
    codeHost: fake.host,
    delivery: async () => ({ change: { n: 5 }, pullRequest: null, checks: [] }) as never,
    run: { id: "run1", actor: null },
  };
  return { store, deps, host: fake, events };
}

const repository = (ciMode: "required" | "advisory" | "disabled" = "required"): Partial<TaskContext> => ({
  repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main", ciMode, systemLabels: [] },
});
const change = (over: Partial<ChangeContext> = {}): ChangeContext => ({
  ref: { provider: "github", id: ID, number: 5 }, url: "https://x/pull/5", state: "open", draft: false,
  headSha: "head1", baseBranch: "main", mergeable: "yes", mergeCommitSha: null, criteria: [], findings: [], ...over,
});
const ctx = (over: Partial<TaskContext> = {}): Partial<TaskContext> => ({
  ...repository(), change: change(),
  checkpoints: { ciPassed: { sha: "head1", at: "t", taskInstanceId: "ci" }, reviewPassed: { sha: "head1", at: "t", taskInstanceId: "rev" } },
  ...over,
});
const cp = (sha: string) => ({ sha, at: "t", taskInstanceId: "x" });

describe("change.load", () => {
  test("writes null when no change request exists yet", async () => {
    const w = await world({}, false);
    const result = await run("change.load", { context: {}, deps: w.deps }) as Pass;
    expect(result.output).toBeNull();
    expect(w.host.calls).toEqual([]);
  });

  test("maps the live delivery into a ChangeContext", async () => {
    const w = await world({ change: request({ mergeable: null, headSha: "h9" }), mergeCommitSha: "mc" });
    const result = await run("change.load", { context: {}, deps: w.deps }) as Pass;
    expect(result.output).toEqual({
      ref: { provider: "github", id: ID, number: 5 }, url: "https://x/pull/5", state: "open", draft: false,
      headSha: "h9", baseBranch: "main", mergeable: "unknown", mergeCommitSha: "mc", criteria: [], findings: [],
    });
  });

  test("maps mergeable booleans to yes and no", async () => {
    for (const [mergeable, expected] of [[true, "yes"], [false, "no"]] as const) {
      const w = await world({ change: request({ mergeable }) });
      expect(((await run("change.load", { context: {}, deps: w.deps }) as Pass).output as ChangeContext).mergeable).toBe(expected);
    }
  });

  test("a merged change reports state merged", async () => {
    const w = await world({ change: request({ state: "merged" }) });
    expect(((await run("change.load", { context: {}, deps: w.deps }) as Pass).output as ChangeContext).state).toBe("merged");
  });
});

describe("change.ensure", () => {
  test("pushes, ensures with the closing reference, stores the change and invalidates change and workspace", async () => {
    const w = await world({}, false);
    const result = await run("change.ensure", { context: repository(), deps: w.deps });
    expect(result.status).toBe("pass");
    expect(w.host.calls.map(([n]) => n)).toEqual(["push", "ensure"]);
    expect(w.host.calls[1]![1]).toMatchObject({
      address: "o/r", issueNumber: 7, branch: "conveyor/7-r1-x", base: "main", title: "Fix the Thing!", closes: true,
    });
    expect(w.store.getCurrentPullRequest("i1")).toMatchObject({ id: ID, number: 5, state: "open" });
    expect(registry.require("change.ensure").invalidates).toEqual(["change", "workspace"]);
  });

  test("closingReference false is a related reference", async () => {
    const w = await world({}, false);
    await run("change.ensure", { context: repository(), deps: w.deps, config: { closingReference: false } });
    expect(w.host.calls[1]![1]).toMatchObject({ closes: false });
  });

  test("a rejected push fails with the reason routed to retry and creates nothing", async () => {
    const w = await world({ push: { pushed: false, status: "changes-requested", reason: "diverged" } }, false);
    const result = await run("change.ensure", { context: repository(), deps: w.deps }) as Fail;
    expect(result).toEqual({ status: "fail", message: "diverged", route: { retry: true } });
    expect(w.host.calls.map(([n]) => n)).toEqual(["push"]);
    expect(w.store.getCurrentPullRequest("i1")).toBeNull();
  });

  test("fails without a workspace", async () => {
    const w = await world({}, false);
    w.store.getActiveWorkspace = () => null;
    expect(await run("change.ensure", { context: repository(), deps: w.deps })).toEqual({ status: "fail", message: "run has no workspace" });
  });
});

describe("change.merge", () => {
  test("merges the reviewed head with the SHA fence and records the merge", async () => {
    const w = await world();
    const result = await run("change.merge", { context: ctx(), deps: w.deps }) as Pass;
    expect(result.status).toBe("pass");
    expect(w.host.calls.find(([n]) => n === "merge")![1]).toEqual({ address: "o/r", id: ID, method: "squash", expectedHeadSha: "head1" });
    expect(w.store.getCurrentPullRequest("i1")).toMatchObject({ state: "merged" });
    expect(registry.require("change.merge").invalidates).toEqual(["change"]);
  });

  test("refuses with stop blocked when review has not passed", async () => {
    const w = await world();
    const result = await run("change.merge", { context: ctx({ checkpoints: { ciPassed: cp("head1"), reviewPassed: null } }), deps: w.deps }) as Fail;
    expect(result.status).toBe("fail");
    expect(result.route).toEqual({ stop: "blocked" });
    expect(result.message).toContain("Review");
    expect(w.host.calls.some(([n]) => n === "merge")).toBe(false);
  });

  test("refuses when the review was for a different head", async () => {
    const w = await world();
    const result = await run("change.merge", { context: ctx({ checkpoints: { ciPassed: cp("head1"), reviewPassed: cp("old") } }), deps: w.deps }) as Fail;
    expect(result.route).toEqual({ stop: "blocked" });
    expect(w.host.calls.some(([n]) => n === "merge")).toBe(false);
  });

  test("requires CI for the head only when CI is required", async () => {
    const stale = { checkpoints: { ciPassed: cp("old"), reviewPassed: cp("head1") } };
    const w = await world();
    const blocked = await run("change.merge", { context: ctx(stale), deps: w.deps }) as Fail;
    expect(blocked.route).toEqual({ stop: "blocked" });
    expect(blocked.message).toContain("CI");
    const advisory = await run("change.merge", { context: ctx({ ...stale, ...repository("advisory") }), deps: w.deps });
    expect(advisory.status).toBe("pass");
  });

  test("an already merged change passes without merging, even without checkpoints", async () => {
    const w = await world();
    const result = await run("change.merge", {
      context: ctx({ change: change({ state: "merged" }), checkpoints: { ciPassed: null, reviewPassed: null } }), deps: w.deps,
    });
    expect(result.status).toBe("pass");
    expect(w.host.calls.some(([n]) => n === "merge")).toBe(false);
  });

  test("observes the live change first: merged elsewhere passes, a moved head is blocked", async () => {
    const merged = await world({ change: request({ state: "merged" }) });
    expect((await run("change.merge", { context: ctx(), deps: merged.deps })).status).toBe("pass");
    expect(merged.host.calls.some(([n]) => n === "merge")).toBe(false);
    const moved = await world({ change: request({ headSha: "head2" }) });
    const result = await run("change.merge", { context: ctx(), deps: moved.deps }) as Fail;
    expect(result.route).toEqual({ stop: "blocked" });
    expect(moved.host.calls.some(([n]) => n === "merge")).toBe(false);
  });

  test("a head that moves during the merge is blocked with a clear message", async () => {
    const w = await world({ merge: { merged: false, headMoved: true } });
    const result = await run("change.merge", { context: ctx(), deps: w.deps }) as Fail;
    expect(result.route).toEqual({ stop: "blocked" });
    expect(result.message).toContain("head");
  });

  test("fails when there is no change request or it is closed", async () => {
    const w = await world();
    expect(await run("change.merge", { context: ctx({ change: null }), deps: w.deps })).toEqual({ status: "fail", message: "No change request exists yet" });
    const closed = await run("change.merge", { context: ctx({ change: change({ state: "closed" }) }), deps: w.deps }) as Fail;
    expect(closed.route).toEqual({ stop: "blocked" });
  });

  test("a merge the host did not perform fails", async () => {
    const w = await world({ merge: { merged: false } });
    expect((await run("change.merge", { context: ctx(), deps: w.deps })).status).toBe("fail");
  });
});

describe("change checks", () => {
  test("headUnchanged compares the head with the CI-passed SHA", async () => {
    expect((await run("change.headUnchanged", { context: ctx() })).status).toBe("pass");
    const moved = await run("change.headUnchanged", { context: ctx({ change: change({ headSha: "head2" }) }) }) as Fail;
    expect(moved.status).toBe("fail");
    expect(moved.message).toContain("head2");
    expect((await run("change.headUnchanged", { context: ctx({ checkpoints: { ciPassed: null, reviewPassed: null } }) })).status).toBe("fail");
    expect(await run("change.headUnchanged", { context: ctx({ change: null }) })).toEqual({ status: "fail", message: "No change request exists yet" });
  });

  test("mergeable is pending while unknown, fails on no, passes on yes", async () => {
    expect((await run("change.mergeable", { context: ctx({ change: change({ mergeable: "unknown" }) }) })).status).toBe("pending");
    expect((await run("change.mergeable", { context: ctx({ change: change({ mergeable: "no" }) }) })).status).toBe("fail");
    expect((await run("change.mergeable", { context: ctx() })).status).toBe("pass");
    expect(await run("change.mergeable", { context: ctx({ change: null }) })).toEqual({ status: "fail", message: "No change request exists yet" });
    expect(registry.require("change.mergeable").defaultWait).toEqual({ timeoutMs: 30 * 60_000, pollMs: 60_000 });
  });

  test("merged passes only for a merged change", async () => {
    expect((await run("change.merged", { context: ctx({ change: change({ state: "merged" }) }) })).status).toBe("pass");
    expect((await run("change.merged", { context: ctx() })).status).toBe("fail");
    expect(await run("change.merged", { context: ctx({ change: null }) })).toEqual({ status: "fail", message: "No change request exists yet" });
  });

  test("checks are pure", () => {
    for (const name of ["change.headUnchanged", "change.mergeable", "change.merged"]) {
      const def = registry.require(name);
      expect([def.kind, def.writes, def.invalidates]).toEqual(["check", [], []]);
    }
  });
});

describe("change tools", () => {
  test("change.get returns the live delivery payload", async () => {
    const w = await world();
    const result = await run("change.get", { context: {}, deps: w.deps, input: {} }) as Pass;
    expect(result.output).toEqual({ change: { n: 5 }, pullRequest: null, checks: [] });
    expect(registry.require("change.get").kind).toBe("tool");
  });

  test("change.setMetadata records the run event exactly as the legacy tool did", async () => {
    const w = await world();
    const input = { title: "T", labels: ["a"] };
    const result = await run("change.setMetadata", { context: {}, deps: w.deps, input }) as Pass;
    expect(result.output).toEqual({ accepted: true });
    expect(w.store.listRunEvents("run1")).toEqual([expect.objectContaining({ type: "source.set_pull_request_metadata", payload: input })]);
    expect(registry.require("change.setMetadata").mutating).toBe(true);
  });
});
