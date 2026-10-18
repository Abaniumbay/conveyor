// The service's reactions to events: each subscriber is driven by appending its event to the log.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import type { StoredEvent } from "../../src/events/catalogue";
import type { EventSink } from "../../src/events/sinks";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const ISSUE = "issue";

async function setup(options: { drained?: boolean; sink?: EventSink; secondRepository?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-service-events-"));
  directories.push(root);
  const records: LogRecord[] = [];
  log.configure({ sinks: [{ write: (record: LogRecord) => { records.push(record); } }] });
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  const secondRepositoryPath = path.join(root, "repo-two");
  if (options.secondRepository) await mkdir(secondRepositoryPath);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings: { database: ${root}/db.sqlite, logs: ${root}/logs, workspaces: ${root}/workspaces, artifacts: ${root}/artifacts }
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
        concurrency: 1
        actions: []
        exit-gate:
          - { id: ciGate, task: ci.passed, manual: true }
repositories:
  repo: { source: github, address: owner/my-app, folder: ${repositoryPath}, pipeline: default }
${options.secondRepository ? `  repo-two: { source: github, address: owner/other-app, folder: ${secondRepositoryPath}, pipeline: default }
` : ""}`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.recordConfigSnapshot(config.hash, config);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: repositoryPath, configHash: config.hash });
  store.upsertIssue({ id: ISSUE, repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "F", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
  store.setIssueProjection(ISSUE, { stage: "implementation", state: "active", warning: null });
  store.setStageState({ issueId: ISSUE, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  store.activateEnrollment(ISSUE);
  store.setQueueRank(ISSUE, 10);
  if (options.secondRepository) {
    store.upsertRepository({ id: "repo-two", configName: "repo-two", source: "github", address: "owner/other-app", folder: secondRepositoryPath, configHash: config.hash });
    store.upsertIssue({ id: "issue-two", repositoryId: "repo-two", sourceNumber: 2, sourceUrl: "https://example.com/2", title: "Second", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
    store.setIssueProjection("issue-two", { stage: "implementation", state: "active", warning: null });
    store.setStageState({ issueId: "issue-two", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
    store.activateEnrollment("issue-two");
    store.setQueueRank("issue-two", 20);
  }
  const service = new ConveyorService(config, store, { async upsertStatusComment() { return 1; } } as never, options.sink ? { eventSinks: [options.sink] } : {});
  if (options.drained !== false) service.drain("tests: nothing executes");
  const journal = store.executions();
  /** Parks the item on its exit gate for one visit, as the executor does. */
  const park = (attempt = 1, taskInstanceId = "ciGate") => {
    const epoch = journal.stageEpoch(ISSUE);
    journal.saveCursor({
      issueId: ISSUE, stage: "implementation", stageEpoch: epoch, attempt, returns: 0, list: "exit-gate",
      taskInstanceId, state: "pending", feedback: null, pendingSince: new Date().toISOString(), wakeAt: null, deadlineAt: null,
    }, epoch);
    return epoch;
  };
  return { service, store, journal, park, records };
}

describe("waking parked gates", () => {
  test("gate.approved wakes the gate visit it was given for", async () => {
    const { service, store, journal, park } = await setup();
    const epoch = park();
    store.events().append("gate.approved", { stageId: "implementation", gateId: "ciGate", stageEpoch: epoch, attempt: 1 }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toEqual(expect.any(String));
    await service.close();
  });

  test("an approval of an earlier visit does not wake a later one", async () => {
    const { service, store, journal, park } = await setup();
    const earlier = park(1);
    journal.onStageChange(ISSUE);
    park(1);
    store.events().append("gate.approved", { stageId: "implementation", gateId: "ciGate", stageEpoch: earlier, attempt: 1 }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toBeNull();
    await service.close();
  });

  test("a board approval wakes only its matching board-approval visit", async () => {
    const { service, store, journal, park } = await setup();
    const epoch = park(1, "board-approval");
    store.events().append("gate.boardApproved", { stageId: "implementation", stageEpoch: epoch, attempt: 1 }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toEqual(expect.any(String));

    journal.onStageChange(ISSUE);
    park(1, "board-approval");
    store.events().append("gate.boardApproved", { stageId: "implementation", stageEpoch: epoch, attempt: 1 }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toBeNull();
    await service.close();
  });

  test("a board-approval requirement change wakes its matching parked gate", async () => {
    const { service, store, journal, park } = await setup();
    park(1, "board-approval");
    store.events().append("gate.boardApprovalChanged", { stageId: "implementation", required: false }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toEqual(expect.any(String));
    await service.close();
  });

  test("a future-stage board-approval requirement change leaves the current board gate asleep", async () => {
    const { service, store, journal, park } = await setup();
    park(1, "board-approval");
    store.events().append("gate.boardApprovalChanged", { stageId: "review", required: true }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toBeNull();
    await service.close();
  });

  test("gate.requirementChanged wakes the gate parked on that requirement", async () => {
    const { service, store, journal, park } = await setup();
    park();
    store.events().append("gate.requirementChanged", { stageId: "implementation", gateId: "ciGate", required: false }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toEqual(expect.any(String));
    await service.close();
  });

  test("a requirement change of another gate leaves the parked one asleep", async () => {
    const { service, store, journal, park } = await setup();
    park();
    store.events().append("gate.requirementChanged", { stageId: "implementation", gateId: "otherGate", required: false }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toBeNull();
    await service.close();
  });

  test("a dismissed finding wakes an item parked on its exit gate", async () => {
    const { service, store, journal, park } = await setup();
    park();
    store.events().append("finding.changed", { findingId: "f-1", change: "dismissed" }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toEqual(expect.any(String));
    await service.close();
  });

  test("a new finding does not wake the item", async () => {
    const { service, store, journal, park } = await setup();
    park();
    store.events().append("finding.changed", { findingId: "f-1", change: "created" }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(journal.getCursor(ISSUE)?.wakeAt).toBeNull();
    await service.close();
  });
});

describe("scheduling", () => {
  const started = (records: LogRecord[]) => records.filter((record) => record.message === "Stage started");

  test("item.requeued schedules the item", async () => {
    const { service, store, records } = await setup({ drained: false });
    store.events().append("item.requeued", { reason: "retry" }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(started(records)).toEqual([expect.objectContaining({ item: "repo:1", stage: "implementation" })]);
    await service.close();
  });

  test("retry, follow-on, and operator wake events do not admit a paused repository", async () => {
    const { service, store, records } = await setup({ drained: false });
    const epoch = store.executions().stageEpoch(ISSUE);
    service.pauseRepository("repo", "Conserve CI time", "operator");

    store.events().append("task.woken", {}, { issueId: ISSUE });
    store.events().append("item.requeued", { reason: "retry" }, { issueId: ISSUE });
    store.events().append("command.accepted", { command: "backlog.move" });
    await service.eventsSettled();

    expect(started(records)).toEqual([]);
    expect(store.getStageState(ISSUE)).toMatchObject({ status: "ready" });
    expect(store.executions().stageEpoch(ISSUE)).toBe(epoch);

    await service.resumeRepository("repo");
    await service.eventsSettled();

    expect(started(records)).toEqual([expect.objectContaining({ item: "repo:1", stage: "implementation" })]);
    await service.close();
  });

  test("a paused repository does not prevent another repository from starting", async () => {
    const { service, store, records } = await setup({ drained: false, secondRepository: true });
    service.pauseRepository("repo", "Conserve CI time", "operator");

    store.events().append("command.accepted", { command: "backlog.move" });
    await service.eventsSettled();

    expect(started(records)).toEqual([expect.objectContaining({ item: "repo-two:2", stage: "implementation" })]);
    expect(store.getStageState(ISSUE)).toMatchObject({ status: "ready" });
    await service.close();
  });

  test("pause and resume retain a manual approval's gate visit and pipeline hash", async () => {
    const { service, store, journal, park } = await setup();
    const epoch = park();
    const configHash = store.getStageState(ISSUE)!.configHash;

    service.approveManualGate(ISSUE, "implementation", "ciGate", { id: "operator", username: "operator" });
    await service.eventsSettled();
    const wakeAt = journal.getCursor(ISSUE)?.wakeAt;

    service.pauseRepository("repo", "Conserve CI time", "operator");
    await service.resumeRepository("repo");

    expect(journal.getCursor(ISSUE)).toMatchObject({ stage: "implementation", stageEpoch: epoch, wakeAt });
    expect(store.getStageState(ISSUE)?.configHash).toBe(configHash);
    await service.close();
  });

  test("an accepted command schedules", async () => {
    const { service, store, records } = await setup({ drained: false });
    store.events().append("command.accepted", { command: "backlog.move" });
    await service.eventsSettled();
    expect(started(records)).toHaveLength(1);
    await service.close();
  });

  test("a reconcile's own changes do not schedule outside the scheduler's loop", async () => {
    const { service, store, records } = await setup({ drained: false });
    store.events().append("item.stageChanged", { fromStage: null, fromState: null, toStage: "implementation", toState: "active" }, { issueId: ISSUE });
    store.events().append("repository.reconciled", { issueNumbers: null }, { repositoryId: "repo" });
    await service.eventsSettled();
    expect(started(records)).toEqual([]);
    await service.close();
  });

  test("a released worker requests scheduling", async () => {
    const { service, store, records } = await setup({ drained: false });
    store.events().append("worker.released", { stageId: "implementation" }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(started(records)).toHaveLength(1);
    await service.close();
  });

  test("a burst of worker releases schedules once", async () => {
    const { service, store, records } = await setup({ drained: false });
    for (let index = 0; index < 5; index += 1) store.events().append("worker.released", { stageId: "implementation" }, { issueId: ISSUE });
    await service.eventsSettled();
    expect(started(records)).toHaveLength(1);
    await service.close();
  });
});

describe("the live dashboard's event feed", () => {
  test("a page that is up to date replays nothing", async () => {
    const { service, store } = await setup();
    expect(service.eventsAfter(store.events().latestSeq())).toEqual([]);
    await service.close();
  });

  test("a page that missed events replays them as type and identifiers only", async () => {
    const { service, store } = await setup();
    const after = store.events().latestSeq();
    store.setQueueRank(ISSUE, 20);
    expect(service.eventsAfter(after)).toEqual([{ seq: after + 1, type: "item.queueChanged", repositoryId: "repo", issueId: ISSUE, correlationId: null }]);
    await service.close();
  });

  test("a page that missed pruned events must reload", async () => {
    const { service, store } = await setup();
    const after = store.events().latestSeq();
    store.setQueueRank(ISSUE, 20);
    store.setQueueRank(ISSUE, 30);
    store.sqlite().query("DELETE FROM events WHERE seq <= ?").run(after + 1);
    expect(service.eventsAfter(after - 1)).toBeNull();
    await service.close();
  });

  test("a page from another database must reload", async () => {
    const { service, store } = await setup();
    expect(service.eventsAfter(store.events().latestSeq() + 10)).toBeNull();
    await service.close();
  });

  test("a page that missed more than a thousand events must reload", async () => {
    const { service, store } = await setup();
    const after = store.events().latestSeq();
    for (let rank = 1; rank <= 1_001; rank += 1) store.setQueueRank(ISSUE, rank + 100);
    expect(service.eventsAfter(after)).toBeNull();
    await service.close();
  });

  test("the web feed receives every committed event", async () => {
    const { service, store } = await setup();
    const seen: string[] = [];
    const unsubscribe = service.webDependencies({} as never, "operator").subscribeEvents!((event) => { seen.push(event.type); });
    store.setQueueRank(ISSUE, 20);
    await service.eventsSettled();
    unsubscribe();
    store.setQueueRank(ISSUE, 30);
    await service.eventsSettled();
    expect(seen).toEqual(["item.queueChanged"]);
    await service.close();
  });
});

describe("service state events", () => {
  test("draining and resuming admission are recorded", async () => {
    const { service, store } = await setup({ drained: false });
    const after = store.events().latestSeq();
    service.drain("maintenance");
    service.drain("again");
    service.resumeAdmission();
    expect(store.events().read({ afterSeq: after, type: "admission." }).map((event) => event.type)).toEqual(["admission.paused", "admission.resumed"]);
    await service.close();
  });
});

describe("event sinks", () => {
  test("a sink receives every event while the service runs, and stops with it", async () => {
    const received: string[] = [];
    const sink: EventSink = { name: "test-sink", async deliver(events: readonly StoredEvent[]) { received.push(...events.map((event) => event.type)); } };
    const { service, store } = await setup({ sink });
    service.start();
    store.setQueueRank(ISSUE, 20);
    await service.sinksIdle();
    expect(received).toContain("item.queueChanged");
    const queued = store.events().read({ type: "item.queueChanged" }).at(-1)!;
    expect(store.events().consumerCursor("test-sink")).toBeGreaterThanOrEqual(queued.seq);
    await service.close();
  });
});
