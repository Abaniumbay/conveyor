import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseManagedSections, upsertManagedSection } from "../../src/source/github/managed-sections";
import { dispatchTool } from "../../src/tasks/dispatch";
import type { ChangeDelivery, ChangeRequest, CodeHost, MergeChangeResult, ReviewArtifact } from "../../src/codehost/types";
import { ConveyorStore } from "../../src/db/store";
import { ReviewFindings } from "../../src/engine/review-findings";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { ChangeContext, TaskContext } from "../../src/tasks/context";
import { InfrastructureError, runTask, TaskInputError, type TaskResult } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";
import { FINDING_TYPES } from "../../src/engine/finding-types";

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
  merge?: MergeChangeResult; mergeCommitSha?: string | null; body?: string;
  artifacts?: ReviewArtifact[]; listFails?: boolean; projectFails?: boolean; nativeFails?: boolean; descriptionFails?: boolean;
  files?: Record<string, string>;
} = {}) {
  let body = state.body ?? "";
  const calls: Array<[string, unknown]> = [];
  const host: CodeHost = {
    async pushBranch(input) { calls.push(["push", input]); return state.push ?? { pushed: true }; },
    async ensureChange(input) { calls.push(["ensure", input]); return state.change ?? request(); },
    async getChange(input) { calls.push(["get", input]); return { ...(state.change ?? request()), body }; },
    async readFileAtRevision(input) { return state.files?.[input.path] ?? null; },
    sourceFileUrl(input) { return `https://example.com/${input.headSha}/${input.path}#L${input.line}`; },
    async setChangeChecklist(input) {
      calls.push(["checklist", input]);
      body = upsertManagedSection(body, "acceptance-criteria", input.markdown, parseManagedSections(body).revision);
    },
    async setChangeDescription(input) {
      if (state.descriptionFails) throw new Error("GitHub refused the description");
      const updated = upsertManagedSection(body, "description", input.markdown, parseManagedSections(body).revision);
      if (updated !== body) calls.push(["description", input]);
      body = updated;
      return { ...(state.change ?? request()), body };
    },
    async mergeChange(input) { calls.push(["merge", input]); return state.merge ?? { merged: true, sha: "merge1" }; },
    async createFinding(input) {
      calls.push(["createFinding", input]);
      if (state.projectFails) throw new Error("GitHub is down");
      return { url: `https://x/finding/${input.findingId}`, projection: input.path ? "inline:11" : "comment:12" };
    },
    async deleteBranch(input) { calls.push(["deleteBranch", input]); return "deleted"; },
    async resolveFindingProjection(input) {
      calls.push(["resolveFinding", input]);
      if (state.projectFails) throw new Error("GitHub is down");
    },
    async resolveNativeFinding(input) {
      calls.push(["resolveNative", input]);
      if (state.nativeFails) throw new Error("thread is locked");
    },
    async listReviewArtifacts(input) {
      calls.push(["listArtifacts", input]);
      if (state.listFails) throw new Error("GraphQL failed");
      return state.artifacts ?? [];
    },
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
    store, config: { repositories: { repo: { extraTrustedLogins: ["review-bot"] } } } as never, items: {} as never,
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
  headSha: "head1", baseBranch: "main", mergeable: "yes", mergeCommitSha: null, criteria: [], projectedCriterionIds: [], projectionError: null, findings: [], ...over,
});
const ctx = (over: Partial<TaskContext> = {}): Partial<TaskContext> => ({
  ...repository(), change: change(),
  checkpoints: { ciPassed: { sha: "head1", at: "t", taskInstanceId: "ci" }, reviewPassed: { sha: "head1", at: "t", taskInstanceId: "rev" } },
  ...over,
});
const cp = (sha: string) => ({ sha, at: "t", taskInstanceId: "x" });

async function verifyCriterionTestLink(name: string, source: string) {
  const w = await world({ body: PR_BODY, files: { "tests/a.test.ts": source } }, true, BODY);
  await dispatchTool(
    { name: "change.recordCriterionTests", input: { headSha: "head1", criteria: [{ criterionId: "a", tests: [{ name, file: "tests/a.test.ts" }] }] }, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
    { registry, deps: () => w.deps, liveHeadSha: async () => "head1", store: w.store },
  );
  const result = await run("change.criterionTestsVerified", { context: ctx({ item: { criteria: [{ id: "a", text: "It works", manual: false }] } as never }), deps: w.deps });
  return { result, w };
}

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
      headSha: "h9", baseBranch: "main", mergeable: "unknown", mergeCommitSha: "mc", criteria: [], projectedCriterionIds: [], projectionError: null, findings: [],
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

  test("fails an owner-updated head without a route, so the configured onFail repairs it, until CI and review pass for it", async () => {
    const w = await world({ change: request({ headSha: "head2" }) });
    const stale = await run("change.merge", { context: ctx({ change: change({ headSha: "head2" }), checkpoints: { ciPassed: cp("head1"), reviewPassed: cp("head1") } }), deps: w.deps }) as Fail;
    expect(stale.route).toBeUndefined();
    expect(stale.message).toContain("head2");
    expect(w.host.calls.some(([n]) => n === "merge")).toBe(false);

    const repaired = await run("change.merge", {
      context: ctx({ change: change({ headSha: "head2" }), checkpoints: { ciPassed: cp("head2"), reviewPassed: cp("head2") } }), deps: w.deps,
    }) as Pass;
    expect(repaired.status).toBe("pass");
    expect(w.host.calls.find(([name]) => name === "merge")![1]).toMatchObject({ expectedHeadSha: "head2" });
  });

  test("requires CI for the head only when CI is required", async () => {
    const stale = { checkpoints: { ciPassed: cp("old"), reviewPassed: cp("head1") } };
    const w = await world();
    const returned = await run("change.merge", { context: ctx(stale), deps: w.deps }) as Fail;
    expect(returned.route).toBeUndefined();
    expect(returned.message).toContain("CI");
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

  test("observes the live change first: merged elsewhere passes, a moved head fails for repair without naming a stage", async () => {
    const merged = await world({ change: request({ state: "merged" }) });
    expect((await run("change.merge", { context: ctx(), deps: merged.deps })).status).toBe("pass");
    expect(merged.host.calls.some(([n]) => n === "merge")).toBe(false);
    const moved = await world({ change: request({ headSha: "head2" }) });
    const result = await run("change.merge", { context: ctx(), deps: moved.deps }) as Fail;
    expect(result.route).toBeUndefined();
    expect(moved.host.calls.some(([n]) => n === "merge")).toBe(false);
  });

  test("a head that moves during the merge fails for repair with a clear message", async () => {
    const w = await world({ merge: { merged: false, refusal: "head-moved" } });
    const result = await run("change.merge", { context: ctx(), deps: w.deps }) as Fail;
    expect(result.route).toBeUndefined();
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
    const result = await run("change.merge", { context: ctx(), deps: w.deps }) as Fail;
    expect(result.route).toEqual({ stop: "blocked" });
    expect(result.message).toContain("not a repairable conflict");
  });

  test("fails merge-time conflicts and an outdated base for repair without naming a stage", async () => {
    for (const [refusal, expected] of [["conflict", "conflicting"], ["outdated", "outdated"]] as const) {
      const w = await world({ merge: { merged: false, refusal } });
      const result = await run("change.merge", { context: ctx(), deps: w.deps }) as Fail;
      expect(result.route).toBeUndefined();
      expect(result.message).toContain(expected);
    }
  });

  test("fails a conflict observed immediately before merge for repair without naming a stage", async () => {
    const w = await world({ change: request({ mergeable: false }) });
    const result = await run("change.merge", { context: ctx(), deps: w.deps }) as Fail;
    expect(result.route).toBeUndefined();
    expect(result.message).toContain("conflicts");
    expect(w.host.calls.some(([name]) => name === "merge")).toBe(false);
  });

  test("stops a non-conflict code-host refusal instead of retrying the repair path", async () => {
    const w = await world({ merge: { merged: false, refusal: "blocked", reason: "Branch protection denied this merge." } });
    const result = await run("change.merge", { context: ctx(), deps: w.deps }) as Fail;
    expect(result.route).toEqual({ stop: "blocked" });
    expect(result.message).toContain("Branch protection denied");
  });
});

describe("change checks", () => {
  test("criterionTestsPassed requires exact passing JUnit cases and reports missing, skipped, failed, errored, and ambiguous links", async () => {
    const w = await world();
    w.deps.config = { repositories: { repo: { ci: { junit: { artifact: "junit", path: "**/*.xml" } } } } } as never;
    w.deps.ci = { provider: () => ({
      reports: async () => [{ runId: "run", artifactId: "artifact", path: "result.xml", content: `<testsuite><testcase classname="suite.a" name="passes"/><testcase classname="suite.b" name="passes"/><testcase name="skipped"><skipped/></testcase><testcase name="failed"><failure/></testcase><testcase name="errored"><error/></testcase></testsuite>` }],
    }) as never };
    w.store.replaceCriterionTestEvidence("i1", [
      { criterionId: "pass", manual: false, tests: [{ name: "suite.a#passes", file: "tests/a.test.ts" }], recordedHead: "head1", sourceLinkHead: "head1", recordedAt: "2026-10-21T00:00:00.000Z" },
      { criterionId: "missing", manual: false, tests: [{ name: "missing", file: "tests/a.test.ts" }], recordedHead: "head1", sourceLinkHead: "head1", recordedAt: "2026-10-21T00:00:00.000Z" },
      { criterionId: "ambiguous", manual: false, tests: [{ name: "passes", file: "tests/a.test.ts" }], recordedHead: "head1", sourceLinkHead: "head1", recordedAt: "2026-10-21T00:00:00.000Z" },
      { criterionId: "skipped", manual: false, tests: [{ name: "skipped", file: "tests/a.test.ts" }], recordedHead: "head1", sourceLinkHead: "head1", recordedAt: "2026-10-21T00:00:00.000Z" },
      { criterionId: "failed", manual: false, tests: [{ name: "failed", file: "tests/a.test.ts" }], recordedHead: "head1", sourceLinkHead: "head1", recordedAt: "2026-10-21T00:00:00.000Z" },
      { criterionId: "errored", manual: false, tests: [{ name: "errored", file: "tests/a.test.ts" }], recordedHead: "head1", sourceLinkHead: "head1", recordedAt: "2026-10-21T00:00:00.000Z" },
    ]);
    const result = await run("change.criterionTestsPassed", { context: ctx({
      item: { criteria: ["pass", "missing", "ambiguous", "skipped", "failed", "errored", "manual"].map((id) => ({ id, text: id, manual: id === "manual" })) } as never,
      ci: { headSha: "head1", awaitingStart: [], runs: [{ id: "1", name: "Tests", state: "passed", url: null, rerunnable: false, hasLog: false, log: null }] } as never,
    }), deps: w.deps }) as Fail;
    expect(result.message).toContain('missing: linked test "missing" did not match');
    expect(result.message).toContain('ambiguous: linked test "passes" is ambiguous');
    expect(result.message).toContain('skipped: linked test "skipped" was skipped');
    expect(result.message).toContain('failed: linked test "failed" was failed');
    expect(result.message).toContain('errored: linked test "errored" errored');
    expect(result.message).not.toContain("manual:");
  });

  test("criterionTestsPassed decodes XML entities in names and flags duplicate qualified cases as ambiguous", async () => {
    const w = await world();
    w.deps.config = { repositories: { repo: { ci: { junit: { artifact: "junit", path: "**/*.xml" } } } } } as never;
    w.deps.ci = { provider: () => ({
      reports: async () => [{ runId: "run", artifactId: "artifact", path: "result.xml", content: `<testsuite><testcase classname="check-config" name="shows each repository&apos;s &quot;q&quot; &lt;x&gt; &amp; y"/><testcase classname="dup" name="twice"/><testcase classname="dup" name="twice"><failure/></testcase></testsuite>` }],
    }) as never };
    const at = "2026-10-21T00:00:00.000Z";
    w.store.replaceCriterionTestEvidence("i1", [
      { criterionId: "entity", manual: false, tests: [{ name: `shows each repository's "q" <x> & y`, file: "tests/a.test.ts" }], recordedHead: "head1", sourceLinkHead: "head1", recordedAt: at },
      { criterionId: "dup", manual: false, tests: [{ name: "dup#twice", file: "tests/a.test.ts" }], recordedHead: "head1", sourceLinkHead: "head1", recordedAt: at },
    ]);
    const result = await run("change.criterionTestsPassed", { context: ctx({
      item: { criteria: ["entity", "dup"].map((id) => ({ id, text: id, manual: false })) } as never,
      ci: { headSha: "head1", awaitingStart: [], runs: [{ id: "1", name: "Tests", state: "passed", url: null, rerunnable: false, hasLog: false, log: null }] } as never,
    }), deps: w.deps }) as Fail;
    expect(result.message).not.toContain("entity:");
    expect(result.message).toContain('dup: linked test "dup#twice" is ambiguous');
  });

  test("criterionTestsPassed is pending for current CI and falls back when JUnit is not configured", async () => {
    const w = await world();
    w.deps.config = { repositories: { repo: { ci: { junit: { artifact: "junit", path: "report.xml" } } } } } as never;
    const pendingResult = await run("change.criterionTestsPassed", { context: ctx({ ci: { headSha: "head1", awaitingStart: [], runs: [{ id: "1", name: "Tests", state: "running", url: null, rerunnable: false, hasLog: false, log: null }] } as never }), deps: w.deps });
    expect(pendingResult.status).toBe("pending");
    w.deps.config = { repositories: { repo: { ci: {} } } } as never;
    expect((await run("change.criterionTestsPassed", { context: ctx(), deps: w.deps })).status).toBe("pass");
  });

  test("criterionTestsPassed waits for a live head change", async () => {
    const w = await world({ change: request({ headSha: "head2" }) });
    w.deps.config = { repositories: { repo: { ci: { junit: { artifact: "junit", path: "report.xml" } } } } } as never;
    const result = await run("change.criterionTestsPassed", { context: ctx({ ci: { headSha: "head1", awaitingStart: [], runs: [{ id: "1", name: "Tests", state: "passed", url: null, rerunnable: false, hasLog: false, log: null }] } as never }), deps: w.deps });
    expect(result.status).toBe("pending");
    expect(result).toMatchObject({ message: expect.stringContaining("head moved") });
  });

  test("criterionTestsPassed rejects missing and unusable configured reports", async () => {
    const w = await world();
    w.deps.config = { repositories: { repo: { ci: { junit: { artifact: "junit", path: "report.xml" } } } } } as never;
    w.deps.ci = { provider: () => ({ reports: async () => [] }) as never };
    const missing = await run("change.criterionTestsPassed", { context: ctx({ ci: { headSha: "head1", awaitingStart: [], runs: [] } as never }), deps: w.deps }) as Fail;
    expect(missing.message).toContain('No JUnit report matched artifact "junit"');
    w.deps.ci = { provider: () => ({ reports: async () => [{ runId: "run", artifactId: "artifact", path: "report.xml", content: "not xml" }] }) as never };
    const malformed = await run("change.criterionTestsPassed", { context: ctx({ ci: { headSha: "head1", awaitingStart: [], runs: [] } as never }), deps: w.deps }) as Fail;
    expect(malformed.message).toContain("report report.xml is not JUnit XML");
  });

  test("criterionTestsPassed preserves provider access failures for infrastructure retry", async () => {
    const w = await world();
    w.deps.config = { repositories: { repo: { ci: { junit: { artifact: "junit", path: "report.xml" } } } } } as never;
    w.deps.ci = { provider: () => ({ reports: async () => { throw new Error("provider unavailable"); } }) as never };
    await expect(run("change.criterionTestsPassed", { context: ctx({ ci: { headSha: "head1", awaitingStart: [], runs: [] } as never }), deps: w.deps })).rejects.toBeInstanceOf(InfrastructureError);
  });

  test("headUnchanged compares the head with the CI-passed SHA", async () => {
    expect((await run("change.headUnchanged", { context: ctx() })).status).toBe("pass");
    const moved = await run("change.headUnchanged", { context: ctx({ change: change({ headSha: "head2" }) }) }) as Fail;
    expect(moved.status).toBe("fail");
    expect(moved.message).toContain("head2");
    expect((await run("change.headUnchanged", { context: ctx({ checkpoints: { ciPassed: null, reviewPassed: null } }) })).status).toBe("fail");
    expect(await run("change.headUnchanged", { context: ctx({ change: null }) })).toEqual({ status: "fail", message: "No change request exists yet" });
  });

  test("mergeable passes while unknown (the merge decides), asks for conflicts to be resolved, and passes on yes", async () => {
    expect((await run("change.mergeable", { context: ctx({ change: change({ mergeable: "unknown" }) }) })).status).toBe("pass");
    const conflict = await run("change.mergeable", { context: ctx({ change: change({ mergeable: "no" }) }) }) as Fail;
    expect(conflict.status).toBe("fail");
    expect(conflict.message).toContain("conflicts");
    expect((await run("change.mergeable", { context: ctx() })).status).toBe("pass");
    expect(await run("change.mergeable", { context: ctx({ change: null }) })).toEqual({ status: "fail", message: "No change request exists yet" });
    expect(registry.require("change.mergeable").defaultWait).toEqual({ timeoutMs: 30 * 60_000, pollMs: 60_000 });
  });

  test("merged passes for a merged change, waits on an open change event, and explains terminal failures", async () => {
    expect((await run("change.merged", { context: ctx({ change: change({ state: "merged" }) }) })).status).toBe("pass");
    expect(await run("change.merged", { context: ctx({ change: change({ state: "open" }) }) })).toEqual({
      status: "pending",
      message: "Waiting for change request #5 to be merged",
      waitFor: { topics: ["change:o/r:5"], kind: "change" },
    });
    const closed = await run("change.merged", { context: ctx({ change: change({ state: "closed" }) }) }) as Fail;
    expect(closed.message).toContain("is closed, not merged");
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
    expect(result.output).toEqual({ change: { n: 5 }, pullRequest: null, checks: [], criteria: [] });
    expect(registry.require("change.get").kind).toBe("tool");
  });

  test("recordCriterionTests replaces only supplied evidence and projects it into the checklist", async () => {
    const w = await world({ body: PR_BODY }, true, BODY);
    const result = await dispatchTool(
      { name: "change.recordCriterionTests", input: { headSha: "head1", criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts", line: 4, description: "covers behavior" }] }] }, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
      { registry, deps: () => w.deps, liveHeadSha: async () => "head1", store: w.store },
    );
    expect(result).toEqual({ headSha: "head1" });
    expect(w.store.criterionTestEvidence("i1")).toMatchObject([{ criterionId: "a", manual: false, recordedHead: "head1", sourceLinkHead: "head1", tests: [{ name: "does work", file: "tests/a.test.ts", line: 4, description: "covers behavior" }] }]);
    expect(lastChecklist(w)).toContain("tests: does work ([tests/a.test.ts:4](https://example.com/head1/tests/a.test.ts#L4) — covers behavior)");
    const reviewerView = await run("change.get", { context: {}, deps: w.deps, input: {} }) as Pass;
    expect((reviewerView.output as { criteria: Array<{ id: string }> }).criteria.find((criterion) => criterion.id === "a")).toMatchObject({ id: "a", tests: [{ name: "does work", file: "tests/a.test.ts", line: 4, description: "covers behavior" }], recordedHead: "head1", sourceLinkHead: "head1" });

    const atomic = await run("change.recordCriterionTests", { context: {}, deps: w.deps, input: { headSha: "head1", criteria: [{ criterionId: "a", tests: [{ name: "replacement", file: "tests/a.test.ts" }] }, { criterionId: "unknown", tests: [{ name: "other", file: "tests/b.test.ts" }] }] } }) as Fail;
    expect(atomic.status).toBe("fail");
    expect(w.store.criterionTestEvidence("i1")).toMatchObject([{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts" }] }]);
  });

  test("recordCriterionTests describes test names as source text optionally qualified by class", () => {
    expect(registry.require("change.recordCriterionTests").description).toContain("name appears in its file as written, optionally qualified by its class");
  });

  test("recordCriterionTests rejects invalid batches without recording evidence", async () => {
    const w = await world({ body: PR_BODY }, true, BODY);
    const grant = { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) };
    const invalidCriteria = [
      [{ criterionId: "a", tests: [] }],
      [{ criterionId: "a", tests: [{ name: "", file: "tests/a.test.ts" }] }],
      [{ criterionId: "a", tests: [{ name: "does work", file: "../tests/a.test.ts" }] }],
      [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts", line: 0 }] }],
      [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts", description: "two\nlines" }] }],
      [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts" }] }, { criterionId: "a", tests: [{ name: "again", file: "tests/a.test.ts" }] }],
    ];
    for (const criteria of invalidCriteria) {
      await expect(dispatchTool(
        { name: "change.recordCriterionTests", input: { headSha: "head1", criteria }, actor: { id: "kaveh" } as never, grant },
        { registry, deps: () => w.deps, liveHeadSha: async () => "head1", store: w.store },
      )).rejects.toBeInstanceOf(TaskInputError);
      expect(w.store.criterionTestEvidence("i1")).toEqual([]);
    }
  });

  test("recordCriterionTests records unverified evidence before a change exists without reading source", async () => {
    const w = await world({}, false, BODY);
    const result = await dispatchTool(
      { name: "change.recordCriterionTests", input: { criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts" }] }, { criterionId: "m", manual: true }] }, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
      { registry, deps: () => w.deps, liveHeadSha: async () => null, store: w.store },
    );
    expect(result).toEqual({ headSha: null });
    expect(w.store.criterionTestEvidence("i1")).toMatchObject([
      { criterionId: "a", manual: false, tests: [{ name: "does work", file: "tests/a.test.ts" }], recordedHead: null, sourceLinkHead: null },
      { criterionId: "m", manual: true, tests: [], recordedHead: null, sourceLinkHead: null },
    ]);
    expect(w.host.calls).toEqual([]);
  });

  test("recordCriterionTests requires the live change head without replacing evidence", async () => {
    for (const input of [
      { criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts" }] }] },
      { headSha: "stale", criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts" }] }] },
    ]) {
      const w = await world({ body: PR_BODY }, true, BODY);
      w.store.replaceCriterionTestEvidence("i1", [{ criterionId: "a", manual: false, tests: [{ name: "original", file: "tests/original.test.ts" }], recordedHead: "head1", sourceLinkHead: "head1", recordedAt: "2026-01-01T00:00:00Z" }]);
      const result = await run("change.recordCriterionTests", { context: {}, deps: w.deps, input }) as Fail;
      expect(result.status).toBe("fail");
      expect(w.store.criterionTestEvidence("i1")).toMatchObject([{ criterionId: "a", tests: [{ name: "original", file: "tests/original.test.ts" }] }]);
    }
  });

  test("recordCriterionTests rejects invalid pre-change batches without recording evidence", async () => {
    const cases: unknown[] = [
      { criteria: [{ criterionId: "unknown", tests: [{ name: "does work", file: "tests/a.test.ts" }] }] },
      { criteria: [{ criterionId: "a", manual: true }] },
      ...["/tests/a.test.ts", "tests/../a.test.ts", "tests/../../a.test.ts"].map((file) => ({ criteria: [{ criterionId: "a", tests: [{ name: "does work", file }] }] })),
      { headSha: "head1", criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts" }] }] },
    ];
    for (const input of cases) {
      const w = await world({}, false, BODY);
      await expect(dispatchTool(
        { name: "change.recordCriterionTests", input, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
        { registry, deps: () => w.deps, liveHeadSha: async () => null, store: w.store },
      )).rejects.toBeInstanceOf(Error);
      expect(w.store.criterionTestEvidence("i1")).toEqual([]);
    }
  });

  test("criterionTestsVerified returns pre-change claims with missing or renamed tests to implementation", async () => {
    for (const { files, message } of [
      { files: {}, message: "a: file tests/a.test.ts is missing at head1" },
      { files: { "tests/a.test.ts": "it(\"renamed test\", () => {})" }, message: 'a: test "does work" must appear in tests/a.test.ts as written' },
    ]) {
      const w = await world({ body: PR_BODY, files }, false, BODY);
      await dispatchTool(
        { name: "change.recordCriterionTests", input: { criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts" }] }] }, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
        { registry, deps: () => w.deps, liveHeadSha: async () => null, store: w.store },
      );
      w.store.upsertPullRequest({ issueId: "i1", id: ID, number: 5, url: "https://x/pull/5", state: "open" });

      const result = await run("change.criterionTestsVerified", { context: ctx({ item: { criteria: [{ id: "a", text: "It works", manual: false }] } as never }), deps: w.deps }) as Fail;

      expect(result.status).toBe("fail");
      expect(result.message).toContain(message);
      expect(w.store.criterionTestEvidence("i1")[0]?.sourceLinkHead).toBeNull();
    }
  });

  test("criterionTestsVerified accepts class-qualified test names on separate source lines", async () => {
    const { result, w } = await verifyCriterionTestLink("MediaSampleTests.Jpeg_sample_is_classified_as_image_jpeg", "class MediaSampleTests {}\n\ntest(\"Jpeg_sample_is_classified_as_image_jpeg\", () => {})");

    expect(result.status).toBe("pass");
    expect(w.store.criterionTestEvidence("i1")[0]!.tests[0]!.line).toBe(3);
  });

  test("criterionTestsVerified accepts pytest-style path qualification without requiring the path in source", async () => {
    const { result, w } = await verifyCriterionTestLink("tests/test_media.py::test_jpeg", "def test_jpeg():\n  pass");

    expect(result.status).toBe("pass");
    expect(w.store.criterionTestEvidence("i1")[0]!.tests[0]!.line).toBe(1);
  });

  test("criterionTestsVerified accepts hash-qualified test names on separate source lines", async () => {
    const { result } = await verifyCriterionTestLink("MediaSampleTests#Jpeg_sample_is_classified_as_image_jpeg", "class MediaSampleTests {}\n\ntest(\"Jpeg_sample_is_classified_as_image_jpeg\", () => {})");

    expect(result.status).toBe("pass");
  });

  test("criterionTestsVerified accepts suite-qualified test titles on separate source lines", async () => {
    const { result } = await verifyCriterionTestLink("media > classifies jpeg", "describe(\"media\", () => {\n  it(\"classifies jpeg\", () => {});\n});");

    expect(result.status).toBe("pass");
  });

  test("criterionTestsVerified continues to accept unqualified test names", async () => {
    const { result } = await verifyCriterionTestLink("classifies jpeg", "it(\"classifies jpeg\", () => {})");

    expect(result.status).toBe("pass");
  });

  test("criterionTestsVerified rejects a qualified test whose non-path qualifier is absent", async () => {
    const { result } = await verifyCriterionTestLink("MediaSampleTests.Jpeg_sample_is_classified_as_image_jpeg", "test(\"Jpeg_sample_is_classified_as_image_jpeg\", () => {})");

    expect(result).toMatchObject({ status: "fail" });
    expect((result as Fail).message).toContain('"MediaSampleTests"');
  });

  test("criterionTestsVerified identifies the missing final test-name segment", async () => {
    const { result } = await verifyCriterionTestLink("MediaSampleTests.Jpeg_sample_is_classified_as_image_jpeg", "class MediaSampleTests {}");

    expect(result).toMatchObject({ status: "fail" });
    expect((result as Fail).message).toContain('"Jpeg_sample_is_classified_as_image_jpeg"');
    expect((result as Fail).message).toContain("must appear in tests/a.test.ts as written");
  });

  test("criterionTestsVerified requires a slash-containing final test title", async () => {
    const { result } = await verifyCriterionTestLink("media > serves image/jpeg", "describe(\"media\", () => {})");

    expect(result).toMatchObject({ status: "fail" });
    expect((result as Fail).message).toContain('"serves image/jpeg"');
  });

  test("criterionTestsVerified links a dotted final test title at its full source text", async () => {
    const { result, w } = await verifyCriterionTestLink("Suite > uses v1.5 seconds", "const delay = \"5 seconds\";\ndescribe(\"Suite\", () => {\n  it(\"uses v1.5 seconds\", () => {});\n});");

    expect(result.status).toBe("pass");
    expect(w.store.criterionTestEvidence("i1")[0]!.tests[0]!.line).toBe(3);
  });

  test("criterionTestsVerified fails unlinked, stale, and renamed evidence without naming a stage and refreshes a moved line", async () => {
    expect(registry.require("change.criterionTestsVerified")).toMatchObject({
      kind: "check", writes: [], invalidates: [],
    });
    const item = { criteria: [{ id: "a", text: "It works", manual: false }, { id: "m", text: "[Manual] Looks right", manual: true }] };
    const unlinked = await world({ body: PR_BODY }, true, BODY);
    const missing = await run("change.criterionTestsVerified", { context: ctx({ item: item as never }), deps: unlinked.deps }) as Fail;
    expect(missing.status).toBe("fail");
    expect(missing.message).toContain("a: no tests linked");
    expect(missing.route).toBeUndefined();

    const w = await world({ body: PR_BODY, files: { "tests/a.test.ts": "\n\n\nit(\"does work\", () => {})" } }, true, BODY);
    await dispatchTool(
      { name: "change.recordCriterionTests", input: { headSha: "head1", criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts", line: 1 }] }, { criterionId: "m", manual: true }] }, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
      { registry, deps: () => w.deps, liveHeadSha: async () => "head1", store: w.store },
    );
    const passed = await run("change.criterionTestsVerified", { context: ctx({ item: item as never }), deps: w.deps });
    expect(passed.status).toBe("pass");
    expect(w.store.criterionTestEvidence("i1")[0]!.tests[0]!.line).toBe(4);
    expect(w.store.criterionTestEvidence("i1")[0]!.sourceLinkHead).toBe("head1");
    expect(lastChecklist(w)).toContain("[tests/a.test.ts:4](https://example.com/head1/tests/a.test.ts#L4)");

    const absent = await world({ body: PR_BODY }, true, BODY);
    await dispatchTool(
      { name: "change.recordCriterionTests", input: { headSha: "head1", criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/missing.test.ts" }] }] }, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
      { registry, deps: () => absent.deps, liveHeadSha: async () => "head1", store: absent.store },
    );
    const missingFile = await run("change.criterionTestsVerified", { context: ctx({ item: { criteria: [{ id: "a", text: "It works", manual: false }] } as never }), deps: absent.deps }) as Fail;
    expect(missingFile.message).toContain("a: file tests/missing.test.ts is missing at head1");

    const stale = await world({ body: PR_BODY, files: { "tests/a.test.ts": "it(\"renamed test\", () => {})" } }, true, BODY);
    await dispatchTool(
      { name: "change.recordCriterionTests", input: { headSha: "head1", criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts" }] }] }, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
      { registry, deps: () => stale.deps, liveHeadSha: async () => "head1", store: stale.store },
    );
    const renamed = await run("change.criterionTestsVerified", { context: ctx({ item: { criteria: [{ id: "a", text: "It works", manual: false }] } as never }), deps: stale.deps }) as Fail;
    expect(renamed.message).toContain('a: test "does work" must appear in tests/a.test.ts as written');

    const moved = await world({ body: PR_BODY, change: request({ headSha: "head2" }) }, true, BODY);
    const changedHead = await run("change.criterionTestsVerified", { context: ctx({ item: { criteria: [{ id: "a", text: "It works", manual: false }] } as never }), deps: moved.deps }) as Fail;
    expect(changedHead.message).toContain("Change head moved from head1 to head2");
    expect(changedHead.route).toBeUndefined();
  });

  test("criterionTestsVerified uses the current Manual marker rather than recorded evidence", async () => {
    const formerlyManual = await world({ body: PR_BODY }, true, BODY);
    await dispatchTool(
      { name: "change.recordCriterionTests", input: { headSha: "head1", criteria: [{ criterionId: "m", manual: true }] }, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
      { registry, deps: () => formerlyManual.deps, liveHeadSha: async () => "head1", store: formerlyManual.store },
    );
    const missing = await run("change.criterionTestsVerified", { context: ctx({ item: { criteria: [{ id: "m", text: "Looks right", manual: false }] } as never }), deps: formerlyManual.deps }) as Fail;
    expect(missing.message).toContain("m: no tests linked");

    const nowManual = await world({ body: PR_BODY }, true, BODY);
    await dispatchTool(
      { name: "change.recordCriterionTests", input: { headSha: "head1", criteria: [{ criterionId: "m", tests: [{ name: "does work", file: "tests/missing.test.ts" }] }] }, actor: { id: "kaveh" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks: new Set(["change.recordCriterionTests"]) } },
      { registry, deps: () => nowManual.deps, liveHeadSha: async () => "head1", store: nowManual.store },
    );
    const skipped = await run("change.criterionTestsVerified", { context: ctx({ item: { criteria: [{ id: "m", text: "[Manual] Looks right", manual: true }] } as never }), deps: nowManual.deps });
    expect(skipped.status).toBe("pass");
  });

  const dispatchMetadata = (w: Awaited<ReturnType<typeof world>>, name: string, input: unknown, tasks = new Set(["change.setMetadata"]), store = w.store) =>
    dispatchTool(
      { name, input, actor: { id: "kaveh", name: "K", title: "T" } as never, grant: { runId: "run1", stageId: "implementation", issueScoped: true, actor: null, tasks } },
      { registry, deps: () => w.deps, liveHeadSha: async () => "head1", store },
    );

  test("change.setMetadata writes and reports a managed description visible through change.get", async () => {
    const w = await world();
    const result = await dispatchMetadata(w, "change.setMetadata", { description: "Why this change exists." });
    expect(result).toEqual({ pullRequest: { number: 5, url: "https://x/pull/5" }, descriptionLength: 23 });
    expect(w.host.calls.filter(([name]) => name === "description")).toHaveLength(1);
    w.deps.delivery = async () => ({ ...(await w.host.host.getChangeDelivery({ address: "o/r", id: ID })), pullRequest: null });
    const visible = await run("change.get", { context: {}, deps: w.deps, input: {} }) as Pass;
    expect((visible.output as ChangeDelivery).change.body).toContain("Why this change exists.");
    expect(w.store.listRunEvents("run1")).toEqual([]);
    expect(registry.require("change.setMetadata").mutating).toBe(true);
    expect(registry.require("change.setMetadata").description).toContain("description");
  });

  test("change.setMetadata reports the normalized stored description length", async () => {
    const w = await world();

    await expect(dispatchMetadata(w, "change.setMetadata", { description: "a\r\nb\n" })).resolves.toEqual({
      pullRequest: { number: 5, url: "https://x/pull/5" },
      descriptionLength: 3,
    });
  });

  test("change.setMetadata rejects unknown fields and descriptions longer than 32,000 characters before a provider write", async () => {
    const w = await world();
    await expect(dispatchMetadata(w, "change.setMetadata", { description: "x", title: "T", labels: ["a"] })).rejects.toThrow(/title.*labels|labels.*title/);
    await expect(dispatchMetadata(w, "change.setMetadata", { description: "x".repeat(32_001) })).rejects.toThrow("32,000");
    expect(w.host.calls.filter(([name]) => name === "description")).toEqual([]);
    await expect(dispatchMetadata(w, "change.setMetadata", { description: "x".repeat(32_000) })).resolves.toMatchObject({ descriptionLength: 32_000 });
  });

  test("change.setMetadata accepts an empty description to clear its managed section", async () => {
    const w = await world();
    await dispatchMetadata(w, "change.setMetadata", { description: "Previously explained" });
    await expect(dispatchMetadata(w, "change.setMetadata", { description: "" })).resolves.toEqual({
      pullRequest: { number: 5, url: "https://x/pull/5" }, descriptionLength: 0,
    });
    w.deps.delivery = async () => ({ ...(await w.host.host.getChangeDelivery({ address: "o/r", id: ID })), pullRequest: null });
    const delivery = (await run("change.get", { context: {}, deps: w.deps, input: {} }) as Pass).output as ChangeDelivery;
    expect(delivery.change.body).toContain("<!-- conveyor:description:start -->\n<!-- conveyor:description:end -->");
    expect(delivery.change.body).not.toContain("Previously explained");
  });

  test("change.setMetadata fails without a change, grant, or provider acceptance without claiming success", async () => {
    const noChange = await world({}, false);
    await expect(dispatchMetadata(noChange, "change.setMetadata", { description: "x" })).rejects.toThrow("No change request exists yet");
    expect(noChange.host.calls.filter(([name]) => name === "description")).toEqual([]);
    const denied = await world();
    await expect(dispatchMetadata(denied, "change.setMetadata", { description: "x" }, new Set())).rejects.toThrow("not granted");
    expect(denied.host.calls.filter(([name]) => name === "description")).toEqual([]);
    const refused = await world({ descriptionFails: true });
    await expect(dispatchMetadata(refused, "change.setMetadata", { description: "x" })).rejects.toThrow("GitHub refused the description");
  });

  test("change.setMetadata uses its source-mutation journal and safely recovers a completed provider write", async () => {
    const w = await world();
    const input = { description: "Durable explanation" };
    const first = await dispatchMetadata(w, "source.set_pull_request_metadata", input);
    const replay = await dispatchMetadata(w, "change.setMetadata", input);
    expect(replay).toEqual(first);
    expect(w.host.calls.filter(([name]) => name === "description")).toHaveLength(1);

    const crash = await world();
    const incompleteStore = {
      beginSourceMutation: crash.store.beginSourceMutation.bind(crash.store),
      completeSourceMutation() { throw new Error("simulated crash after provider write"); },
      failSourceMutation() {},
    };
    await expect(dispatchMetadata(crash, "change.setMetadata", input, new Set(["change.setMetadata"]), incompleteStore as never)).rejects.toThrow("simulated crash");
    await expect(dispatchMetadata(crash, "change.setMetadata", input)).resolves.toMatchObject({ descriptionLength: input.description.length });
    expect(crash.host.calls.filter(([name]) => name === "description")).toHaveLength(1);
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
      "  no tests linked",
      "- [ ] It is fast <!-- conveyor:criterion:b -->",
      "  no tests linked",
      "- [ ] [Manual] Looks right <!-- conveyor:criterion:m -->",
      "  no tests linked",
    ].join("\n"));
    const loaded = (await run("change.load", { context: {}, deps: w.deps }) as Pass).output as ChangeContext;
    expect(loaded.criteria).toMatchObject([
      { id: "a", manual: false, criterionManual: false, tests: [], recordedHead: null, sourceLinkHead: null, projectedChecked: true, approval: { reviewer: "reviewer-1", headSha: "head1", checkedAt: expect.any(String) } },
      { id: "b", manual: false, criterionManual: false, tests: [], recordedHead: null, sourceLinkHead: null, projectedChecked: false, approval: null },
      { id: "m", manual: false, criterionManual: true, tests: [], recordedHead: null, sourceLinkHead: null, projectedChecked: false, approval: null },
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

  test("projects unverified evidence recorded before the pull request exists", async () => {
    const w = await world({ body: PR_BODY }, false, BODY);
    const recorded = await run("change.recordCriterionTests", {
      context: {}, deps: w.deps,
      input: { criteria: [{ criterionId: "a", tests: [{ name: "does work", file: "tests/a.test.ts" }] }, { criterionId: "m", manual: true }] },
    });
    expect(recorded).toEqual({ status: "pass", output: { headSha: null } });

    await run("change.ensure", { context: repository(), deps: w.deps, config: { criteriaChecklist: true } });

    expect(lastChecklist(w)).toContain("tests: does work (tests/a.test.ts)");
    expect(lastChecklist(w)).toContain("manual");
    expect(lastChecklist(w)).not.toContain("https://example.com/");
  });
});

describe("criteria checks", () => {
  const item = { criteria: [{ id: "a", text: "x", manual: false }, { id: "b", text: "y", manual: false }, { id: "m", text: "[Manual] z", manual: true }] };
  const approval = { reviewer: "r", headSha: "head1", checkedAt: "t" };
  const crit = (id: string, approved: boolean) => ({ id, projectedChecked: approved, approval: approved ? approval : null });

  test("criteriaInSync failures are repaired by change.ensure, not by the agent", () => {
    expect(registry.require("change.criteriaInSync").repairedByActions).toBe(true);
  });

  test("criteriaInSync passes when the projection lists exactly the item's ids", async () => {
    const ok = ctx({ item: item as never, change: change({ projectedCriterionIds: ["m", "b", "a"] }) });
    expect((await run("change.criteriaInSync", { context: ok })).status).toBe("pass");
    const bad = await run("change.criteriaInSync", { context: ctx({ item: item as never, change: change({ projectedCriterionIds: ["a", "q"] }) }) }) as Fail;
    expect(bad.status).toBe("fail");
    expect(bad.message).toContain("b");
    expect(bad.message).toContain("q");
    expect(bad.message).toContain("Conveyor rewrites this checklist when it pushes the change; do not edit the pull request description.");
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

describe("criterion tools through the dispatcher", () => {
  const dispatch = (w: Awaited<ReturnType<typeof world>>, name: string, input: unknown, live = "head1") =>
    dispatchTool(
      { name, input, actor: { id: "kaveh", name: "K", title: "T" } as never, grant: { runId: "run1", stageId: "review", issueScoped: true, actor: null, tasks: new Set([name]) } },
      { registry, deps: () => w.deps, liveHeadSha: async () => live, store: w.store },
    );

  test("a stale headSha is rejected before any row is written", async () => {
    const w = await world({ body: PR_BODY }, true, BODY);
    await expect(dispatch(w, "change.checkCriterion", { criterionId: "a", headSha: "old" })).rejects.toThrow("not the current change head");
    expect(w.store.sqlite().query("SELECT COUNT(*) AS n FROM criterion_approvals").get()).toEqual({ n: 0 });
  });

  test("check, uncheck, check in one run records again (not replayed from the journal)", async () => {
    const w = await world({ body: PR_BODY }, true, BODY);
    const input = { criterionId: "a", headSha: "head1" };
    const count = () => (w.store.sqlite().query("SELECT COUNT(*) AS n FROM criterion_approvals").get() as { n: number }).n;
    await dispatch(w, "change.checkCriterion", input);
    expect(count()).toBe(1);
    await dispatch(w, "change.uncheckCriterion", input);
    expect(count()).toBe(0);
    await dispatch(w, "change.checkCriterion", input);
    expect(count()).toBe(1);
  });
});

describe("malformed PR markers and invalid criteria", () => {
  const BROKEN = "Intro\n<!-- conveyor:acceptance-criteria:start -->\n- [ ] It works <!-- conveyor:criterion:a -->\n";

  test("checkCriterion still records the approval but reports the checklist could not be updated", async () => {
    const w = await world({ body: BROKEN }, true, BODY);
    const result = await approve(w, "a") as Pass;
    expect(result.status).toBe("pass");
    expect(JSON.stringify(result.output)).toContain("could not be updated");
    expect(JSON.stringify(result.output)).toContain("malformed");
    expect(w.store.sqlite().query("SELECT COUNT(*) AS n FROM criterion_approvals").get()).toEqual({ n: 1 });
    expect(w.host.calls.some(([n]) => n === "checklist")).toBe(false);
  });

  test("change.load flags the projection error; criteriaInSync says so instead of listing missing ids", async () => {
    const w = await world({ body: BROKEN }, true, BODY);
    const loaded = (await run("change.load", { context: {}, deps: w.deps }) as Pass).output as ChangeContext;
    expect(loaded.projectionError).toContain("incomplete");
    const item = { criteria: [{ id: "a", text: "x", manual: false }] };
    const result = await run("change.criteriaInSync", { context: ctx({ item: item as never, change: loaded }) }) as Fail;
    expect(result.message).toMatch(/^PR checklist markers are malformed: .*; restore or remove the conveyor managed section$/);
  });

  test("change.ensure fails with a retry route and writes nothing", async () => {
    const w = await world({ body: BROKEN }, false, BODY);
    const result = await run("change.ensure", { context: repository(), deps: w.deps, config: { criteriaChecklist: true } }) as Fail;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("PR checklist markers are malformed");
    expect(result.route).toEqual({ retry: true });
    expect(w.host.calls.some(([n]) => n === "checklist")).toBe(false);
  });

  test("duplicate criterion ids fail as a domain failure", async () => {
    const dup = BODY.replace("conveyor:criterion:b", "conveyor:criterion:a");
    const w = await world({ body: PR_BODY }, false, dup);
    const result = await run("change.ensure", { context: repository(), deps: w.deps, config: { criteriaChecklist: true } }) as Fail;
    expect(result.status).toBe("fail");
    expect(result.message).toContain("duplicate");
  });
});

describe("approvals bound to criterion text", () => {
  test("editing a criterion's text drops its approval", async () => {
    const w = await world({ body: PR_BODY }, true, BODY);
    await approve(w, "a");
    w.store.upsertIssue({
      id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://x/7", title: "t", body: BODY.replace("It works", "It works differently"),
      sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-02T00:00:00Z",
    });
    const loaded = (await run("change.load", { context: {}, deps: w.deps }) as Pass).output as ChangeContext;
    expect(loaded.criteria[0]!.approval).toBeNull();
  });
});

describe("findings", () => {
  const actor = { id: "reviewer", name: "Reviewer", title: "Reviewer" };
  const dispatch = (w: Awaited<ReturnType<typeof world>>, name: string, input: unknown, who: typeof actor | null = actor, live = "head1") =>
    dispatchTool(
      { name, input, actor: who as never, grant: { runId: "run1", stageId: "review", issueScoped: true, actor: null, tasks: new Set([name]) } },
      { registry, deps: () => w.deps, liveHeadSha: async () => live, store: w.store },
    );
  const findings = (w: Awaited<ReturnType<typeof world>>) => new ReviewFindings(w.store.sqlite());
  const artifact = (over: Partial<ReviewArtifact> = {}): ReviewArtifact => ({
    providerKey: "thread:T1", author: "alice", trusted: true, body: "Rename", url: "https://x/t1", path: "a.ts", line: 3, resolved: false, ...over,
  });

  test("change.comment records an open agent finding first and then projects it to the code host", async () => {
    const w = await world();
    const output = await dispatch(w, "change.comment", { body: "Fix this", headSha: "head1", path: "a.ts", line: 3 }) as { findingId: string; url: string };
    const [finding] = findings(w).list("i1");
    expect(finding).toMatchObject({ id: output.findingId, state: "open", source: "agent", author: "reviewer", runId: "run1", headSha: "head1", path: "a.ts", line: 3, url: output.url, projection: "inline:11" });
    expect(w.host.calls.find(([name]) => name === "createFinding")![1]).toMatchObject({ findingId: finding!.id, body: "Fix this", headSha: "head1", path: "a.ts", line: 3 });
  });

  test("change.comment without a position makes a change-level finding", async () => {
    const w = await world();
    await dispatch(w, "change.comment", { body: "General concern", headSha: "head1" });
    expect(findings(w).list("i1")[0]).toMatchObject({ path: null, line: null, projection: "comment:12" });
  });

  test("change.comment stores any defined type and returns it with the criterion IDs through change.listFindings", async () => {
    const w = await world();
    for (const type of FINDING_TYPES) {
      const output = await dispatch(w, "change.comment", { body: `About ${type}`, headSha: "head1", type, criteria: ["AC-1", "AC-2", "AC-1"] }) as { findingId: string; type: string };
      expect(output.type).toBe(type);
      expect(findings(w).get("i1", output.findingId)).toMatchObject({ type, criterionIds: ["AC-1", "AC-2"] });
      expect(w.host.calls.filter(([name]) => name === "createFinding").at(-1)![1]).toMatchObject({ type });
    }
    const listed = await dispatch(w, "change.listFindings", {}) as { findings: { type: string; criterionIds: string[] }[] };
    expect(listed.findings.map((f) => f.type)).toEqual([...FINDING_TYPES]);
    expect(listed.findings.every((f) => f.criterionIds.join() === "AC-1,AC-2")).toBe(true);
  });

  test("change.comment without a type records general and no criteria", async () => {
    const w = await world();
    const output = await dispatch(w, "change.comment", { body: "x", headSha: "head1" }) as { findingId: string; type: string };
    expect(output.type).toBe("general");
    expect(findings(w).get("i1", output.findingId)).toMatchObject({ type: "general", criterionIds: [] });
  });

  test("change.comment rejects an unknown type before recording anything", async () => {
    const w = await world();
    await expect(dispatch(w, "change.comment", { body: "x", headSha: "head1", type: "nit" })).rejects.toBeInstanceOf(TaskInputError);
    expect(findings(w).list("i1")).toHaveLength(0);
  });

  test("a retried change.comment returns the journaled response instead of creating a second finding", async () => {
    const w = await world();
    const input = { body: "Fix this", headSha: "head1" };
    const first = await dispatch(w, "change.comment", input);
    const second = await dispatch(w, "change.comment", input);
    expect(second).toEqual(first);
    expect(findings(w).list("i1")).toHaveLength(1);
  });

  test("change.comment is rejected for a stale head before anything is recorded", async () => {
    const w = await world();
    await expect(dispatch(w, "change.comment", { body: "x", headSha: "old" })).rejects.toThrow("not the current change head");
    expect(findings(w).list("i1")).toHaveLength(0);
  });

  test("a failed projection keeps the open finding and says so", async () => {
    const w = await world({ projectFails: true });
    const output = await dispatch(w, "change.comment", { body: "Fix this", headSha: "head1" }) as { findingId: string; projection: string };
    expect(output.projection).toContain("could not be created: GitHub is down");
    expect(findings(w).get("i1", output.findingId)).toMatchObject({ state: "open", url: "" });
  });

  const kaveh = { id: "kaveh", name: "Kaveh", title: "Senior Developer" };
  const fixed = { verdict: "fixed", comment: "Renamed the field" };

  test("change.resolveFinding resolves once, replies with the verdict, head commit and agent, and is a no-op the second time", async () => {
    const w = await world();
    const { findingId } = await dispatch(w, "change.comment", { body: "Fix this", headSha: "head1", path: "a.ts", line: 3 }) as { findingId: string };
    await dispatch(w, "change.resolveFinding", { findingId, ...fixed }, kaveh);
    await dispatch(w, "change.resolveFinding", { findingId, ...fixed }, kaveh);
    expect(findings(w).get("i1", findingId)!.state).toBe("resolved");
    const projections = w.host.calls.filter(([name]) => name === "resolveFinding");
    expect(projections).toHaveLength(1);
    expect(projections[0]![1]).toMatchObject({
      findingId, projection: "inline:11", body: "Fix this", actor: "kaveh", verdict: "fixed", message: "👍 Fixed in head1 by Kaveh: Renamed the field",
    });
    expect(findings(w).events(findingId).map((e) => [e.kind, e.actor])).toEqual([["created", "reviewer"], ["resolved", "kaveh"]]);
  });

  test("an invalid finding is closed with a thumbs-down answer", async () => {
    const w = await world();
    const { findingId } = await dispatch(w, "change.comment", { body: "Use a map", headSha: "head1" }) as { findingId: string };
    await dispatch(w, "change.resolveFinding", { findingId, verdict: "invalid", comment: "The list is already keyed by id" }, kaveh);
    expect(w.host.calls.find(([name]) => name === "resolveFinding")![1]).toMatchObject({
      verdict: "invalid", message: "👎 Not changed by Kaveh (checked at head1): The list is already keyed by id",
    });
    expect(findings(w).get("i1", findingId)!.state).toBe("resolved");
  });

  test("a projection failure does not undo the resolution", async () => {
    const w = await world({ projectFails: true });
    const created = findings(w).create({ issueId: "i1", runId: "run1", author: "reviewer", headSha: "head1", body: "x" });
    findings(w).project(created.id, "u", "comment:1");
    await dispatch(w, "change.resolveFinding", { findingId: created.id, ...fixed });
    expect(w.host.calls.some(([name]) => name === "resolveFinding")).toBe(true);
    expect(findings(w).get("i1", created.id)!.state).toBe("resolved");
  });

  test("an unknown finding cannot be resolved, and a verdict and comment are required", async () => {
    const w = await world();
    await expect(dispatch(w, "change.resolveFinding", { findingId: "nope", ...fixed })).rejects.toThrow("Unknown finding");
    const created = findings(w).create({ issueId: "i1", runId: "run1", author: "reviewer", headSha: "head1", body: "x" });
    await expect(dispatch(w, "change.resolveFinding", { findingId: created.id })).rejects.toThrow();
    await expect(dispatch(w, "change.resolveFinding", { findingId: created.id, verdict: "maybe", comment: "x" })).rejects.toThrow();
  });

  test("a finding from a person or a review bot is answered and resolved on its native thread by the agent", async () => {
    const w = await world({ artifacts: [artifact({ author: "chatgpt-codex-connector" })] });
    await run("change.load", { context: {}, deps: w.deps });
    const [imported] = findings(w).list("i1");
    await dispatch(w, "change.resolveFinding", { findingId: imported!.id, verdict: "invalid", comment: "Already handled by the guard" }, kaveh);
    expect(w.host.calls.find(([name]) => name === "resolveNative")![1]).toMatchObject({
      providerKey: "thread:T1", verdict: "invalid", message: "👎 Not changed by Kaveh (checked at head1): Already handled by the guard",
    });
    expect(findings(w).get("i1", imported!.id)!.state).toBe("resolved");
    expect(w.host.calls.some(([name]) => name === "resolveFinding")).toBe(false);
  });

  test("an imported finding stays open when its native thread cannot be resolved", async () => {
    const w = await world({ artifacts: [artifact()], nativeFails: true });
    await run("change.load", { context: {}, deps: w.deps });
    const [imported] = findings(w).list("i1");
    await expect(dispatch(w, "change.resolveFinding", { findingId: imported!.id, ...fixed }, kaveh)).rejects.toThrow("thread is locked");
    expect(findings(w).get("i1", imported!.id)!.state).toBe("open");
  });

  test("an agent-resolved changes-requested review stays resolved on the next import; an unresolved thread reopens", async () => {
    const w = await world({ artifacts: [artifact({ providerKey: "review:900", path: null, line: null }), artifact({ providerKey: "thread:T2" })] });
    await run("change.load", { context: {}, deps: w.deps });
    for (const finding of findings(w).list("i1")) await dispatch(w, "change.resolveFinding", { findingId: finding.id, ...fixed }, kaveh);
    await run("change.load", { context: {}, deps: w.deps });
    const states = Object.fromEntries(findings(w).list("i1").map((finding) => [finding.providerKey, finding.state]));
    expect(states).toEqual({ "review:900": "resolved", "thread:T2": "open" });
  });

  test("change.resolveFinding cannot resolve a dismissed finding", async () => {
    const w = await world();
    const f = findings(w).create({ issueId: "i1", runId: "run1", author: "reviewer", headSha: "head1", body: "x" });
    findings(w).dismiss("i1", f.id, { actor: "human:amir", reason: "fine", at: "t" });
    await expect(dispatch(w, "change.resolveFinding", { findingId: f.id, ...fixed })).rejects.toThrow("dismissed");
    expect(findings(w).get("i1", f.id)!.state).toBe("dismissed");
  });

  test("change.listFindings lists all findings or only those in a state", async () => {
    const w = await world();
    const a = findings(w).create({ issueId: "i1", runId: "run1", author: "reviewer", headSha: "head1", body: "a" });
    findings(w).create({ issueId: "i1", runId: "run1", author: "reviewer", headSha: "head1", body: "b" });
    findings(w).resolve("i1", a.id, "kaveh");
    const all = await dispatch(w, "change.listFindings", {}) as { findings: Array<{ id: string }> };
    const open = await dispatch(w, "change.listFindings", { state: "open" }) as { findings: Array<{ body: string }> };
    expect(all.findings).toHaveLength(2);
    expect(open.findings.map((f) => f.body)).toEqual(["b"]);
  });

  test("change.listFindings re-reads native review first, so a thread resolved on the host since the last gate is not listed open", async () => {
    const host: Parameters<typeof world>[0] = { artifacts: [artifact()] };
    const w = await world(host);
    await run("change.load", { context: {}, deps: w.deps });
    const [imported] = findings(w).list("i1");
    expect(imported!.state).toBe("open");
    host.artifacts = [artifact({ resolved: true })];
    const open = await dispatch(w, "change.listFindings", { state: "open" }) as { findings: unknown[] };
    expect(open.findings).toEqual([]);
    expect(findings(w).get("i1", imported!.id)!.state).toBe("resolved");
  });

  test("change.load imports native review and puts the findings in the change context", async () => {
    const w = await world({ artifacts: [artifact()] });
    const result = await run("change.load", { context: {}, deps: w.deps }) as Pass;
    expect((result.output as ChangeContext).findings).toEqual([
      { id: expect.any(String), providerKey: "thread:T1", author: "alice", source: "human", headSha: "head1", state: "open", path: "a.ts", line: 3, url: "https://x/t1", type: "general", criterionIds: [] },
    ]);
    await run("change.load", { context: {}, deps: w.deps });
    expect(findings(w).list("i1")).toHaveLength(1);
  });

  test("change.load exposes a finding's stored type and criterion IDs", async () => {
    const w = await world();
    const finding = findings(w).create({
      issueId: "i1", runId: "run1", author: "reviewer", headSha: "head1", body: "Validate access control",
      type: "security", criterionIds: ["AC-1", "AC-4"],
    });

    const result = await run("change.load", { context: {}, deps: w.deps }) as Pass;

    expect((result.output as ChangeContext).findings).toContainEqual(expect.objectContaining({
      id: finding.id, type: "security", criterionIds: ["AC-1", "AC-4"],
    }));
  });

  test("change.load retains body-free provenance for untrusted artifacts and exposes only a trusted adoption", async () => {
    const w = await world({ artifacts: [
      artifact({ author: "outsider", trusted: false, body: "Untrusted instruction" }),
      artifact({ providerKey: "thread:T1:comment:C2", author: "review-bot", trusted: true, body: "Trusted adoption", url: "https://x/t2" }),
    ] });
    const result = await run("change.load", { context: {}, deps: w.deps }) as Pass;
    expect((result.output as ChangeContext).findings).toMatchObject([{ providerKey: "thread:T1:comment:C2", author: "review-bot" }]);
    expect(findings(w).list("i1")).toMatchObject([{ providerKey: "thread:T1:comment:C2", body: "Trusted adoption" }]);
    expect(findings(w).skippedNative("i1")).toEqual([{
      providerKey: "thread:T1", author: "outsider", url: "https://x/t1", skippedAt: expect.any(String), active: true,
    }]);
    expect(w.host.calls.find(([name]) => name === "listArtifacts")![1]).toMatchObject({ extraTrustedLogins: ["review-bot"] });
  });

  test("change.load withdraws a legacy native finding when its author is now untrusted", async () => {
    const w = await world({ artifacts: [artifact({ author: "outsider", trusted: false, body: "Do not show" })] });
    findings(w).importNative("i1", [artifact()], "head0", "t0");
    const result = await run("change.load", { context: {}, deps: w.deps }) as Pass;
    expect((result.output as ChangeContext).findings).toEqual([]);
    expect(findings(w).list("i1")[0]).toMatchObject({ state: "withdrawn", withdrawal: { reason: "provider-artifact-untrusted" } });
  });

  test("change.load carries dismissal and withdrawal audit in the context", async () => {
    const state: Parameters<typeof hostFake>[0] = { artifacts: [artifact(), artifact({ providerKey: "thread:T2" })] };
    const w = await world(state);
    await run("change.load", { context: {}, deps: w.deps });
    const [one] = findings(w).list("i1");
    findings(w).dismiss("i1", one!.id, { actor: "human:amir", reason: "ok", at: "t1" });
    state.artifacts = [artifact({ providerKey: "thread:T1" })];
    const result = await run("change.load", { context: {}, deps: w.deps }) as Pass;
    const byKey = Object.fromEntries((result.output as ChangeContext).findings.map((f) => [f.providerKey, f]));
    expect(byKey["thread:T1"]).toMatchObject({ state: "dismissed", dismissal: { actor: "human:amir", reason: "ok", at: "t1" } });
    expect(byKey["thread:T2"]).toMatchObject({ state: "withdrawn", withdrawal: { actor: "provider", reason: "provider-artifact-deleted" } });
  });

  test("a GraphQL failure while importing is an infrastructure error", async () => {
    const w = await world({ listFails: true });
    const error = await run("change.load", { context: {}, deps: w.deps }).catch((caught) => caught);
    expect(error).toBeInstanceOf(InfrastructureError);
    expect((error as Error).message).toContain("GraphQL failed");
  });

  test("change.findingsResolved passes with no open findings and lists open ones with URLs", async () => {
    const task = registry.require("change.findingsResolved");
    expect(task.kind).toBe("check");
    expect(task.checkpoint).toEqual({ name: "reviewPassed", scope: "gate" });
    const finding = (state: "open" | "resolved" | "dismissed" | "withdrawn", id: string): ChangeContext["findings"][number] =>
      ({ id, providerKey: null, author: "a", source: "agent", headSha: "head1", state, path: "a.ts", line: 3, url: `https://x/${id}`, type: "general", criterionIds: [] });
    expect((await run("change.findingsResolved", { context: ctx({ change: change({ findings: [finding("resolved", "r"), finding("dismissed", "d"), finding("withdrawn", "w")] }) }) })).status).toBe("pass");
    const failed = await run("change.findingsResolved", { context: ctx({ change: change({ findings: [finding("open", "o1"), finding("resolved", "r")] }) }) }) as Fail;
    expect(failed.status).toBe("fail");
    expect(failed.message).toContain("o1");
    expect(failed.message).toContain("https://x/o1");
    expect(failed.message).not.toContain("https://x/r");
    expect((await run("change.findingsResolved", { context: ctx({ change: null }) })).status).toBe("fail");
  });

  test("change.dismissFinding records the human, reason and time and audits it", async () => {
    const w = await world();
    const f = findings(w).create({ issueId: "i1", runId: "run1", author: "reviewer", headSha: "head1", body: "x" });
    const human = { id: "human:amir", name: "amir", title: "Operator" };
    await expect(dispatch(w, "change.dismissFinding", { findingId: f.id, reason: "  " }, human)).rejects.toThrow();
    await dispatch(w, "change.dismissFinding", { findingId: f.id, reason: "Not applicable here" }, human);
    expect(findings(w).get("i1", f.id)).toMatchObject({ state: "dismissed", dismissal: { actor: "human:amir", reason: "Not applicable here" } });
    expect(findings(w).events(f.id).at(-1)).toMatchObject({ kind: "dismissed", actor: "human:amir", reason: "Not applicable here" });
    await expect(dispatch(w, "change.dismissFinding", { findingId: f.id, reason: "again" }, human)).rejects.toThrow("not open");
    expect(registry.require("change.dismissFinding")).toMatchObject({ kind: "tool", mutating: true, journal: false });
  });
});
