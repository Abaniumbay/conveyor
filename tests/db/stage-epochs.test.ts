import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { ExecutionStore, type StageCursor } from "../../src/engine/journal";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-epochs-"));
  directories.push(directory);
  const store = await ConveyorStore.open(path.join(directory, "conveyor.sqlite"));
  store.recordConfigSnapshot("hash", {});
  store.upsertRepository({
    id: "repo-1",
    configName: "sample",
    source: "github",
    address: "owner/sample",
    folder: "/srv/sample",
    configHash: "hash",
  });
  store.upsertIssue({
    id: "issue-1",
    repositoryId: "repo-1",
    sourceNumber: 1,
    sourceUrl: "https://example.test/1",
    title: "T",
    body: "B",
    sourceState: "open",
    labels: [],
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
  const journal = new ExecutionStore(store.sqlite());
  const stage = (stageId: string, status: string, feedbackCycle = 0) =>
    store.setStageState({ issueId: "issue-1", stageId, status, feedbackCycle, configHash: "hash" });
  const project = (stageId: string | null, state: string | null, warning: string | null = null) =>
    store.setIssueProjection("issue-1", { stage: stageId, state, warning });
  const cursor = (epoch: number): StageCursor => ({
    issueId: "issue-1",
    stage: "build",
    stageEpoch: epoch,
    attempt: 1,
    returns: 0,
    list: "actions",
    taskInstanceId: "t",
    state: "running",
    feedback: null,
    pendingSince: null,
    wakeAt: null,
    deadlineAt: null,
  });
  return { store, journal, stage, project, cursor, epoch: () => journal.stageEpoch("issue-1") };
}

describe("stage epoch fencing", () => {
  test("onStageChange bumps once and clears the cursor in one operation", async () => {
    const { store, journal, cursor, epoch } = await setup();
    journal.bumpStageEpoch("issue-1");
    journal.saveCursor(cursor(1), 1);

    expect(journal.onStageChange("issue-1")).toBe(2);

    expect(epoch()).toBe(2);
    expect(journal.getCursor("issue-1")).toBeNull();
    store.close();
  });

  test("a stage change bumps the epoch and clears the cursor", async () => {
    const { store, journal, stage, cursor, epoch } = await setup();
    stage("build", "ready");
    const before = epoch();
    journal.saveCursor(cursor(before), before);

    stage("review", "awaiting-source");

    expect(epoch()).toBe(before + 1);
    expect(journal.getCursor("issue-1")).toBeNull();
    store.close();
  });

  test("a status change into a parked or terminal state bumps once", async () => {
    const { store, stage, epoch } = await setup();
    stage("build", "running");
    const before = epoch();

    stage("build", "blocked");
    expect(epoch()).toBe(before + 1);

    stage("build", "blocked");
    expect(epoch()).toBe(before + 1);
    store.close();
  });

  test("a stage-state row for a first enrollment bumps", async () => {
    const { store, stage, epoch } = await setup();
    expect(epoch()).toBe(0);
    stage("build", "ready");
    expect(epoch()).toBe(1);
    store.close();
  });

  test("executor bookkeeping between ready, running, error and interrupted does not bump", async () => {
    const { store, journal, stage, cursor, epoch } = await setup();
    stage("build", "ready");
    const before = epoch();
    journal.saveCursor(cursor(before), before);

    stage("build", "running");
    stage("build", "ready");
    stage("build", "running");
    stage("build", "error");
    stage("build", "ready");
    stage("build", "running");
    stage("build", "interrupted");
    stage("build", "ready", 1);

    expect(epoch()).toBe(before);
    expect(journal.getCursor("issue-1")).not.toBeNull();
    store.close();
  });

  test("an unchanged stage state does not bump", async () => {
    const { store, stage, epoch } = await setup();
    stage("build", "awaiting-source");
    const before = epoch();
    stage("build", "awaiting-source");
    expect(epoch()).toBe(before);
    store.close();
  });

  test("projection changes of stage or state bump; warning-only changes do not", async () => {
    const { store, journal, project, cursor, epoch } = await setup();
    project("build", "active");
    const first = epoch();
    expect(first).toBe(1);
    journal.saveCursor(cursor(first), first);

    project("build", "active", "waiting for CI");
    project("build", "active");
    project("build", "active");
    expect(epoch()).toBe(first);
    expect(journal.getCursor("issue-1")).not.toBeNull();

    project("build", "blocked");
    expect(epoch()).toBe(first + 1);
    expect(journal.getCursor("issue-1")).toBeNull();

    project("review", "blocked");
    expect(epoch()).toBe(first + 2);
    store.close();
  });

  test("starting and ending enrollment bump; ending none does not", async () => {
    const { store, epoch } = await setup();
    store.activateEnrollment("issue-1");
    expect(epoch()).toBe(1);

    store.activateEnrollment("issue-1");
    expect(epoch()).toBe(1);

    store.endActiveEnrollment("issue-1", "offboarded");
    expect(epoch()).toBe(2);

    store.endActiveEnrollment("issue-1", "offboarded");
    expect(epoch()).toBe(2);
    store.close();
  });

  test("a late completion from the old stage is rejected after a stage change", async () => {
    const { store, journal, stage, cursor, epoch } = await setup();
    stage("build", "running");
    const old = epoch();
    stage("review", "awaiting-source");

    expect(() => journal.saveCursor(cursor(old), old)).toThrow("Stale stage epoch");
    store.close();
  });
});
