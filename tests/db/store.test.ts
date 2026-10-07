import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { ItemTodos } from "../../src/engine/todos";

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
    expect(store.schemaVersion()).toBe(15);

    store.close();
  });

  test("seeds one superuser once and persists accounts, changed credentials, avatars, and session versions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-accounts-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "conveyor.sqlite");
    const store = await ConveyorStore.open(databasePath);
    store.seedDashboardSuperuser("admin", "initial-hash");
    store.seedDashboardSuperuser("admin", "restart-hash");
    const admin = store.dashboardAccountByUsername("ADMIN")!;
    expect(store.dashboardAccounts()).toHaveLength(1);
    expect(admin.passwordHash).toBe("initial-hash");
    store.changeDashboardPassword(admin.id, "changed-hash");
    store.changeDashboardAvatar(admin.id, "🦊");
    const user = store.createDashboardUser("reader", "reader-hash");
    store.close();

    const restarted = await ConveyorStore.open(databasePath);
    restarted.seedDashboardSuperuser("replacement", "replacement-hash");
    expect(restarted.dashboardAccounts()).toHaveLength(2);
    expect(restarted.dashboardAccountById(admin.id)).toMatchObject({ passwordHash: "changed-hash", avatar: "🦊", sessionVersion: 2 });
    expect(restarted.dashboardAccountByUsername("replacement")).toBeNull();
    expect(restarted.dashboardAccountById(user.id)).toMatchObject({ username: "reader", role: "user" });
    restarted.close();
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

  test("removes repositories that are no longer configured", async () => {
    const store = await openStore();
    for (const id of ["kept", "removed"]) {
      store.upsertRepository({
        id,
        configName: id,
        source: "github",
        address: `owner/${id}`,
        folder: `/srv/${id}`,
        configHash: "config-hash",
      });
      store.upsertIssue({
        id: `issue-${id}`,
        repositoryId: id,
        sourceNumber: 1,
        sourceUrl: `https://github.com/owner/${id}/issues/1`,
        title: id,
        body: "",
        sourceState: "open",
        labels: ["conveyor"],
        sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
      });
    }

    expect(store.removeRepositoriesExcept(["kept"])).toEqual(["removed"]);
    expect(store.listIssues().map((issue) => issue.id)).toEqual(["issue-kept"]);
    expect(store.removeRepositoriesExcept(["kept"])).toEqual([]);
    expect(store.removeRepositoriesExcept([])).toEqual(["kept"]);
    expect(store.listIssues()).toEqual([]);

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

  test("records an issue stage journey with correction reasons", async () => {
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
      sourceNumber: 12,
      sourceUrl: "https://github.com/owner/sample/issues/12",
      title: "Journey",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:review"],
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });

    store.beginStageTransition({
      id: "transition-1",
      issueId: "issue-1",
      fromStage: "review",
      toStage: "implementation",
      kind: "correction",
      sourceMutationId: null,
      detail: {
        reason: "Concurrent finish can return null.",
        requiredFixes: ["Return duel-ended."],
        resultStatus: "changes-requested",
      },
    });
    store.completeStageTransition("transition-1");

    expect(store.listStageTransitions("issue-1")).toMatchObject([{
      id: "transition-1",
      fromStage: "review",
      toStage: "implementation",
      kind: "correction",
      status: "completed",
      reason: "Concurrent finish can return null.",
      requiredFixes: ["Return duel-ended."],
      resultStatus: "changes-requested",
      completedAt: expect.any(String),
    }]);
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

  test("retains Claude harness events with their emitting agent across database reopen", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-harness-events-"));
    temporaryDirectories.push(directory);
    const database = path.join(directory, "conveyor.sqlite");
    let store = await ConveyorStore.open(database);
    store.createRun({
      id: "run-claude",
      issueId: null,
      stageId: "implementation",
      attempt: 1,
      kind: "producer",
      status: "running",
      configHash: "config-hash",
      startedAt: "2026-10-03T14:00:00.000Z",
    });
    store.appendRunEvent("run-claude", "execution", { agentId: "implementer" });
    store.appendRunEvent("run-claude", "harness", {
      type: "rate_limit_event",
      rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: "2026-10-10T00:00:00Z" } } },
    });
    store.appendRunEvent("run-claude", "harness", { type: "assistant", message: "ordinary stream event" });
    // Simulate opening a populated database created before the indexed quota projection existed.
    store.sqlite().exec("DROP TABLE harness_quota_events; DROP TABLE item_indicators; DELETE FROM schema_migrations WHERE version IN (14, 15);");
    store.close();

    store = await ConveyorStore.open(database);
    expect(store.listHarnessRunEvents("implementer")).toHaveLength(1);
    expect(store.listHarnessRunEvents("implementer")[0]).toMatchObject({
      createdAt: expect.any(String),
      payload: { type: "rate_limit_event" },
    });
    expect(store.listHarnessRunEvents("other-agent")).toEqual([]);
    expect(store.sqlite().query("SELECT COUNT(*) AS count FROM run_events").get()).toEqual({ count: 3 });
    expect(JSON.stringify(store.sqlite().query("EXPLAIN QUERY PLAN SELECT payload_json FROM harness_quota_events WHERE agent_id = ? ORDER BY event_id DESC LIMIT ?")
      .all("implementer", 256))).toContain("harness_quota_events_agent_idx");
    store.close();
  });

  test("limits quota events independently for each Claude agent, even with malformed recent records", async () => {
    const store = await openStore();
    store.createRun({
      id: "run-quota-history", issueId: null, stageId: "implementation", attempt: 1,
      kind: "producer", status: "running", configHash: "config-hash", startedAt: "2026-10-03T14:00:00.000Z",
    });
    store.appendRunEvent("run-quota-history", "execution", { agentId: "agent-a" });
    store.appendRunEvent("run-quota-history", "harness", { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 0.2, resetsAt: "2026-10-03T18:00:00Z" },
    } } });
    for (let index = 0; index < 300; index += 1) {
      store.appendRunEvent("run-quota-history", "harness", { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
        five_hour: { utilization: 2, resetsAt: "invalid" },
      } } });
    }

    expect(store.listHarnessRunEvents("agent-a")).toHaveLength(256);
    expect(store.listHarnessRunEvents("agent-b")).toEqual([]);
    store.close();
  });

  test("persists a concise issue conversation independently from technical run events", async () => {
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
      sourceNumber: 12,
      sourceUrl: "https://github.com/owner/sample/issues/12",
      title: "Shared handoff",
      body: "",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });

    store.appendConversationMessage({
      issueId: "issue-1",
      runId: null,
      stageId: "implementation",
      actorType: "user",
      actorId: "operator",
      actorName: "You",
      actorTitle: null,
      message: "Keep the public API backward compatible.",
    });
    store.appendConversationMessage({
      issueId: "issue-1",
      runId: null,
      stageId: "implementation",
      actorType: "agent",
      actorId: "implementer",
      actorName: "Implementer",
      actorTitle: "Senior Developer",
      message: "The API is compatible; I am running the focused tests now.",
    });

    expect(store.listConversationMessages("issue-1", 20)).toMatchObject([
      { actorType: "user", actorName: "You", message: "Keep the public API backward compatible." },
      { actorType: "agent", actorName: "Implementer", actorTitle: "Senior Developer" },
    ]);
    expect(store.listConversationMessages("issue-1", 1)).toHaveLength(1);
    expect(store.listConversationMessages("issue-1", 1)[0]?.actorName).toBe("Implementer");
    store.close();
  });

  test("trims an over-long system message to fit instead of failing, but still rejects over-long user input", async () => {
    const store = await openStore();
    store.upsertRepository({ id: "repo-1", configName: "sample", source: "github", address: "owner/sample", folder: "/srv/sample", configHash: "h" });
    store.upsertIssue({
      id: "issue-1", repositoryId: "repo-1", sourceNumber: 12, sourceUrl: "https://github.com/owner/sample/issues/12",
      title: "CI", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    const long = `CI failed at abc1234: Full suite (failed).\n${"log line\n".repeat(1_000)}`;
    for (const actorType of ["conveyor", "agent"] as const) {
      const stored = store.appendConversationMessage({
        issueId: "issue-1", runId: null, stageId: "ci", actorType, actorId: actorType, actorName: actorType, actorTitle: null, message: long,
      });
      expect(stored.message.length).toBeLessThanOrEqual(4_000);
      expect(stored.message.startsWith("CI failed at abc1234: Full suite (failed).")).toBe(true);
      expect(stored.message).toContain("characters omitted");
    }
    expect(() => store.appendConversationMessage({
      issueId: "issue-1", runId: null, stageId: "ci", actorType: "user", actorId: "op", actorName: "You", actorTitle: null, message: "x".repeat(4_001),
    })).toThrow("must not exceed 4000 characters");
    store.close();
  });

  test("separates stable board revisions from conversation and technical activity", async () => {
    const store = await openStore();
    store.upsertRepository({
      id: "repo-1",
      configName: "sample",
      source: "github",
      address: "owner/sample",
      folder: "/srv/sample",
      configHash: "config-hash",
    });
    const issue = {
      id: "issue-1",
      repositoryId: "repo-1",
      sourceNumber: 12,
      sourceUrl: "https://github.com/owner/sample/issues/12",
      title: "Stable board",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:implementation"],
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
    store.upsertIssue(issue);
    store.setIssueProjection("issue-1", { stage: "implementation", state: "active", warning: null });
    store.setStageState({
      issueId: "issue-1",
      stageId: "implementation",
      status: "ready",
      feedbackCycle: 0,
      configHash: "config-hash",
    });
    store.createRun({
      id: "run-1",
      issueId: "issue-1",
      stageId: "implementation",
      attempt: 1,
      kind: "producer",
      status: "running",
      configHash: "config-hash",
      startedAt: "2026-01-01T00:00:01.000Z",
    });

    const board = store.dashboardRevision();
    const conversation = store.conversationRevision();
    const activity = store.activityRevision();
    await Bun.sleep(2);
    store.upsertIssue(issue);
    store.setIssueProjection("issue-1", { stage: "implementation", state: "active", warning: null });
    store.setStageState({
      issueId: "issue-1",
      stageId: "implementation",
      status: "ready",
      feedbackCycle: 0,
      configHash: "config-hash",
    });
    store.replaceRelationships("issue-1", null, []);
    expect(store.dashboardRevision()).toBe(board);

    store.appendRunEvent("run-1", "progress", { message: "Editing" });
    expect(store.dashboardRevision()).toBe(board);
    expect(store.activityRevision()).not.toBe(activity);
    expect(store.conversationRevision()).toBe(conversation);

    store.appendConversationMessage({
      issueId: "issue-1",
      runId: "run-1",
      stageId: "implementation",
      actorType: "agent",
      actorId: "implementer",
      actorName: "Implementer",
      actorTitle: "Senior Developer",
      message: "Running focused tests.",
    });
    expect(store.dashboardRevision()).toBe(board);
    expect(store.conversationRevision()).not.toBe(conversation);

    // A todo change shows on the card, so the board must refresh for it.
    new ItemTodos(store.sqlite()).set("issue-1", [{ id: "t1", text: "A", status: "in_progress" }], "run-1", "2026-01-01T00:00:02.000Z");
    const withTodo = store.dashboardRevision();
    expect(withTodo).not.toBe(board);
    new ItemTodos(store.sqlite()).set("issue-1", [{ id: "t1", text: "A", status: "done" }], "run-1", "2026-01-01T00:00:03.000Z");
    expect(store.dashboardRevision()).not.toBe(withTodo);
    store.close();
  });

  test("lists active issue runners and complete issue run history", async () => {
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
      sourceNumber: 12,
      sourceUrl: "https://github.com/owner/sample/issues/12",
      title: "Active feature",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:implementation"],
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    for (const run of [
      { id: "run-old", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z" },
      { id: "run-live", status: "running", startedAt: "2026-01-02T00:00:00.000Z" },
    ]) {
      store.createRun({
        id: run.id,
        issueId: "issue-1",
        stageId: "implementation",
        attempt: run.id === "run-old" ? 1 : 2,
        kind: "producer",
        status: run.status,
        configHash: "config-hash",
        startedAt: run.startedAt,
      });
    }
    store.appendRunEvent("run-live", "progress", { message: "editing" });
    store.appendRunEvent("run-live", "progress", { message: "testing" });
    store.appendRunEvent("run-live", "progress", { message: "pushing" });

    expect(store.listActiveIssueRuns()).toEqual([{
      id: "run-live",
      issueId: "issue-1",
      repository: "repo-1",
      issueNumber: 12,
      issueTitle: "Active feature",
      stageId: "implementation",
      kind: "producer",
      startedAt: "2026-01-02T00:00:00.000Z",
    }]);
    expect(store.listIssueRuns("issue-1").map((run) => run.id)).toEqual(["run-live", "run-old"]);
    expect(store.listIssueRuns("issue-1")[0]).toMatchObject({
      status: "running",
      result: null,
    });
    const newestRuns = store.listIssueRunsPage("issue-1", { limit: 1 });
    expect(newestRuns).toMatchObject({ runs: [{ id: "run-live" }], nextBefore: "run-live" });
    expect(store.listIssueRunsPage("issue-1", { before: newestRuns.nextBefore!, limit: 1 })).toMatchObject({
      runs: [{ id: "run-old" }],
      nextBefore: null,
    });
    const newestEvents = store.listRunEventsPage("run-live", { limit: 2 });
    expect(newestEvents).toMatchObject({
      events: [{ sequence: 3 }, { sequence: 2 }],
      nextBefore: 2,
    });
    expect(store.listRunEventsPage("run-live", { before: newestEvents.nextBefore!, limit: 2 })).toMatchObject({
      events: [{ sequence: 1 }],
      nextBefore: null,
    });
    store.close();
  });

  test("keeps running orchestration visible between agent and verifier runs", async () => {
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
      sourceNumber: 12,
      sourceUrl: "https://github.com/owner/sample/issues/12",
      title: "Active check",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:implementation"],
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.setStageState({
      issueId: "issue-1",
      stageId: "implementation",
      status: "running",
      feedbackCycle: 0,
      configHash: "config-hash",
    });

    expect(store.listActiveIssueRuns()).toMatchObject([{
      id: "orchestration:issue-1:implementation",
      issueId: "issue-1",
      repository: "repo-1",
      issueNumber: 12,
      issueTitle: "Active check",
      stageId: "implementation",
      kind: "orchestration",
    }]);
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

  test("places a queued issue before another, last, and renumbers when ranks crowd", async () => {
    const store = await openStore();
    store.upsertRepository({
      id: "repo-1", configName: "sample", source: "github", address: "owner/sample",
      folder: "/srv/sample", configHash: "config-hash",
    });
    for (const [id, number, rank] of [["a", 1, 1], ["b", 2, 2], ["c", 3, 3], ["d", 4, 4]] as const) {
      store.upsertIssue({
        id, repositoryId: "repo-1", sourceNumber: number, sourceUrl: `https://example.test/${number}`,
        title: id, body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
      });
      store.setQueueRank(id, rank);
    }
    const order = () => store.listIssues("repo-1").map((issue) => issue.id);

    store.moveQueueIssueBefore("d", "b");
    expect(order()).toEqual(["a", "d", "b", "c"]);
    store.moveQueueIssueBefore("a", null);
    expect(order()).toEqual(["d", "b", "c", "a"]);
    store.moveQueueIssueBefore("c", "d");
    expect(order()).toEqual(["c", "d", "b", "a"]);
    // Repeatedly halving the same gap eventually forces a renumber; order must survive it.
    for (let index = 0; index < 60; index += 1) {
      store.moveQueueIssueBefore(index % 2 === 0 ? "a" : "b", "d");
    }
    expect(order()).toEqual(["c", "a", "b", "d"]);
    expect(() => store.moveQueueIssueBefore("missing", null)).toThrow();
    expect(() => store.moveQueueIssueBefore("a", "missing")).toThrow();
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
    expect(store.getCurrentPullRequest("issue-1")).toMatchObject({
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
      finishedAt: "2026-01-01T00:00:01Z",
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
      finishedAt: "2026-01-01T00:00:01Z",
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
    // A stage waiting on an in-memory retry timer when the process stopped retries after restart.
    store.setStageState({ issueId: "issue-1", stageId: "implementation", status: "error", feedbackCycle: 1, configHash: "config-hash" });
    expect(store.recoverInterruptedExecutions("config-hash")).toEqual({ runs: 0, stages: 1 });
    expect(store.getStageState("issue-1")).toMatchObject({ stageId: "implementation", status: "ready" });
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

  test("persists isolated push preferences and snapshots only currently opted-in subscriptions per event", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-push-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "conveyor.sqlite");
    let store = await ConveyorStore.open(filename);
    const first = store.createDashboardUser("first", "hash");
    const second = store.createDashboardUser("second", "hash");
    store.upsertRepository({ id: "repo-1", configName: "sample", source: "github", address: "owner/sample", folder: "/srv/sample", configHash: "config-hash" });
    store.upsertIssue({ id: "issue-1", repositoryId: "repo-1", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Private issue title", body: "Private details", sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
    expect(store.getPushPreferences(first.id)).toEqual({ questions: false, stopped: false, done: false });
    store.putPushSubscription(first.id, "https://push.example/first", { p256dh: "key1", auth: "secret1" });
    store.putPushSubscription(second.id, "https://push.example/second", { p256dh: "key2", auth: "secret2" });
    store.setPushPreferences(first.id, { questions: true, stopped: true, done: true });
    store.setIssueProjection("issue-1", { stage: "implementation", state: "running", warning: null });
    store.setIssueProjection("issue-1", { stage: "done", state: "done", warning: null });
    const doneEvent = store.pendingPushEvents().find((event) => event.category === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent).not.toHaveProperty("title");
    expect(store.pushEventSubscriptions(doneEvent!.id).map((subscription) => subscription.accountId)).toEqual([first.id]);
    store.setIssueProjection("issue-1", { stage: "done", state: "done", warning: null });
    expect(store.pendingPushEvents().filter((event) => event.category === "done")).toHaveLength(1);
    store.setIssueProjection("issue-1", { stage: "implementation", state: "blocked", warning: null });
    const stoppedEvent = store.pendingPushEvents().find((event) => event.category === "stopped");
    expect(stoppedEvent).toBeDefined();
    expect(store.pushEventSubscriptions(stoppedEvent!.id).map((subscription) => subscription.accountId)).toEqual([first.id]);
    store.setIssueProjection("issue-1", { stage: "implementation", state: "blocked", warning: null });
    expect(store.pendingPushEvents().filter((event) => event.category === "stopped")).toHaveLength(1);

    store.setPushPreferences(first.id, { questions: false, stopped: true, done: true });
    store.recordPushEvent({ id: "old-question", category: "questions", target: "issue-1" });
    expect(store.pushEventSubscriptions("old-question")).toEqual([]);
    store.setPushPreferences(first.id, { questions: true, stopped: false, done: false });

    store.recordPushEvent({ id: "new-question", category: "questions", target: "issue-1" });
    expect(store.pendingPushEvents().some((event) => event.id === "old-question")).toBe(false);
    expect(store.pendingPushEvents().some((event) => event.id === "new-question")).toBe(true);
    expect(store.pushEventSubscriptions("new-question").map((subscription) => subscription.accountId)).toEqual([first.id]);
    const openedQuestion = store.openQuestion({ issueId: "issue-1", runId: null, prompt: "Choose an option", reason: "Need a decision", options: [{ id: "one", label: "One" }] });
    expect(store.pendingPushEvents().filter((event) => event.category === "questions" && event.target === "issue-1")).toHaveLength(2);
    expect(store.openQuestion({ issueId: "issue-1", runId: null, prompt: "Duplicate question", reason: "Must be ignored", options: [] }).id).toBe(openedQuestion.id);
    expect(store.pendingPushEvents().filter((event) => event.category === "questions" && event.target === "issue-1")).toHaveLength(2);
    expect(store.claimPushDelivery("new-question", store.pushEventSubscriptions("new-question")[0]!.id)).toBe(true);
    expect(store.claimPushDelivery("new-question", store.pushEventSubscriptions("new-question")[0]!.id)).toBe(false);
    expect(store.pendingPushEvents().some((event) => event.id === "new-question")).toBe(false);

    store.close();
    store = await ConveyorStore.open(filename);
    expect(store.getPushPreferences(first.id)).toEqual({ questions: true, stopped: false, done: false });
    expect(store.getPushPreferences(second.id)).toEqual({ questions: false, stopped: false, done: false });
    expect(store.listPushSubscriptions(first.id)).toHaveLength(1);
    expect(store.listPushSubscriptions(second.id)).toHaveLength(1);
    store.setPushPreferences(first.id, { questions: false, stopped: false, done: false });
    expect(store.listPushSubscriptions(first.id)).toHaveLength(0);
    expect(store.listPushSubscriptions(second.id)).toHaveLength(1);
    store.close();
  });

  test("moves a browser push endpoint to the account that most recently signed in", async () => {
    const store = await openStore();
    const first = store.createDashboardUser("first-endpoint-owner", "hash");
    const second = store.createDashboardUser("second-endpoint-owner", "hash");
    const endpoint = "https://push.example/shared-browser";
    store.setPushPreferences(first.id, { questions: true, stopped: false, done: false });
    store.setPushPreferences(second.id, { questions: true, stopped: false, done: false });
    store.putPushSubscription(first.id, endpoint, { p256dh: "first-key", auth: "first-auth" });
    store.putPushSubscription(second.id, endpoint, { p256dh: "second-key", auth: "second-auth" });

    expect(store.listPushSubscriptions(first.id)).toEqual([]);
    expect(store.listPushSubscriptions(second.id).map(({ endpoint: savedEndpoint }) => savedEndpoint)).toEqual([endpoint]);
    store.recordPushEvent({ id: "shared-browser-question", category: "questions", target: "issue-1" });
    expect(store.pushEventSubscriptions("shared-browser-question").map(({ accountId }) => accountId)).toEqual([second.id]);
    store.close();
  });
});
