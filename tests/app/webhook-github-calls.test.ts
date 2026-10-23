import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { CodeHostRegistry } from "../../src/codehost/registry";
import type { CodeHost } from "../../src/codehost/types";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const LABELS = {
  enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }, metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
};

/** One repository with one enrolled issue, and a GitHub fake that records what Conveyor reads and writes. */
async function service(options: { second?: boolean; pipeline?: "merge-action" | "multiple-boundaries" | "wait-only" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-webhook-calls-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "worktrees"), runners: 1, labelPrefix: "conveyor" },
    web: { listen: "127.0.0.1:7788" },
    sources: { github: { type: "github", webhookPath: "/hooks/github", webhookSecret: "secret" } },
    labels: LABELS,
    pipelines: { default: {
      successStatuses: ["done"],
      failureStatuses: ["blocked"],
      stages: options.pipeline === "merge-action"
        ? [
          { id: "review", actions: [], exitGate: [], concurrency: 1 },
          { id: "merge", actions: [{ id: "mergeChange", task: "change.merge" }], exitGate: [], concurrency: 1 },
          { id: "deploy", actions: [], exitGate: [], concurrency: 1 },
        ]
        : options.pipeline === "wait-only"
          ? [
            { id: "review", actions: [], exitGate: [], concurrency: 1 },
            { id: "awaiting-merge", actions: [], exitGate: [{ task: "change.merged" }], concurrency: 1 },
            { id: "deploy", actions: [], exitGate: [], concurrency: 1 },
          ]
          : options.pipeline === "multiple-boundaries"
            ? [
              { id: "review", actions: [], exitGate: [], concurrency: 1 },
              { id: "merge", actions: [{ id: "mergeChange", task: "change.merge" }], exitGate: [], concurrency: 1 },
              { id: "awaiting-merge", actions: [], exitGate: [{ task: "change.merged" }], concurrency: 1 },
              { id: "deploy", actions: [], exitGate: [], concurrency: 1 },
            ]
        : [{ id: "work", run: { type: "agent", agent: "a" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }],
    } },
    repositories: {
      repo: { source: "github", address: "owner/repo", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [], ci: { mode: "disabled" } },
    },
    agents: {},
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: "h" });
  const issue = {
    id: "github:owner/repo#1", number: 1, url: "https://github.com/owner/repo/issues/1", title: "One", body: "",
    state: "open" as "open" | "closed", stateReason: null as string | null, labels: ["conveyor", "conveyor:work"], updatedAt: "2026-10-07T20:00:00Z",
  };
  const second = { ...issue, id: "github:owner/repo#2", number: 2, url: "https://github.com/owner/repo/issues/2", title: "Two" };
  const issues = options.second ? [issue, second] : [issue];
  const calls = { listed: [] as Array<string | undefined>, fetched: [] as number[], changeReads: [] as string[], labelWrites: [] as Array<{ issue: number; labels: string[] }>, subIssues: 0, dependencies: 0, relationshipReads: [] as number[], statusWrites: [] as Array<{ issue: number; known: number | undefined }> };
  let listingGate: Promise<void> | null = null;
  let omitFromPartialListing = false;
  const rejectedFetches = new Set<number>();
  const github = {
    async listIssues(_address: string, options: { since?: string } = {}) {
      calls.listed.push(options.since);
      if (listingGate) await listingGate;
      return omitFromPartialListing && options.since !== undefined ? [] : issues;
    },
    async getIssue(_address: string, issueNumber: number) {
      calls.fetched.push(issueNumber);
      if (rejectedFetches.has(issueNumber)) throw new Error("not found");
      return issue;
    },
    async getIssueProvenance() {
      return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } };
    },
    async collaboratorPermission() { return "write" as const; },
    async replaceConveyorLabels(_address: string, issueNumber: number, labels: readonly string[]) {
      calls.labelWrites.push({ issue: issueNumber, labels: [...labels] });
    },
    async listSubIssues(_address: string, issueNumber: number) { calls.subIssues += 1; calls.relationshipReads.push(issueNumber); return []; },
    async listDependencies() { calls.dependencies += 1; return []; },
    async upsertStatusComment(_address: string, issueNumber: number, _markdown: string, known?: number) {
      calls.statusWrites.push({ issue: issueNumber, known });
      return 42;
    },
  };
  const codeHost: CodeHost = {
    async pushBranch() { throw new Error("not expected"); },
    async ensureChange() { throw new Error("not expected"); },
    async getChange() { throw new Error("not expected"); },
    async readFileAtRevision() { throw new Error("not expected"); },
    sourceFileUrl() { return "https://example.com/change"; },
    async mergeChange() { throw new Error("not expected"); },
    async setChangeChecklist() { throw new Error("not expected"); },
    async setChangeDescription() { throw new Error("not expected"); },
    async getChangeDelivery(input) {
      calls.changeReads.push(input.id);
      return {
        change: {
          id: input.id, number: 23, url: "https://example.com/changes/23", state: "merged",
          headSha: "head", draft: false, mergeable: true, mergedAt: "2026-10-07T21:00:00Z",
        },
        checks: [],
      };
    },
    async createFinding() { throw new Error("not expected"); },
    async resolveFindingProjection() { throw new Error("not expected"); },
    async resolveNativeFinding() { throw new Error("not expected"); },
    async deleteBranch() { throw new Error("not expected"); },
    async listReviewArtifacts() { throw new Error("not expected"); },
  };
  const conveyor = new ConveyorService(config, store, github as never, {
    codeHosts: new CodeHostRegistry().register("github", codeHost),
  });
  conveyor.drain("tests: nothing executes");
  let delivery = 0;
  const deliver = (event: string, payload: Record<string, unknown> = {}) => {
    const body = new TextEncoder().encode(JSON.stringify({ repository: { full_name: "owner/repo" }, ...payload }));
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    return conveyor.handleWebhook(body, new Headers({ "x-hub-signature-256": signature, "x-github-delivery": `d${(delivery += 1)}`, "x-github-event": event }));
  };
  /** Holds the next issue listing open until the returned function is called. */
  const holdListing = () => {
    let release = () => {};
    listingGate = new Promise<void>((resolve) => { release = resolve; });
    return () => { listingGate = null; release(); };
  };
  return {
    conveyor, store, calls, deliver, holdListing, issue, second,
    omitFromPartialListing: () => { omitFromPartialListing = true; },
    rejectFetchFor: (issueNumber: number) => { rejectedFetches.add(issueNumber); },
  };
}

describe("GitHub calls made for webhook deliveries", () => {
  test("a person-merged current change continues a closed review item at its post-merge stage", async () => {
    const { conveyor, store, calls, deliver, issue } = await service({ pipeline: "merge-action" });
    issue.labels = ["conveyor", "conveyor:review"];
    await conveyor.reconcileAll();
    store.activateEnrollment(issue.id);
    store.upsertPullRequest({
      issueId: issue.id,
      id: "github:owner/repo#pr-23",
      number: 23,
      url: "https://example.com/changes/23",
      state: "open",
    });
    issue.state = "closed";
    issue.updatedAt = "2026-10-07T21:00:00Z";

    await deliver("pull_request", {
      action: "closed",
      pull_request: {
        number: 23,
        merged: true,
        head: { sha: "head" },
      },
    });
    await conveyor.webhooksSettled();

    expect(calls.fetched).toEqual([1]);
    expect(calls.changeReads).toEqual(["github:owner/repo#pr-23"]);
    expect(calls.labelWrites).toEqual([{ issue: 1, labels: ["conveyor", "conveyor:deploy"] }]);
    expect(store.getCurrentPullRequest(issue.id)).toMatchObject({ state: "merged", mergedAt: "2026-10-07T21:00:00Z" });
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "deploy", projectedState: "active", warning: null });
    store.close();
  });

  test("a person-merged change webhook continues a closed item blocked at a wait-only merged gate", async () => {
    const { conveyor, store, calls, deliver, issue } = await service({ pipeline: "wait-only" });
    issue.labels = ["conveyor", "conveyor:awaiting-merge", "conveyor:blocked"];
    await conveyor.reconcileAll();
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "awaiting-merge", projectedState: "blocked" });
    store.activateEnrollment(issue.id);
    store.upsertPullRequest({
      issueId: issue.id,
      id: "github:owner/repo#pr-23",
      number: 23,
      url: "https://example.com/changes/23",
      state: "open",
    });
    issue.state = "closed";
    issue.updatedAt = "2026-10-07T21:00:00Z";

    await deliver("pull_request", {
      action: "closed",
      pull_request: { number: 23, merged: true, head: { sha: "head" } },
    });
    await conveyor.webhooksSettled();

    expect(calls.labelWrites).toEqual([{ issue: 1, labels: ["conveyor", "conveyor:deploy"] }]);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "deploy", projectedState: "active", warning: null });
    store.close();
  });

  test("a merged change webhook does not move an item beyond its last merge boundary backward", async () => {
    const { conveyor, store, calls, deliver, issue } = await service({ pipeline: "wait-only" });
    issue.labels = ["conveyor", "conveyor:deploy"];
    await conveyor.reconcileAll();
    store.activateEnrollment(issue.id);
    store.upsertPullRequest({
      issueId: issue.id,
      id: "github:owner/repo#pr-23",
      number: 23,
      url: "https://example.com/changes/23",
      state: "open",
    });
    issue.state = "closed";
    issue.updatedAt = "2026-10-07T21:00:00Z";

    await deliver("pull_request", {
      action: "closed",
      pull_request: { number: 23, merged: true, head: { sha: "head" } },
    });
    await conveyor.webhooksSettled();

    expect(calls.labelWrites).toEqual([]);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "deploy", projectedState: "active", warning: null });
    store.close();
  });

  test("a person-merged change webhook skips every merge boundary after a blocked pre-merge item", async () => {
    const { conveyor, store, calls, deliver, issue } = await service({ pipeline: "multiple-boundaries" });
    issue.labels = ["conveyor", "conveyor:review", "conveyor:blocked"];
    await conveyor.reconcileAll();
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "review", projectedState: "blocked" });
    store.activateEnrollment(issue.id);
    store.upsertPullRequest({
      issueId: issue.id,
      id: "github:owner/repo#pr-23",
      number: 23,
      url: "https://example.com/changes/23",
      state: "open",
    });
    issue.state = "closed";
    issue.updatedAt = "2026-10-07T21:00:00Z";

    await deliver("pull_request", {
      action: "closed",
      pull_request: { number: 23, merged: true, head: { sha: "head" } },
    });
    await conveyor.webhooksSettled();

    expect(calls.labelWrites).toEqual([{ issue: 1, labels: ["conveyor", "conveyor:deploy"] }]);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "deploy", projectedState: "active", warning: null });
    store.close();
  });

  test("hourly recovery continues a closed item blocked at a wait-only merged gate", async () => {
    const { conveyor, store, calls, issue } = await service({ pipeline: "wait-only" });
    issue.labels = ["conveyor", "conveyor:awaiting-merge", "conveyor:blocked"];
    await conveyor.reconcileAll();
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "awaiting-merge", projectedState: "blocked" });
    store.activateEnrollment(issue.id);
    store.upsertPullRequest({
      issueId: issue.id,
      id: "github:owner/repo#pr-23",
      number: 23,
      url: "https://example.com/changes/23",
      state: "open",
    });
    issue.state = "closed";
    issue.updatedAt = "2026-10-07T21:00:00Z";
    calls.fetched.length = 0;

    const now = Date.now;
    Date.now = () => now() + (61 * 60 * 1000);
    try {
      await conveyor.tick();
    } finally {
      Date.now = now;
    }

    expect(calls.fetched).toEqual([1]);
    expect(calls.changeReads).toEqual(["github:owner/repo#pr-23"]);
    expect(calls.labelWrites).toEqual([{ issue: 1, labels: ["conveyor", "conveyor:deploy"] }]);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "deploy", projectedState: "active", warning: null });
    store.close();
  });

  test("hourly recovery reads an unchanged open blocked item once and leaves it alone", async () => {
    const { conveyor, store, calls, issue } = await service();
    issue.labels = ["conveyor", "conveyor:work", "conveyor:blocked"];
    await conveyor.reconcileAll();
    calls.fetched.length = 0;
    const journey = store.listStageTransitions(issue.id);
    const now = Date.now;
    Date.now = () => now() + (61 * 60 * 1000);
    try {
      await conveyor.tick();
    } finally {
      Date.now = now;
    }

    expect(calls.fetched).toEqual([1]);
    expect(calls.changeReads).toEqual([]);
    expect(calls.labelWrites).toEqual([]);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "work", projectedState: "blocked" });
    expect(store.listStageTransitions(issue.id)).toEqual(journey);
    store.close();
  });

  test("hourly recovery does not read an item whose workflow position just changed", async () => {
    const { conveyor, store, calls, issue } = await service();
    issue.labels = ["conveyor", "conveyor:work", "conveyor:blocked"];
    await conveyor.reconcileAll();
    calls.fetched.length = 0;

    await conveyor.tick();

    expect(calls.fetched).toEqual([]);
    expect(calls.changeReads).toEqual([]);
    expect(calls.labelWrites).toEqual([]);
    store.close();
  });

  test("a closed enrolled item without a current merged change is offboarded", async () => {
    const { conveyor, store, calls, deliver, issue } = await service();
    await conveyor.reconcileAll();
    issue.state = "closed";
    issue.stateReason = "not_planned";
    issue.labels = ["conveyor", "conveyor:work", "unrelated"];
    issue.updatedAt = "2026-10-07T21:00:00Z";

    await deliver("issues", { action: "closed", issue: {
      id: 1, number: 1, html_url: issue.url, title: issue.title, body: issue.body,
      state: issue.state, state_reason: issue.stateReason, labels: issue.labels, updated_at: issue.updatedAt,
    }, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();

    expect(calls.fetched).toEqual([]);
    expect(calls.changeReads).toEqual([]);
    expect(calls.labelWrites).toEqual([{ issue: 1, labels: [] }]);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedState: "offboarded", projectedStage: null });
    store.close();
  });

  test("a closed paused item is offboarded immediately once, without a source read", async () => {
    const { conveyor, store, calls, deliver, issue } = await service();
    await conveyor.reconcileAll();
    const closed = {
      id: 1,
      number: 1,
      html_url: issue.url,
      title: issue.title,
      body: issue.body,
      state: "closed",
      state_reason: "not_planned",
      labels: ["conveyor:work", "unrelated"],
      updated_at: "2026-10-07T21:00:00Z",
    };

    await deliver("issues", { action: "closed", issue: closed, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();
    await deliver("issues", { action: "closed", issue: closed, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();

    expect(calls.fetched).toEqual([]);
    expect(calls.labelWrites).toEqual([{ issue: 1, labels: [] }]);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedState: "offboarded", projectedStage: null });
    expect(store.listStageTransitions(issue.id)).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "offboarded",
      status: "completed",
      reason: "closed without a merged change",
    })]));
    store.close();
  });

  test("a re-enrolled closed item offboards its new enrollment", async () => {
    const { conveyor, store, calls, deliver, issue } = await service();
    await conveyor.reconcileAll();
    expect(store.activateEnrollment(issue.id).generation).toBe(1);
    issue.state = "closed";
    issue.stateReason = "not_planned";
    issue.labels = ["conveyor", "conveyor:work", "unrelated"];
    issue.updatedAt = "2026-10-07T21:00:00Z";

    await deliver("issues", { action: "closed", issue: {
      id: 1, number: 1, html_url: issue.url, title: issue.title, body: issue.body,
      state: issue.state, state_reason: issue.stateReason, labels: issue.labels, updated_at: issue.updatedAt,
    }, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();

    issue.state = "open";
    issue.stateReason = null;
    issue.labels = ["conveyor", "conveyor:work", "unrelated"];
    issue.updatedAt = "2026-10-07T22:00:00Z";
    await conveyor.reconcileAll();
    expect(store.activateEnrollment(issue.id).generation).toBe(2);
    issue.state = "closed";
    issue.stateReason = "not_planned";
    issue.updatedAt = "2026-10-07T23:00:00Z";

    await deliver("issues", { action: "closed", issue: {
      id: 1, number: 1, html_url: issue.url, title: issue.title, body: issue.body,
      state: issue.state, state_reason: issue.stateReason, labels: issue.labels, updated_at: issue.updatedAt,
    }, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();

    expect(calls.labelWrites).toEqual([{ issue: 1, labels: [] }, { issue: 1, labels: [] }]);
    expect(store.listStageTransitions(issue.id).filter((transition) => transition.kind === "offboarded")).toHaveLength(2);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedState: "offboarded", projectedStage: null });
    store.close();
  });

  test("a completed parent remains done when its completed closure delivery arrives", async () => {
    const { conveyor, store, calls, deliver, issue } = await service();
    issue.labels = ["conveyor", "conveyor:work", "conveyor:done"];
    await conveyor.reconcileAll();
    issue.state = "closed";
    issue.stateReason = "completed";
    issue.updatedAt = "2026-10-07T21:00:00Z";

    await deliver("issues", { action: "closed", issue: {
      id: 1, number: 1, html_url: issue.url, title: issue.title, body: issue.body,
      state: issue.state, state_reason: issue.stateReason, labels: issue.labels, updated_at: issue.updatedAt,
    }, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();

    expect(calls.fetched).toEqual([]);
    expect(calls.labelWrites).toEqual([]);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedStage: "work", projectedState: "done", warning: null });
    store.close();
  });

  test("a paused repository retries a pending closed-item cleanup as soon as it resumes", async () => {
    const { conveyor, store, calls, deliver, issue } = await service();
    await conveyor.reconcileAll();
    conveyor.pauseRepository("repo", "maintenance", "Ada");
    issue.state = "closed";
    issue.stateReason = "not_planned";
    issue.labels = ["conveyor:work", "unrelated"];
    issue.updatedAt = "2026-10-07T21:00:00Z";
    await deliver("issues", { action: "closed", issue: {
      id: 1, number: 1, html_url: issue.url, title: issue.title, body: issue.body,
      state: issue.state, state_reason: issue.stateReason, labels: issue.labels, updated_at: issue.updatedAt,
    }, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();

    expect(calls.labelWrites).toEqual([]);
    expect(store.getIssue(issue.id)?.warning).toBe("Closed-item cleanup will resume when the repository resumes.");

    await conveyor.resumeRepository("repo");

    expect(calls.fetched).toEqual([1]);
    expect(calls.labelWrites).toEqual([{ issue: 1, labels: [] }]);
    expect(store.getIssue(issue.id)).toMatchObject({ projectedState: "offboarded", projectedStage: null });
    store.close();
  });

  test("a delivery is recorded together with what it means, by the webhook", async () => {
    const { conveyor, store, deliver } = await service();
    const after = store.events().latestSeq();
    await deliver("issues", { action: "labeled", issue: { number: 1 } });
    await conveyor.webhooksSettled();
    const recorded = store.events().read({ afterSeq: after }).filter((event) => event.type === "webhook.received" || event.type.startsWith("github."));
    expect(recorded.map((event) => [event.type, event.actor.kind, event.repositoryId])).toEqual([
      ["webhook.received", "webhook", "repo"],
      ["github.issueUpdated", "webhook", "repo"],
    ]);
    store.close();
  });

  test("a delivery nothing reacts to is recorded and reads nothing from GitHub", async () => {
    const { conveyor, store, calls, deliver } = await service();
    await deliver("deployment_status", { action: "created", deployment_status: { state: "success" } });
    await conveyor.webhooksSettled();
    expect(store.events().read({ type: "webhook.received" }).map((event) => event.payload)).toEqual([{ deliveryId: "d1", eventType: "deployment_status" }]);
    expect({ listed: calls.listed, fetched: calls.fetched, statusWrites: calls.statusWrites }).toEqual({ listed: [], fetched: [], statusWrites: [] });
    store.close();
  });


  test("Conveyor's own status-comment edits are ignored: nothing is recorded, read or written", async () => {
    const { conveyor, store, calls, deliver } = await service();
    await deliver("issue_comment", { action: "edited", issue: { number: 1 }, comment: { id: 42, body: "<!-- conveyor:status -->\n## Conveyor status" } });
    await conveyor.webhooksSettled();
    expect(calls.listed).toEqual([]);
    expect(calls.statusWrites).toEqual([]);
    // A person's comment still reconciles.
    await deliver("issue_comment", { action: "created", issue: { number: 1 }, comment: { id: 43, body: "Please also cover the empty case" } });
    await conveyor.webhooksSettled();
    expect(calls.listed).toHaveLength(1);
    store.close();
  });

  test("a burst of deliveries costs one pass plus one for those that arrived during it, which reads only recent changes", async () => {
    const { conveyor, store, calls, deliver, holdListing } = await service();
    const release = holdListing();
    await deliver("issues", { action: "labeled", issue: { number: 1 } });
    await Bun.sleep(5);
    for (let index = 0; index < 5; index += 1) await deliver("issues", { action: "edited", issue: { number: 1 } });
    release();
    await conveyor.webhooksSettled();
    expect(calls.listed).toHaveLength(2);
    // The first webhook pass has no earlier read to start from; the next reads changes since it.
    expect(calls.listed[0]).toBeUndefined();
    expect(calls.listed[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    store.close();
  });

  test("a labeled delivery refreshes its named issue when the recent listing omits it", async () => {
    const { conveyor, store, calls, deliver, issue, omitFromPartialListing } = await service();
    await conveyor.reconcileAll();
    issue.labels = ["bug"];
    omitFromPartialListing();

    await deliver("issues", { action: "labeled", issue: { number: 1 } });
    await conveyor.webhooksSettled();

    expect(calls.listed).toHaveLength(2);
    expect(calls.listed[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(calls.fetched).toEqual([1]);
    expect(store.getIssue("github:owner/repo#1")).toMatchObject({ labels: ["bug"], projectedState: "offboarded" });
    store.close();
  });

  test("an issue dependency webhook does not refresh a blocking issue in another repository", async () => {
    const { conveyor, calls, deliver } = await service();

    await deliver("issue_dependencies", {
      action: "blocked",
      blocked_issue: { number: 1 },
      blocking_issue: { number: 7 },
      blocking_issue_repo: { full_name: "other/repository" },
    });
    await conveyor.webhooksSettled();

    expect(calls.fetched).toEqual([1]);
  });

  test("a failed named issue refresh does not prevent another named issue from reconciling", async () => {
    const { conveyor, store, calls, deliver, issue, omitFromPartialListing, rejectFetchFor } = await service();
    await conveyor.reconcileAll();
    issue.labels = ["bug"];
    omitFromPartialListing();
    rejectFetchFor(2);

    await deliver("issue_dependencies", {
      action: "blocked",
      blocked_issue: { number: 1 },
      blocking_issue: { number: 2 },
    });
    await conveyor.webhooksSettled();

    expect(calls.fetched).toEqual([1, 2]);
    expect(store.getIssue("github:owner/repo#1")).toMatchObject({ labels: ["bug"], projectedState: "offboarded" });
    store.close();
  });

  test("a sub-issue webhook does not refresh a cross-repository sub-issue", async () => {
    const { conveyor, calls, deliver } = await service();

    await deliver("sub_issues", {
      action: "sub_issue_added",
      parent_issue: { number: 1 },
      parent_issue_repo: { full_name: "owner/repo" },
      sub_issue: { number: 7 },
      sub_issue_repo: { full_name: "other/repository" },
    });
    await conveyor.webhooksSettled();

    expect(calls.fetched).toEqual([1]);
  });

  test("only the status comment of the issue a delivery names is refreshed, straight to its known comment", async () => {
    const { conveyor, store, calls, deliver } = await service();
    await deliver("issues", { action: "labeled", issue: { number: 1 } });
    await conveyor.webhooksSettled();
    await deliver("issues", { action: "labeled", issue: { number: 2 } });
    await conveyor.webhooksSettled();
    await Bun.sleep(10);
    expect(calls.statusWrites).toEqual([{ issue: 1, known: undefined }]);
    store.close();
  });

  test("sub-issues and blockers of an unchanged issue are read once, and again after a relationship delivery", async () => {
    const { conveyor, store, calls, deliver } = await service();
    await deliver("issues", { action: "edited", issue: { number: 1 } });
    await conveyor.webhooksSettled();
    await deliver("issues", { action: "edited", issue: { number: 1 } });
    await conveyor.webhooksSettled();
    expect({ subIssues: calls.subIssues, dependencies: calls.dependencies }).toEqual({ subIssues: 1, dependencies: 1 });
    await deliver("sub_issues", { action: "sub_issue_added", parent_issue: { number: 1 }, sub_issue: { number: 3 } });
    await conveyor.webhooksSettled();
    expect({ subIssues: calls.subIssues, dependencies: calls.dependencies }).toEqual({ subIssues: 2, dependencies: 2 });
    store.close();
  });

  test("a webhook pass reads sub-issues and blockers only for the issues it names", async () => {
    const { conveyor, store, calls, deliver, second } = await service({ second: true });
    await conveyor.reconcileAll();
    second.updatedAt = "2026-10-08T00:00:00Z";
    calls.relationshipReads.length = 0;
    await deliver("issues", { action: "edited", issue: { number: 1 } });
    await conveyor.webhooksSettled();
    expect(calls.relationshipReads).not.toContain(2);
    store.close();
  });

  test("a relationship delivery forgets only the relationships of the issues it names", async () => {
    const { conveyor, store, calls, deliver } = await service({ second: true });
    await conveyor.reconcileAll();
    calls.relationshipReads.length = 0;
    await deliver("sub_issues", { action: "sub_issue_added", parent_issue: { number: 1 }, sub_issue: { number: 3 } });
    await conveyor.webhooksSettled();
    expect(calls.relationshipReads).toEqual([1]);
    store.close();
  });
});

describe("issue deliveries that carry the full issue", () => {
  const fullIssue = (labels: string[], updatedAt: string) => ({
    id: 1, number: 1, html_url: "https://github.com/owner/repo/issues/1", title: "One", body: "", state: "open", state_reason: null,
    labels: labels.map((name) => ({ name })), updated_at: updatedAt,
  });
  const nothingRead = (calls: { listed: unknown[]; fetched: unknown[]; subIssues: number; dependencies: number }) =>
    ({ listed: calls.listed, fetched: calls.fetched, subIssues: calls.subIssues, dependencies: calls.dependencies });

  test("a label change is applied from the delivery, with no GitHub read", async () => {
    const { conveyor, store, calls, deliver } = await service();
    await conveyor.reconcileAll();
    for (const key of ["listed", "fetched"] as const) calls[key].length = 0;
    calls.subIssues = 0;
    calls.dependencies = 0;
    await deliver("issues", { action: "labeled", issue: fullIssue(["conveyor", "conveyor:work", "priority"], "2026-10-07T21:00:00Z"), label: { name: "priority" }, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();
    expect(nothingRead(calls)).toEqual({ listed: [], fetched: [], subIssues: 0, dependencies: 0 });
    expect(store.getIssue("github:owner/repo#1")?.labels).toContain("priority");
    store.close();
  });

  test("a comment is applied from the delivery, with no GitHub read", async () => {
    const { conveyor, store, calls, deliver } = await service();
    await conveyor.reconcileAll();
    for (const key of ["listed", "fetched"] as const) calls[key].length = 0;
    await deliver("issue_comment", { action: "created", issue: fullIssue(["conveyor", "conveyor:work"], "2026-10-07T21:00:00Z"), comment: { id: 7, body: "Please cover the empty case" }, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();
    expect({ listed: calls.listed, fetched: calls.fetched }).toEqual({ listed: [], fetched: [] });
    store.close();
  });

  test("a delivery older than the stored issue changes nothing", async () => {
    const { conveyor, store, deliver } = await service();
    await conveyor.reconcileAll();
    await deliver("issues", { action: "labeled", issue: fullIssue(["conveyor", "conveyor:work", "stale"], "2026-10-07T19:00:00Z"), label: { name: "stale" }, sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();
    expect(store.getIssue("github:owner/repo#1")?.labels).not.toContain("stale");
    store.close();
  });

  test("a transfer is read from GitHub instead", async () => {
    const { conveyor, store, calls, deliver } = await service();
    await conveyor.reconcileAll();
    calls.fetched.length = 0;
    await deliver("issues", { action: "transferred", issue: fullIssue(["conveyor", "conveyor:work"], "2026-10-07T21:00:00Z"), sender: { login: "maintainer" } });
    await conveyor.webhooksSettled();
    expect(calls.fetched).toEqual([1]);
    store.close();
  });
});
