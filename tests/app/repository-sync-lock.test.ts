import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { CodeHostRegistry } from "../../src/codehost/registry";
import type { CodeHost } from "../../src/codehost/types";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";
import { githubPlugins } from "../support/plugins";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const CRITERIA = "<!-- conveyor:acceptance-criteria:start -->\n- [ ] Works <!-- conveyor:criterion:works -->\n<!-- conveyor:acceptance-criteria:end -->\n";
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Two repositories, a GitHub fake that records every read in order, and a listing the test can hold open. */
async function setup(options: { runStages?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-sync-lock-"));
  directories.push(root);
  log.configure({ sinks: [] });
  
  await writeFile(path.join(root, "instructions.md"), "Work.");
  for (const name of ["repo", "other"]) await mkdir(path.join(root, name));
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources: { github: { type: github, webhookSecret: secret } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./instructions.md } }
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: implementation
        ${options.runStages ? "actions: []\n        exit-gate: [{ task: item.criteriaDefined }]" : "run: { agent: worker }"}
        concurrency: 1
repositories:
  repo: { source: github, address: owner/repo, folder: ${root}/repo, pipeline: default }
  other: { source: github, address: owner/other, folder: ${root}/other, pipeline: default }
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);

  const issue = {
    id: "github:owner/repo#1", number: 1, url: "https://github.com/owner/repo/issues/1", title: "One", body: "",
    state: "open" as "open" | "closed", stateReason: null as string | null, labels: ["conveyor", "conveyor:implementation"],
    updatedAt: "2026-10-07T20:00:00Z",
  };
  const otherIssue = { ...issue, id: "github:owner/other#1", url: "https://github.com/owner/other/issues/1" };
  const reads: string[] = [];
  const labelWrites: Array<{ issue: number; labels: string[] }> = [];
  let held: { started: () => void; gate: Promise<void> } | null = null;
  let failNextListing = false;
  let heldLabelWrite: { started: () => void; gate: Promise<void> } | null = null;
  const github = {
    async listIssues(address: string) {
      reads.push(`list:${address}`);
      // The listing reflects the source when the read starts, not when a held read is let go.
      const listed = address === "owner/repo" ? [{ ...issue }] : [{ ...otherIssue }];
      if (failNextListing) {
        failNextListing = false;
        throw new Error("listing failed");
      }
      if (address === "owner/repo" && held) {
        const { started, gate } = held;
        held = null;
        started();
        await gate;
      }
      return listed;
    },
    async getIssue(address: string, number: number) {
      reads.push(`get:${address}#${number}`);
      return { ...(address === "owner/repo" ? issue : otherIssue) };
    },
    async getIssueProvenance() {
      return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } };
    },
    async collaboratorPermission() { return "write" as const; },
    async replaceConveyorLabels(address: string, number: number, labels: readonly string[]) {
      if (heldLabelWrite) {
        const { started, gate } = heldLabelWrite;
        heldLabelWrite = null;
        started();
        await gate;
      }
      labelWrites.push({ issue: number, labels: [...labels] });
      if (address === "owner/repo") issue.labels = [...labels];
    },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async upsertStatusComment() { return 42; },
  };
  const unexpected = async () => { throw new Error("not expected"); };
  const codeHost: CodeHost = {
    pushBranch: unexpected, ensureChange: unexpected, getChange: unexpected, readFileAtRevision: unexpected,
    sourceFileUrl() { return "https://example.com/change"; },
    mergeChange: unexpected, setChangeChecklist: unexpected, setChangeDescription: unexpected,
    async getChangeDelivery(input) {
      return {
        change: {
          id: input.id, number: 23, url: "https://example.com/changes/23", state: "merged",
          headSha: "head", draft: false, mergeable: true, mergedAt: "2026-10-07T21:00:00Z",
        },
        checks: [],
      };
    },
    createFinding: unexpected, resolveFindingProjection: unexpected, resolveNativeFinding: unexpected,
    deleteBranch: unexpected, listReviewArtifacts: unexpected, listReviewThreadStates: unexpected,
  };
  const conveyor = new ConveyorService(config, store, github as never, {
    plugins: githubPlugins(config, github as never),
    codeHosts: new CodeHostRegistry().register("github", codeHost),
  });
  // Deliveries and syncs run; a stage run starts only when the test asks for it.
  if (!options.runStages) conveyor.drain("tests: nothing executes");

  let delivery = 0;
  const deliver = (event: string, payload: Record<string, unknown>, address = "owner/repo") => {
    const body = new TextEncoder().encode(JSON.stringify({ repository: { full_name: address }, ...payload }));
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    return conveyor.handleWebhook(body, new Headers({ "x-hub-signature-256": signature, "x-github-delivery": `d${(delivery += 1)}`, "x-github-event": event }));
  };
  const issueBody = (state: "open" | "closed", title: string, number = 1, updatedAt = "2026-10-08T00:00:00Z") => ({
    id: number, number, html_url: `https://github.com/owner/repo/issues/${number}`, title, body: CRITERIA, state, state_reason: null,
    labels: ["conveyor", "conveyor:implementation"], updated_at: updatedAt,
  });
  /** A relationship delivery queues a webhook pass, which lists the repository's issues. */
  const queuePass = (address = "owner/repo") => deliver("issue_dependencies", {
    action: "blocked", blocked_issue: { number: 1 }, blocking_issue: { number: 2 },
  }, address);
  /** Holds the next listing of owner/repo open; resolves `started` once it is waiting. */
  const holdListing = () => {
    let release = () => {};
    let started = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    held = { started, gate };
    return { started: waiting, release };
  };
  /** Holds the next label write open (a stage run writes labels when its step ends); resolves `started` once it is waiting. */
  const holdLabelWrite = () => {
    let release = () => {};
    let started = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    heldLabelWrite = { started, gate };
    return { started: waiting, release };
  };
  const listsOfRepo = () => reads.filter((read) => read === "list:owner/repo").length;
  return {
    conveyor, store, reads, labelWrites, issue, deliver, issueBody, queuePass, holdListing, holdLabelWrite, listsOfRepo,
    failNextListing: () => { failNextListing = true; },
  };
}

describe("repository sync lock", () => {
  test("a delivery for the repository is applied only after a queued webhook pass between its reads finished", async () => {
    const { conveyor, store, deliver, issueBody, queuePass, holdListing } = await setup();
    const { started, release } = holdListing();
    await queuePass();
    await started;

    await deliver("issues", { action: "edited", issue: issueBody("open", "Delivered title", 7), sender: { login: "maintainer" } });
    await settle();
    expect(store.getIssueByNumber("repo", 7)).toBeNull();

    release();
    await conveyor.webhooksSettled();
    expect(store.getIssueByNumber("repo", 7)?.title).toBe("Delivered title");
    store.close();
  });

  test("reconcileAll started during a sync of the repository starts its reads after that sync finished", async () => {
    const { conveyor, store, queuePass, holdListing, listsOfRepo } = await setup();
    const { started, release } = holdListing();
    await queuePass();
    await started;

    const all = conveyor.reconcileAll();
    await settle();
    expect(listsOfRepo()).toBe(1);

    release();
    await all;
    await conveyor.webhooksSettled();
    expect(listsOfRepo()).toBeGreaterThanOrEqual(2);
    store.close();
  });

  test("a refresh of one issue (pauseIssue) started during a sync of the repository starts its reads after that sync finished", async () => {
    const { conveyor, store, reads, issue, queuePass, holdListing } = await setup();
    await conveyor.reconcileAll();
    await conveyor.webhooksSettled();
    reads.length = 0;
    const { started, release } = holdListing();
    await queuePass();
    await started;

    // pauseIssue reads the live issue itself, then refreshes the stored one with a read of that issue only.
    const paused = conveyor.pauseIssue(issue.id, "maintainer");
    await settle();
    const readsWhileHeld = [...reads];
    expect(readsWhileHeld.filter((read) => read === "list:owner/repo")).toHaveLength(1);
    expect(readsWhileHeld.filter((read) => read === "get:owner/repo#1")).toHaveLength(1);

    release();
    await paused;
    expect(reads.filter((read) => read === "get:owner/repo#1").length).toBeGreaterThan(1);
    store.close();
  });

  test("a closed item's snapshot is applied only after a sync of the repository that was running finished", async () => {
    const { conveyor, store, issue, deliver, queuePass, holdListing } = await setup();
    await conveyor.reconcileAll();
    await conveyor.webhooksSettled();
    store.activateEnrollment(issue.id);
    store.upsertPullRequest({ issueId: issue.id, id: "github:owner/repo#pr-23", number: 23, url: "https://example.com/changes/23", state: "open" });
    const { started, release } = holdListing();
    await queuePass();
    await started;

    // The item closed at the source; the person-merged change is recovered and its closed snapshot applied.
    issue.state = "closed";
    issue.updatedAt = "2026-10-07T21:00:00Z";
    await deliver("pull_request", { action: "closed", pull_request: { number: 23, merged: true, head: { sha: "head" } } });
    await settle();
    expect(store.getIssue(issue.id)?.sourceState).toBe("open");

    release();
    await conveyor.webhooksSettled();
    expect(store.getIssue(issue.id)?.sourceState).toBe("closed");
    store.close();
  });

  test("the reconcile of a change's issue started during a sync of the repository applies after that sync finished", async () => {
    const { conveyor, store, deliver, issueBody, holdListing } = await setup();
    const { started, release } = holdListing();
    const all = conveyor.reconcileAll();
    await started;

    await deliver("issues", { action: "edited", issue: issueBody("open", "Change issue title", 5), sender: { login: "maintainer" } });
    await settle();
    expect(store.getIssueByNumber("repo", 5)).toBeNull();

    release();
    await all;
    await conveyor.webhooksSettled();
    expect(store.getIssueByNumber("repo", 5)?.title).toBe("Change issue title");
    store.close();
  });

  test("syncs of two different repositories run at the same time", async () => {
    const { conveyor, store, reads, queuePass, holdListing } = await setup();
    const { started, release } = holdListing();
    await queuePass();
    await started;

    await queuePass("owner/other");
    await settle();
    expect(reads).toContain("list:owner/other");
    expect(reads.filter((read) => read === "list:owner/repo")).toHaveLength(1);

    release();
    await conveyor.webhooksSettled();
    store.close();
  });

  test("a sync that throws releases the lock and the next sync of that repository runs", async () => {
    const { conveyor, store, queuePass, failNextListing, listsOfRepo } = await setup();
    failNextListing();
    await queuePass();
    await conveyor.webhooksSettled();
    expect(listsOfRepo()).toBe(1);

    await queuePass();
    await conveyor.webhooksSettled();
    expect(listsOfRepo()).toBe(2);
    store.close();
  });

  test("a sync started from inside a locked sync completes without deadlock", async () => {
    const { conveyor, store, issue, deliver, issueBody } = await setup();
    await conveyor.reconcileAll();
    await conveyor.webhooksSettled();
    store.activateEnrollment(issue.id);
    store.upsertPullRequest({ issueId: issue.id, id: "github:owner/repo#pr-23", number: 23, url: "https://example.com/changes/23", state: "open" });

    // A closed delivery is applied under the lock; the merged change then reconciles the closed item, a nested sync.
    await deliver("issues", { action: "closed", issue: issueBody("closed", "One"), sender: { login: "maintainer" } });
    const settled = await Promise.race([
      conveyor.webhooksSettled().then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadlock"), 2000)),
    ]);
    expect(settled).toBe("settled");
    expect(store.getIssue(issue.id)?.sourceState).toBe("closed");
    store.close();
  });

  test("a stage run scheduled from inside a locked delivery takes the lock for its own refresh", async () => {
    const { conveyor, store, reads, labelWrites, deliver, issueBody, queuePass, holdListing, holdLabelWrite } = await setup({ runStages: true });
    const stepEnds = holdLabelWrite();
    // The delivery is applied under the lock and admits the item: its stage run starts from inside that sync.
    await deliver("issues", { action: "edited", issue: issueBody("open", "Run me", 1), sender: { login: "maintainer" } });
    await stepEnds.started;
    await conveyor.webhooksSettled();

    // While the run's step is ending, another sync of the repository holds the lock between its reads.
    const pass = holdListing();
    await queuePass();
    await pass.started;
    const refreshesBefore = reads.filter((read) => read === "get:owner/repo#1").length;
    stepEnds.release();
    await settle();
    expect(reads.filter((read) => read === "get:owner/repo#1")).toHaveLength(refreshesBefore);

    pass.release();
    await conveyor.webhooksSettled();
    await settle();
    expect(reads.filter((read) => read === "get:owner/repo#1").length).toBeGreaterThan(refreshesBefore);
    await conveyor.close();
    store.close();
  });
});
