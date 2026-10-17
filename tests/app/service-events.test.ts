// The service's reactions to events: each subscriber is driven by appending its event to the log.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const ISSUE = "issue";

async function setup(options: { drained?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-service-events-"));
  directories.push(root);
  const records: LogRecord[] = [];
  log.configure({ sinks: [{ write: (record: LogRecord) => { records.push(record); } }] });
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
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
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.recordConfigSnapshot(config.hash, config);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: repositoryPath, configHash: config.hash });
  store.upsertIssue({ id: ISSUE, repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "F", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
  store.setIssueProjection(ISSUE, { stage: "implementation", state: "active", warning: null });
  store.setStageState({ issueId: ISSUE, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  store.activateEnrollment(ISSUE);
  store.setQueueRank(ISSUE, 10);
  const service = new ConveyorService(config, store, { async upsertStatusComment() { return 1; } } as never);
  if (options.drained !== false) service.drain("tests: nothing executes");
  const journal = store.executions();
  /** Parks the item on its exit gate for one visit, as the executor does. */
  const park = (attempt = 1) => {
    const epoch = journal.stageEpoch(ISSUE);
    journal.saveCursor({
      issueId: ISSUE, stage: "implementation", stageEpoch: epoch, attempt, returns: 0, list: "exit-gate",
      taskInstanceId: "ciGate", state: "pending", feedback: null, pendingSince: new Date().toISOString(), wakeAt: null, deadlineAt: null,
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

  test("a burst of events schedules once", async () => {
    const { service, store, records } = await setup({ drained: false });
    for (let index = 0; index < 5; index += 1) store.events().append("command.accepted", { command: "backlog.move" });
    await service.eventsSettled();
    expect(started(records)).toHaveLength(1);
    await service.close();
  });
});
