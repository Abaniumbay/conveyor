import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { CodeHostRegistry } from "../../src/codehost/registry";
import { ConveyorStore } from "../../src/db/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sourceIssue(address: string, number: number, title: string, state: "open" | "closed" = "open") {
  return {
    id: `github:${address}#${number}`, number, url: `https://example.test/${address}/${number}`, title, body: "Body",
    state, stateReason: null, labels: ["conveyor", "conveyor:implementation"], updatedAt: "2026-01-02T00:00:00Z",
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-sync-lock-"));
  temporaryDirectories.push(root);
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const repositories = {
    repo: { source: "github", address: "owner/repo", folder: root, pipeline: "default" },
    other: { source: "github", address: "owner/other", folder: root, pipeline: "default" },
  };
  const config = {
    hash: "config-hash", root,
    settings: { workspaces: path.join(root, "workspaces"), runners: 1 },
    labels: {
      enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
      states: { done: "conveyor:done", blocked: "conveyor:blocked" },
      metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
    },
    pipelines: { default: { stages: [{ id: "implementation" }, { id: "review" }] } },
    repositories,
  } as unknown as ConveyorConfig;
  for (const [id, repository] of Object.entries(repositories)) {
    store.upsertRepository({ id, configName: id, source: "github", address: repository.address, folder: root, configHash: config.hash });
  }

  // The first listing of `owner/repo` waits for `release`; every read is recorded in order.
  const reads: string[] = [];
  let release: () => void = () => {};
  let firstListingStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { firstListingStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let gated = false;
  let failNextListing = false;
  const source = {
    async listIssues(address: string) {
      reads.push(`list:${address}`);
      if (failNextListing) {
        failNextListing = false;
        throw new Error("listing failed");
      }
      if (address === "owner/repo" && !gated) {
        gated = true;
        firstListingStarted();
        await gate;
      }
      return [];
    },
    async getIssue(address: string, number: number) {
      reads.push(`get:${address}#${number}`);
      return sourceIssue(address, number, "Read title");
    },
    async getIssueProvenance() { return { enrollment: "unchanged", title: "unchanged", body: "unchanged" }; },
    async repositoryVisibility() { return "private"; },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
  };
  const codeHosts = new CodeHostRegistry();
  const mergedHost = {
    async getChangeDelivery(input: { id: string }) {
      return {
        change: { id: input.id, number: 9, url: "https://example.test/pull/9", state: "merged", mergedAt: "2026-01-04T00:00:00Z", headSha: "head", draft: false, mergeable: true },
        checks: [],
      };
    },
  };
  codeHosts.register("github", mergedHost as never);
  const service = new ConveyorService(config, store, source as never, { codeHosts });
  const internals = service as unknown as {
    reconcileRepository(repositoryId: string, options?: { partial?: boolean; only?: readonly number[] }): Promise<void>;
    reconcileOne(id: string, kind: "full" | "changed"): Promise<number>;
    reconcileClosedItem(repositoryId: string, issue: ReturnType<typeof sourceIssue>): Promise<void>;
    queueWebhookReconcile(repositoryId: string, issueNumbers: number[] | null): Promise<void>;
    applyIssueDelivery(repositoryId: string, deliveryId: string | null): Promise<boolean>;
  };
  const deliver = (deliveryId: string, number: number, title: string, state: "open" | "closed" = "open") => {
    store.recordSourceEvent({
      source: "github", deliveryId, eventType: "issues", repositoryId: "repo",
      payload: {
        action: state === "closed" ? "closed" : "edited",
        issue: { id: number, number, html_url: `https://example.test/${number}`, title, body: "Body", state, labels: ["conveyor", "conveyor:implementation"], updated_at: "2026-01-03T00:00:00Z" },
        sender: { login: "someone" },
      },
    });
  };
  return {
    store, reads, service, internals, deliver, started, release: () => release(), failNextListing: () => { failNextListing = true; },
  };
}

describe("repository sync lock", () => {
  test("a delivery for the repository is applied only after a queued webhook pass between its reads finished", async () => {
    const { store, internals, deliver, started, release } = await setup();
    deliver("d1", 7, "Delivered title");
    const pass = internals.queueWebhookReconcile("repo", null);
    await started;

    const applied = internals.applyIssueDelivery("repo", "d1");
    await settle();
    expect(store.getIssueByNumber("repo", 7)).toBeNull();

    release();
    await pass;
    expect(await applied).toBe(true);
    expect(store.getIssueByNumber("repo", 7)?.title).toBe("Delivered title");
    store.close();
  });

  test("reconcileOne started during a sync of the repository starts its reads after that sync finished", async () => {
    const { store, reads, internals, started, release } = await setup();
    const first = internals.reconcileRepository("repo");
    await started;

    const second = internals.reconcileOne("repo", "full");
    await settle();
    expect(reads).toEqual(["list:owner/repo"]);

    release();
    await Promise.all([first, second]);
    expect(reads).toEqual(["list:owner/repo", "list:owner/repo"]);
    store.close();
  });

  test("reconcileRepository with only started during a sync of the repository starts its reads after that sync finished", async () => {
    const { store, reads, internals, started, release } = await setup();
    const first = internals.reconcileRepository("repo");
    await started;

    const second = internals.reconcileRepository("repo", { only: [3] });
    await settle();
    expect(reads).toEqual(["list:owner/repo"]);

    release();
    await Promise.all([first, second]);
    expect(reads).toEqual(["list:owner/repo", "get:owner/repo#3"]);
    store.close();
  });

  test("reconcileClosedItem started during a sync of the repository applies its snapshot after that sync finished", async () => {
    const { store, internals, started, release } = await setup();
    const first = internals.reconcileRepository("repo");
    await started;

    const second = internals.reconcileClosedItem("repo", sourceIssue("owner/repo", 4, "Closed title", "closed"));
    await settle();
    expect(store.getIssueByNumber("repo", 4)).toBeNull();

    release();
    await Promise.all([first, second]);
    expect(store.getIssueByNumber("repo", 4)?.title).toBe("Closed title");
    store.close();
  });

  test("the reconcile of a change's issue started during a sync of the repository applies after that sync finished", async () => {
    const { store, internals, deliver, started, release } = await setup();
    deliver("d5", 5, "Change issue title");
    const first = internals.reconcileOne("repo", "full");
    await started;

    const second = internals.applyIssueDelivery("repo", "d5");
    await settle();
    expect(store.getIssueByNumber("repo", 5)).toBeNull();

    release();
    await Promise.all([first, second]);
    expect(store.getIssueByNumber("repo", 5)?.title).toBe("Change issue title");
    store.close();
  });

  test("syncs of two different repositories run at the same time", async () => {
    const { store, reads, internals, started, release } = await setup();
    const first = internals.reconcileRepository("repo");
    await started;

    await internals.reconcileOne("other", "full");
    expect(reads).toEqual(["list:owner/repo", "list:owner/other"]);

    release();
    await first;
    store.close();
  });

  test("a sync that throws releases the lock and the next sync of that repository runs", async () => {
    const { store, reads, internals, release, failNextListing } = await setup();
    release();
    failNextListing();
    await expect(internals.reconcileRepository("repo")).rejects.toThrow("listing failed");

    await internals.reconcileRepository("repo", { only: [2] });
    expect(reads).toEqual(["list:owner/repo", "get:owner/repo#2"]);
    store.close();
  });

  test("a sync started from inside a locked sync completes without deadlock", async () => {
    const { store, internals, deliver, release } = await setup();
    release();
    // The stored issue has a merged current change, so the closed delivery runs recoverClosedItem →
    // continueExternalMerge → reconcileClosedItem: a second sync started inside the locked delivery.
    await internals.reconcileClosedItem("repo", sourceIssue("owner/repo", 8, "Stored title"));
    const stored = store.getIssueByNumber("repo", 8)!;
    store.activateEnrollment(stored.id);
    store.upsertPullRequest({ issueId: stored.id, id: "github:pull/9", number: 9, url: "https://example.test/pull/9", state: "open" });
    deliver("d8", 8, "Stored title", "closed");

    const applied = await Promise.race([
      internals.applyIssueDelivery("repo", "d8"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadlock"), 2000)),
    ]);
    expect(applied).toBe(true);
    expect(store.getIssueByNumber("repo", 8)?.sourceState).toBe("closed");
    store.close();
  });

  test("a stage run scheduled from inside a locked delivery does not skip the lock for its own syncs", async () => {
    const { store, reads, service, internals, deliver, started, release } = await setup();
    // The stage run waits until the delivery that scheduled it has finished, then refreshes its issue.
    let startRun: () => void = () => {};
    const runMayStart = new Promise<void>((resolve) => { startRun = resolve; });
    let runRefresh: Promise<void> | null = null;
    (service as unknown as { execute(): Promise<void> }).execute = async () => {
      await runMayStart;
      runRefresh = internals.reconcileRepository("repo", { only: [3] });
      await runRefresh;
    };
    // The issue is ready in its first stage, so the delivery that updates it admits a stage run.
    store.upsertIssue({ id: "repo:9", repositoryId: "repo", sourceNumber: 9, sourceUrl: "https://example.test/9", title: "Stored title", body: "Body", sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
    store.setIssueProjection("repo:9", { stage: "implementation", state: "active", warning: null });
    store.setStageState({ issueId: "repo:9", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: "config-hash" });
    store.activateEnrollment("repo:9");
    store.setQueueRank("repo:9", 1);
    deliver("d9", 9, "Scheduled title");
    expect(await internals.applyIssueDelivery("repo", "d9")).toBe(true);

    const pass = internals.reconcileRepository("repo");
    await started;
    startRun();
    await settle();
    expect(runRefresh).not.toBeNull();
    expect(reads).toEqual(["list:owner/repo"]);

    release();
    await pass;
    await runRefresh;
    expect(reads).toEqual(["list:owner/repo", "get:owner/repo#3"]);
    store.close();
  });
});
