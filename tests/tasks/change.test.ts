import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseManagedSections, upsertManagedSection } from "../../src/source/github/managed-sections";
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
  merge?: { merged: boolean; sha?: string; headMoved?: boolean }; mergeCommitSha?: string | null; body?: string;
} = {}) {
  let body = state.body ?? "";
  const calls: Array<[string, unknown]> = [];
  const host: CodeHost = {
    async pushBranch(input) { calls.push(["push", input]); return state.push ?? { pushed: true }; },
    async ensureChange(input) { calls.push(["ensure", input]); return state.change ?? request(); },
    async getChange(input) { calls.push(["get", input]); return { ...(state.change ?? request()), body }; },
    async setChangeChecklist(input) {
      calls.push(["checklist", input]);
      body = upsertManagedSection(body, "acceptance-criteria", input.markdown, parseManagedSections(body).revision);
    },
    async mergeChange(input) { calls.push(["merge", input]); return state.merge ?? { merged: true, sha: "merge1" }; },
    async getChangeDelivery(input): Promise<ChangeDelivery> {
      calls.push(["delivery", input]);
      const change = { ...(state.change ?? request()), body };
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

async function world(hostState: Parameters<typeof hostFake>[0] = {}, withChange = true, issueBody = "") {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-change-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://x/7", title: "Fix the Thing!", body: issueBody,
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
  headSha: "head1", baseBranch: "main", mergeable: "yes", mergeCommitSha: null, criteria: [], projectedCriterionIds: [], findings: [], ...over,
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
      headSha: "h9", baseBranch: "main", mergeable: "unknown", mergeCommitSha: "mc", criteria: [], projectedCriterionIds: [], findings: [],
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

const BODY = [
  "<!-- conveyor:acceptance-criteria:start -->",
  "- [ ] It works <!-- conveyor:criterion:a -->",
  "- [ ] It is fast <!-- conveyor:criterion:b -->",
  "- [ ] [Manual] Looks right <!-- conveyor:criterion:m -->",
  "<!-- conveyor:acceptance-criteria:end -->",
].join("\n");
const PR_BODY = "Human intro\n";
const lastChecklist = (w: Awaited<ReturnType<typeof world>>) =>
  (w.host.calls.filter(([n]) => n === "checklist").at(-1)?.[1] as { markdown: string }).markdown;
const approve = (w: Awaited<ReturnType<typeof world>>, criterionId: string, headSha = "head1") =>
  run("change.checkCriterion", { context: {}, deps: { ...w.deps, run: { id: "run1", actor: { id: "reviewer-1" } } }, input: { criterionId, headSha }, actor: "reviewer-1" });

describe("criterion approvals", () => {
  test("checkCriterion records the approval for the head and re-renders the PR checklist", async () => {
    const w = await world({ body: PR_BODY }, true, BODY);
    const result = await approve(w, "a");
    expect(result.status).toBe("pass");
    expect(lastChecklist(w)).toBe([
      "- [x] It works <!-- conveyor:criterion:a -->",
      "- [ ] It is fast <!-- conveyor:criterion:b -->",
      "- [ ] [Manual] Looks right <!-- conveyor:criterion:m -->",
    ].join("\n"));
    const loaded = (await run("change.load", { context: {}, deps: w.deps }) as Pass).output as ChangeContext;
    expect(loaded.criteria).toEqual([
      { id: "a", projectedChecked: true, approval: { reviewer: "reviewer-1", headSha: "head1", checkedAt: expect.any(String) } },
      { id: "b", projectedChecked: false, approval: null },
      { id: "m", projectedChecked: false, approval: null },
    ]);
    expect(loaded.projectedCriterionIds).toEqual(["a", "b", "m"]);
    const def = registry.require("change.checkCriterion");
    expect([def.kind, def.mutating, def.invalidates]).toEqual(["tool", true, ["change"]]);
  });

  test("an unknown criterion id fails and lists the valid ids", async () => {
    const w = await world({ body: PR_BODY }, true, BODY);
    const result = await approve(w, "zzz") as Fail;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("zzz");
    expect(result.message).toContain("a, b, m");
    expect(w.host.calls.some(([n]) => n === "checklist")).toBe(false);
  });

  test("an approval for an older head shows as null and is not projected as checked", async () => {
    const w = await world({ body: PR_BODY }, true, BODY);
    await approve(w, "a");
    w.store.sqlite().query("UPDATE criterion_approvals SET head_sha = 'old'").run();
    const loaded = (await run("change.load", { context: {}, deps: w.deps }) as Pass).output as ChangeContext;
    expect(loaded.criteria.find((c) => c.id === "a")!.approval).toBeNull();
    expect(w.store.sqlite().query("SELECT head_sha FROM criterion_approvals").get()).toEqual({ head_sha: "old" });
  });

  test("uncheckCriterion removes the approval and unchecks the projection", async () => {
    const w = await world({ body: PR_BODY }, true, BODY);
    await approve(w, "a");
    const result = await run("change.uncheckCriterion", { context: {}, deps: w.deps, input: { criterionId: "a", headSha: "head1" }, actor: "reviewer-1" });
    expect(result.status).toBe("pass");
    expect(lastChecklist(w)).toContain("- [ ] It works <!-- conveyor:criterion:a -->");
    const loaded = (await run("change.load", { context: {}, deps: w.deps }) as Pass).output as ChangeContext;
    expect(loaded.criteria[0]!.approval).toBeNull();
    expect(registry.require("change.uncheckCriterion").mutating).toBe(true);
  });

  test("a head that moved since the call refuses to record", async () => {
    const w = await world({ body: PR_BODY, change: request({ headSha: "head2" }) }, true, BODY);
    const result = await approve(w, "a", "head1") as Fail;
    expect(result.status).toBe("fail");
    expect(w.store.sqlite().query("SELECT COUNT(*) AS n FROM criterion_approvals").get()).toEqual({ n: 0 });
  });
});

describe("change.ensure criteriaChecklist", () => {
  test("writes the checklist once, preserving human text, and skips when unchanged", async () => {
    const w = await world({ body: PR_BODY }, false, BODY);
    await run("change.ensure", { context: repository(), deps: w.deps, config: { criteriaChecklist: true } });
    expect(w.host.calls.filter(([n]) => n === "checklist")).toHaveLength(1);
    expect(lastChecklist(w)).toContain("- [ ] It works <!-- conveyor:criterion:a -->");
    await run("change.ensure", { context: repository(), deps: w.deps, config: { criteriaChecklist: true } });
    expect(w.host.calls.filter(([n]) => n === "checklist")).toHaveLength(1);
  });

  test("without criteriaChecklist the PR body is untouched", async () => {
    const w = await world({ body: PR_BODY }, false, BODY);
    await run("change.ensure", { context: repository(), deps: w.deps, config: {} });
    expect(w.host.calls.some(([n]) => n === "checklist")).toBe(false);
  });
});

describe("criteria checks", () => {
  const item = { criteria: [{ id: "a", text: "x", manual: false }, { id: "b", text: "y", manual: false }, { id: "m", text: "[Manual] z", manual: true }] };
  const approval = { reviewer: "r", headSha: "head1", checkedAt: "t" };
  const crit = (id: string, approved: boolean) => ({ id, projectedChecked: approved, approval: approved ? approval : null });

  test("criteriaInSync passes when the projection lists exactly the item's ids", async () => {
    const ok = ctx({ item: item as never, change: change({ projectedCriterionIds: ["m", "b", "a"] }) });
    expect((await run("change.criteriaInSync", { context: ok })).status).toBe("pass");
    const bad = await run("change.criteriaInSync", { context: ctx({ item: item as never, change: change({ projectedCriterionIds: ["a", "q"] }) }) }) as Fail;
    expect(bad.status).toBe("fail");
    expect(bad.message).toContain("b");
    expect(bad.message).toContain("q");
    expect(await run("change.criteriaInSync", { context: ctx({ item: item as never, change: null }) })).toEqual({ status: "fail", message: "No change request exists yet" });
  });

  test("criteriaChecked needs every non-manual criterion approved and names the missing ones", async () => {
    const missing = await run("change.criteriaChecked", { context: ctx({ item: item as never, change: change({ criteria: [crit("a", true), crit("b", false), crit("m", false)] }) }) }) as Fail;
    expect(missing.status).toBe("fail");
    expect(missing.message).toContain("b");
    expect(missing.message).not.toContain("m,");
    const done = await run("change.criteriaChecked", { context: ctx({ item: item as never, change: change({ criteria: [crit("a", true), crit("b", true), crit("m", false)] }) }) });
    expect(done.status).toBe("pass");
    const stale = change({ criteria: [crit("a", true), { id: "b", projectedChecked: true, approval: { ...approval, headSha: "old" } }, crit("m", false)] });
    expect((await run("change.criteriaChecked", { context: ctx({ item: item as never, change: stale }) })).status).toBe("fail");
  });

  test("both are pure checks reading item and change", () => {
    for (const name of ["change.criteriaInSync", "change.criteriaChecked"]) {
      const def = registry.require(name);
      expect([def.kind, def.reads, def.writes, def.invalidates]).toEqual(["check", ["item", "change"], [], []]);
    }
  });
});
