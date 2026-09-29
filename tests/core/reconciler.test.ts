import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { reconcileRepository } from "../../src/core/reconciler";
import { ConveyorStore } from "../../src/db/store";
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
});
