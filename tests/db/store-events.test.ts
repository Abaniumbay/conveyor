// Every store and engine write records its change as an event in the same transaction. One test per
// writer: the change happens, and its event is the newest one in the log.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { AdvisoryCiWatches } from "../../src/engine/advisory-ci";
import { ManualGateApprovals } from "../../src/engine/manual-gates";
import { CriterionApprovals } from "../../src/engine/review-records";
import { ReviewFindings } from "../../src/engine/review-findings";
import { ItemTodos } from "../../src/engine/todos";
import type { EventType, StoredEvent } from "../../src/events/catalogue";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const ISSUE = "github:owner/my-app#1";

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-store-events-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "h" });
  store.upsertIssue({ id: ISSUE, repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "T", body: "B", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-10-17T00:00:00Z" });
  const enrollment = store.activateEnrollment(ISSUE);
  /** The events appended by `change`, without the payload noise of unrelated ones. */
  const during = (change: () => void): StoredEvent[] => {
    const after = store.events().latestSeq();
    change();
    return store.events().read({ afterSeq: after });
  };
  const types = (change: () => void): EventType[] => during(change).map((event) => event.type);
  return { store, enrollment, during, types, root };
}

const issueProjection = (over: Record<string, unknown> = {}) => ({
  id: ISSUE, repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "T", body: "B",
  sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-10-17T00:00:00Z", ...over,
});

describe("item events", () => {
  test("a new source issue is discovered", async () => {
    const { store, types } = await world();
    expect(types(() => store.upsertIssue({ ...issueProjection(), id: "github:owner/my-app#2", sourceNumber: 2 }))).toEqual(["item.discovered"]);
  });
  test("an unchanged source issue records nothing", async () => {
    const { store, types } = await world();
    expect(types(() => store.upsertIssue(issueProjection()))).toEqual([]);
  });
  test("a changed source issue names the fields that changed", async () => {
    const { store, during } = await world();
    expect(during(() => store.upsertIssue(issueProjection({ title: "New", labels: ["bug", "conveyor"] })))[0]).toMatchObject({
      type: "item.updated", payload: { number: 1, changed: ["title", "labels"] },
    });
  });
  test("a new enrollment generation", async () => {
    const { store, types } = await world();
    store.endActiveEnrollment(ISSUE, "offboarded");
    expect(types(() => store.activateEnrollment(ISSUE))).toContain("item.enrolled");
  });
  test("an ended enrollment", async () => {
    const { store, types } = await world();
    expect(types(() => store.endActiveEnrollment(ISSUE, "offboarded"))).toContain("item.offboarded");
  });
  test("a projected stage change", async () => {
    const { store, during } = await world();
    expect(during(() => store.setIssueProjection(ISSUE, { stage: "review", state: "active", warning: null }))[0]).toMatchObject({
      type: "item.stageChanged", payload: { fromStage: null, fromState: null, toStage: "review", toState: "active" },
    });
  });
  test("a warning-only projection change records nothing", async () => {
    const { store, types } = await world();
    store.setIssueProjection(ISSUE, { stage: "review", state: "active", warning: null });
    expect(types(() => store.setIssueProjection(ISSUE, { stage: "review", state: "active", warning: "careful" }))).toEqual([]);
  });
  test("a queue rank change", async () => {
    const { store, types } = await world();
    expect(types(() => store.setQueueRank(ISSUE, 10))).toEqual(["item.queueChanged"]);
  });
  test("a relationship change", async () => {
    const { store, types } = await world();
    store.upsertIssue({ ...issueProjection(), id: "github:owner/my-app#2", sourceNumber: 2 });
    expect(types(() => store.replaceRelationships(ISSUE, null, ["github:owner/my-app#2"]))).toEqual(["item.relationshipsChanged"]);
  });
  test("an issue type change", async () => {
    const { store, types } = await world();
    expect(types(() => store.setIssueMetadata(ISSUE, { type: "Bug" }))).toEqual(["item.metadataChanged"]);
  });
  test("a stage record change", async () => {
    const { store, types } = await world();
    expect(types(() => store.setStageState({ issueId: ISSUE, stageId: "review", status: "ready", feedbackCycle: 0, configHash: "h" }))).toContain("stage.stateChanged");
  });
  test("a completed journey entry", async () => {
    const { store, types } = await world();
    expect(types(() => store.recordJourneyEvent({ issueId: ISSUE, stage: "review", kind: "resume", reason: "resumed" }))).toEqual(["journey.recorded"]);
  });
});

describe("execution events", () => {
  test("planned, pending, passed and woken tasks", async () => {
    const { store, types } = await world();
    const journal = store.executions();
    const epoch = journal.stageEpoch(ISSUE);
    let id = "";
    expect(types(() => {
      id = journal.planExecution({ itemId: ISSUE, stage: "review", stageEpoch: epoch, attempt: 1, list: "exit-gate", taskInstanceId: "gate" }).record.id;
    })).toEqual(["task.planned"]);
    expect(types(() => journal.markPending(id, { wakeAt: "2026-10-17T00:01:00Z", deadlineAt: null }, epoch))).toEqual(["task.pending"]);
    journal.saveCursor({ issueId: ISSUE, stage: "review", stageEpoch: epoch, attempt: 1, returns: 0, list: "exit-gate", taskInstanceId: "gate", state: "pending", feedback: null, pendingSince: null, wakeAt: "2026-10-17T00:01:00Z", deadlineAt: null }, epoch);
    expect(types(() => journal.wakeNow(ISSUE))).toEqual(["task.woken"]);
    expect(types(() => journal.completeExecution(id, { status: "pass" }, epoch))).toEqual(["task.passed"]);
  });
  test("a failed task", async () => {
    const { store, types } = await world();
    const journal = store.executions();
    const epoch = journal.stageEpoch(ISSUE);
    const { record } = journal.planExecution({ itemId: ISSUE, stage: "review", stageEpoch: epoch, attempt: 1, list: "exit-gate", taskInstanceId: "gate" });
    expect(types(() => journal.failExecution(record.id, { status: "fail" }, epoch))).toEqual(["task.failed"]);
  });
});

describe("run, conversation and review events", () => {
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, amount: 0, currency: "USD", source: "unavailable", durationMs: 0 };

  test("a run starts and finishes", async () => {
    const { store, types } = await world();
    expect(types(() => store.createRun({ id: "run-1", issueId: ISSUE, stageId: "review", attempt: 1, kind: "agent", status: "running", configHash: "h", startedAt: "2026-10-17T00:00:00Z" }))).toEqual(["run.started"]);
    expect(types(() => store.finishRun("run-1", { status: "succeeded", exitCode: 0, result: null, sessionId: null, usage }))).toContain("run.finished");
  });
  test("a run interrupted by a restart finishes as interrupted", async () => {
    const { store, during } = await world();
    store.createRun({ id: "run-1", issueId: ISSUE, stageId: "review", attempt: 1, kind: "agent", status: "running", configHash: "h", startedAt: "2026-10-17T00:00:00Z" });
    expect(during(() => store.recoverInterruptedExecutions("h")).find((event) => event.type === "run.finished")?.payload).toEqual({ runId: "run-1", status: "interrupted" });
  });
  test("a question is asked and answered", async () => {
    const { store, types } = await world();
    let questionId = "";
    expect(types(() => { questionId = store.openQuestion({ issueId: ISSUE, runId: null, prompt: "Which?", reason: "r", options: ["a", "b"] }).id; })).toEqual(["question.asked"]);
    expect(types(() => store.answerQuestion(questionId, "web", "a"))).toEqual(["answer.recorded"]);
  });
  test("a recorded answer counts once it completes", async () => {
    const { store, types } = await world();
    const { id } = store.openQuestion({ issueId: ISSUE, runId: null, prompt: "Which?", reason: "r", options: ["a"] });
    expect(types(() => store.recordQuestionAnswer(id, "web", "a"))).toEqual([]);
    expect(types(() => store.completeQuestionAnswer(id))).toEqual(["answer.recorded"]);
  });
  test("a conversation message", async () => {
    const { store, during } = await world();
    expect(during(() => store.appendConversationMessage({ issueId: ISSUE, runId: null, stageId: null, actorType: "user", actorId: "a", actorName: "A", actorTitle: null, message: "Hello" }))[0]).toMatchObject({
      type: "message.posted", payload: { role: "user" },
    });
  });
  test("a manual gate approval and requirement change", async () => {
    const { store, types } = await world();
    const gates = new ManualGateApprovals(store.sqlite());
    expect(types(() => gates.setRequirement({ issueId: ISSUE, stageId: "review", gateId: "gate", changedAt: "2026-10-17T00:00:00Z", required: true }))).toEqual(["gate.requirementChanged"]);
    expect(types(() => gates.approve({ issueId: ISSUE, stageId: "review", gateId: "gate", stageEpoch: 1, attempt: 1, accountId: "a", accountName: "A", approvedAt: "2026-10-17T00:00:00Z" }))).toEqual(["gate.approved"]);
  });
  test("an unchanged gate requirement records nothing", async () => {
    const { store, types } = await world();
    const gates = new ManualGateApprovals(store.sqlite());
    expect(types(() => gates.setRequirement({ issueId: ISSUE, stageId: "review", gateId: "gate", changedAt: "2026-10-17T00:00:00Z", required: false }))).toEqual([]);
  });
  test("a finding is created and dismissed", async () => {
    const { store, during } = await world();
    const findings = new ReviewFindings(store.sqlite());
    let findingId = "";
    expect(during(() => { findingId = findings.create({ issueId: ISSUE, runId: null, author: "reviewer", headSha: "abc", body: "Fix" }).id; }).map((event) => event.payload)).toEqual([{ findingId, change: "created" }]);
    expect(during(() => findings.dismiss(ISSUE, findingId, { actor: "a", reason: "fine", at: "2026-10-17T00:00:00Z" })).map((event) => event.payload)).toEqual([{ findingId, change: "dismissed" }]);
  });
  test("a to-do list change", async () => {
    const { store, types } = await world();
    expect(types(() => new ItemTodos(store.sqlite()).set(ISSUE, [{ id: "a", text: "A", status: "pending" }], null, "2026-10-17T00:00:00Z"))).toEqual(["todo.changed"]);
  });
  test("a criterion approval and its withdrawal", async () => {
    const { store, types } = await world();
    const approvals = new CriterionApprovals(store.sqlite());
    expect(types(() => approvals.approve({ issueId: ISSUE, criterionId: "c1", reviewer: "r", headSha: "abc", checkedAt: "2026-10-17T00:00:00Z", textHash: "x" }))).toEqual(["criterion.approvalChanged"]);
    expect(types(() => approvals.withdraw(ISSUE, "c1"))).toEqual(["criterion.approvalChanged"]);
  });
  test("criterion test evidence", async () => {
    const { store, types } = await world();
    expect(types(() => store.replaceCriterionTestEvidence(ISSUE, [{ criterionId: "c1", manual: true, tests: [], recordedHead: "abc", sourceLinkHead: "abc", recordedAt: "2026-10-17T00:00:00Z" }]))).toEqual(["criterion.testsRecorded"]);
  });
});

describe("change, CI and source events", () => {
  const indicator = (state: "running" | "passing") => ({
    id: "ci", label: "CI", state, detail: state, progress: state === "passing" ? "1/1" : "0/1", url: null,
    observedAt: "2026-10-17T00:00:00Z", entries: [], reference: null,
  });

  test("a pull request is opened, then merged", async () => {
    const { store, types } = await world();
    expect(types(() => store.upsertPullRequest({ issueId: ISSUE, id: "pr-5", number: 5, url: "https://example.com/pull/5", state: "open" }))).toEqual(["change.opened"]);
    expect(types(() => store.upsertPullRequest({ issueId: ISSUE, id: "pr-5", number: 5, url: "https://example.com/pull/5", state: "closed", mergedAt: "2026-10-17T00:00:00Z" }))).toEqual(["change.stateChanged"]);
  });
  test("an indicator changes, repeats unchanged and is cleared", async () => {
    const { store, types } = await world();
    expect(types(() => store.saveIndicator(ISSUE, "abc", indicator("running"), true))).toEqual(["indicator.changed"]);
    expect(types(() => store.saveIndicator(ISSUE, "abc", indicator("running"), true))).toEqual([]);
    expect(types(() => store.clearIndicator(ISSUE, "ci"))).toEqual(["indicator.cleared"]);
  });
  test("an advisory CI watch starts", async () => {
    const { store, types } = await world();
    const watches = new AdvisoryCiWatches(store.sqlite(), store.executions(), {
      resolve: () => { throw new Error("not polled"); }, post: () => {},
    });
    expect(types(() => watches.ensureWatch({ repositoryId: "repo", itemId: ISSUE, headSha: "abc", stage: "review", change: { changeId: "pr-5", url: "https://example.com/pull/5" }, now: Date.now() }))).toEqual(["advisoryCi.watchStarted"]);
  });
  test("a webhook delivery is stored once", async () => {
    const { store, types } = await world();
    expect(types(() => store.recordSourceEvent({ source: "github", deliveryId: "d1", eventType: "issues", payload: {}, repositoryId: "repo" }))).toEqual(["webhook.received"]);
    expect(types(() => store.recordSourceEvent({ source: "github", deliveryId: "d1", eventType: "issues", payload: {}, repositoryId: "repo" }))).toEqual([]);
  });
  test("a source mutation starts, completes and fails", async () => {
    const { store, types } = await world();
    let id = "";
    expect(types(() => { id = store.beginSourceMutation({ idempotencyKey: "k1", source: "github", operation: "labels", request: {} }).id; })).toEqual(["source.mutationStarted"]);
    expect(types(() => store.completeSourceMutation(id, {}))).toEqual(["source.mutationCompleted"]);
    const failing = store.beginSourceMutation({ idempotencyKey: "k2", source: "github", operation: "labels", request: {} });
    expect(types(() => store.failSourceMutation(failing.id, "denied"))).toEqual(["source.mutationFailed"]);
  });
  test("a workspace is recorded and removed", async () => {
    const { store, enrollment, types, root } = await world();
    expect(types(() => store.recordWorkspace({ id: "w1", enrollmentId: enrollment.id, path: root, branch: "conveyor/1", status: "active" }))).toEqual(["workspace.recorded"]);
    expect(types(() => store.markWorkspaceRemoved("w1"))).toEqual(["workspace.removed"]);
  });
});

describe("system events", () => {
  test("a repository is onboarded once and removed", async () => {
    const { store, types, root } = await world();
    expect(types(() => store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "h" }))).toEqual([]);
    expect(types(() => store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "h2" }))).toEqual(["repository.onboarded"]);
    expect(types(() => store.removeRepositoriesExcept([]))).toEqual(["repository.removed"]);
  });
  test("a repository's visibility change", async () => {
    const { store, types } = await world();
    expect(types(() => store.setRepositoryTrustStatus({ repositoryId: "repo", visibility: "private", checkedAt: "2026-10-17T00:00:00Z", warning: null }))).toEqual(["repository.trustChanged"]);
    expect(types(() => store.setRepositoryTrustStatus({ repositoryId: "repo", visibility: "private", checkedAt: "2026-10-17T01:00:00Z", warning: null }))).toEqual([]);
  });
  test("a new configuration snapshot", async () => {
    const { store, types } = await world();
    expect(types(() => store.recordConfigSnapshot("hash-1", {}))).toEqual(["config.recorded"]);
    expect(types(() => store.recordConfigSnapshot("hash-1", {}))).toEqual([]);
  });
  test("account events never carry a password, its hash or a session", async () => {
    const { store, during } = await world();
    const events = during(() => {
      store.seedDashboardSuperuser("admin", "hash-of-secret-password");
      const user = store.createDashboardUser("someone", "another-password-hash");
      store.changeDashboardPassword(user.id, "third-password-hash");
      store.changeDashboardAvatar(user.id, "fox");
      store.deleteDashboardAccount(user.id);
    });
    expect(events.map((event) => event.type)).toEqual(["account.created", "account.created", "account.passwordChanged", "account.avatarChanged", "account.deleted"]);
    expect(JSON.stringify(events)).not.toMatch(/password-hash|secret-password|session/);
  });
  test("push notification settings and subscriptions", async () => {
    const { store, types } = await world();
    const account = store.createDashboardUser("someone", "hash");
    expect(types(() => store.setPushPreferences(account.id, { questions: true, stopped: false, done: false }))).toEqual(["notifications.settingsChanged"]);
    expect(types(() => store.putPushSubscription(account.id, "https://push.example.com/1", { p256dh: "k", auth: "a" }))).toEqual(["notifications.subscribed"]);
    expect(types(() => store.deletePushSubscription(account.id, "https://push.example.com/1"))).toEqual(["notifications.unsubscribed"]);
  });
});
