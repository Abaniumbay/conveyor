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
    expect(store.schemaVersion()).toBe(3);

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
      sourceState: "closed",
      sourceStateReason: "completed",
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
      sourceState: "closed",
      sourceStateReason: "completed",
      labels: ["conveyor", "backend"],
      sourceUpdatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(store.getIssue("issue-1")).toMatchObject({
      title: "Edited title",
      labels: ["backend", "conveyor"],
      queueRank: 42.5,
      sourceStateReason: "completed",
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
    store.moveQueueIssue("issue-2", "up");
    expect(store.listIssues("repo-1").map((issue) => issue.id)).toEqual([
      "issue-2",
      "issue-1",
    ]);
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

  test("tracks enrollment generations, workspaces, and durable stage state", async () => {
    const store = await openStore();
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
      sourceNumber: 1,
      sourceUrl: "https://example.test/1",
      title: "Feature",
      body: "",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });

    const first = store.activateEnrollment("issue-1");
    expect(store.activateEnrollment("issue-1")).toEqual(first);
    store.recordWorkspace({
      id: "workspace-1",
      enrollmentId: first.id,
      path: "/tmp/worktree",
      branch: "conveyor/1-r1-feature",
      status: "active",
    });
    store.setStageState({
      issueId: "issue-1",
      stageId: "refinement",
      status: "ready",
      feedbackCycle: 0,
      configHash: "config-hash",
    });

    expect(store.getActiveWorkspace("issue-1")).toMatchObject({
      id: "workspace-1",
      generation: 1,
    });
    expect(store.getStageState("issue-1")).toMatchObject({
      stageId: "refinement",
      status: "ready",
    });
    store.upsertPullRequest({
      issueId: "issue-1",
      id: "github:owner/sample#pr-9",
      number: 9,
      url: "https://example.test/pull/9",
      state: "merged",
      mergedAt: "2026-01-02T00:00:00Z",
    });
    expect(store.hasMergedPullRequest("issue-1")).toBe(true);

    store.endActiveEnrollment("issue-1", "offboarded");
    const second = store.activateEnrollment("issue-1");
    expect(second.generation).toBe(2);
    expect(second.id).not.toBe(first.id);
    store.close();
  });

  test("finishes runs with usage and exposes cost totals", async () => {
    const store = await openStore();
    store.createRun({
      id: "run-1",
      issueId: null,
      stageId: "review",
      attempt: 1,
      kind: "verifier",
      status: "running",
      configHash: "config-hash",
      startedAt: "2026-01-01T00:00:00Z",
    });
    store.finishRun("run-1", {
      status: "succeeded",
      exitCode: 0,
      result: { decision: "pass" },
      sessionId: "thread-1",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 5,
        amount: 0,
        currency: "USD",
        source: "unavailable",
        durationMs: 1200,
      },
    });

    expect(store.getRun("run-1")).toMatchObject({
      status: "succeeded",
      sessionId: "thread-1",
      result: { decision: "pass" },
    });
    expect(store.costSummary()).toEqual({
      runs: 1,
      amount: 0,
      currency: "USD",
      durationMs: 1200,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 5,
      unavailableRuns: 1,
    });
    store.close();
  });

  test("recovers interrupted runs and makes running stages ready after restart", async () => {
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
      sourceNumber: 1,
      sourceUrl: "https://example.test/1",
      title: "Feature",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:implementation"],
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setStageState({
      issueId: "issue-1",
      stageId: "implementation",
      status: "running",
      feedbackCycle: 1,
      configHash: "old-config-hash",
    });
    store.createRun({
      id: "orphaned-run",
      issueId: "issue-1",
      stageId: "implementation",
      attempt: 1,
      kind: "producer",
      status: "running",
      configHash: "old-config-hash",
      startedAt: "2026-01-01T00:00:00Z",
    });

    expect(store.recoverInterruptedExecutions("config-hash")).toEqual({
      runs: 1,
      stages: 1,
    });
    expect(store.getRun("orphaned-run")).toMatchObject({
      status: "interrupted",
      result: { reason: "Conveyor restarted before this run completed." },
    });
    expect(store.getStageState("issue-1")).toMatchObject({
      stageId: "implementation",
      status: "ready",
      feedbackCycle: 1,
      configHash: "config-hash",
    });
    expect(store.costSummary()).toMatchObject({ runs: 1, unavailableRuns: 1 });
    expect(store.recoverInterruptedExecutions("config-hash")).toEqual({
      runs: 0,
      stages: 0,
    });
    store.close();
  });

  test("persists one structured open question per issue and its answer", async () => {
    const store = await openStore();
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
      sourceNumber: 1,
      sourceUrl: "https://example.test/1",
      title: "Feature",
      body: "",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });

    const question = store.openQuestion({
      issueId: "issue-1",
      runId: null,
      prompt: "Which layout?",
      reason: "Both are valid",
      options: [{ id: "compact", label: "Compact" }],
    });
    expect(store.listOpenQuestions()).toEqual([question]);
    store.answerQuestion(question.id, "web", { selections: ["compact"] });

    expect(store.listOpenQuestions()).toEqual([]);
    expect(store.getQuestion(question.id)).toMatchObject({
      status: "answered",
      answer: { selections: ["compact"] },
    });
    store.close();
  });
});
