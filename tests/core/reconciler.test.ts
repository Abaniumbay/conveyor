import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { reconcileRepository } from "../../src/core/reconciler";
import { ConveyorStore } from "../../src/db/store";
import { ExecutionStore } from "../../src/engine/journal";
import type { SourceIssue } from "../../src/source/types";

const temporaryDirectories: string[] = [];

async function openStore(): Promise<ConveyorStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-reconcile-"));
  temporaryDirectories.push(directory);
  return ConveyorStore.open(path.join(directory, "conveyor.sqlite"));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const labels = {
  enrollment: "conveyor",
  stageTemplate: "conveyor:{stage}",
  states: { done: "conveyor:done", blocked: "conveyor:blocked" },
  metadata: {
    closable: "conveyor:closable",
    orderTemplate: "conveyor:order:{number}",
  },
};

function issue(number: number, issueLabels: string[], state: "open" | "closed" = "open"): SourceIssue {
  return {
    id: `github:owner/repo#${number}`,
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    title: `Issue ${number}`,
    body: "Body",
    state,
    labels: issueLabels,
    updatedAt: `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
  };
}

describe("reconcileRepository", () => {
  test("preserves issue identity and history when a repository address changes", async () => {
    const store = await openStore();
    const repository = {
      id: "repo",
      configName: "repo",
      source: "github",
      address: "old-owner/repo",
      folder: "/srv/repo",
    };
    const oldIssue = {
      ...issue(1, ["conveyor"]),
      id: "github:old-owner/repo#1",
      url: "https://github.com/old-owner/repo/issues/1",
    };
    await reconcileRepository({
      store,
      configHash: "hash-1",
      repository,
      stages: ["refinement"],
      labels,
      source: { async listIssues() { return [oldIssue]; } },
    });
    const enrollment = store.activateEnrollment(oldIssue.id);

    const transferredIssue = {
      ...oldIssue,
      id: "github:new-owner/repo#1",
      url: "https://github.com/new-owner/repo/issues/1",
      updatedAt: "2026-02-01T00:00:00Z",
    };
    const result = await reconcileRepository({
      store,
      configHash: "hash-2",
      repository: { ...repository, address: "new-owner/repo" },
      stages: ["refinement"],
      labels,
      source: { async listIssues() { return [transferredIssue]; } },
    });

    expect(result).toEqual({ seen: 1, enrolled: 0, offboarded: 0, missing: 0 });
    expect(store.listIssues("repo")).toHaveLength(1);
    expect(store.getIssue(oldIssue.id)).toMatchObject({
      id: oldIssue.id,
      sourceUrl: transferredIssue.url,
    });
    expect(store.getIssue(transferredIssue.id)).toBeNull();
    expect(store.activateEnrollment(oldIssue.id).id).toBe(enrollment.id);
    store.close();
  });

  test("projects source truth and queues only newly enrolled issues", async () => {
    const store = await openStore();
    const sourceIssues = [
      issue(1, ["conveyor"]),
      issue(2, ["backend"]),
      issue(3, ["conveyor", "conveyor:review"]),
    ];

    const result = await reconcileRepository({
      store,
      configHash: "hash-1",
      repository: {
        id: "repo",
        configName: "repo",
        source: "github",
        address: "owner/repo",
        folder: "/srv/repo",
      },
      stages: ["refinement", "implementation", "review"],
      labels,
      source: { async listIssues() { return sourceIssues; } },
    });

    expect(result).toEqual({ seen: 3, enrolled: 2, offboarded: 0, missing: 0 });
    expect(store.listIssues("repo").map((stored) => stored.sourceNumber)).toEqual([1, 3]);
    expect(store.getIssue(sourceIssues[0]!.id)).toMatchObject({
      projectedStage: "refinement",
      projectedState: "active",
      queueRank: 10,
    });
    expect(store.getIssue(sourceIssues[2]!.id)).toMatchObject({
      projectedStage: "review",
      queueRank: 20,
    });
    expect(store.getStageState(sourceIssues[2]!.id)).toMatchObject({
      stageId: "review",
      status: "ready",
    });
    store.close();
  });

  test("makes a known issue invisible as soon as its final Conveyor label disappears", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: {
        id: "repo",
        configName: "repo",
        source: "github",
        address: "owner/repo",
        folder: "/srv/repo",
      },
      stages: ["refinement"],
      labels,
    };
    await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor"])]; } },
    });
    const enrollment = store.activateEnrollment("github:owner/repo#1");

    const result = await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["backend"])]; } },
    });

    expect(result.offboarded).toBe(1);
    expect(store.getIssue("github:owner/repo#1")).toMatchObject({
      labels: ["backend"],
      projectedStage: null,
      projectedState: "offboarded",
      queueRank: 10,
    });
    expect(store.activateEnrollment("github:owner/repo#1").generation).toBe(
      enrollment.generation + 1,
    );
    store.close();
  });

  test("confirms an awaiting label transition before making the new stage ready", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: {
        id: "repo",
        configName: "repo",
        source: "github",
        address: "owner/repo",
        folder: "/srv/repo",
      },
      stages: ["refinement", "review"],
      labels,
    };
    await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:refinement"])]; } },
    });
    store.setStageState({
      issueId: "github:owner/repo#1",
      stageId: "review",
      status: "awaiting-source",
      feedbackCycle: 0,
      configHash: "hash-1",
    });

    await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:review"])]; } },
    });

    expect(store.getStageState("github:owner/repo#1")).toMatchObject({
      stageId: "review",
      status: "ready",
    });
    store.close();
  });

  test("stops scheduling closed and missing source issues with visible reasons", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: {
        id: "repo",
        configName: "repo",
        source: "github",
        address: "owner/repo",
        folder: "/srv/repo",
      },
      stages: ["refinement"],
      labels,
    };
    await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor"]), issue(2, ["conveyor"])]; } },
    });

    const result = await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor"], "closed")]; } },
    });

    expect(result.missing).toBe(1);
    expect(store.getIssue("github:owner/repo#1")).toMatchObject({
      projectedState: "closed",
      warning: expect.stringContaining("closed before"),
    });
    expect(store.getIssue("github:owner/repo#2")).toMatchObject({
      projectedState: "missing",
      warning: expect.stringContaining("not returned"),
    });
    store.close();
  });

  test("relabelling, pausing and offboarding fence the item once each, and a no-op pass does not", async () => {
    const store = await openStore();
    const journal = new ExecutionStore(store.sqlite());
    const id = "github:owner/repo#1";
    const common = {
      store,
      configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: "/srv/repo" },
      stages: ["refinement", "review"],
      labels,
    };
    const pass = (issueLabels: string[]) =>
      reconcileRepository({ ...common, source: { async listIssues() { return [issue(1, issueLabels)]; } } });

    await pass(["conveyor", "conveyor:refinement"]);
    store.activateEnrollment(id);
    const enrolled = journal.stageEpoch(id);

    await pass(["conveyor", "conveyor:refinement"]);
    expect(journal.stageEpoch(id)).toBe(enrolled);

    await pass(["conveyor", "conveyor:refinement", "conveyor:blocked"]);
    const paused = journal.stageEpoch(id);
    expect(paused).toBeGreaterThan(enrolled);
    await pass(["conveyor", "conveyor:refinement", "conveyor:blocked"]);
    expect(journal.stageEpoch(id)).toBe(paused);

    await pass(["conveyor", "conveyor:refinement"]);
    const resumed = journal.stageEpoch(id);
    expect(resumed).toBeGreaterThan(paused);

    await pass(["backend"]);
    expect(journal.stageEpoch(id)).toBeGreaterThan(resumed);
    store.close();
  });
});
