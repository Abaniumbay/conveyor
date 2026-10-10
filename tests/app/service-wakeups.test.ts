import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { IssueExecutor } from "../../src/app/issue-executor";
import { ConveyorService } from "../../src/app/service";
import { loadConfig, type ConveyorConfig } from "../../src/config/load";
import { ConveyorStore, type StoredIssue } from "../../src/db/store";
import type { GitHubAdapter } from "../../src/source/github/adapter";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const MESSAGE = "Waiting for CI at abc1234: Tests.";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-wakeups-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources: { github: { type: github } }
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
        run: { agent: worker }
        concurrency: 1
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryPath}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const open = async () => {
    const store = await ConveyorStore.open(config.settings.database);
    const executed: string[] = [];
    const statusComments: string[] = [];
    const service = new ConveyorService(config, store, {
      async upsertStatusComment(_address: string, _number: number, markdown: string) {
        statusComments.push(markdown);
        return statusComments.length;
      },
    } as unknown as GitHubAdapter);
    (service as unknown as { execute(issue: StoredIssue): Promise<void> }).execute = async (issue) => {
      executed.push(issue.id);
    };
    return { store, service, executed, statusComments };
  };
  const first = await open();
  first.store.upsertRepository({
    id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash,
  });
  first.store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Feature", body: "",
    sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  first.store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
  first.store.setQueueRank("issue", first.store.nextQueueRank());
  first.store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  return { config, first, open };
}

/** What StageExecutor leaves behind when a task returns pending. */
function park(store: ConveyorStore, config: ConveyorConfig, wakeAt: string) {
  const journal = store.executions();
  const epoch = journal.stageEpoch("issue");
  const { record } = journal.planExecution({
    itemId: "issue", stage: "implementation", stageEpoch: epoch, attempt: 1, list: "actions", taskInstanceId: "legacy.produce",
  });
  journal.markPending(record.id, { wakeAt, deadlineAt: null, message: MESSAGE }, epoch);
  journal.saveCursor({
    issueId: "issue", stage: "implementation", stageEpoch: epoch, attempt: 1, returns: 0, list: "actions",
    taskInstanceId: "legacy.produce", state: "pending", feedback: null, pendingSince: wakeAt, wakeAt, deadlineAt: null,
  }, epoch);
  void config;
}

function addRunningHolder(store: ConveyorStore, config: ConveyorConfig) {
  store.upsertIssue({
    id: "holder", repositoryId: "repo", sourceNumber: 2, sourceUrl: "https://example.test/2", title: "Holder", body: "",
    sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("holder", { stage: "implementation", state: "active", warning: null });
  store.setQueueRank("holder", store.nextQueueRank());
  store.setStageState({ issueId: "holder", stageId: "implementation", status: "running", feedbackCycle: 0, configHash: config.hash });
}

const schedule = (service: ConveyorService) => (service as unknown as { schedule(): void }).schedule();

describe("persisted wake-ups", () => {
  test("keeps a dependent child ineligible after restart until its blocker is closed", async () => {
    const { first, open } = await setup();
    first.store.upsertIssue({
      id: "parent", repositoryId: "repo", sourceNumber: 3, sourceUrl: "https://example.test/3", title: "Parent", body: "",
      sourceState: "closed", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    first.store.upsertIssue({
      id: "blocker", repositoryId: "repo", sourceNumber: 2, sourceUrl: "https://example.test/2", title: "Blocker", body: "",
      sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    first.store.setIssueProjection("blocker", { stage: "implementation", state: "active", warning: null });
    first.store.replaceRelationships("issue", { parentId: "parent", siblingOrder: 1 }, ["blocker"]);
    schedule(first.service);
    expect(first.executed).toEqual([]);
    await first.service.close();

    const second = await open();
    schedule(second.service);
    expect(second.executed).toEqual([]);

    second.store.upsertIssue({
      id: "blocker", repositoryId: "repo", sourceNumber: 2, sourceUrl: "https://example.test/2", title: "Blocker", body: "",
      sourceState: "closed", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-02T00:00:00Z",
    });
    schedule(second.service);
    expect(second.executed).toEqual(["issue"]);
    await second.service.close();
  });

  test("a parked item keeps its wake-up across a restart and is scheduled when due", async () => {
    const { config, first, open } = await setup();
    const wakeAt = new Date(Date.now() + 600).toISOString();
    park(first.store, config, wakeAt);
    schedule(first.service);
    expect(first.executed).toEqual([]);
    await first.service.close();

    const second = await open();
    expect(second.store.executions().wakeAt("issue")).toBe(wakeAt);
    schedule(second.service);
    expect(second.executed).toEqual([]);

    // The armed timer fires a schedule pass at the wake-up time.
    const deadline = Date.now() + 5_000;
    while (second.executed.length === 0 && Date.now() < deadline) await Bun.sleep(50);
    expect(second.executed).toEqual(["issue"]);
    await second.service.close();
  });

  test("an item whose wake-up has passed is schedulable immediately", async () => {
    const { config, first } = await setup();
    park(first.store, config, new Date(Date.now() - 1_000).toISOString());
    schedule(first.service);
    expect(first.executed).toEqual(["issue"]);
    await first.service.close();
  });

  test("a due item reports all full capacity slots, then starts when its holder releases", async () => {
    const { config, first } = await setup();
    config.settings.runners = 1;
    config.repositories.repo!.concurrency = 1;
    config.pipelines.default!.stages[0]!.concurrency = 1;
    const wakeAt = new Date(Date.now() - 1_000).toISOString();
    park(first.store, config, wakeAt);
    addRunningHolder(first.store, config);
    first.store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: MESSAGE });

    const internals = first.service as unknown as {
      currentIssueStatus(issue: StoredIssue): { kind: string; reason: string; since: string; nextCheckAt: string | null; deadline: string | null } | null;
      updateStatusComment(issueId: string): Promise<void>;
    };
    const queuedCard = first.service.dashboard("csrf", { view: "board", column: null, page: 1, doneLimit: 20, runId: null, issueId: "issue" }).selectedIssue;
    expect(queuedCard).toMatchObject({ waiting: { kind: "queued" }, reason: null });
    expect(internals.currentIssueStatus(first.store.getIssue("issue")!)).toEqual({
      kind: "queued",
      reason: "global runner slots 1/1 busy: #2; implementation slots 1/1 busy: #2; repo slots 1/1 busy: #2",
      since: wakeAt,
      nextCheckAt: null,
      deadline: null,
    });
    await internals.updateStatusComment("issue");
    expect(first.statusComments.at(-1)).toContain(
      "- Status: Queued · global runner slots 1/1 busy: #2; implementation slots 1/1 busy: #2; repo slots 1/1 busy: #2",
    );

    schedule(first.service);
    expect(first.executed).toEqual([]);
    first.store.setStageState({ issueId: "holder", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
    schedule(first.service);
    expect(first.executed).toEqual(["issue"]);
    await Bun.sleep(0);
    await internals.updateStatusComment("issue");
    expect(first.statusComments.at(-1)).not.toContain("Queued");
    expect(first.statusComments.at(-1)).not.toContain("global runner slots 1/1 busy: #2");
    await first.service.close();
  });

  test("a returned item starts a new queued period instead of retaining its parked gate message", async () => {
    const { config, first } = await setup();
    config.settings.runners = 1;
    const wakeAt = new Date(Date.now() - 1_000).toISOString();
    park(first.store, config, wakeAt);
    addRunningHolder(first.store, config);

    // A return/retry fences the parked task and puts the stage back in ready state.
    first.store.setStageState({ issueId: "issue", stageId: "implementation", status: "blocked", feedbackCycle: 0, configHash: config.hash });
    first.store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
    const requeuedAt = first.store.getStageState("issue")!.updatedAt;
    const status = (first.service as unknown as {
      currentIssueStatus(issue: StoredIssue): { kind: string; reason: string; since: string; nextCheckAt: string | null; deadline: string | null } | null;
    }).currentIssueStatus(first.store.getIssue("issue")!);

    expect(status).toEqual({
      kind: "queued",
      reason: "global runner slots 1/1 busy: #2; implementation slots 1/1 busy: #2; repo slots 1/1 busy: #2",
      since: requeuedAt,
      nextCheckAt: null,
      deadline: null,
    });
    expect(status?.reason).not.toContain("Waiting for CI");
    expect(status?.since).not.toBe(wakeAt);
    await first.service.close();
  });

  test("a queued capacity status keeps its queue clock and holder detail across a restart", async () => {
    const { config, first, open } = await setup();
    config.settings.runners = 1;
    const wakeAt = new Date(Date.now() - 1_000).toISOString();
    park(first.store, config, wakeAt);
    addRunningHolder(first.store, config);
    first.store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: MESSAGE });
    const status = (first.service as unknown as {
      currentIssueStatus(issue: StoredIssue): { kind: string; reason: string; since: string; nextCheckAt: string | null; deadline: string | null } | null;
    }).currentIssueStatus(first.store.getIssue("issue")!);
    expect(status).toMatchObject({ kind: "queued", since: wakeAt, reason: expect.stringContaining("#2") });
    await first.service.close();

    const second = await open();
    const restarted = (second.service as unknown as {
      currentIssueStatus(issue: StoredIssue): { kind: string; reason: string; since: string; nextCheckAt: string | null; deadline: string | null } | null;
    }).currentIssueStatus(second.store.getIssue("issue")!);
    expect(restarted).toEqual(status);
    await second.service.close();
  });

  test("a retry re-queues with a fresh capacity status instead of its failure wait", async () => {
    const { config, first } = await setup();
    config.settings.runners = 1;
    addRunningHolder(first.store, config);
    const internals = first.service as unknown as {
      handleInfrastructureFailure(issue: StoredIssue, error: unknown): Promise<void>;
      retryLater(issueId: string, delayMs: number): void;
      currentIssueStatus(issue: StoredIssue): { kind: string; reason: string; since: string; nextCheckAt: string | null; deadline: string | null } | null;
    };
    const retry = internals.retryLater.bind(first.service);
    internals.retryLater = (issueId, _delayMs) => retry(issueId, 0);
    first.store.setStageState({ issueId: "issue", stageId: "implementation", status: "error", feedbackCycle: 0, configHash: config.hash });
    await internals.handleInfrastructureFailure(first.store.getIssue("issue")!, new Error("runner unavailable"));
    expect(first.service.dashboard("csrf", { view: "board", column: null, page: 1, doneLimit: 20, runId: null, issueId: "issue" }).selectedIssue?.waiting)
      .toMatchObject({ kind: "waiting", reason: "Execution failed: runner unavailable" });

    const deadline = Date.now() + 1_000;
    let status = internals.currentIssueStatus(first.store.getIssue("issue")!);
    while (status === null && Date.now() < deadline) {
      await Bun.sleep(10);
      status = internals.currentIssueStatus(first.store.getIssue("issue")!);
    }
    expect(status).not.toBeNull();
    expect(status).toMatchObject({ kind: "queued", reason: expect.stringContaining("global runner slots 1/1 busy: #2") });
    expect(String(status?.reason)).not.toContain("Execution failed");
    await first.service.close();
  });

  test("closing the service cancels delayed infrastructure retries", async () => {
    const { first } = await setup();
    const internals = first.service as unknown as { retryLater(issueId: string, delayMs: number): void };
    internals.retryLater("issue", 10);
    await first.service.close();
    await Bun.sleep(25);
  });

  test("reconciliation resetting the warning does not lose a parked item's status line", async () => {
    const { config, first } = await setup();
    park(first.store, config, new Date(Date.now() + 60_000).toISOString());
    first.store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
    (first.service as unknown as { restorePendingStatus(id: string): void }).restorePendingStatus("repo");
    expect(first.store.getIssue("issue")?.warning).toBe(MESSAGE);
    await first.service.close();
  });

  test("a native stage is lightweight only when it runs no agent or script", async () => {
    const { first } = await setup();
    const stages = first.service.config.pipelines.default!.stages as unknown[];
    const native = (id: string, task: string) => ({ id, concurrency: 1, retries: 2, actions: [{ task }], exitGate: [{ task: "ci.await" }] });
    stages.push(native("poll", "ci.await"), native("coding", "agent.run"), native("scripted", "script.run"));
    const lightweight = (id: string) =>
      (first.service as unknown as { isLightweightStage(r: string, s: string): boolean }).isLightweightStage("repo", id);
    expect(lightweight("poll")).toBe(true);
    expect(lightweight("coding")).toBe(false);
    expect(lightweight("scripted")).toBe(false);
    expect(lightweight("implementation")).toBe(false);
    await first.service.close();
  });

  test("a parked outcome skips source reconciliation and the status comment when the text is unchanged", async () => {
    const { config, open } = await setup();
    const h = await open();
    park(h.store, config, new Date(Date.now() + 60_000).toISOString());
    h.store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: MESSAGE });
    const calls: string[] = [];
    const internals = h.service as unknown as Record<string, unknown>;
    internals.reconcileRepository = async () => { calls.push("reconcile"); };
    internals.updateStatusComment = async () => { calls.push("comment"); };
    delete (internals as { execute?: unknown }).execute;
    const spy = spyOn(IssueExecutor.prototype, "execute").mockResolvedValue({
      kind: "parked", stageId: "implementation", reason: "pending", wakeAt: null,
    });
    try {
      await (internals.execute as (i: unknown, s: AbortSignal) => Promise<void>).call(
        h.service, h.store.getIssue("issue"), new AbortController().signal,
      );
      expect(calls).toEqual([]);
      spy.mockResolvedValue({ kind: "advance", stageId: "implementation", nextStageId: null, result: null, feedbackCycles: 0 });
      await (internals.execute as (i: unknown, s: AbortSignal) => Promise<void>).call(
        h.service, h.store.getIssue("issue"), new AbortController().signal,
      );
      expect(calls).toEqual(["reconcile", "comment"]);
    } finally {
      spy.mockRestore();
      await h.service.close();
    }
  });
});
