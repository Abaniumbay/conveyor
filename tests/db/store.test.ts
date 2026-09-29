import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";

const temporaryDirectories: string[] = [];

async function openStore(): Promise<ConveyorStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-store-"));
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

describe("ConveyorStore", () => {
  test("migrates a new database with durable SQLite settings", async () => {
    const store = await openStore();

    expect(store.pragma("journal_mode")).toEqual([{ journal_mode: "wal" }]);
    expect(store.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(store.schemaVersion()).toBe(1);

    store.close();
  });

  test("updates source projections without losing Conveyor queue rank", async () => {
    const store = await openStore();
    store.recordConfigSnapshot("config-hash", { version: 1 });
    store.upsertRepository({
      id: "repo-1",
      configName: "sample",
      source: "github",
      address: "owner/sample",
      folder: "/srv/sample",
      configHash: "config-hash",
    });
    store.upsertIssue({
      id: "issue-1",
      repositoryId: "repo-1",
      sourceNumber: 12,
      sourceUrl: "https://github.com/owner/sample/issues/12",
      title: "Original title",
      body: "Body",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.setQueueRank("issue-1", 42.5);

    store.upsertIssue({
      id: "issue-1",
      repositoryId: "repo-1",
      sourceNumber: 12,
      sourceUrl: "https://github.com/owner/sample/issues/12",
      title: "Edited title",
      body: "Updated body",
      sourceState: "open",
      labels: ["conveyor", "backend"],
      sourceUpdatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(store.getIssue("issue-1")).toMatchObject({
      title: "Edited title",
      labels: ["backend", "conveyor"],
      queueRank: 42.5,
    });
    store.close();
  });

  test("deduplicates webhook deliveries and source mutations", async () => {
    const store = await openStore();

    expect(
      store.recordSourceEvent({
        source: "github",
        deliveryId: "delivery-1",
        eventType: "issues",
        payload: { action: "labeled" },
      }),
    ).toBe(true);
    expect(
      store.recordSourceEvent({
        source: "github",
        deliveryId: "delivery-1",
        eventType: "issues",
        payload: { action: "labeled" },
      }),
    ).toBe(false);

    const first = store.beginSourceMutation({
      idempotencyKey: "issue-1:status-comment:v1",
      source: "github",
      operation: "comment.upsert",
      request: { issue: 1 },
    });
    const duplicate = store.beginSourceMutation({
      idempotencyKey: "issue-1:status-comment:v1",
      source: "github",
      operation: "comment.upsert",
      request: { issue: 1 },
    });

    expect(duplicate).toEqual(first);
    store.completeSourceMutation(first.id, { commentId: 99 });
    expect(store.getSourceMutation(first.id)).toMatchObject({
      status: "succeeded",
      response: { commentId: 99 },
    });
    store.close();
  });

  test("persists an ordered event timeline for a run", async () => {
    const store = await openStore();
    store.createRun({
      id: "run-1",
      issueId: null,
      stageId: "refinement",
      attempt: 1,
      kind: "producer",
      status: "running",
      configHash: "config-hash",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    store.appendRunEvent("run-1", "progress", { message: "reading issue" });
    store.appendRunEvent("run-1", "progress", { message: "writing criteria" });

    expect(store.listRunEvents("run-1").map((event) => event.payload)).toEqual([
      { message: "reading issue" },
      { message: "writing criteria" },
    ]);
    store.close();
  });

  test("lists projected issues in durable queue order", async () => {
    const store = await openStore();
    store.upsertRepository({
      id: "repo-1",
      configName: "sample",
      source: "github",
      address: "owner/sample",
      folder: "/srv/sample",
      configHash: "config-hash",
    });
    for (const [id, number, rank] of [
      ["issue-2", 2, 20],
      ["issue-1", 1, 10],
    ] as const) {
      store.upsertIssue({
        id,
        repositoryId: "repo-1",
        sourceNumber: number,
        sourceUrl: `https://example.test/${number}`,
        title: id,
        body: "",
        sourceState: "open",
        labels: ["conveyor"],
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
      });
      store.setQueueRank(id, rank);
    }
    store.setIssueProjection("issue-1", {
      stage: "refinement",
      state: "active",
      warning: null,
    });

    expect(store.nextQueueRank()).toBe(30);
    expect(store.listIssues("repo-1").map((issue) => issue.id)).toEqual([
      "issue-1",
      "issue-2",
    ]);
    expect(store.getIssue("issue-1")).toMatchObject({
      projectedStage: "refinement",
      projectedState: "active",
    });
    store.close();
  });

  test("replaces hierarchy and dependency projections transactionally", async () => {
    const store = await openStore();
    store.upsertRepository({
      id: "repo-1",
      configName: "sample",
      source: "github",
      address: "owner/sample",
      folder: "/srv/sample",
      configHash: "config-hash",
    });
    for (const [id, number] of [
      ["parent", 1],
      ["child", 2],
      ["blocker", 3],
    ] as const) {
      store.upsertIssue({
        id,
        repositoryId: "repo-1",
        sourceNumber: number,
        sourceUrl: `https://example.test/${number}`,
        title: id,
        body: "",
        sourceState: "open",
        labels: ["conveyor"],
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
      });
    }

    store.replaceRelationships("child", { parentId: "parent", siblingOrder: 2 }, [
      "blocker",
    ]);

    expect(store.getIssue("child")?.parentId).toBe("parent");
    expect(store.listDependencies("child")).toEqual(["blocker"]);
    expect(store.listChildren("parent")).toEqual([
      { issueId: "child", siblingOrder: 2 },
    ]);
    store.close();
  });
});
