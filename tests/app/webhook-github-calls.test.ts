import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
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
  states: { done: "conveyor:done" }, metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
};

/** One repository with one enrolled issue, and a GitHub fake that records what Conveyor reads and writes. */
async function service() {
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
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "work", run: { type: "agent", agent: "a" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }] } },
    repositories: {
      repo: { source: "github", address: "owner/repo", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [], ci: { mode: "disabled" } },
    },
    agents: {},
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: "h" });
  const issue = {
    id: "github:owner/repo#1", number: 1, url: "https://github.com/owner/repo/issues/1", title: "One", body: "",
    state: "open" as const, stateReason: null, labels: ["conveyor", "conveyor:work"], updatedAt: "2026-10-07T20:00:00Z",
  };
  const calls = { listed: [] as Array<string | undefined>, fetched: [] as number[], subIssues: 0, dependencies: 0, statusWrites: [] as Array<{ issue: number; known: number | undefined }> };
  let listingGate: Promise<void> | null = null;
  let omitFromPartialListing = false;
  const github = {
    async listIssues(_address: string, options: { since?: string } = {}) {
      calls.listed.push(options.since);
      if (listingGate) await listingGate;
      return omitFromPartialListing && options.since !== undefined ? [] : [issue];
    },
    async getIssue(_address: string, issueNumber: number) { calls.fetched.push(issueNumber); return issue; },
    async listSubIssues() { calls.subIssues += 1; return []; },
    async listDependencies() { calls.dependencies += 1; return []; },
    async upsertStatusComment(_address: string, issueNumber: number, _markdown: string, known?: number) {
      calls.statusWrites.push({ issue: issueNumber, known });
      return 42;
    },
  };
  const conveyor = new ConveyorService(config, store, github as never);
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
  return { conveyor, store, calls, deliver, holdListing, issue, omitFromPartialListing: () => { omitFromPartialListing = true; } };
}

describe("GitHub calls made for webhook deliveries", () => {
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
});
